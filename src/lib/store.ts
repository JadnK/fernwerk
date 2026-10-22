import { create } from "zustand";
import { api, errText } from "./api";
import { uid } from "./format";
import type { HostProfile, Tool, VaultData } from "./types";

export interface TermTab {
  key: string;
  title: string;
  /** Wird nach dem Öffnen einmalig ins Terminal geschrieben */
  startup?: string;
}

export interface Session {
  id: string;
  hostId: string;
  label: string;
  username: string;
  host: string;
  color: string;
  status: "connected" | "closed";
  tool: Tool;
  terminals: TermTab[];
  activeTerm: string | null;
  sudoPassword?: string;
}

export type View = "hosts" | "keys" | "settings";

export interface DialogField {
  name: string;
  label: string;
  type?: "text" | "password" | "checkbox" | "textarea" | "select";
  value?: string | boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
}

export interface DialogSpec {
  title: string;
  message?: string;
  /** Monospace-Block, z.B. für Fingerprints */
  detail?: string;
  fields?: DialogField[];
  confirm?: string;
  cancel?: string | null;
  danger?: boolean;
}

export type DialogResult = Record<string, string | boolean>;

export interface NavEntry {
  active: string | null;
  view: View;
  tool: Tool | null;
}

export interface UpdateInfo {
  version: string;
  current: string;
  notes: string;
  date: string | null;
}

export interface Toast {
  id: string;
  kind: "info" | "error" | "ok";
  text: string;
}

interface State {
  vault: VaultData | null;
  sessions: Session[];
  active: string | null;
  view: View;
  paletteOpen: boolean;
  editingHost: HostProfile | "new" | null;
  connecting: Record<string, boolean>;
  dialog: (DialogSpec & { resolve: (r: DialogResult | null) => void }) | null;
  toasts: Toast[];
  navBack: NavEntry[];
  navFwd: NavEntry[];
  update: UpdateInfo | null;

  reloadVault: () => Promise<void>;
  setView: (v: View) => void;
  setActive: (id: string | null) => void;
  setTool: (sessionId: string, tool: Tool) => void;
  updateSession: (id: string, patch: Partial<Session>) => void;
  addTerminal: (sessionId: string, startup?: string) => void;
  closeTerminal: (sessionId: string, key: string) => void;
  connectHost: (hostId: string) => Promise<void>;
  disconnect: (sessionId: string) => Promise<void>;
  reconnect: (sessionId: string) => Promise<void>;
  /** Einen Schritt in der App-Historie zurück (-1) oder vor (1). */
  goNav: (dir: -1 | 1) => boolean;
}

const snap = (s: Pick<State, "active" | "view" | "sessions">): NavEntry => ({
  active: s.active,
  view: s.view,
  tool: s.sessions.find((x) => x.id === s.active)?.tool ?? null,
});
const sameNav = (a: NavEntry, b: NavEntry) => a.active === b.active && a.view === b.view && a.tool === b.tool;

