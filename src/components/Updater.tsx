import { useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { Download, Sparkles } from "lucide-react";
import { errText } from "../lib/api";
import { bytes } from "../lib/format";
import { toast, useStore } from "../lib/store";
import { Bar, Modal } from "./ui";

const SKIP_KEY = "fw-skip-version";

let pending: Update | null = null;
let checking = false;

function readSkip(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

function writeSkip(v: string | null) {
  try {
    if (v) localStorage.setItem(SKIP_KEY, v);
    else localStorage.removeItem(SKIP_KEY);
  } catch {
    /* ignorieren */
  }
}

/**
 * Prüft auf eine neue Version. Automatische Prüfungen bleiben still,
 * eine manuelle Prüfung meldet auch „aktuell“ und Fehler.
 */
export async function checkForUpdates(manual: boolean) {
  if (checking || useStore.getState().update) return;
  checking = true;
  try {
    const update = await check();
    if (!update) {
      if (manual) toast("ok", `Fernwerk ist aktuell (v${await getVersion()})`);
      return;
    }
    if (!manual && readSkip() === update.version) return;
    pending = update;
    useStore.setState({
      update: {
        version: update.version,
        current: update.currentVersion,
        notes: update.body ?? "",
        date: update.date ?? null,
      },
    });
  } catch (e) {
    if (manual) toast("error", `Update-Prüfung fehlgeschlagen: ${errText(e)}`);
  } finally {
    checking = false;
  }
}

/** Nur die Aufzählungspunkte aus den Release-Notes (CHANGELOG-Abschnitt). */
function noteItems(notes: string): string[] {
  return notes
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*] /.test(l))
    .map((l) => l.slice(2).replace(/`/g, ""));
}

type Phase = { kind: "idle" } | { kind: "download"; done: number; total: number } | { kind: "restart" } | { kind: "error"; msg: string };

export function UpdateDialog() {
  const info = useStore((s) => s.update);
  const liveSessions = useStore((s) => s.sessions.filter((x) => x.status === "connected").length);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  if (!info) return null;
  const busy = phase.kind === "download" || phase.kind === "restart";
  const items = noteItems(info.notes);

  const close = () => {
    if (busy) return;
    useStore.setState({ update: null });
    setPhase({ kind: "idle" });
  };

  const skip = () => {
    writeSkip(info.version);
    close();
  };

  const install = async () => {
    if (!pending) return;
    writeSkip(null);
    setPhase({ kind: "download", done: 0, total: 0 });
    try {
      let done = 0;
      let total = 0;
      await pending.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        if (ev.event === "Progress") done += ev.data.chunkLength;
        if (ev.event === "Finished") done = total || done;
        setPhase({ kind: "download", done, total });
      });
      setPhase({ kind: "restart" });
      // Offene Verbindungen sauber trennen, bevor die App neu startet
      const { sessions, disconnect } = useStore.getState();
      await Promise.allSettled(sessions.map((s) => disconnect(s.id)));
      await relaunch();
    } catch (e) {
      setPhase({ kind: "error", msg: errText(e) });
    }
  };

  const pct = phase.kind === "download" && phase.total > 0 ? (phase.done / phase.total) * 100 : 0;

  return (
    <Modal
      title={`Fernwerk ${info.version} ist verfügbar`}
      icon={<Sparkles size={16} style={{ color: "var(--accent)" }} />}
      onClose={close}
      footer={
        <>
          {!busy && (
            <button className="btn ghost" style={{ marginRight: "auto" }} onClick={skip}>
              Diese Version überspringen
            </button>
          )}
          <button className="btn" disabled={busy} onClick={close}>
            Später
          </button>
          <button className="btn primary" disabled={busy} onClick={install}>
            <Download size={14} /> {phase.kind === "error" ? "Erneut versuchen" : "Jetzt installieren"}
          </button>
        </>
      }
    >
      <div className="row muted">
        <span className="version-chip">v{info.current}</span>→<span className="version-chip" style={{ color: "var(--accent)" }}>v{info.version}</span>
        {info.date && <span className="dim">· {new Date(info.date).toLocaleDateString("de-DE")}</span>}
      </div>

      {items.length > 0 ? (
        <ul className="update-notes">
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      ) : (
        info.notes && <div className="detail">{info.notes}</div>
      )}

      {liveSessions > 0 && phase.kind === "idle" && (
        <div className="warn" style={{ fontSize: 12 }}>
          {liveSessions} offene Verbindung{liveSessions === 1 ? " wird" : "en werden"} beim Neustart getrennt.
        </div>
      )}

      {phase.kind === "download" && (
        <div className="col" style={{ gap: 4 }}>
          <Bar value={pct} tone="ok" />
          <span className="dim mono" style={{ fontSize: 11 }}>
            {phase.total > 0 ? `${bytes(phase.done)} / ${bytes(phase.total)}` : `${bytes(phase.done)} geladen`}
          </span>
        </div>
      )}
      {phase.kind === "restart" && <div className="ok">Installiert – Fernwerk startet neu…</div>}
      {phase.kind === "error" && <div className="err selectable">{phase.msg}</div>}
    </Modal>
  );
}

/** Kleine Einstellungs-Sektion: aktuelle Version + manuelle Prüfung. */
export function UpdateSettings() {
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (version === null) getVersion().then(setVersion).catch(() => setVersion("?"));

  return (
    <div className="row">
      <span className="muted">
        Installiert: <span className="version-chip">v{version ?? "…"}</span>
      </span>
      <button
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await checkForUpdates(true);
          setBusy(false);
        }}
      >
        {busy ? "Prüfe…" : "Nach Updates suchen"}
      </button>
    </div>
  );
}
