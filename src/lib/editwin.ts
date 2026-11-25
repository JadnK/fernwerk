import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

/** Was ein Editor-Fenster zum Start braucht (per localStorage übergeben). */
export interface EditorInfo {
  connId: string;
  path: string;
  /** Name des Hosts */
  label: string;
  /** user@host */
  host: string;
  color: string;
  root?: boolean;
  /** Bereits gelesener Inhalt – spart das zweite Lesen; fehlt bei sehr großen Dateien */
  content?: string;
}

/** Hauptfenster: Datei wurde im Editor-Fenster gespeichert (Liste aktualisieren) */
export interface FileSavedPayload {
  connId: string;
  path: string;
}

export const EDITOR_PREFIX = "edit-";
export const FILE_SAVED_EVENT = "file-saved";
export const editorKey = (label: string) => `fw-editor:${label}`;

/** Fester Fenstername je Verbindung und Datei – dieselbe Datei öffnet kein zweites Fenster. */
function labelFor(connId: string, path: string) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  const s = `${connId}\u0000${path}`;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
  }
  return `${EDITOR_PREFIX}${a.toString(36)}${b.toString(36)}`;
}

export function forgetEditor(label: string) {
  try {
    localStorage.removeItem(editorKey(label));
  } catch {
    /* egal */
  }
}

/**
 * Öffnet eine Datei in einem eigenen Editor-Fenster.
 * Liefert false, wenn kein Fenster aufgeht – dann bleibt der eingebaute Editor.
 */
export async function openEditorWindow(info: EditorInfo): Promise<boolean> {
  const label = labelFor(info.connId, info.path);

  const existing = await WebviewWindow.getByLabel(label).catch(() => null);
  if (existing) {
    await existing.unminimize().catch(() => {});
    await existing.setFocus().catch(() => {});
    return true;
  }

  try {
    localStorage.setItem(editorKey(label), JSON.stringify(info));
  } catch {
    // Zu groß für localStorage – das Fenster liest die Datei dann selbst
    try {
      localStorage.setItem(editorKey(label), JSON.stringify({ ...info, content: undefined }));
    } catch {
      return false;
    }
  }

  const name = info.path.split("/").pop() || info.path;
  return new Promise((resolve) => {
    const win = new WebviewWindow(label, {
      url: "index.html",
      title: `${name} – ${info.label}`,
      width: 1000,
      height: 700,
      minWidth: 480,
      minHeight: 300,
      center: true,
    });
    win.once("tauri://created", () => resolve(true));
    win.once("tauri://error", () => {
      forgetEditor(label);
      resolve(false);
    });
  });
}