export const useStore = create<State>((set, get) => {
  /** Führt eine Navigation aus und merkt sich den vorherigen Stand für „Zurück“. */
  const withNav = (change: () => void) => {
    const before = snap(get());
    change();
    if (!sameNav(before, snap(get()))) {
      set((s) => ({ navBack: [...s.navBack, before].slice(-100), navFwd: [] }));
    }
  };

  return {
  vault: null,
  sessions: [],
  active: null,
  view: "hosts",
  paletteOpen: false,
  editingHost: null,
  connecting: {},
  dialog: null,
  toasts: [],
  navBack: [],
  navFwd: [],
  update: null,

  reloadVault: async () => {
    set({ vault: await api.vaultLoad() });
  },

  setView: (view) => withNav(() => set({ view, active: null })),
  setActive: (active) => withNav(() => set({ active })),

  setTool: (sessionId, tool) => withNav(() => get().updateSession(sessionId, { tool })),

  goNav: (dir) => {
    const s = get();
    const stack = [...(dir < 0 ? s.navBack : s.navFwd)];
    const cur = snap(s);
    while (stack.length) {
      const e = stack.pop()!;
      // Geschlossene Sitzungen überspringen
      if (e.active && !s.sessions.some((x) => x.id === e.active)) continue;
      if (sameNav(e, cur)) continue;
      const other = [...(dir < 0 ? s.navFwd : s.navBack), cur];
      set((st) => ({
        ...(dir < 0 ? { navBack: stack, navFwd: other } : { navFwd: stack, navBack: other }),
        active: e.active,
        view: e.view,
        sessions:
          e.active && e.tool
            ? st.sessions.map((x) => (x.id === e.active ? { ...x, tool: e.tool! } : x))
            : st.sessions,
      }));
      return true;
    }
    set(dir < 0 ? { navBack: [] } : { navFwd: [] });
    return false;
  },

  updateSession: (id, patch) =>
    set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, ...patch } : x)) })),

  addTerminal: (sessionId, startup) => {
    const s = get().sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const tab: TermTab = { key: uid(), title: `Shell ${s.terminals.length + 1}`, startup };
    get().updateSession(sessionId, {
      terminals: [...s.terminals, tab],
      activeTerm: tab.key,
      tool: "terminal",
    });
  },

  closeTerminal: (sessionId, key) => {
    const s = get().sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const terminals = s.terminals.filter((t) => t.key !== key);
    get().updateSession(sessionId, {
      terminals,
      activeTerm: s.activeTerm === key ? (terminals[terminals.length - 1]?.key ?? null) : s.activeTerm,
    });
  },

  connectHost: async (hostId) => {
    const vault = get().vault;
    const host = vault?.hosts.find((h) => h.id === hostId);
    if (!host || get().connecting[hostId]) return;

    set((s) => ({ connecting: { ...s.connecting, [hostId]: true } }));
    const done = () =>
      set((s) => {
        const c = { ...s.connecting };
        delete c[hostId];
        return { connecting: c };
      });

    let password: string | undefined;
    let passphrase: string | undefined;
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const info = await api.connect(hostId, password, passphrase);
          if (info.newHostKey) {
            toast("info", `Host-Schlüssel von ${host.host} gespeichert (${info.fingerprint})`);
          }
          const session: Session = {
            id: info.id,
            hostId,
            label: host.name,
            username: info.username,
            host: host.host,
            color: host.color,
            status: "connected",
            tool: "terminal",
            terminals: [{ key: uid(), title: "Shell 1", startup: host.startupCommand || undefined }],
            activeTerm: null,
          };
          session.activeTerm = session.terminals[0].key;
          withNav(() => set((s) => ({ sessions: [...s.sessions, session], active: session.id })));
          void get().reloadVault();

          for (const t of host.tunnels.filter((t) => t.autoStart)) {
            api.tunnelStart(info.id, t).catch((e) => toast("error", `Tunnel „${t.name}“: ${errText(e)}`));
          }
          return;
        } catch (e) {
          const msg = errText(e);

          if (msg.includes("PASSWORD_REQUIRED") || (msg.includes("AUTH_FAILED") && host.auth.type === "password")) {
            const r = await ask({
              title: `Passwort für ${host.username}@${host.host}`,
              message: msg.includes("AUTH_FAILED") ? "Anmeldung fehlgeschlagen. Bitte erneut eingeben." : undefined,
              fields: [
                { name: "password", label: "Passwort", type: "password" },
                { name: "save", label: "Im Tresor speichern", type: "checkbox", value: false },
              ],
              confirm: "Verbinden",
            });
            if (!r) return;
            password = String(r.password);
            if (r.save) await api.hostSave(host, { password });
            continue;
          }

          if (msg.includes("PASSPHRASE_REQUIRED")) {
            const r = await ask({
              title: "Passphrase für Schlüssel",
              message: host.auth.type === "key" ? host.auth.keyPath : undefined,
              fields: [
                { name: "passphrase", label: "Passphrase", type: "password" },
                { name: "save", label: "Im Tresor speichern", type: "checkbox", value: false },
              ],
              confirm: "Entsperren",
            });
            if (!r) return;
            passphrase = String(r.passphrase);
            if (r.save) await api.hostSave(host, { passphrase });
            continue;
          }

          if (msg.includes("HOSTKEY_MISMATCH")) {
            const [, expected, got] = msg.split("|");
            const r = await ask({
              title: "Host-Schlüssel hat sich geändert",
              message:
                "Der Server meldet einen anderen Schlüssel als beim letzten Mal. Das kann eine Neuinstallation sein – oder ein Angriff. Nur fortfahren, wenn du den neuen Fingerprint geprüft hast.",
              detail: `Gespeichert: ${expected}\nAktuell:     ${got}`,
              confirm: "Neuem Schlüssel vertrauen",
              danger: true,
            });
            if (!r) return;
            await api.hostForgetKey(host.host, host.port);
            continue;
          }

          toast("error", `${host.name}: ${humanError(msg)}`);
          return;
        }
      }
    } finally {
      done();
    }
  },

  disconnect: async (sessionId) => {
    await api.disconnect(sessionId).catch(() => {});
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== sessionId);
      return {
        sessions,
        active: s.active === sessionId ? (sessions[sessions.length - 1]?.id ?? null) : s.active,
      };
    });
  },

  reconnect: async (sessionId) => {
    const s = get().sessions.find((x) => x.id === sessionId);
    if (!s) return;
    await get().disconnect(sessionId);
    await get().connectHost(s.hostId);
  },
  };
});

