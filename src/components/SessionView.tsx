import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  Activity,
  ArrowRightLeft,
  Columns2,
  ExternalLink,
  FolderTree,
  Gamepad2,
  Radio,
  KeyRound,
  PanelsLeftRight,
  Plus,
  RotateCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  SquareTerminal,
  Users as UsersIcon,
  WifiOff,
  X,
} from "lucide-react";
import { popOutShell } from "../lib/popout";
import { setRootMode, useStore, type Session } from "../lib/store";
import type { Tool } from "../lib/types";
import { Access } from "./Access";
import { Consoles } from "./Consoles";
import { FileBrowser } from "./FileBrowser";
import { Monitor, StatusBar } from "./Monitor";
import { Security } from "./Security";
import { Services } from "./Services";
import { TerminalPane } from "./TerminalPane";
import { Tunnels } from "./Tunnels";
import { Users } from "./Users";

export const TOOLS: { id: Tool; label: string; icon: typeof Activity; key: string }[] = [
  { id: "terminal", label: "Terminal", icon: SquareTerminal, key: "1" },
  { id: "files", label: "Dateien", icon: FolderTree, key: "2" },
  { id: "monitor", label: "Monitor", icon: Activity, key: "3" },
  { id: "services", label: "Dienste", icon: Server, key: "4" },
  { id: "consoles", label: "Konsolen", icon: Gamepad2, key: "8" },
  { id: "tunnels", label: "Tunnel", icon: ArrowRightLeft, key: "5" },
  { id: "users", label: "Benutzer", icon: UsersIcon, key: "6" },
  { id: "access", label: "SSH-Keys", icon: KeyRound, key: "7" },
  { id: "security", label: "Sicherheit", icon: ShieldCheck, key: "9" },
];

/** Ab dieser Mausbewegung gilt ein Klick auf einen Shell-Tab als Ziehen */
const DRAG_THRESHOLD = 6;

const isOutside = (e: { clientX: number; clientY: number }) =>
  e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight;

