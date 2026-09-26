import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Code2, KeyRound, LayoutGrid, Plus, Server, Settings } from "lucide-react";
import { fuzzy } from "../lib/format";
import { toast, useStore } from "../lib/store";
import { TOOLS } from "./SessionView";
import { sendToActiveTerminal } from "./TerminalPane";

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const vault = useStore((s) => s.vault);
  const sessions = useStore((s) => s.sessions);
  const active = useStore((s) => s.active);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);

  const close = () => useStore.setState({ paletteOpen: false });

  const items = useMemo<Item[]>(() => {
    if (!vault) return [];
    const st = useStore.getState();
    const list: Item[] = [];
    for (const h of vault.hosts) {
      const live = sessions.find((s) => s.hostId === h.id && s.status === "connected");
      list.push({
        id: "h" + h.id,
        label: h.name,
        hint: live ? "wechseln" : `${h.username}@${h.host}`,
        icon: <Server size={14} className={live ? "ok" : "muted"} />,
        run: () => (live ? st.setActive(live.id) : st.connectHost(h.id)),
      });
    }
    if (active) {
      for (const t of TOOLS) {
        list.push({
          id: "t" + t.id,
          label: `Gehe zu: ${t.label}`,
          hint: `Strg+${t.key}`,
          icon: <t.icon size={14} className="muted" />,
          run: () => st.setTool(active, t.id),
        });
      }
    }
    for (const s of vault.snippets) {
      list.push({
        id: "s" + s.id,
        label: `Snippet: ${s.name}`,
        hint: s.command.split("\n")[0].slice(0, 40),
        icon: <Code2 size={14} className="muted" />,
        run: () => {
          if (!sendToActiveTerminal(s.command.replace(/\n/g, "\r") + "\r")) toast("info", "Keine aktive Shell");
        },
      });
    }
    list.push(
      { id: "new", label: "Neuen Host anlegen", icon: <Plus size={14} className="muted" />, run: () => useStore.setState({ editingHost: "new" }) },
      { id: "home", label: "Übersicht", icon: <LayoutGrid size={14} className="muted" />, run: () => st.setView("hosts") },
      { id: "keys", label: "Schlüssel verwalten", icon: <KeyRound size={14} className="muted" />, run: () => st.setView("keys") },
      { id: "settings", label: "Einstellungen", icon: <Settings size={14} className="muted" />, run: () => st.setView("settings") },
    );
    return list;
  }, [vault, sessions, active]);

  const filtered = useMemo(() => items.filter((i) => !q || fuzzy(`${i.label} ${i.hint ?? ""}`, q)).slice(0, 50), [items, q]);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
    }
  }, [open]);
  useEffect(() => setIdx(0), [q]);

  if (!open) return null;

  const exec = (i: Item | undefined) => {
    if (!i) return;
    close();
    i.run();
  };

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal palette">
        <input
          className="input"
          autoFocus
          placeholder="Host, Werkzeug, Snippet oder Aktion…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(filtered.length - 1, i + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            }
            if (e.key === "Enter") exec(filtered[idx]);
          }}
        />
        <div className="palette-list">
          {filtered.map((i, n) => (
            <div key={i.id} className={`palette-item ${n === idx ? "on" : ""}`} onMouseEnter={() => setIdx(n)} onClick={() => exec(i)}>
              {i.icon}
              <span className="ellipsis">{i.label}</span>
              {i.hint && <span className="hint mono ellipsis">{i.hint}</span>}
            </div>
          ))}
          {filtered.length === 0 && <div className="dim" style={{ padding: 12 }}>Nichts gefunden</div>}
        </div>
      </div>
    </div>
  );
}
