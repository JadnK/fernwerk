import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRightLeft,
  FolderTree,
  Plus,
  RotateCw,
  Server,
  SquareTerminal,
  WifiOff,
  X,
} from "lucide-react";
import { useStore, type Session } from "../lib/store";
import type { Tool } from "../lib/types";
import { FileBrowser } from "./FileBrowser";
import { Monitor } from "./Monitor";
import { Services } from "./Services";
import { TerminalPane } from "./TerminalPane";
import { Tunnels } from "./Tunnels";

export const TOOLS: { id: Tool; label: string; icon: typeof Activity; key: string }[] = [
  { id: "terminal", label: "Terminal", icon: SquareTerminal, key: "1" },
  { id: "files", label: "Dateien", icon: FolderTree, key: "2" },
  { id: "monitor", label: "Monitor", icon: Activity, key: "3" },
  { id: "services", label: "Dienste", icon: Server, key: "4" },
  { id: "tunnels", label: "Tunnel", icon: ArrowRightLeft, key: "5" },
];

export function SessionView({ session, visible }: { session: Session; visible: boolean }) {
  const settings = useStore((s) => s.vault?.settings);
  const { setTool, addTerminal, closeTerminal, updateSession, reconnect } = useStore.getState();
  const [mounted, setMounted] = useState<Set<Tool>>(new Set(["terminal"]));
  const [titles, setTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    setMounted((m) => (m.has(session.tool) ? m : new Set(m).add(session.tool)));
  }, [session.tool]);

  if (!settings) return null;
  const closed = session.status === "closed";
  const show = (t: Tool) => visible && session.tool === t;

  return (
    <div className="session" style={{ display: visible ? "flex" : "none" }}>
      <div className="toolbar">
        <div className="tools">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={`tool ${session.tool === t.id ? "on" : ""}`}
              onClick={() => setTool(session.id, t.id)}
              title={`${t.label} (Strg+${t.key})`}
            >
              <t.icon size={15} />
              {t.label}
            </button>
          ))}
        </div>
        <span className="session-meta">
          {session.username}@{session.host}
        </span>
      </div>

      {closed && (
        <div className="closed-banner">
          <WifiOff size={15} />
          <span className="grow">Verbindung getrennt.</span>
          <button className="btn sm" onClick={() => reconnect(session.id)}>
            <RotateCw size={13} /> Neu verbinden
          </button>
        </div>
      )}

      {/* Terminal */}
      <div className={`pane ${show("terminal") ? "" : "hidden"}`}>
        <div className="term-tabs">
          {session.terminals.map((t) => (
            <div
              key={t.key}
              className={`term-tab ${session.activeTerm === t.key ? "on" : ""}`}
              onClick={() => updateSession(session.id, { activeTerm: t.key })}
              onAuxClick={(e) => e.button === 1 && closeTerminal(session.id, t.key)}
            >
              <span className="ellipsis">{titles[t.key] || t.title}</span>
              <button
                className="btn sm icon ghost"
                style={{ width: 18, height: 18 }}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(session.id, t.key);
                }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <button
            className="btn sm icon ghost"
            title="Neue Shell (Strg+Shift+T)"
            disabled={closed}
            onClick={() => addTerminal(session.id)}
          >
            <Plus size={14} />
          </button>
        </div>
        {session.terminals.length === 0 && (
          <div className="empty">
            <button className="btn" disabled={closed} onClick={() => addTerminal(session.id)}>
              <Plus size={14} /> Neue Shell öffnen
            </button>
          </div>
        )}
        {!closed &&
          session.terminals.map((t) => (
            <TerminalPane
              key={t.key}
              connId={session.id}
              tab={t}
              settings={settings}
              visible={show("terminal") && session.activeTerm === t.key}
              onTitle={(title) => setTitles((x) => ({ ...x, [t.key]: title }))}
            />
          ))}
      </div>

      {!closed && (
        <>
          {mounted.has("files") && (
            <div className={`pane ${show("files") ? "" : "hidden"}`}>
              <FileBrowser connId={session.id} visible={show("files")} />
            </div>
          )}
          {mounted.has("monitor") && (
            <div className={`pane ${show("monitor") ? "" : "hidden"}`}>
              <Monitor sessionId={session.id} connId={session.id} visible={show("monitor")} />
            </div>
          )}
          {mounted.has("services") && (
            <div className={`pane ${show("services") ? "" : "hidden"}`}>
              <Services sessionId={session.id} connId={session.id} visible={show("services")} />
            </div>
          )}
          {mounted.has("tunnels") && (
            <div className={`pane ${show("tunnels") ? "" : "hidden"}`}>
              <Tunnels connId={session.id} hostId={session.hostId} visible={show("tunnels")} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
