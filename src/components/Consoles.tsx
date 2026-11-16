import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CirclePower, Container, Eraser, ExternalLink, Gamepad2, Play, RefreshCw, RotateCw, SendHorizontal, Square, X } from "lucide-react";
import { api, errText } from "../lib/api";
import { bytes, duration } from "../lib/format";
import { q } from "../lib/shell";
import { confirm, run, toast, useStore } from "../lib/store";
import { Empty } from "./ui";

/*
 * Konsolen: zeigt, was auf dem Server dauerhaft im Hintergrund läuft.
 *
 * Kein Agent: Fernwerk liest tmux-Sitzungen (`tmux list-panes`), screen-Sitzungen (`screen -ls`)
 * und Docker-Container aus. Die Ausgabe kommt per `tmux capture-pane` bzw. `screen -X hardcopy`,
 * Eingaben gehen per `tmux send-keys` bzw. `screen -X stuff` hinein.
 */

interface QuickCmd {
  label: string;
  cmd: string;
  /** nur ins Eingabefeld übernehmen (braucht noch ein Argument) */
  fill?: boolean;
}

const MC_QUICK: QuickCmd[] = [
  { label: "list", cmd: "list" },
  { label: "save-all", cmd: "save-all" },
  { label: "tps", cmd: "tps" },
  { label: "say …", cmd: "say ", fill: true },
  { label: "op …", cmd: "op ", fill: true },
  { label: "kick …", cmd: "kick ", fill: true },
  { label: "whitelist add …", cmd: "whitelist add ", fill: true },
  { label: "time set day", cmd: "time set day" },
  { label: "weather clear", cmd: "weather clear" },
];

/** Erkennt einen Minecraft-Server an seiner Ausgabe. */
const looksLikeMinecraft = (text: string) => /\[Server thread\/INFO\]|Done \([\d.,]+s\)! For help/.test(text);

// ---------------------------------------------------------------- Server-Zugriff

async function sh(connId: string, cmd: string): Promise<string> {
  const r = await api.exec(connId, cmd);
  if (r.code !== 0 && r.code !== null) throw new Error((r.stderr || r.stdout).trim() || `Exit ${r.code}`);
  return r.stdout;
}

type Mux = "tmux" | "screen";

/** Befehle je Multiplexer. `t` ist der tmux-Sitzungsname bzw. „pid.name“ bei screen. */
const MUX: Record<
  Mux,
  {
    capture: (t: string) => string;
    send: (t: string, cmd: string) => string;
    interrupt: (t: string) => string;
    clear: (t: string) => string;
    attach: (t: string) => string;
    kill: (t: string) => string;
    detachHint: string;
  }
> = {
  tmux: {
    capture: (t) => `tmux capture-pane -p -J -S -2000 -t ${q(t)} 2>/dev/null`,
    send: (t, cmd) => `tmux send-keys -t ${q(t)} -l -- ${q(cmd)} && tmux send-keys -t ${q(t)} Enter`,
    interrupt: (t) => `tmux send-keys -t ${q(t)} C-c`,
    clear: (t) => `tmux clear-history -t ${q(t)}`,
    attach: (t) => `tmux attach -t ${q(t)}`,
    kill: (t) => `tmux kill-session -t ${q(t)}`,
    detachHint: "tmux attach – Strg+B, D zum Lösen",
  },
  screen: {
    // hardcopy schreibt die Datei asynchron im screen-Prozess – kurz darauf warten
    capture: (t) =>
      `f=$(mktemp) || exit 1; screen -S ${q(t)} -p 0 -X hardcopy -h "$f" >/dev/null 2>&1; i=0; while [ ! -s "$f" ] && [ $i -lt 10 ]; do sleep 0.1; i=$((i+1)); done; cat "$f"; rm -f "$f"`,
    send: (t, cmd) => `screen -S ${q(t)} -p 0 -X stuff "$(printf '%s\\r' ${q(cmd)})"`,
    interrupt: (t) => `screen -S ${q(t)} -p 0 -X stuff "$(printf '\\003')"`,
    clear: (t) => `screen -S ${q(t)} -p 0 -X clear`,
    attach: (t) => `screen -x ${q(t)}`,
    kill: (t) => `screen -S ${q(t)} -X quit 2>/dev/null; screen -wipe >/dev/null 2>&1; true`,
    detachHint: "screen -x – Strg+A, D zum Lösen",
  },
};

