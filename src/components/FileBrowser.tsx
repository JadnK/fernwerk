import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  EyeOff,
  File,
  FilePlus,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  FolderUp,
  Home,
  Link2,
  Pencil,
  RefreshCw,
  Scissors,
  Shield,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api, errText } from "../lib/api";
import { bytes, joinPath, parentDir, uid, unixDate } from "../lib/format";
import { paneNav, type NavDir } from "../lib/nav";
import { ask, attempt, confirm, run, toast } from "../lib/store";
import type { FileEntry, Progress } from "../lib/types";
import { Bar, Modal } from "./ui";

interface Transfer {
  id: string;
  label: string;
  dir: "up" | "down";
  done: number;
  total: number;
  file: string;
  finished: boolean;
  error: string | null;
}

interface Clip {
  paths: string[];
  mode: "move" | "copy";
}

interface DragState {
  x: number;
  y: number;
  items: string[];
  target: string | null;
  copy: boolean;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** "datei.txt" -> "datei (Kopie).txt" */
function copyName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (Kopie)${name.slice(dot)}` : `${name} (Kopie)`;
}

/** Eingabefelder und der Editor behalten ihre eigenen Tastenkürzel (Strg+A, Entf, Backspace …). */
function isTextTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && !!t.closest("input, textarea, select, [contenteditable]");
}

const TEXT_EXT = /\.(txt|md|conf|cfg|ini|env|json|ya?ml|toml|xml|html?|css|s?js|tsx?|jsx|php|py|rb|go|rs|java|c|h|cpp|sh|bash|zsh|service|log|sql|csv|lua|properties|gitignore|dockerignore)$/i;

export function FileBrowser({ sessionId, connId, visible }: { sessionId: string; connId: string; visible: boolean }) {
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [dragging, setDragging] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [editor, setEditor] = useState<{ path: string; content: string; original: string } | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const lastClicked = useRef<number>(-1);
  const pathRef = useRef<string | null>(null);
  const hist = useRef<{ back: string[]; fwd: string[] }>({ back: [], fwd: [] });
  const [, bumpHist] = useState(0);

  const load = useCallback(
    async (p: string, mode: "push" | "back" | "fwd" = "push") => {
      setLoading(true);
      setError(null);
      try {
        const list = await api.sftpList(connId, p);
        const cur = pathRef.current;
        if (cur && cur !== p) {
          const h = hist.current;
          if (mode === "push") {
            h.back = [...h.back, cur].slice(-100);
            h.fwd = [];
          } else if (mode === "back") h.fwd.push(cur);
          else h.back.push(cur);
          bumpHist((x) => x + 1);
        }
        pathRef.current = p;
        setEntries(list);
        setPath(p);
        setSelected(new Set());
        lastClicked.current = -1;
      } catch (e) {
        setError(errText(e));
      } finally {
        setLoading(false);
      }
    },
    [connId],
  );

  useEffect(() => {
    if (!visible || path !== null) return;
    api
      .sftpHome(connId)
      .then(load)
      .catch((e) => setError(errText(e)));
  }, [visible, path, connId, load]);

  const shown = useMemo(
    () =>
      entries.filter(
        (e) =>
          (showHidden || !e.name.startsWith(".")) &&
          (!filter || e.name.toLowerCase().includes(filter.toLowerCase())),
      ),
    [entries, showHidden, filter],
  );

  const refresh = () => path && load(path);

  // ------------------------------------------------------------ Verlauf (Zurück/Vor)

  const go = useCallback(
    (dir: NavDir): boolean => {
      const h = hist.current;
      const target = dir < 0 ? h.back.pop() : h.fwd.pop();
      if (!target) return false;
      bumpHist((x) => x + 1);
      load(target, dir < 0 ? "back" : "fwd");
      return true;
    },
    [load],
  );

  useEffect(() => {
    const key = `${sessionId}:files`;
    paneNav.set(key, go);
    return () => {
      paneNav.delete(key);
    };
  }, [sessionId, go]);

  // ------------------------------------------------------------ Verschieben / Kopieren

  const moveOrCopy = async (paths: string[], destDir: string, mode: "move" | "copy") => {
    const inside = (p: string) => destDir === p || destDir.startsWith(p.replace(/\/+$/, "") + "/");
    const items = paths.filter((p) => !inside(p));
    if (items.length < paths.length) toast("error", "Ein Ordner kann nicht in sich selbst verschoben werden");
    let done = 0;
    for (const p of items) {
      const sameDir = parentDir(p) === destDir;
      if (mode === "move" && sameDir) continue;
      const target = joinPath(destDir, sameDir ? copyName(baseName(p)) : baseName(p));
      try {
        if (mode === "move") {
          await api.sftpRename(connId, p, target);
        } else {
          const r = await api.exec(
            connId,
            `if [ -e ${q(target)} ]; then echo "Ziel existiert bereits" >&2; exit 1; fi; cp -a -- ${q(p)} ${q(target)}`,
          );
          if (r.code !== 0) throw new Error(r.stderr.trim() || `Exit ${r.code}`);
        }
        done++;
      } catch (e) {
        toast("error", `${baseName(p)}: ${errText(e)}`);
      }
    }
    if (done > 0) {
      toast("ok", `${done} Element${done === 1 ? "" : "e"} ${mode === "move" ? "verschoben" : "kopiert"} nach ${destDir}`);
    }
    refresh();
    return done;
  };
  const moveRef = useRef(moveOrCopy);
  moveRef.current = moveOrCopy;

  const cutOrCopy = (mode: Clip["mode"], paths: string[]) => {
    if (paths.length === 0) return;
    setClip({ paths, mode });
    toast("info", `${paths.length} Element${paths.length === 1 ? "" : "e"} ${mode === "move" ? "ausgeschnitten" : "kopiert"} – mit Strg+V einfügen`);
  };

  const paste = async () => {
    if (!clip || !path) return;
    await moveOrCopy(clip.paths, path, clip.mode);
    if (clip.mode === "move") setClip(null);
  };

  const moveTo = async (paths: string[]) => {
    if (paths.length === 0 || !path) return;
    const r = await ask({
      title: paths.length === 1 ? `„${baseName(paths[0])}“ verschieben` : `${paths.length} Elemente verschieben`,
      fields: [
        { name: "dest", label: "Zielordner", value: path },
        { name: "copy", label: "Kopieren statt verschieben", type: "checkbox", value: false },
      ],
      confirm: "Ausführen",
    });
    if (!r) return;
    const dest = String(r.dest).trim().replace(/(.)\/+$/, "$1");
    if (!dest.startsWith("/")) return toast("error", "Bitte einen absoluten Pfad angeben");
    await moveOrCopy(paths, dest, r.copy ? "copy" : "move");
  };

  // Ziehen per Maus (eigene Umsetzung, weil das native Drag & Drop für Uploads reserviert ist)
  const dragStart = useRef<{ x: number; y: number; items: string[] } | null>(null);

  const onRowMouseDown = (ev: React.MouseEvent, e: FileEntry) => {
    if (ev.button !== 0 || (ev.target as HTMLElement).closest("button")) return;
    const items = selected.has(e.path) ? [...selected] : [e.path];
    dragStart.current = { x: ev.clientX, y: ev.clientY, items };
  };

  useEffect(() => {
    const findTarget = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]");
      return el?.dataset.drop ?? null;
    };
    const onMove = (ev: MouseEvent) => {
      const st = dragStart.current;
      if (!st) return;
      if (!drag && Math.hypot(ev.clientX - st.x, ev.clientY - st.y) < 6) return;
      let target = findTarget(ev.clientX, ev.clientY);
      if (target && st.items.includes(target)) target = null;
      setDrag({ x: ev.clientX, y: ev.clientY, items: st.items, target, copy: ev.ctrlKey || ev.altKey });
    };
    const onUp = (ev: MouseEvent) => {
      const st = dragStart.current;
      dragStart.current = null;
      if (!st || !drag) return;
      setDrag(null);
      const target = drag.target;
      if (target) moveRef.current(st.items, target, ev.ctrlKey || ev.altKey ? "copy" : "move");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag]);

  // ------------------------------------------------------------ Transfers

  const startTransfer = async (dir: "up" | "down", label: string, exec: (id: string, ch: Channel<Progress>) => Promise<void>) => {
    const id = uid();
    const ch = new Channel<Progress>();
    setTransfers((t) => [...t, { id, label, dir, done: 0, total: 0, file: "", finished: false, error: null }]);
    ch.onmessage = (p) =>
      setTransfers((t) =>
        t.map((x) =>
          x.id === p.transferId
            ? { ...x, done: p.done, total: p.total, file: p.file || x.file, finished: p.finished, error: p.error }
            : x,
        ),
      );
    try {
      await exec(id, ch);
      setTimeout(() => setTransfers((t) => t.filter((x) => x.id !== id || x.error)), 2500);
      if (dir === "up") refresh();
    } catch (e) {
      const msg = errText(e);
      if (msg !== "Abgebrochen") toast("error", `${label}: ${msg}`);
      setTransfers((t) => t.filter((x) => x.id !== id));
    }
  };

  const upload = async (localPaths: string[]) => {
    if (!path || localPaths.length === 0) return;
    const label = localPaths.length === 1 ? localPaths[0].split(/[\\/]/).pop()! : `${localPaths.length} Elemente`;
    const target = path;
    await startTransfer("up", label, (id, ch) => api.sftpUpload(connId, localPaths, target, id, ch));
  };

  const pickUpload = async (directory: boolean) => {
    const res = await openDialog({ multiple: true, directory, title: directory ? "Ordner hochladen" : "Dateien hochladen" });
    if (!res) return;
    await upload(Array.isArray(res) ? res : [res]);
  };

  const download = async (paths: string[]) => {
    if (paths.length === 0) return;
    const dest = await openDialog({ directory: true, title: "Zielordner wählen" });
    if (!dest || Array.isArray(dest)) return;
    const label = paths.length === 1 ? paths[0].split("/").pop()! : `${paths.length} Elemente`;
    await startTransfer("down", label, (id, ch) => api.sftpDownload(connId, paths, dest, id, ch));
  };

  // Drag & Drop aus dem Dateimanager
  useEffect(() => {
    if (!visible) return;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        const p = ev.payload;
        if (p.type === "enter" || p.type === "over") setDragging(true);
        else if (p.type === "leave") setDragging(false);
        else if (p.type === "drop") {
          setDragging(false);
          upload(p.paths);
        }
      })
      .then((u) => (unlisten = u));
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, path, connId]);

  // ------------------------------------------------------------ Aktionen

  const openEntry = async (e: FileEntry) => {
    if (e.kind === "dir" || e.linkToDir) return load(e.path);
    if (e.size > 5 * 1024 * 1024 && !TEXT_EXT.test(e.name)) return download([e.path]);
    await editFile(e.path);
  };

  const editFile = async (p: string) => {
    try {
      const content = await api.sftpReadText(connId, p);
      setEditor({ path: p, content, original: content });
    } catch (e) {
      toast("error", errText(e));
    }
  };

  const newFolder = async () => {
    const r = await ask({ title: "Neuer Ordner", fields: [{ name: "name", label: "Name" }], confirm: "Anlegen" });
    if (!r || !path || !String(r.name).trim()) return;
    await run(() => api.sftpMkdir(connId, joinPath(path, String(r.name).trim())));
    refresh();
  };

  const newFile = async () => {
    const r = await ask({ title: "Neue Datei", fields: [{ name: "name", label: "Name" }], confirm: "Anlegen" });
    if (!r || !path || !String(r.name).trim()) return;
    const p = joinPath(path, String(r.name).trim());
    if (await attempt(() => api.sftpTouch(connId, p))) {
      refresh();
      setEditor({ path: p, content: "", original: "" });
    }
  };

  const rename = async (e: FileEntry) => {
    const r = await ask({ title: "Umbenennen", fields: [{ name: "name", label: "Neuer Name", value: e.name }], confirm: "Umbenennen" });
    if (!r || !path) return;
    const name = String(r.name).trim();
    if (!name || name === e.name) return;
    await run(() => api.sftpRename(connId, e.path, joinPath(path, name)));
    refresh();
  };

  const chmod = async (e: FileEntry) => {
    const r = await ask({
      title: `Rechte: ${e.name}`,
      message: `Aktuell ${e.perms} (${e.mode.toString(8).padStart(3, "0")})`,
      fields: [{ name: "mode", label: "Oktal (z.B. 644, 755)", value: e.mode.toString(8).padStart(3, "0") }],
      confirm: "Setzen",
    });
    if (!r) return;
    const mode = parseInt(String(r.mode), 8);
    if (isNaN(mode) || mode < 0 || mode > 0o7777) return toast("error", "Ungültiger Modus");
    await run(() => api.sftpChmod(connId, e.path, mode));
    refresh();
  };

  const remove = async (paths: string[]) => {
    if (paths.length === 0) return;
    const ok = await confirm(
      "Löschen",
      paths.length === 1
        ? `„${paths[0].split("/").pop()}“ endgültig löschen? Ordner werden rekursiv gelöscht.`
        : `${paths.length} Elemente endgültig löschen? Ordner werden rekursiv gelöscht.`,
      "Löschen",
      true,
    );
    if (!ok) return;
    await run(() => api.sftpRemove(connId, paths), "Gelöscht");
    refresh();
  };

  const clickRow = (ev: React.MouseEvent, idx: number, e: FileEntry) => {
    const next = new Set(ev.ctrlKey || ev.metaKey ? selected : []);
    if (ev.shiftKey && lastClicked.current >= 0) {
      const [a, b] = [lastClicked.current, idx].sort((x, y) => x - y);
      for (let i = a; i <= b; i++) next.add(shown[i].path);
    } else if ((ev.ctrlKey || ev.metaKey) && next.has(e.path)) {
      next.delete(e.path);
    } else {
      next.add(e.path);
      lastClicked.current = idx;
    }
    setSelected(next);
  };

  const onKey = (ev: React.KeyboardEvent) => {
    if (isTextTarget(ev.target) || editor) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key.toLowerCase();
    if (ev.key === "Delete") remove([...selected]);
    if (ev.key === "Backspace" && path) load(parentDir(path));
    if (ev.key === "F2" && selected.size === 1) {
      const e = entries.find((x) => selected.has(x.path));
      if (e) rename(e);
    }
    if (ev.key === "F5") {
      ev.preventDefault();
      refresh();
    }
    if (mod && key === "a") {
      ev.preventDefault();
      setSelected(new Set(shown.map((e) => e.path)));
    }
    if (mod && key === "x") cutOrCopy("move", [...selected]);
    if (mod && key === "c") cutOrCopy("copy", [...selected]);
    if (mod && key === "v") paste();
  };

  const crumbs = useMemo(() => {
    if (!path) return [];
    const parts = path.split("/").filter(Boolean);
    return [{ name: "/", path: "/" }, ...parts.map((p, i) => ({ name: p, path: "/" + parts.slice(0, i + 1).join("/") }))];
  }, [path]);

  const sel = [...selected];

  return (
    <div className="pane" tabIndex={0} onKeyDown={onKey} style={{ outline: "none" }}>
      <div className="pathbar">
        <button className="btn icon ghost" title="Zurück (Maustaste 4, Alt+←)" disabled={hist.current.back.length === 0} onClick={() => go(-1)}>
          <ArrowLeft size={16} />
        </button>
        <button className="btn icon ghost" title="Vor (Maustaste 5, Alt+→)" disabled={hist.current.fwd.length === 0} onClick={() => go(1)}>
          <ArrowRight size={16} />
        </button>
        <button
          className={`btn icon ghost ${drag && path && drag.target === parentDir(path) ? "drop-on" : ""}`}
          title="Übergeordneter Ordner"
          data-drop={path && path !== "/" ? parentDir(path) : undefined}
          onClick={() => path && load(parentDir(path))}
        >
          <ArrowUp size={16} />
        </button>
        <button className="btn icon ghost" title="Home" onClick={() => api.sftpHome(connId).then(load)}>
          <Home size={15} />
        </button>
        {editingPath ? (
          <input
            className="input mono grow"
            autoFocus
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onBlur={() => setEditingPath(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setEditingPath(false);
                load(pathInput.trim() || "/");
              }
              if (e.key === "Escape") setEditingPath(false);
            }}
          />
        ) : (
          <div
            className="crumbs"
            onDoubleClick={() => {
              setPathInput(path ?? "/");
              setEditingPath(true);
            }}
            title="Doppelklick zum Bearbeiten"
          >
            {crumbs.map((c, i) => (
              <span key={c.path} className="row" style={{ gap: 2 }}>
                {i > 1 && <span className="dim">/</span>}
                <span
                  className={`crumb ${drag?.target === c.path ? "drop-on" : ""}`}
                  data-drop={c.path}
                  onClick={() => load(c.path)}
                >
                  {c.name}
                </span>
              </span>
            ))}
          </div>
        )}
        <input
          className="input"
          style={{ width: 160 }}
          placeholder="Filtern…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="btn icon ghost" title={showHidden ? "Versteckte ausblenden" : "Versteckte anzeigen"} onClick={() => setShowHidden(!showHidden)}>
          {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
        <button className="btn icon ghost" title="Aktualisieren (F5)" onClick={refresh}>
          <RefreshCw size={15} className={loading ? "spin" : ""} />
        </button>
      </div>

      <div className="toolbar" style={{ borderBottom: "1px solid var(--line)" }}>
        <button className="btn sm" onClick={() => pickUpload(false)}>
          <Upload size={14} /> Hochladen
        </button>
        <button className="btn sm" onClick={() => pickUpload(true)}>
          <FolderUp size={14} /> Ordner
        </button>
        <button className="btn sm" disabled={sel.length === 0} onClick={() => download(sel)}>
          <Download size={14} /> Herunterladen
        </button>
        <span className="dim">|</span>
        <button className="btn sm ghost" onClick={newFolder}>
          <FolderPlus size={14} /> Ordner
        </button>
        <button className="btn sm ghost" onClick={newFile}>
          <FilePlus size={14} /> Datei
        </button>
        <button className="btn sm ghost danger" disabled={sel.length === 0} onClick={() => remove(sel)}>
          <Trash2 size={14} /> Löschen
        </button>
        <span className="dim">|</span>
        <button className="btn sm icon ghost" title="Ausschneiden (Strg+X)" disabled={sel.length === 0} onClick={() => cutOrCopy("move", sel)}>
          <Scissors size={14} />
        </button>
        <button className="btn sm icon ghost" title="Kopieren (Strg+C)" disabled={sel.length === 0} onClick={() => cutOrCopy("copy", sel)}>
          <Copy size={14} />
        </button>
        <button
          className="btn sm ghost"
          title="Einfügen (Strg+V)"
          disabled={!clip}
          onClick={paste}
        >
          <ClipboardPaste size={14} /> Einfügen{clip ? ` (${clip.paths.length})` : ""}
        </button>
        <button className="btn sm ghost" disabled={sel.length === 0} onClick={() => moveTo(sel)}>
          <FolderInput size={14} /> Verschieben nach…
        </button>
        <span className="session-meta">
          {shown.length} Einträge{sel.length > 0 && ` · ${sel.length} ausgewählt`}
        </span>
      </div>

      <div className="file-list">
        {dragging && <div className="dropzone">Loslassen zum Hochladen nach {path}</div>}
        {error ? (
          <div className="empty">
            <div className="err">{error}</div>
            <button className="btn" onClick={() => (path ? load(path) : api.sftpHome(connId).then(load))}>
              Erneut versuchen
            </button>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">Größe</th>
                <th>Geändert</th>
                <th>Rechte</th>
                <th>Besitzer</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((e, i) => {
                const isDir = e.kind === "dir" || e.linkToDir;
                return (
                  <tr
                    key={e.path}
                    className={[
                      selected.has(e.path) ? "sel" : "",
                      drag?.target === e.path ? "drop-on" : "",
                      drag?.items.includes(e.path) ? "dragged" : "",
                      clip?.mode === "move" && clip.paths.includes(e.path) ? "cut" : "",
                    ].join(" ")}
                    data-drop={isDir ? e.path : undefined}
                    onMouseDown={(ev) => onRowMouseDown(ev, e)}
                    onClick={(ev) => clickRow(ev, i, e)}
                    onDoubleClick={() => openEntry(e)}
                  >
                    <td>
                      <span className="file-name">
                        {e.kind === "link" ? (
                          <Link2 size={15} className={isDir ? "" : "dim"} style={isDir ? { color: "var(--accent)" } : {}} />
                        ) : isDir ? (
                          <Folder size={15} style={{ color: "var(--accent)" }} />
                        ) : TEXT_EXT.test(e.name) ? (
                          <FileText size={15} className="muted" />
                        ) : (
                          <File size={15} className="dim" />
                        )}
                        {e.name}
                      </span>
                    </td>
                    <td className="num mono dim">{isDir ? "" : bytes(e.size)}</td>
                    <td className="mono dim">{unixDate(e.mtime)}</td>
                    <td className="mono dim">{e.perms}</td>
                    <td className="dim">{e.owner}</td>
                    <td>
                      <div className="row-actions">
                        {!isDir && (
                          <button className="btn sm icon ghost" title="Bearbeiten" onClick={() => editFile(e.path)}>
                            <FileText size={13} />
                          </button>
                        )}
                        <button className="btn sm icon ghost" title="Herunterladen" onClick={() => download([e.path])}>
                          <Download size={13} />
                        </button>
                        <button className="btn sm icon ghost" title="Verschieben nach…" onClick={() => moveTo([e.path])}>
                          <FolderInput size={13} />
                        </button>
                        <button className="btn sm icon ghost" title="Umbenennen (F2)" onClick={() => rename(e)}>
                          <Pencil size={13} />
                        </button>
                        <button className="btn sm icon ghost" title="Rechte" onClick={() => chmod(e)}>
                          <Shield size={13} />
                        </button>
                        <button className="btn sm icon ghost" title="Löschen" onClick={() => remove([e.path])}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {!error && !loading && shown.length === 0 && path && <div className="empty dim">Ordner ist leer</div>}
      </div>

      {transfers.length > 0 && (
        <div className="transfers">
          {transfers.map((t) => {
            const p = t.total > 0 ? (t.done / t.total) * 100 : t.finished ? 100 : 0;
            return (
              <div key={t.id} className="transfer">
                <div className="ellipsis">
                  {t.dir === "up" ? <Upload size={13} className="dim" /> : <Download size={13} className="dim" />}{" "}
                  <span>{t.label}</span>{" "}
                  <span className="dim mono">{t.error ? <span className="err">{t.error}</span> : t.file.split("/").pop()}</span>
                </div>
                <div className="col" style={{ gap: 3 }}>
                  <Bar value={p} tone="ok" />
                  <span className="dim mono" style={{ fontSize: 11 }}>
                    {bytes(t.done)} / {bytes(t.total)}
                  </span>
                </div>
                {t.finished ? (
                  <button className="btn sm icon ghost" onClick={() => setTransfers((x) => x.filter((y) => y.id !== t.id))}>
                    <X size={13} />
                  </button>
                ) : (
                  <button className="btn sm ghost" onClick={() => api.sftpCancel(connId, t.id)}>
                    Abbrechen
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {drag && (
        <div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y + 10 }}>
          {drag.items.length === 1 ? baseName(drag.items[0]) : `${drag.items.length} Elemente`}
          <span className="dim">
            {drag.target ? ` → ${drag.copy ? "kopieren nach" : "verschieben nach"} ${baseName(drag.target) || "/"}` : ""}
          </span>
        </div>
      )}

      {editor && (
        <FileEditor
          path={editor.path}
          initial={editor.content}
          onClose={() => setEditor(null)}
          onSave={async (content) => {
            await api.sftpWriteText(connId, editor.path, content);
            toast("ok", `${editor.path.split("/").pop()} gespeichert`);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function FileEditor({
  path,
  initial,
  onClose,
  onSave,
}: {
  path: string;
  initial: string;
  onClose: () => void;
  onSave: (content: string) => Promise<void>;
}) {
  const [content, setContent] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [saving, setSaving] = useState(false);
  const dirty = content !== saved;

  const save = async () => {
    setSaving(true);
    try {
      await onSave(content);
      setSaved(content);
    } catch (e) {
      toast("error", errText(e));
    } finally {
      setSaving(false);
    }
  };

  const close = async () => {
    if (dirty && !(await confirm("Ungespeicherte Änderungen", "Änderungen verwerfen?", "Verwerfen", true))) return;
    onClose();
  };

  return (
    <Modal
      size="full"
      title={
        <span className="mono" style={{ fontWeight: 500 }}>
          {path}
          {dirty && <span className="warn"> ●</span>}
        </span>
      }
      onClose={close}
      footer={
        <>
          <span className="dim mono" style={{ marginRight: "auto", fontSize: 12 }}>
            {content.split("\n").length} Zeilen · Strg+S speichert
          </span>
          <button className="btn" onClick={close}>
            Schließen
          </button>
          <button className="btn primary" disabled={!dirty || saving} onClick={save}>
            {saving ? "Speichert…" : "Speichern"}
          </button>
        </>
      }
    >
      <textarea
        className="editor-area"
        spellCheck={false}
        autoFocus
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          // Tasten gehören dem Editor, nicht dem Dateibrowser dahinter
          e.stopPropagation();
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
            e.preventDefault();
            e.currentTarget.select();
            return;
          }
          if (e.key === "Escape") {
            e.preventDefault();
            close();
            return;
          }
          if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            if (dirty) save();
          }
          if (e.key === "Tab") {
            e.preventDefault();
            const t = e.currentTarget;
            const { selectionStart: s, selectionEnd: end } = t;
            const next = content.slice(0, s) + "    " + content.slice(end);
            setContent(next);
            requestAnimationFrame(() => (t.selectionStart = t.selectionEnd = s + 4));
          }
        }}
      />
    </Modal>
  );
}