export function humanError(msg: string): string {
  if (msg.includes("AUTH_FAILED")) return "Anmeldung fehlgeschlagen";
  if (msg.includes("Connection refused")) return "Verbindung abgelehnt";
  if (msg.includes("failed to lookup") || msg.includes("Name or service not known"))
    return "Host nicht gefunden";
  return msg;
}

// ---------------------------------------------------------------- Dialoge & Toasts

export function ask(spec: DialogSpec): Promise<DialogResult | null> {
  return new Promise((resolve) => {
    useStore.setState({
      dialog: {
        ...spec,
        resolve: (r) => {
          useStore.setState({ dialog: null });
          resolve(r);
        },
      },
    });
  });
}

export async function confirm(title: string, message: string, confirmLabel = "OK", danger = false) {
  return (await ask({ title, message, confirm: confirmLabel, danger })) !== null;
}

export function toast(kind: Toast["kind"], text: string) {
  const id = uid();
  useStore.setState((s) => ({ toasts: [...s.toasts, { id, kind, text }].slice(-5) }));
  setTimeout(
    () => useStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    kind === "error" ? 7000 : 4000,
  );
}

/**
 * Führt eine root-Aktion aus. Fragt bei Bedarf nach dem sudo-Passwort und merkt es sich
 * für die laufende Sitzung (nur im Speicher).
 */
export async function withSudo<T>(sessionId: string, fn: (pw: string | undefined) => Promise<T>): Promise<T> {
  const get = () => useStore.getState().sessions.find((s) => s.id === sessionId);
  let pw = get()?.sudoPassword;
  for (let i = 0; i < 3; i++) {
    try {
      return await fn(pw);
    } catch (e) {
      const msg = errText(e);
      if (!msg.includes("SUDO_PASSWORD_REQUIRED") && !msg.includes("SUDO_PASSWORD_WRONG")) throw e;
      const r = await ask({
        title: "sudo-Passwort",
        message: msg.includes("WRONG")
          ? "Falsches Passwort, bitte erneut versuchen."
          : `Für diese Aktion werden root-Rechte auf ${get()?.host ?? "dem Server"} benötigt.`,
        fields: [{ name: "pw", label: `Passwort für ${get()?.username ?? "Benutzer"}`, type: "password" }],
        confirm: "Ausführen",
      });
      if (!r) throw new Error("Abgebrochen");
      pw = String(r.pw);
      useStore.getState().updateSession(sessionId, { sudoPassword: pw });
    }
  }
  throw new Error("sudo fehlgeschlagen");
}

/** Wie run(), liefert aber true/false – für Aktionen ohne Rückgabewert. */
export async function attempt(fn: () => Promise<unknown>, okText?: string): Promise<boolean> {
  return (await run(async () => (await fn(), true), okText)) === true;
}

/** Wrapper für Aktionen mit Fehler-Toast. */
export async function run<T>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (okText) toast("ok", okText);
    return r;
  } catch (e) {
    const msg = errText(e);
    if (msg !== "Abgebrochen") toast("error", msg);
    return undefined;
  }
}