interface PaneInfo {
  name: string;
  dead: boolean;
  /** screen meldet „Dead ???“ – die Sitzung ist ohne sauberes Ende verschwunden */
  crashed?: boolean;
  pid: number;
  exit: number | null;
  created: number;
  attached: number;
  cpu: number;
  rss: number;
}

interface Snapshot {
  now: number;
  tmux: string | null;
  screen: string | null;
  panes: Map<string, PaneInfo>;
  screens: Map<string, PaneInfo>;
}

const STATUS_CMD = [
  `echo "@@now $(date +%s)"`,
  `echo "@@tmux $(command -v tmux 2>/dev/null)"`,
  `tmux list-panes -a -F '#{session_name}\t#{pane_dead}\t#{pane_pid}\t#{pane_dead_status}\t#{session_created}\t#{session_attached}' 2>/dev/null`,
  `echo "@@screen $(command -v screen 2>/dev/null)"`,
  `screen -ls 2>/dev/null`,
  `echo "@@ps"`,
  `ps -eo pid=,ppid=,pcpu=,rss=,etimes= 2>/dev/null || ps -eo pid=,ppid=,pcpu=,rss= 2>/dev/null`,
].join("; ");

function parseSnapshot(out: string): Snapshot {
  let now = Math.floor(Date.now() / 1000);
  let tmux: string | null = null;
  let screen: string | null = null;
  const panes = new Map<string, PaneInfo>();
  const screens = new Map<string, PaneInfo>();
  const children = new Map<number, number[]>();
  const usage = new Map<number, { cpu: number; rss: number; age: number }>();
  let section = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("@@now ")) now = Number(line.slice(6)) || now;
    else if (line.startsWith("@@tmux")) {
      tmux = line.slice(6).trim() || null;
      section = "panes";
    } else if (line.startsWith("@@screen")) {
      screen = line.slice(8).trim() || null;
      section = "screen";
    } else if (line === "@@ps") section = "ps";
    else if (section === "panes" && line.includes("\t")) {
      const [name, dead, pid, exit, created, attached] = line.split("\t");
      if (panes.has(name)) continue; // erste Pane pro Sitzung reicht
      panes.set(name, {
        name,
        dead: dead === "1",
        pid: Number(pid),
        exit: exit === "" ? null : Number(exit),
        created: Number(created),
        attached: Number(attached) || 0,
        cpu: 0,
        rss: 0,
      });
    } else if (section === "screen") {
      // „	12345.minecraft	(16.11.2026 10:00:00)	(Detached)“
      const m = line.match(/^\s+(\d+)\.(\S+)\s+(.*)$/);
      if (!m) continue;
      const dead = /dead/i.test(m[3]);
      const key = `${m[1]}.${m[2]}`;
      screens.set(key, {
        name: key,
        dead,
        crashed: dead,
        pid: Number(m[1]),
        exit: null,
        created: 0,
        attached: /\((multi, )?attached\)/i.test(m[3]) ? 1 : 0,
        cpu: 0,
        rss: 0,
      });
    } else if (section === "ps") {
      const [pid, ppid, cpu, rss, age] = line.trim().split(/\s+/).map(Number);
      if (!pid) continue;
      usage.set(pid, { cpu: cpu || 0, rss: (rss || 0) * 1024, age: age || 0 });
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid)!.push(pid);
    }
  }
  // CPU/RAM über den ganzen Prozessbaum summieren
  for (const p of [...panes.values(), ...screens.values()]) {
    if (p.dead) continue;
    if (!p.created) {
      const age = usage.get(p.pid)?.age;
      if (age) p.created = now - age;
    }
    const stack = [p.pid];
    while (stack.length) {
      const pid = stack.pop()!;
      const u = usage.get(pid);
      if (u) {
        p.cpu += u.cpu;
        p.rss += u.rss;
      }
      stack.push(...(children.get(pid) ?? []));
    }
  }
  return { now, tmux, screen, panes, screens };
}

