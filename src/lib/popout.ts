import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { releaseTerminal } from "../components/TerminalPane";
import { errText } from "./api";
import { toast, useStore } from "./store";

/** Was ein ausgelagertes Shell-Fenster zum Start braucht (per localStorage übergeben). */
export interface PopoutInfo {
  sessionId: string;
  connId: string;
  termId: string;
  title: string;
  label: string;
  host: string;
  color: string;
  /** root-Shell (sudo -i) */
  root?: boolean;
}

/** Nachricht vom Shell-Fenster an das Hauptfenster: Shell zurück als Tab übernehmen */
export interface DockPayload {
  sessionId: string;
  termId: string;
  title: string;
  root?: boolean;
}

export const POPOUT_PREFIX = "shell-";
export const popoutKey = (label: string) => `fw-popout:${label}`;
export const DOCK_EVENT = "shell-dock";

/**
 * Löst eine laufende Shell aus der Sitzung und öffnet sie in einem eigenen Fenster.
 * Die SSH-Shell läuft dabei weiter, nur die Anzeige wechselt das Fenster.
 */
export async function popOutShell(sessionId: string, tabKey: string, title: string, at?: { x: number; y: number }) {
  const st = useStore.getState();
  const s = st.sessions.find((x) => x.id === sessionId);
  const tab = s?.terminals.find((t) => t.key === tabKey);
  if (!s || !tab || s.status !== "connected") return;
  const termId = releaseTerminal(tabKey);
  if (!termId) {
    toast("info", "Die Shell startet noch – bitte gleich noch einmal versuchen");
    return;
  }

  const label = `${POPOUT_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const info: PopoutInfo = {
    sessionId,
    connId: s.id,
    termId,
    title,
    label: s.label,
    host: s.isRoot ? s.host : `${s.username}@${s.host}`,
    color: s.color,
    root: tab.root,
  };
  try {
    localStorage.setItem(popoutKey(label), JSON.stringify(info));
  } catch {
    /* ohne localStorage kein Auslagern möglich */
  }

  // Tab entfernen – die Shell wird dabei nicht geschlossen (releaseTerminal)
  st.closeTerminal(sessionId, tabKey);

  const win = new WebviewWindow(label, {
    url: "index.html",
    title: `${title} – ${s.label}`,
    width: 900,
    height: 560,
    minWidth: 420,
    minHeight: 240,
    ...(at ? { x: Math.max(0, Math.round(at.x)), y: Math.max(0, Math.round(at.y)) } : { center: true }),
  });
  win.once("tauri://error", (e) => {
    toast("error", `Fenster konnte nicht geöffnet werden: ${errText(e.payload)}`);
    // Shell zurückholen, damit sie nicht verwaist
    useStore.getState().adoptTerminal(sessionId, termId, title, tab.root);
  });
}
