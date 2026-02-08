import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { api, errText } from "../lib/api";
import { b64ToBytes } from "../lib/format";
import { useStore, type TermTab } from "../lib/store";
import type { Settings, TermEvent } from "../lib/types";

const THEME = {
  background: "#0b0d10",
  foreground: "#d9dde3",
  cursor: "#e8a33d",
  cursorAccent: "#0b0d10",
  selectionBackground: "rgba(232,163,61,0.28)",
  black: "#1b1f24",
  red: "#e06c62",
  green: "#7cbf8e",
  yellow: "#d9b44a",
  blue: "#6aa6d8",
  magenta: "#c08ad6",
  cyan: "#5fb8b3",
  white: "#c9ced6",
  brightBlack: "#5d656f",
  brightRed: "#f08a80",
  brightGreen: "#9ad6a9",
  brightYellow: "#ecc865",
  brightBlue: "#8cbde6",
  brightMagenta: "#d4a6e6",
  brightCyan: "#7fd0cb",
  brightWhite: "#f2f4f7",
};

/** termKey -> Funktion zum Schreiben in die Shell (für Snippets & Palette) */
const writers = new Map<string, (text: string) => void>();

export function sendToActiveTerminal(text: string): boolean {
  const { sessions, active } = useStore.getState();
  const s = sessions.find((x) => x.id === active);
  if (!s || !s.activeTerm || s.status !== "connected") return false;
  const w = writers.get(s.activeTerm);
  if (!w) return false;
  useStore.getState().setTool(s.id, "terminal");
  w(text);
  return true;
}

export function TerminalPane({
  connId,
  tab,
  visible,
  settings,
  onTitle,
}: {
  connId: string;
  tab: TermTab;
  visible: boolean;
  settings: Settings;
  onTitle: (title: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const termIdRef = useRef<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const onTitleRef = useRef(onTitle);
  onTitleRef.current = onTitle;

  useEffect(() => {
    const term = new Terminal({
      fontFamily: `"${settings.fontFamily}", "JetBrains Mono", monospace`,
      fontSize: settings.fontSize,
      cursorBlink: settings.cursorBlink,
      scrollback: settings.scrollback,
      theme: THEME,
      allowProposedApi: true,
      macOptionIsMeta: true,
      lineHeight: 1.15,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(hostRef.current!);
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;
    try {
      fit.fit();
    } catch {
      /* noch nicht sichtbar */
    }

    let disposed = false;
    const pending: string[] = [];
    const send = (data: string) => {
      const id = termIdRef.current;
      if (!id) {
        pending.push(data);
        return;
      }
      api.termWrite(connId, id, data).catch(() => {});
    };
    writers.set(tab.key, (text) => {
      send(text);
      term.focus();
    });

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel);
        return false;
      }
      if (mod && e.shiftKey && e.code === "KeyV") {
        navigator.clipboard.readText().then((t) => t && send(t));
        return false;
      }
      if (mod && e.shiftKey && e.code === "KeyF") {
        setSearchOpen(true);
        return false;
      }
      return true;
    });

    term.onData(send);
    term.onTitleChange((t) => onTitleRef.current(t));
    term.onSelectionChange(() => {
      if (settings.copyOnSelect) {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
      }
    });

    const channel = new Channel<TermEvent>();
    channel.onmessage = (ev) => {
      if (ev.kind === "data") term.write(b64ToBytes(ev.data));
      else term.write(`\r\n\x1b[2m[Shell beendet${ev.code != null ? ` – Exit ${ev.code}` : ""}]\x1b[0m\r\n`);
    };

    api
      .termOpen(connId, term.cols, term.rows, channel)
      .then((id) => {
        if (disposed) {
          api.termClose(connId, id);
          return;
        }
        termIdRef.current = id;
        pending.splice(0).forEach(send);
        if (tab.startup) send(tab.startup + "\r");
      })
      .catch((e) => term.write(`\x1b[31mTerminal konnte nicht geöffnet werden: ${errText(e)}\x1b[0m\r\n`));

    const ro = new ResizeObserver(() => {
      if (!hostRef.current?.offsetParent) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const id = termIdRef.current;
      if (id) api.termResize(connId, id, term.cols, term.rows).catch(() => {});
    });
    ro.observe(hostRef.current!);

    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel);
        term.clearSelection();
      } else {
        navigator.clipboard.readText().then((t) => t && send(t));
      }
    };
    hostRef.current!.addEventListener("contextmenu", onContext);

    return () => {
      disposed = true;
      ro.disconnect();
      writers.delete(tab.key);
      if (termIdRef.current) api.termClose(connId, termIdRef.current);
      term.dispose();
    };
    // Terminal wird nur einmal pro Tab erzeugt
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, tab.key]);

  // Einstellungen live übernehmen
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.options.fontSize = settings.fontSize;
    t.options.fontFamily = `"${settings.fontFamily}", "JetBrains Mono", monospace`;
    t.options.cursorBlink = settings.cursorBlink;
    t.options.scrollback = settings.scrollback;
    try {
      fitRef.current?.fit();
    } catch {
      /* ignore */
    }
  }, [settings]);

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      termRef.current?.focus();
    }, 20);
    return () => clearTimeout(t);
  }, [visible]);

  const find = (dir: 1 | -1) => {
    if (!query) return;
    if (dir === 1) searchRef.current?.findNext(query);
    else searchRef.current?.findPrevious(query);
  };

  return (
    <div className="term-wrap" style={{ display: visible ? "block" : "none" }}>
      {searchOpen && (
        <div className="term-search">
          <input
            autoFocus
            className="input mono"
            placeholder="Suchen…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") find(e.shiftKey ? -1 : 1);
              if (e.key === "Escape") {
                setSearchOpen(false);
                termRef.current?.focus();
              }
            }}
          />
          <button className="btn sm icon ghost" onClick={() => find(-1)} title="Vorheriger">
            <ArrowUp size={14} />
          </button>
          <button className="btn sm icon ghost" onClick={() => find(1)} title="Nächster">
            <ArrowDown size={14} />
          </button>
          <button
            className="btn sm icon ghost"
            onClick={() => {
              setSearchOpen(false);
              termRef.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div ref={hostRef} className="term-host" />
    </div>
  );
}
