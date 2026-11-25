import { useEffect, useMemo, useRef, useState } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { RotateCw, Save, Search, X } from "lucide-react";
import { api, errText } from "../lib/api";
import { editorKey, forgetEditor, FILE_SAVED_EVENT, type EditorInfo, type FileSavedPayload } from "../lib/editwin";
import { bytes } from "../lib/format";
import type { Settings } from "../lib/types";

function readInfo(label: string): EditorInfo | null {
  try {
    const raw = localStorage.getItem(editorKey(label));
    if (!raw) return null;
    const info = JSON.parse(raw) as EditorInfo;
    // Inhalt nur einmal übernehmen – beim Neuladen des Fensters wird frisch gelesen
    if (info.content !== undefined) localStorage.setItem(editorKey(label), JSON.stringify({ ...info, content: undefined }));
    return info;
  } catch {
    return null;
  }
}

const isDenied = (e: unknown) => /permission ?denied|operation not permitted|keine berechtigung/i.test(errText(e));

type Status = { kind: "ok" | "err" | "info"; text: string } | null;

/** Eigenes Fenster zum Bearbeiten einer Datei auf dem Server. */
export function EditorWindow({ label }: { label: string }) {
  const info = useMemo(() => readInfo(label), [label]);
  const name = info ? info.path.split("/").pop() || info.path : "";

  const [content, setContent] = useState<string | null>(info?.content !== undefined ? info.content.replace(/\r\n/g, "\n") : null);
  const [saved, setSaved] = useState<string>(content ?? "");
  const [crlf, setCrlf] = useState(() => (info?.content ?? "").includes("\r\n"));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [find, setFind] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);

  const text = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const dirty = content !== null && content !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const load = async () => {
    if (!info) return;
    setLoadError(null);
    try {
      const raw = await api.sftpReadText(info.connId, info.path);
      const norm = raw.replace(/\r\n/g, "\n");
      setCrlf(raw.includes("\r\n"));
      setContent(norm);
      setSaved(norm);
      setStatus(null);
    } catch (e) {
      setLoadError(
        isDenied(e)
          ? `${errText(e)} – schalte im Hauptfenster den root-Modus ein und klicke dann auf „Neu laden“.`
          : errText(e),
      );
    }
  };

  useEffect(() => {
    if (info && info.content === undefined) load();
    api
      .vaultLoad()
      .then((v) => setSettings(v.settings))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!info) return;
    getCurrentWindow()
      .setTitle(`${dirty ? "● " : ""}${name} – ${info.label}`)
      .catch(() => {});
  }, [dirty, name, info]);

  // Schließen mit ungespeicherten Änderungen erst nachfragen
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested((ev) => {
      if (dirtyRef.current) {
        ev.preventDefault();
        setClosing(true);
        return;
      }
      forgetEditor(label);
    });
    return () => {
      un.then((f) => f());
    };
  }, [label]);

  const save = async (): Promise<boolean> => {
    if (!info || content === null) return false;
    setSaving(true);
    try {
      await api.sftpWriteText(info.connId, info.path, crlf ? content.replace(/\n/g, "\r\n") : content);
      setSaved(content);
      setStatus({ kind: "ok", text: `Gespeichert ${new Date().toLocaleTimeString("de-DE")}` });
      const payload: FileSavedPayload = { connId: info.connId, path: info.path };
      emitTo("main", FILE_SAVED_EVENT, payload).catch(() => {});
      return true;
    } catch (e) {
      setStatus({
        kind: "err",
        text: isDenied(e)
          ? `${errText(e)} – root-Modus im Hauptfenster einschalten und erneut speichern`
          : errText(e),
      });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const close = async (force = false) => {
    if (!force && dirtyRef.current) {
      setClosing(true);
      return;
    }
    forgetEditor(label);
    await getCurrentWindow().destroy();
  };

  const reload = async () => {
    if (dirty && !(await ask("Ungespeicherte Änderungen verwerfen und neu laden?", { title: name, kind: "warning" }))) return;
    await load();
  };

  const updateCursor = () => {
    const t = text.current;
    if (!t) return;
    const before = t.value.slice(0, t.selectionStart);
    const line = before.split("\n").length;
    setCursor({ line, col: t.selectionStart - before.lastIndexOf("\n") });
  };

  const findNext = (back = false) => {
    const t = text.current;
    const q = find;
    if (!t || !q) return;
    const hay = t.value.toLowerCase();
    const needle = q.toLowerCase();
    let at = back ? hay.lastIndexOf(needle, t.selectionStart - 1) : hay.indexOf(needle, t.selectionEnd);
    if (at < 0) at = back ? hay.lastIndexOf(needle) : hay.indexOf(needle); // von vorn/hinten weitersuchen
    if (at < 0) {
      setStatus({ kind: "info", text: `„${q}“ nicht gefunden` });
      return;
    }
    t.focus();
    t.setSelectionRange(at, at + q.length);
    // markierte Stelle in den sichtbaren Bereich holen
    const line = t.value.slice(0, at).split("\n").length;
    const lh = parseFloat(getComputedStyle(t).lineHeight) || 18;
    t.scrollTop = Math.max(0, (line - 5) * lh);
    updateCursor();
    setStatus(null);
  };

  const lines = useMemo(() => {
    if (content === null) return 1;
    let n = 1;
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
    return n;
  }, [content]);
  const numbers = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1).join("\n"), [lines]);

  const font = settings
    ? { fontFamily: `"${settings.fontFamily}", var(--mono)`, fontSize: Math.max(11, settings.fontSize - 1) }
    : undefined;

  if (!info) {
    return (
      <div className="edwin">
        <div className="empty">Diese Datei ist nicht mehr geöffnet.</div>
      </div>
    );
  }

  return (
    <div className="edwin">
      <div className="popout-bar" style={{ ["--tab-color" as string]: info.color || undefined }}>
        <span className="tab-stripe" />
        {info.root && <span className="root-chip">root</span>}
        <span className="ellipsis mono" style={{ fontWeight: 500 }} title={info.path}>
          {info.path}
          {dirty && <span className="warn"> ●</span>}
        </span>
        <span className="session-meta">{info.host}</span>
        <button className="btn sm ghost" title="Suchen (Strg+F)" onClick={() => setFind(find === null ? "" : null)}>
          <Search size={13} />
        </button>
        <button className="btn sm ghost" title="Vom Server neu laden" onClick={reload}>
          <RotateCw size={13} /> Neu laden
        </button>
        <button className="btn sm primary" disabled={!dirty || saving} onClick={save} title="Speichern (Strg+S)">
          <Save size={13} /> {saving ? "Speichert…" : "Speichern"}
        </button>
      </div>

      {find !== null && (
        <div className="edwin-find">
          <Search size={13} className="dim" />
          <input
            ref={findInput}
            className="input"
            autoFocus
            placeholder="Suchen – Enter weiter, Shift+Enter zurück"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                findNext(e.shiftKey);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setFind(null);
                text.current?.focus();
              }
            }}
          />
          <button className="btn sm icon ghost" onClick={() => setFind(null)}>
            <X size={13} />
          </button>
        </div>
      )}

      {content === null ? (
        <div className="empty">
          {loadError ? (
            <>
              <div className="err selectable" style={{ maxWidth: 560 }}>
                {loadError}
              </div>
              <button className="btn" onClick={load}>
                <RotateCw size={13} /> Neu laden
              </button>
            </>
          ) : (
            <span className="dim">Lade {name}…</span>
          )}
        </div>
      ) : (
        <div className="edwin-body" style={font}>
          <pre className="edwin-gutter" ref={gutter} aria-hidden>
            {numbers}
          </pre>
          <textarea
            ref={text}
            className="edwin-text"
            spellCheck={false}
            autoFocus
            wrap="off"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onScroll={(e) => {
              if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onSelect={updateCursor}
            onKeyUp={updateCursor}
            onClick={updateCursor}
            onKeyDown={(e) => {
              const mod = e.ctrlKey || e.metaKey;
              if (mod && e.key.toLowerCase() === "s") {
                e.preventDefault();
                if (dirty) save();
                return;
              }
              if (mod && e.key.toLowerCase() === "f") {
                e.preventDefault();
                const sel = e.currentTarget.value.slice(e.currentTarget.selectionStart, e.currentTarget.selectionEnd);
                setFind(sel && !sel.includes("\n") ? sel : (find ?? ""));
                requestAnimationFrame(() => findInput.current?.select());
                return;
              }
              if (e.key === "F3") {
                e.preventDefault();
                findNext(e.shiftKey);
                return;
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
        </div>
      )}

      <div className="edwin-status">
        <span>
          Zeile {cursor.line}, Spalte {cursor.col}
        </span>
        <span>{lines} Zeilen</span>
        {content !== null && <span>{bytes(new Blob([content]).size)}</span>}
        <span>{crlf ? "CRLF" : "LF"}</span>
        <span>UTF-8</span>
        {status && <span className={status.kind === "err" ? "err" : status.kind === "ok" ? "ok" : ""}>{status.text}</span>}
        <span style={{ marginLeft: "auto" }}>Strg+S speichern · Strg+F suchen</span>
      </div>

      {closing && (
        <div className="edwin-confirm">
          <div className="edwin-confirm-box">
            <div style={{ fontWeight: 600 }}>Ungespeicherte Änderungen</div>
            <div className="muted">{name} wurde geändert. Vor dem Schließen speichern?</div>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setClosing(false)}>
                Abbrechen
              </button>
              <button className="btn" onClick={() => close(true)}>
                Verwerfen
              </button>
              <button
                className="btn primary"
                disabled={saving}
                onClick={async () => {
                  if (await save()) await close(true);
                  else setClosing(false);
                }}
              >
                Speichern & schließen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