/** Anzeigename einer screen-Sitzung ohne die PID davor */
const screenLabel = (key: string) => key.slice(key.indexOf(".") + 1);

// ---------------------------------------------------------------- Docker

interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

type DockerState = { kind: "ok"; list: DockerContainer[] } | { kind: "none" } | { kind: "denied"; msg: string };

async function loadDocker(connId: string): Promise<DockerState> {
  const r = await api.exec(
    connId,
    `command -v docker >/dev/null 2>&1 || { echo "@@nodocker"; exit 0; }; docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}'`,
  );
  if (r.stdout.includes("@@nodocker")) return { kind: "none" };
  if (r.code !== 0) return { kind: "denied", msg: (r.stderr || r.stdout).trim() };
  const list = r.stdout
    .split("\n")
    .filter((l) => l.includes("\t"))
    .map((l) => {
      const [id, name, image, state, status] = l.split("\t");
      return { id, name, image, state, status };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { kind: "ok", list };
}

// ---------------------------------------------------------------- Status & Sortierung

type StateKind = "up" | "stopped" | "crash";

const STATE_INFO: Record<StateKind, { label: string; desc: string }> = {
  up: { label: "Läuft", desc: "Das Programm ist gerade aktiv." },
  stopped: { label: "Beendet", desc: "Die Sitzung oder der Container ist da, das Programm läuft aber nicht." },
  crash: { label: "Abgestürzt", desc: "Mit Fehler beendet bzw. Sitzung tot." },
};

const paneKind = (p: PaneInfo): StateKind =>
  !p.dead ? "up" : p.crashed || (p.exit && p.exit !== 0 && p.exit !== 130) ? "crash" : "stopped";

const dockerKind = (c: DockerContainer): StateKind =>
  c.state === "running" ? "up" : c.state === "exited" && !/\(0\)/.test(c.status) ? "crash" : "stopped";

const SORT_KEY = "fernwerk.consoles.sort";

function loadSort(): StateKind | null {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return v === "up" || v === "stopped" || v === "crash" ? v : null;
  } catch {
    return null;
  }
}

/** Gewählter Status zuerst, sonst alphabetisch (sort ist stabil). */
function sortByState<T>(list: T[], kind: (t: T) => StateKind, first: StateKind | null): T[] {
  if (!first) return list;
  return [...list].sort((a, b) => Number(kind(b) === first) - Number(kind(a) === first));
}

/** Die Raute: zeigt den Status, ein Klick sortiert diesen Status nach oben. */
function StateDot({ s, sortBy, onSort }: { s: StateKind; sortBy: StateKind | null; onSort: (s: StateKind | null) => void }) {
  const info = STATE_INFO[s];
  const active = sortBy === s;
  return (
    <button
      type="button"
      className={`state-btn ${active ? "on" : ""}`}
      title={`${info.label}: ${info.desc}\n${active ? "Klicken hebt die Sortierung auf." : `Klicken sortiert alle mit Status „${info.label}“ nach oben.`}`}
      onClick={(e) => {
        e.stopPropagation();
        onSort(active ? null : s);
      }}
    >
      <span className={`console-state ${s === "up" ? "up" : s === "crash" ? "crash" : ""}`} />
    </button>
  );
}

// ---------------------------------------------------------------- Hauptansicht

type Sel = { kind: Mux; name: string } | { kind: "docker"; name: string };

export function Consoles({ sessionId, connId, visible }: { sessionId: string; connId: string; visible: boolean }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [docker, setDocker] = useState<DockerState | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [sortBy, setSortByState] = useState<StateKind | null>(loadSort);

  const setSortBy = (s: StateKind | null) => {
    setSortByState(s);
    try {
      if (s) localStorage.setItem(SORT_KEY, s);
      else localStorage.removeItem(SORT_KEY);
    } catch {
      /* Sortierung wird dann nur nicht gemerkt */
    }
  };

  const refresh = useCallback(async () => {
    try {
      setSnap(parseSnapshot((await api.exec(connId, STATUS_CMD)).stdout));
    } catch {
      /* nächster Versuch beim nächsten Takt */
    }
  }, [connId]);

  const refreshDocker = useCallback(async () => {
    setDocker(await loadDocker(connId).catch((e) => ({ kind: "denied" as const, msg: errText(e) })));
  }, [connId]);

  useEffect(() => {
    if (!visible) return;
    refreshDocker();
    refresh();
    const t = setInterval(refresh, 3000);
    const d = setInterval(refreshDocker, 10000);
    return () => {
      clearInterval(t);
      clearInterval(d);
    };
  }, [visible, refresh, refreshDocker]);

  const tmuxList = useMemo(
    () =>
      sortByState(
        [...(snap?.panes.values() ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
        paneKind,
        sortBy,
      ),
    [snap, sortBy],
  );
  const screenList = useMemo(
    () =>
      sortByState(
        [...(snap?.screens.values() ?? [])].sort((a, b) => screenLabel(a.name).localeCompare(screenLabel(b.name))),
        paneKind,
        sortBy,
      ),
    [snap, sortBy],
  );
  const dockerList = useMemo(
    () => (docker?.kind === "ok" ? sortByState(docker.list, dockerKind, sortBy) : []),
    [docker, sortBy],
  );

  // Erste Sitzung automatisch auswählen
  useEffect(() => {
    if (sel) return;
    if (tmuxList[0]) setSel({ kind: "tmux", name: tmuxList[0].name });
    else if (screenList[0]) setSel({ kind: "screen", name: screenList[0].name });
    else if (dockerList[0]) setSel({ kind: "docker", name: dockerList[0].name });
  }, [sel, tmuxList, screenList, dockerList]);

  const selPane =
    sel?.kind === "tmux" ? snap?.panes.get(sel.name) : sel?.kind === "screen" ? snap?.screens.get(sel.name) : undefined;
  const selContainer = sel?.kind === "docker" ? dockerList.find((c) => c.name === sel.name) : undefined;
  const nothing = snap && !tmuxList.length && !screenList.length && !dockerList.length;

  const paneItem = (kind: Mux, p: PaneInfo) => {
    const st = paneKind(p);
    return (
      <div
        key={p.name}
        className={`console-item ${sel?.kind === kind && sel.name === p.name ? "on" : ""}`}
        onClick={() => setSel({ kind, name: p.name })}
      >
        <StateDot s={st} sortBy={sortBy} onSort={setSortBy} />
        <div className="grow">
          <div className="ellipsis mono">{kind === "screen" ? screenLabel(p.name) : p.name}</div>
          <div className="sub">
            {st === "crash" ? "abgestürzt" : st === "stopped" ? "beendet" : p.attached ? "angehängt" : "losgelöst"}
            {kind === "screen" ? ` · PID ${p.pid}` : ""}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="consoles">
      <div className="console-list">
        {sortBy && (
          <div className="sort-bar">
            <span className={`console-state ${sortBy === "up" ? "up" : sortBy === "crash" ? "crash" : ""}`} />
            <span className="grow">{STATE_INFO[sortBy].label} zuerst</span>
            <button className="btn sm icon ghost" title="Sortierung aufheben" onClick={() => setSortBy(null)}>
              <X size={12} />
            </button>
          </div>
        )}

        {snap === null && <div className="dim" style={{ padding: "10px 14px" }}>Lade…</div>}

        {tmuxList.length > 0 && (
          <>
            <div className="side-section">
              <span>tmux-Sitzungen</span>
              <span>{tmuxList.length}</span>
            </div>
            {tmuxList.map((p) => paneItem("tmux", p))}
          </>
        )}

        {screenList.length > 0 && (
          <>
            <div className="side-section">
              <span>screen-Sitzungen</span>
              <span>{screenList.length}</span>
            </div>
            {screenList.map((p) => paneItem("screen", p))}
          </>
        )}

        {docker?.kind === "ok" && (
          <>
            <div className="side-section">
              <span>Container</span>
              <button className="btn sm icon ghost" title="Aktualisieren" onClick={refreshDocker}>
                <RefreshCw size={12} />
              </button>
            </div>
            {dockerList.length === 0 && <div className="dim" style={{ padding: "4px 14px", fontSize: 12 }}>Keine Container</div>}
            {dockerList.map((c) => (
              <div
                key={c.id}
                className={`console-item ${sel?.kind === "docker" && sel.name === c.name ? "on" : ""}`}
                onClick={() => setSel({ kind: "docker", name: c.name })}
              >
                <StateDot s={dockerKind(c)} sortBy={sortBy} onSort={setSortBy} />
                <div className="grow">
                  <div className="ellipsis">{c.name}</div>
                  <div className="sub ellipsis">{c.image}</div>
                </div>
              </div>
            ))}
          </>
        )}
        {docker?.kind === "denied" && (
          <>
            <div className="side-section">
              <span>Container</span>
            </div>
            <div className="dim" style={{ padding: "4px 14px 10px", fontSize: 12 }} title={docker.msg}>
              Docker ist installiert, aber dein Benutzer darf nicht darauf zugreifen (Gruppe <span className="mono">docker</span>).
            </div>
          </>
        )}
      </div>

      <div className="console-main">
        {(sel?.kind === "tmux" || sel?.kind === "screen") && selPane ? (
          <ConsoleView
            key={`${sel.kind}:${sel.name}`}
            connId={connId}
            mux={sel.kind}
            target={sel.name}
            title={sel.kind === "screen" ? screenLabel(sel.name) : sel.name}
            subtitle={sel.kind === "screen" ? `screen-Sitzung · PID ${selPane.pid}` : "tmux-Sitzung"}
            pane={selPane}
            now={snap?.now}
            visible={visible}
            actions={
              <button
                className="btn ghost danger"
                onClick={async () => {
                  const label = sel.kind === "screen" ? screenLabel(sel.name) : sel.name;
                  if (!(await confirm("Sitzung beenden", `${sel.kind}-Sitzung „${label}“ mit allen Programmen darin beenden?`, "Beenden", true))) return;
                  await run(() => sh(connId, MUX[sel.kind].kill(sel.name)));
                  setSel(null);
                  refresh();
                }}
              >
                <CirclePower size={14} /> Beenden
              </button>
            }
            attach={selPane.dead ? undefined : () => useStore.getState().addTerminal(sessionId, MUX[sel.kind].attach(sel.name))}
          />
        ) : selContainer ? (
          <DockerView
            key={selContainer.id}
            connId={connId}
            c={selContainer}
            visible={visible}
            onChanged={refreshDocker}
            onShell={() =>
              useStore
                .getState()
                .addTerminal(sessionId, `docker exec -it ${q(selContainer.name)} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`)
            }
          />
        ) : (
          <Empty icon={<Gamepad2 size={30} />} title={nothing ? "Nichts läuft im Hintergrund" : "Konsolen"}>
            <div className="muted" style={{ maxWidth: 480 }}>
              Hier erscheinen alle tmux- und screen-Sitzungen sowie Docker-Container auf dem Server – mit Live-Ausgabe und
              Eingabe. Starte z.&nbsp;B. im Terminal <span className="mono">screen -dmS minecraft java -jar server.jar nogui</span>,
              dann taucht die Sitzung hier automatisch auf.
            </div>
            {snap && !snap.tmux && !snap.screen && (
              <div className="dim" style={{ maxWidth: 480 }}>
                Auf diesem Server ist weder tmux noch screen installiert.
              </div>
            )}
          </Empty>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Live-Konsole

function classify(line: string): string {
  if (line.startsWith("[fernwerk]")) return "l-sys";
  if (line.startsWith("» ")) return "l-me";
  if (/\b(ERROR|SEVERE|FATAL|Exception|Error:)\b/.test(line)) return "l-err";
  if (/\bWARN(ING)?\b/.test(line)) return "l-warn";
  if (/joined the game|left the game|Player (dis)?connected/.test(line)) return "l-join";
  return "";
}

function OutputView({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lines = useMemo(() => text.split("\n"), [text]);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div
      ref={ref}
      className="console-out"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
      }}
    >
      {lines.map((l, i) => {
        const c = classify(l);
        return c ? (
          <div key={i} className={c}>
            {l}
          </div>
        ) : (
          <div key={i}>{l || " "}</div>
        );
      })}
    </div>
  );
}

function ConsoleView({
  connId,
  mux,
  target,
  title,
  subtitle,
  pane,
  now,
  visible,
  actions,
  attach,
}: {
  connId: string;
  mux: Mux;
  target: string;
  title: string;
  subtitle: string;
  pane: PaneInfo;
  now: number | undefined;
  visible: boolean;
  actions: ReactNode;
  attach?: () => void;
}) {
  const M = MUX[mux];
  const [text, setText] = useState("");
  const [input, setInput] = useState("");
  const history = useRef<string[]>([]);
  const histIdx = useRef(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const alive = !pane.dead;

  const poll = useCallback(async () => {
    try {
      const r = await api.exec(connId, M.capture(target));
      // screen füllt die Zeilen mit Leerzeichen auf
      if (r.code === 0) setText(r.stdout.replace(/[ 	]+$/gm, "").replace(/\s+$/, ""));
    } catch {
      /* ignorieren */
    }
  }, [connId, target, M]);

  useEffect(() => {
    if (!visible) return;
    poll();
    const t = setInterval(poll, alive ? 1000 : 4000);
    return () => clearInterval(t);
  }, [visible, alive, poll]);

  const send = async (cmd: string) => {
    if (!alive) return toast("info", "Das Programm läuft gerade nicht");
    if (cmd.trim()) {
      history.current = [cmd, ...history.current.filter((h) => h !== cmd)].slice(0, 100);
    }
    histIdx.current = -1;
    await run(() =>
      api.exec(connId, M.send(target, cmd)).then((r) => {
        if (r.code !== 0) throw new Error(r.stderr.trim() || "Senden fehlgeschlagen");
      }),
    );
    setTimeout(poll, 250);
  };

  const minecraft = useMemo(() => looksLikeMinecraft(text), [text]);
  const quick = minecraft ? MC_QUICK : [];

  const players = useMemo(() => {
    if (!minecraft) return null;
    const all = [...text.matchAll(/There are (\d+)(?:\/| of a max(?: of)? )(\d+) players online:?[ 	]*(.*)$/gm)];
    const m = all[all.length - 1];
    return m ? { n: Number(m[1]), max: Number(m[2]), names: m[3].trim() } : null;
  }, [text, minecraft]);

  const st = paneKind(pane);

  return (
    <>
      <div className="console-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 className="ellipsis">{title}</h2>
          <div className="mono dim ellipsis" style={{ fontSize: 11 }} title={subtitle}>
            {subtitle}
          </div>
        </div>
        {attach && (
          <button className="btn ghost" title={`In einer Shell öffnen (${M.detachHint})`} onClick={attach}>
            <ExternalLink size={14} /> Im Terminal
          </button>
        )}
        {actions}
      </div>

      <div className="console-meta">
        <div>
          <span>Status</span>
          <b className={st === "crash" ? "err" : st === "up" ? "" : "muted"}>
            {STATE_INFO[st].label}
            {pane.dead && pane.exit != null ? ` (${pane.exit})` : ""}
          </b>
        </div>
        <div>
          <span>Laufzeit</span>
          <b>{alive && now && pane.created ? duration(Math.max(0, now - pane.created)) : "–"}</b>
        </div>
        <div>
          <span>CPU</span>
          <b>{alive ? `${pane.cpu.toFixed(0)} %` : "–"}</b>
        </div>
        <div>
          <span>RAM</span>
          <b>{alive ? bytes(pane.rss) : "–"}</b>
        </div>
        {minecraft && (
          <div className="grow" title={players?.names || undefined}>
            <span>Spieler</span>
            <b className="ellipsis">
              {players ? `${players.n} / ${players.max}` : "–"}
              {players?.names ? <em className="names"> · {players.names}</em> : null}
            </b>
          </div>
        )}
      </div>

      <OutputView text={text} />

      {quick.length > 0 && (
        <div className="quick">
          {quick.map((c) => (
            <button
              key={c.label}
              className="btn ghost"
              disabled={!alive}
              onClick={() => {
                if (c.fill) {
                  setInput(c.cmd);
                  inputRef.current?.focus();
                } else send(c.cmd);
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}

      <form
        className="console-input"
        onSubmit={(e) => {
          e.preventDefault();
          const v = input;
          setInput("");
          send(v);
        }}
      >
        <span className="prompt">›</span>
        <input
          ref={inputRef}
          placeholder={alive ? "Befehl an die Konsole senden  (↑/↓ Verlauf)" : "Programm läuft nicht"}
          disabled={!alive}
          value={input}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            const h = history.current;
            if (e.key === "ArrowUp" && h.length) {
              e.preventDefault();
              histIdx.current = Math.min(h.length - 1, histIdx.current + 1);
              setInput(h[histIdx.current]);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              histIdx.current = Math.max(-1, histIdx.current - 1);
              setInput(histIdx.current < 0 ? "" : h[histIdx.current]);
            } else if (e.key === "c" && e.ctrlKey && !input && alive) {
              e.preventDefault();
              api.exec(connId, M.interrupt(target)).then(() => setTimeout(poll, 300));
            }
          }}
        />
        <button className="btn sm ghost" type="button" title="Ansicht leeren"
          onClick={() => api.exec(connId, M.clear(target)).then(poll)}>
          <Eraser size={13} />
        </button>
        <button className="btn sm primary" type="submit" disabled={!alive}>
          <SendHorizontal size={13} /> Senden
        </button>
      </form>
    </>
  );
}

// ---------------------------------------------------------------- Docker-Ansicht

function DockerView({
  connId,
  c,
  visible,
  onChanged,
  onShell,
}: {
  connId: string;
  c: DockerContainer;
  visible: boolean;
  onChanged: () => void;
  onShell: () => void;
}) {
  const [logs, setLogs] = useState("");
  const [extra, setExtra] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const running = c.state === "running";

  const poll = useCallback(async () => {
    const r = await api.exec(connId, `docker logs --tail 500 ${q(c.name)} 2>&1`).catch(() => null);
    if (r) setLogs(r.stdout.replace(/\s+$/, ""));
  }, [connId, c.name]);

  useEffect(() => {
    if (!visible) return;
    poll();
    const t = setInterval(poll, running ? 2000 : 6000);
    return () => clearInterval(t);
  }, [visible, running, poll]);

  const act = async (action: "start" | "stop" | "restart") => {
    setBusy(true);
    await run(() => sh(connId, `docker ${action} ${q(c.name)}`), `${c.name}: ${action}`);
    setBusy(false);
    onChanged();
    poll();
  };

  const exec = async (cmd: string) => {
    if (!cmd.trim()) return;
    const r = await api.exec(connId, `docker exec ${q(c.name)} sh -c ${q(cmd)} 2>&1`).catch((e) => ({ stdout: errText(e), code: 1 }));
    setExtra((x) => `${x}${x ? "\n" : ""}» ${cmd}\n${r.stdout.replace(/\s+$/, "")}`);
  };

  return (
    <>
      <div className="console-head">
        <Container size={18} className="gold" />
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 className="ellipsis">{c.name}</h2>
          <div className="mono dim ellipsis" style={{ fontSize: 11 }}>
            {c.image} · {c.id}
          </div>
        </div>
        {running && (
          <button className="btn ghost" onClick={onShell}>
            <ExternalLink size={14} /> Shell im Container
          </button>
        )}
        {running ? (
          <>
            <button className="btn" disabled={busy} onClick={() => act("restart")}>
              <RotateCw size={14} /> Neustart
            </button>
            <button className="btn" disabled={busy} onClick={() => act("stop")}>
              <Square size={13} /> Stoppen
            </button>
          </>
        ) : (
          <button className="btn primary" disabled={busy} onClick={() => act("start")}>
            <Play size={14} /> Starten
          </button>
        )}
      </div>
      <div className="console-meta">
        <div>
          <span>Status</span>
          <b className={running ? "" : "muted"}>{c.status}</b>
        </div>
      </div>
      <OutputView text={extra ? `${logs}\n\n${extra}` : logs} />
      <form
        className="console-input"
        onSubmit={(e) => {
          e.preventDefault();
          const v = input;
          setInput("");
          exec(v);
        }}
      >
        <span className="prompt">›</span>
        <input
          placeholder={running ? "Befehl im Container ausführen (docker exec)" : "Container läuft nicht"}
          disabled={!running}
          value={input}
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn sm primary" type="submit" disabled={!running}>
          <SendHorizontal size={13} /> Ausführen
        </button>
      </form>
    </>
  );
}
