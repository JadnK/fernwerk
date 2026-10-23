import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, KeyRound, LayoutGrid, Loader2, Pencil, Play, Plus, Search, Settings, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { fuzzy } from "../lib/format";
import { ask, confirm, run, toast, useStore } from "../lib/store";
import type { HostProfile, Snippet } from "../lib/types";
import { sendToActiveTerminal } from "./TerminalPane";

export function Sidebar() {
  const vault = useStore((s) => s.vault);
  const sessions = useStore((s) => s.sessions);
  const active = useStore((s) => s.active);
  const view = useStore((s) => s.view);
  const connecting = useStore((s) => s.connecting);
  const { connectHost, setActive, setView, reloadVault } = useStore.getState();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const grouped = useMemo(() => {
    const hosts = (vault?.hosts ?? []).filter(
      (h) => !query || fuzzy(`${h.name} ${h.host} ${h.username} ${h.group} ${h.tags.join(" ")}`, query),
    );
    const map = new Map<string, HostProfile[]>();
    for (const h of [...hosts].sort((a, b) => a.name.localeCompare(b.name))) {
      const g = h.group || "Hosts";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(h);
    }
    return [...map.entries()].sort(([a], [b]) => (a === "Hosts" ? -1 : b === "Hosts" ? 1 : a.localeCompare(b)));
  }, [vault, query]);

  const openHost = (h: HostProfile) => {
    const existing = sessions.find((s) => s.hostId === h.id && s.status === "connected");
    if (existing) setActive(existing.id);
    else connectHost(h.id);
  };

  const editSnippet = async (s?: Snippet) => {
    const r = await ask({
      title: s ? "Snippet bearbeiten" : "Neues Snippet",
      fields: [
        { name: "name", label: "Name", value: s?.name ?? "" },
        { name: "command", label: "Befehl", type: "textarea", value: s?.command ?? "", placeholder: "docker ps --format 'table {{.Names}}\\t{{.Status}}'" },
      ],
      confirm: "Speichern",
    });
    if (!r || !String(r.command).trim()) return;
    await run(async () => {
      await api.snippetSave({ id: s?.id ?? "", name: String(r.name).trim() || String(r.command).slice(0, 30), command: String(r.command) });
      await reloadVault();
    });
  };

  const deleteSnippet = async (s: Snippet) => {
    if (!(await confirm("Snippet löschen", `„${s.name}“ löschen?`, "Löschen", true))) return;
    await run(async () => {
      await api.snippetDelete(s.id);
      await reloadVault();
    });
  };

  const runSnippet = (s: Snippet) => {
    if (!sendToActiveTerminal(s.command.replace(/\n/g, "\r") + "\r")) toast("info", "Öffne zuerst eine Sitzung");
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">&gt;_</div>
        Fernwerk
      </div>

      <div className="search">
        <Search size={14} />
        <input placeholder="Hosts filtern" value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="kbd" title="Befehlspalette – im Terminal Strg+Shift+K">Strg K</span>
      </div>

      <div className="side-scroll">
        {grouped.map(([group, hosts]) => (
          <div key={group}>
            <div className="side-section" onClick={() => setCollapsed((c) => ({ ...c, [group]: !c[group] }))} style={{ cursor: "pointer" }}>
              <span className="row" style={{ gap: 4 }}>
                {collapsed[group] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                {group}
              </span>
              <span>{hosts.length}</span>
            </div>
            {!collapsed[group] &&
              hosts.map((h) => {
                const live = sessions.find((s) => s.hostId === h.id && s.status === "connected");
                const isActive = live && live.id === active;
                return (
                  <div
                    key={h.id}
                    className={`host-item ${isActive ? "active" : ""}`}
                    onDoubleClick={() => openHost(h)}
                    onClick={() => live && setActive(live.id)}
                    title="Doppelklick zum Verbinden"
                  >
                    <span
                      className={`host-dot ${live ? "live" : ""}`}
                      style={!live && h.color ? { background: h.color } : undefined}
                    />
                    <div className="grow">
                      <div className="host-name ellipsis">{h.name}</div>
                      <div className="host-sub ellipsis">
                        {h.username}@{h.host}
                        {h.port !== 22 ? `:${h.port}` : ""}
                      </div>
                    </div>
                    {connecting[h.id] ? (
                      <Loader2 size={14} className="spin muted" />
                    ) : (
                      <div className="actions">
                        <button className="btn sm icon ghost" title="Verbinden" onClick={(e) => (e.stopPropagation(), openHost(h))}>
                          <Play size={12} />
                        </button>
                        <button
                          className="btn sm icon ghost"
                          title="Bearbeiten"
                          onClick={(e) => (e.stopPropagation(), useStore.setState({ editingHost: h }))}
                        >
                          <Pencil size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        ))}

        {vault && vault.hosts.length === 0 && <div className="dim" style={{ padding: "8px 10px" }}>Noch keine Hosts angelegt.</div>}

        <button className="btn ghost sm" style={{ margin: "6px 4px", width: "calc(100% - 8px)", justifyContent: "flex-start" }} onClick={() => useStore.setState({ editingHost: "new" })}>
          <Plus size={13} /> Host hinzufügen
        </button>

        <div className="side-section">
          <span>Snippets</span>
          <button className="btn sm icon ghost" title="Neues Snippet" onClick={() => editSnippet()}>
            <Plus size={13} />
          </button>
        </div>
        {(vault?.snippets ?? []).map((s) => (
          <div key={s.id} className="snippet-item" title={s.command}>
            <button className="btn sm icon ghost" title="Im aktiven Terminal ausführen" onClick={() => runSnippet(s)}>
              <Play size={11} />
            </button>
            <span className="grow ellipsis" onDoubleClick={() => runSnippet(s)}>
              {s.name}
            </span>
            <div className="actions">
              <button className="btn sm icon ghost" onClick={() => editSnippet(s)}>
                <Pencil size={11} />
              </button>
              <button className="btn sm icon ghost" onClick={() => deleteSnippet(s)}>
                <Trash2 size={11} />
              </button>
            </div>
          </div>
        ))}
        {vault && vault.snippets.length === 0 && (
          <div className="dim" style={{ padding: "4px 10px", fontSize: 12 }}>
            Häufige Befehle speichern und mit einem Klick ins Terminal schicken.
          </div>
        )}
      </div>

      <div className="side-foot">
        <button className={`btn ghost sm wide ${active === null && view === "hosts" ? "on" : ""}`} onClick={() => setView("hosts")}>
          <LayoutGrid size={13} /> Übersicht
        </button>
        <button className="btn ghost sm wide" onClick={() => setView("keys")}>
          <KeyRound size={13} /> Schlüssel
        </button>
        <button className="btn ghost sm icon" title="Einstellungen" onClick={() => setView("settings")}>
          <Settings size={14} />
        </button>
      </div>
    </aside>
  );
}