export function SessionView({ session, visible }: { session: Session; visible: boolean }) {
  const settings = useStore((s) => s.vault?.settings);
  const broadcast = useStore((s) => s.broadcast);
  const { setTool, addTerminal, closeTerminal, reconnect, toggleSplit, focusTerminal, updateSession } = useStore.getState();
  const [mounted, setMounted] = useState<Set<Tool>>(new Set(["terminal"]));
  const [titles, setTitles] = useState<Record<string, string>>({});
  /** Breite der Dateiansicht in der geteilten Ansicht (Prozent) */
  const [duoRatio, setDuoRatio] = useState(42);
  const panesRef = useRef<HTMLDivElement>(null);
  /** Shell-Tab, der gerade gezogen wird (zum Herauslösen in ein eigenes Fenster) */
  const [dragging, setDragging] = useState<{ key: string; outside: boolean } | null>(null);
  const drag = useRef<{ key: string; x: number; y: number; moved: boolean } | null>(null);
  /** Werkzeug vor dem Öffnen der Monitor-Details aus der Statusleiste */
  const beforeMonitor = useRef<Tool>("terminal");

  const duoActive = session.duo && (session.tool === "terminal" || session.tool === "files");

  useEffect(() => {
    setMounted((m) => {
      const want: Tool[] = session.duo ? [session.tool, "files"] : [session.tool];
      return want.every((t) => m.has(t)) ? m : new Set([...m, ...want]);
    });
  }, [session.tool, session.duo]);

  if (!settings) return null;
  const closed = session.status === "closed";
  const monitorBottom = settings.monitorPlacement === "bottom";
  const tools = monitorBottom ? TOOLS.filter((t) => t.id !== "monitor") : TOOLS;
  const show = (t: Tool) => visible && (session.tool === t || (duoActive && (t === "terminal" || t === "files")));

  /** Fokus wechselt zwischen Dateien und Terminal, ohne die Zurück-Historie zu füllen */
  const follow = (t: Tool) => {
    if (duoActive && session.tool !== t) updateSession(session.id, { tool: t });
  };

  const toggleDuo = () => {
    const duo = !session.duo;
    updateSession(session.id, { duo, tool: duo && session.tool !== "files" ? "terminal" : session.tool });
  };

  const startSplitDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = panesRef.current?.getBoundingClientRect();
      if (!r || r.width === 0) return;
      setDuoRatio(Math.min(80, Math.max(18, ((ev.clientX - r.left) / r.width) * 100)));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // ------------------------------------------------ Shell-Tabs aus dem Fenster ziehen

  const tabDown = (e: ReactPointerEvent<HTMLDivElement>, key: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    drag.current = { key, x: e.clientX, y: e.clientY, moved: false };
    // Capture: Bewegungen kommen auch außerhalb des Fensters an
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const tabMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD) return;
    d.moved = true;
    const outside = isOutside(e);
    setDragging((cur) => (cur?.key === d.key && cur.outside === outside ? cur : { key: d.key, outside }));
  };
  const tabUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    if (!d?.moved || !isOutside(e)) return;
    const t = session.terminals.find((x) => x.key === d.key);
    if (t) void popOutShell(session.id, t.key, titles[t.key] || t.title, { x: e.screenX - 80, y: e.screenY - 18 });
  };

  const popActive = () => {
    const t = session.terminals.find((x) => x.key === session.activeTerm);
    if (t) void popOutShell(session.id, t.key, titles[t.key] || t.title);
  };

  const toggleMonitorDetails = () => {
    if (session.tool === "monitor") setTool(session.id, beforeMonitor.current);
    else {
      beforeMonitor.current = session.tool;
      setTool(session.id, "monitor");
    }
  };

  return (
    <div className="session" style={{ display: visible ? "flex" : "none" }}>
      <div className="toolbar">
        <div className="tools">
          {tools.map((t) => (
            <button
              key={t.id}
              className={`tool ${session.tool === t.id || (duoActive && (t.id === "terminal" || t.id === "files")) ? "on" : ""}`}
              onClick={() => setTool(session.id, t.id)}
              title={`${t.label} (Strg+${t.key}, im Terminal Strg+Shift+${t.key})`}
            >
              <t.icon size={15} />
              {t.label}
            </button>
          ))}
        </div>
        <button
          className={`btn sm ghost ${session.duo ? "on" : ""}`}
          style={{ marginLeft: "auto" }}
          title="Dateien und Terminal nebeneinander anzeigen"
          disabled={closed}
          onClick={toggleDuo}
        >
          <PanelsLeftRight size={13} /> Dateien | Terminal
        </button>
        {/* Wer schon als root angemeldet ist, braucht keinen root-Modus */}
        {!session.isRoot && (
          <button
            className={`btn sm ghost root-toggle ${session.root ? "root-on" : ""}`}
            style={{ marginLeft: 0 }}
            disabled={closed}
            title={
              session.root
                ? "root-Modus beenden"
                : "root-Modus: neue Shells, Dateien, Dienste und Konsolen mit sudo als root"
            }
            onClick={async () => {
              const on = !session.root;
              if ((await setRootMode(session.id, on)) && on && session.tool === "terminal") addTerminal(session.id);
            }}
          >
            <ShieldAlert size={13} /> root
          </button>
        )}
        <span className="session-meta" style={{ marginLeft: 0 }}>
          {session.isRoot ? session.host : `${session.username}@${session.host}`}
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

      <div className={`panes ${duoActive && visible ? "duo" : ""}`} ref={panesRef}>
        {/* Terminal */}
        <div
          className={`pane ${show("terminal") ? "" : "hidden"}`}
          style={{ order: 3 }}
          onPointerDownCapture={() => follow("terminal")}
        >
          {broadcast && (
            <div className="broadcast-bar">
              <Radio size={13} />
              <span className="grow">Broadcast – Eingabe geht an alle offenen Shells</span>
              <button className="btn sm" onClick={() => useStore.setState({ broadcast: false })}>
                Beenden
              </button>
            </div>
          )}
          <div className="term-tabs">
            {session.terminals.map((t) => (
              <div
                key={t.key}
                className={`term-tab ${session.activeTerm === t.key ? "on" : session.splitTerm === t.key ? "split" : ""} ${
                  dragging?.key === t.key ? (dragging.outside ? "dragging out" : "dragging") : ""
                }`}
                title="Aus dem Fenster ziehen, um die Shell in einem eigenen Fenster zu öffnen"
                onClick={() => focusTerminal(session.id, t.key)}
                onAuxClick={(e) => e.button === 1 && closeTerminal(session.id, t.key)}
                onPointerDown={(e) => tabDown(e, t.key)}
                onPointerMove={tabMove}
                onPointerUp={tabUp}
                onPointerCancel={() => {
                  drag.current = null;
                  setDragging(null);
                }}
              >
                {t.root && <span className="root-chip">root</span>}
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
            <span className="spacer" />
            {dragging?.outside && <span className="drag-hint">Loslassen öffnet ein eigenes Fenster</span>}
            <button
              className="btn sm ghost"
              title="Aktive Shell in einem eigenen Fenster öffnen (oder Tab aus dem Fenster ziehen)"
              disabled={closed || !session.activeTerm}
              onClick={popActive}
            >
              <ExternalLink size={13} /> Fenster
            </button>
            <button
              className={`btn sm ghost ${session.splitTerm ? "on" : ""}`}
              title="Zwei Shells nebeneinander"
              disabled={closed}
              onClick={() => toggleSplit(session.id)}
            >
              <Columns2 size={13} /> Teilen
            </button>
            <button
              className={`btn sm ghost ${broadcast ? "on" : ""}`}
              title="In allen offenen Shells gleichzeitig tippen (Strg+Shift+B)"
              onClick={() => useStore.setState({ broadcast: !broadcast })}
            >
              <Radio size={13} /> Broadcast
            </button>
          </div>
          {session.terminals.length === 0 && (
            <div className="empty">
              <button className="btn" disabled={closed} onClick={() => addTerminal(session.id)}>
                <Plus size={14} /> Neue Shell öffnen
              </button>
            </div>
          )}
          <div className="term-split" style={session.terminals.length === 0 ? { display: "none" } : undefined}>
            {!closed &&
              session.terminals.map((t) => (
                <TerminalPane
                  key={t.key}
                  connId={session.id}
                  tab={t}
                  settings={settings}
                  visible={show("terminal") && (session.activeTerm === t.key || session.splitTerm === t.key)}
                  focused={visible && session.tool === "terminal" && session.activeTerm === t.key}
                  onFocus={() => {
                    follow("terminal");
                    focusTerminal(session.id, t.key);
                  }}
                  onTitle={(title) => setTitles((x) => ({ ...x, [t.key]: title }))}
                />
              ))}
          </div>
        </div>

        {!closed && (
          <>
            {mounted.has("files") && (
              <div
                className={`pane ${show("files") ? "" : "hidden"}`}
                style={duoActive ? { order: 1, flex: `0 0 ${duoRatio}%` } : { order: 1 }}
                onPointerDownCapture={() => follow("files")}
              >
                <FileBrowser sessionId={session.id} connId={session.id} visible={show("files")} />
              </div>
            )}
            {duoActive && visible && (
              <div className="duo-splitter" style={{ order: 2 }} onPointerDown={startSplitDrag} title="Breite anpassen" />
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
            {mounted.has("consoles") && (
              <div className={`pane ${show("consoles") ? "" : "hidden"}`}>
                <Consoles sessionId={session.id} connId={session.id} visible={show("consoles")} />
              </div>
            )}
            {mounted.has("tunnels") && (
              <div className={`pane ${show("tunnels") ? "" : "hidden"}`}>
                <Tunnels connId={session.id} hostId={session.hostId} visible={show("tunnels")} />
              </div>
            )}
            {mounted.has("users") && (
              <div className={`pane ${show("users") ? "" : "hidden"}`}>
                <Users sessionId={session.id} connId={session.id} visible={show("users")} />
              </div>
            )}
            {mounted.has("access") && (
              <div className={`pane ${show("access") ? "" : "hidden"}`}>
                <Access connId={session.id} username={session.username} visible={show("access")} />
              </div>
            )}
            {mounted.has("security") && (
              <div className={`pane ${show("security") ? "" : "hidden"}`}>
                <Security
                  sessionId={session.id}
                  connId={session.id}
                  hostId={session.hostId}
                  username={session.username}
                  visible={show("security")}
                />
              </div>
            )}
          </>
        )}
      </div>

      {monitorBottom && !closed && (
        <StatusBar connId={session.id} active={visible} open={session.tool === "monitor"} onToggle={toggleMonitorDetails} />
      )}
    </div>
  );
}
