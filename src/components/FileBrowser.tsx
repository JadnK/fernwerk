import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ArrowUp,
  Download,
  Eye,
  EyeOff,
  File,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  FolderUp,
  Home,
  Link2,
  Pencil,
  RefreshCw,
  Shield,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api, errText } from "../lib/api";
import { bytes, joinPath, parentDir, uid, unixDate } from "../lib/format";
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

const TEXT_EXT = /\.(txt|md|conf|cfg|ini|env|json|ya?ml|toml|xml|html?|css|s?js|tsx?|jsx|php|py|rb|go|rs|java|c|h|cpp|sh|bash|zsh|service|log|sql|csv|lua|properties|gitignore|dockerignore)$/i;

export function FileBrowser({ connId, visible }: { connId: string; visible: boolean }) {
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [editor, setEditor] = useState<{ path: string; content: string; original: string } | null>(null);
  const lastClicked = useRef<number>(-1);

  const load = useCallback(
    async (p: string) => {
      setLoading(true);
      setError(null);
      try {
        const list = await api.sftpList(connId, p);
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
    if ((ev.target as HTMLElement).tagName === "INPUT") return;
    if (ev.key === "Delete") remove([...selected]);
    if (ev.key === "Backspace" && path) load(parentDir(path));
    if (ev.key === "F5") {
      ev.preventDefault();
      refresh();
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "a") {
      ev.preventDefault();
      setSelected(new Set(shown.map((e) => e.path)));
    }
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
        <button className="btn icon ghost" title="Übergeordneter Ordner" onClick={() => path && load(parentDir(path))}>
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
                <span className="crumb" onClick={() => load(c.path)}>
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
        <span className="session-meta">
          {shown.length} Einträge{sel.length > 0 && ` · ${sel.length} ausgewählt`}
        </span>
      </div>

      <div className="file-list">
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
                    className={selected.has(e.path) ? "sel" : ""}
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
                        <button className="btn sm icon ghost" title="Umbenennen" onClick={() => rename(e)}>
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
