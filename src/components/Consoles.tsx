import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRightLeft, CirclePower, Container, Cpu, Eraser, ExternalLink, Gamepad2, Play, RefreshCw, RotateCw, SendHorizontal, Square } from "lucide-react";
import { api, errText } from "../lib/api";
import { bytes, duration } from "../lib/format";
import { q } from "../lib/shell";
import { ask, confirm, run, toast, useStore, withSudo } from "../lib/store";
import { Empty } from "./ui";

/*
 * Konsolen: zeigt, was auf dem Server dauerhaft im Hintergrund läuft.
 *
 * Kein Agent: Fernwerk liest tmux-Sitzungen (`tmux list-panes`), screen-Sitzungen (`screen -ls`)
 * und Docker-Container aus. Die Ausgabe kommt per `tmux capture-pane` bzw. `screen -X hardcopy`,
 * Eingaben gehen per `tmux send-keys` bzw. `screen -X stuff` hinein.
 *
 * Dazu kommen Gameserver, die „lose“ laufen (z.B. `./start.sh` mit `exec java …`, nohup oder als
 * systemd-Dienst): Sie werden an ihrer Befehlszeile erkannt. Ausgabe kommt dann aus logs/latest.log
 * bzw. dem Journal, Befehle gehen per RCON hinein, falls es in server.properties aktiv ist.
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

/** Ein Gameserver, der außerhalb von tmux/screen/Docker läuft */
interface ProcInfo {
  pid: number;
  /** Kurzname für die Liste, z.B. „paper.jar“ */
  name: string;
  args: string;
  game: string;
  created: number;
  cpu: number;
  rss: number;
}

interface Snapshot {
  now: number;
  tmux: string | null;
  screen: string | null;
  panes: Map<string, PaneInfo>;
  screens: Map<string, PaneInfo>;
  procs: ProcInfo[];
}

/** Befehlszeilen, die nach Gameserver aussehen → Anzeigename des Spiels */
const GAME_PATTERNS: [RegExp, string][] = [
  [/\bjava\b.*(?:paper|purpur|spigot|bukkit|folia|fabric|forge|neoforge|velocity|bungee|waterfall|minecraft|server)[\w.-]*\.jar/i, "Minecraft"],
  [/\bjava\b.*(?:\bnogui\b|--nogui)/i, "Minecraft"],
  [/\bjava\b.*-jar\s+\S+\.jar/i, "Java-Server"],
  [/bedrock_server/i, "Minecraft Bedrock"],
  [/TerrariaServer|tModLoaderServer/i, "Terraria"],
  [/factorio\b.*--start-server/i, "Factorio"],
  [/valheim_server/i, "Valheim"],
  [/PalServer/i, "Palworld"],
  [/RustDedicated/i, "Rust"],
  [/srcds_linux|srcds_run/i, "Source-Server"],
  [/7DaysToDieServer/i, "7 Days to Die"],
  [/ArmaReforgerServer|arma3server/i, "Arma"],
];

function gameOf(args: string): string | null {
  for (const [re, name] of GAME_PATTERNS) if (re.test(args)) return name;
  return null;
}

/** „java -Xmx4G -jar paper.jar --nogui“ → „paper.jar“ */
function procName(args: string): string {
  const jar = args.match(/-jar\s+(\S+\.jar)/i);
  if (jar) return jar[1].split("/").pop()!;
  return (args.split(/\s+/)[0] ?? "").split("/").pop() || args;
}

const STATUS_CMD = [
  `echo "@@now $(date +%s)"`,
  `echo "@@tmux $(command -v tmux 2>/dev/null)"`,
  `tmux list-panes -a -F '#{session_name}\t#{pane_dead}\t#{pane_pid}\t#{pane_dead_status}\t#{session_created}\t#{session_attached}' 2>/dev/null`,
  `echo "@@screen $(command -v screen 2>/dev/null)"`,
  `screen -ls 2>/dev/null`,
  `echo "@@ps"`,
  // args steht am Ende, weil es Leerzeichen enthält
  `ps -eo pid=,ppid=,pcpu=,rss=,etimes=,args= 2>/dev/null`,
].join("; ");

function parseSnapshot(out: string): Snapshot {
  let now = Math.floor(Date.now() / 1000);
  let tmux: string | null = null;
  let screen: string | null = null;
  const panes = new Map<string, PaneInfo>();
  const screens = new Map<string, PaneInfo>();
  const children = new Map<number, number[]>();
  const usage = new Map<number, { cpu: number; rss: number; age: number }>();
  const argsOf = new Map<number, string>();
  const parentOf = new Map<number, number>();
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
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s*(.*)$/);
      if (!m) continue;
      const [pid, ppid, cpu, rss, age] = m.slice(1, 6).map(Number);
      usage.set(pid, { cpu: cpu || 0, rss: (rss || 0) * 1024, age: age || 0 });
      argsOf.set(pid, m[6]);
      parentOf.set(pid, ppid);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid)!.push(pid);
    }
  }
  // Alles unterhalb von tmux/screen-Sitzungen und Docker-Containern ist schon anderswo zu sehen
  const covered = new Set<number>();
  const cover = (root: number) => {
    const stack = [root];
    while (stack.length) {
      const pid = stack.pop()!;
      if (covered.has(pid)) continue;
      covered.add(pid);
      stack.push(...(children.get(pid) ?? []));
    }
  };
  for (const p of [...panes.values(), ...screens.values()]) if (!p.dead) cover(p.pid);
  for (const [pid, args] of argsOf) {
    if (/containerd-shim|^(tmux|screen|SCREEN)\b/.test(args)) cover(pid);
  }

  // Lose laufende Gameserver: oberster passender Prozess, der noch nicht abgedeckt ist
  const procs: ProcInfo[] = [];
  for (const [pid, args] of argsOf) {
    if (covered.has(pid)) continue;
    const game = gameOf(args);
    if (!game) continue;
    // Elternprozess passt auch (z.B. Wrapper-Skript) → nur den oberen zeigen
    const parent = parentOf.get(pid);
    if (parent && !covered.has(parent) && gameOf(argsOf.get(parent) ?? "")) continue;
    const u = usage.get(pid);
    const p: ProcInfo = { pid, name: procName(args), args, game, created: u ? now - u.age : 0, cpu: 0, rss: 0 };
    const stack = [pid];
    while (stack.length) {
      const x = stack.pop()!;
      const ux = usage.get(x);
      if (ux) {
        p.cpu += ux.cpu;
        p.rss += ux.rss;
      }
      stack.push(...(children.get(x) ?? []));
    }
    procs.push(p);
  }
  procs.sort((a, b) => a.name.localeCompare(b.name) || a.pid - b.pid);

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
  return { now, tmux, screen, panes, screens, procs };
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

type Filter = "all" | StateKind;

const FILTER_KEY = "fernwerk.consoles.filter";
const FILTERS: Filter[] = ["all", "up", "crash", "stopped"];

function loadFilter(): Filter {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return v === "up" || v === "stopped" || v === "crash" ? v : "all";
  } catch {
    return "all";
  }
}

const dotClass = (s: StateKind) => `console-state ${s === "up" ? "up" : s === "crash" ? "crash" : ""}`;

/** Die Raute in einer Zeile: zeigt den Status, ein Klick filtert auf diesen Status. */
function StateDot({ s, filter, onFilter }: { s: StateKind; filter: Filter; onFilter: (f: Filter) => void }) {
  const info = STATE_INFO[s];
  const active = filter === s;
  return (
    <button
      type="button"
      className={`state-btn ${active ? "on" : ""}`}
      title={`${info.label}: ${info.desc}\n${active ? "Klicken zeigt wieder alle." : `Klicken zeigt nur „${info.label}“.`}`}
      onClick={(e) => {
        e.stopPropagation();
        onFilter(active ? "all" : s);
      }}
    >
      <span className={dotClass(s)} />
    </button>
  );
}

/** Leiste oben: Alle / Läuft / Abgestürzt / Beendet mit Anzahl */
function FilterBar({ filter, counts, onFilter }: { filter: Filter; counts: Record<Filter, number>; onFilter: (f: Filter) => void }) {
  return (
    <div className="state-filter" role="tablist">
      {FILTERS.map((f) => (
        <button
          key={f}
          type="button"
          role="tab"
          aria-selected={filter === f}
          className={`state-chip ${filter === f ? "on" : ""}`}
          title={f === "all" ? "Alle anzeigen" : `${STATE_INFO[f].label}: ${STATE_INFO[f].desc}`}
          onClick={() => onFilter(f)}
        >
          {f === "all" ? (
            <span className="chip-dots">
              <span className={dotClass("up")} />
              <span className={dotClass("crash")} />
              <span className={dotClass("stopped")} />
            </span>
          ) : (
            <span className={dotClass(f)} />
          )}
          <span className="chip-label">{f === "all" ? "Alle" : STATE_INFO[f].label}</span>
          <span className="chip-count">{counts[f]}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Hauptansicht

type Sel = { kind: Mux; name: string } | { kind: "docker"; name: string } | { kind: "proc"; name: string };

export function Consoles({ sessionId, connId, visible }: { sessionId: string; connId: string; visible: boolean }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [docker, setDocker] = useState<DockerState | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [filter, setFilterState] = useState<Filter>(loadFilter);

  const setFilter = (f: Filter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {
      /* Filter wird dann nur nicht gemerkt */
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

  const allTmux = useMemo(() => [...(snap?.panes.values() ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [snap]);
  const allScreen = useMemo(
    () => [...(snap?.screens.values() ?? [])].sort((a, b) => screenLabel(a.name).localeCompare(screenLabel(b.name))),
    [snap],
  );
  const allDocker = useMemo(() => (docker?.kind === "ok" ? docker.list : []), [docker]);
  const allProcs = useMemo(() => snap?.procs ?? [], [snap]);

  const counts = useMemo(() => {
    const kinds = [...allTmux.map(paneKind), ...allScreen.map(paneKind), ...allDocker.map(dockerKind), ...allProcs.map(() => "up" as const)];
    return {
      all: kinds.length,
      up: kinds.filter((k) => k === "up").length,
      crash: kinds.filter((k) => k === "crash").length,
      stopped: kinds.filter((k) => k === "stopped").length,
    };
  }, [allTmux, allScreen, allDocker, allProcs]);

  const keep = (k: StateKind) => filter === "all" || filter === k;
  const tmuxList = allTmux.filter((p) => keep(paneKind(p)));
  const screenList = allScreen.filter((p) => keep(paneKind(p)));
  const dockerList = allDocker.filter((c) => keep(dockerKind(c)));
  const procList = allProcs.filter(() => keep("up"));

  // Erste Sitzung automatisch auswählen
  useEffect(() => {
    if (sel) return;
    if (procList[0]) setSel({ kind: "proc", name: String(procList[0].pid) });
    else if (tmuxList[0]) setSel({ kind: "tmux", name: tmuxList[0].name });
    else if (screenList[0]) setSel({ kind: "screen", name: screenList[0].name });
    else if (dockerList[0]) setSel({ kind: "docker", name: dockerList[0].name });
  }, [sel, tmuxList, screenList, dockerList, procList]);

  const selPane =
    sel?.kind === "tmux" ? snap?.panes.get(sel.name) : sel?.kind === "screen" ? snap?.screens.get(sel.name) : undefined;
  const selContainer = sel?.kind === "docker" ? allDocker.find((c) => c.name === sel.name) : undefined;
  const selProc = sel?.kind === "proc" ? allProcs.find((p) => String(p.pid) === sel.name) : undefined;
  const nothing = snap && counts.all === 0;

  // Gewählter Eintrag ist verschwunden (beendet, übernommen …) → Auswahl freigeben, damit der nächste greift
  const selMissing = !!sel && !!snap && !selPane && !selProc && !(sel.kind === "docker" && (selContainer || docker === null));
  useEffect(() => {
    if (selMissing) setSel(null);
  }, [selMissing]);
  const filteredEmpty = snap && counts.all > 0 && !tmuxList.length && !screenList.length && !dockerList.length && !procList.length;

  const paneItem = (kind: Mux, p: PaneInfo) => {
    const st = paneKind(p);
    return (
      <div
        key={p.name}
        className={`console-item ${sel?.kind === kind && sel.name === p.name ? "on" : ""}`}
        onClick={() => setSel({ kind, name: p.name })}
      >
        <StateDot s={st} filter={filter} onFilter={setFilter} />
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
        <FilterBar filter={filter} counts={counts} onFilter={setFilter} />

        {snap === null && <div className="dim" style={{ padding: "10px 14px" }}>Lade…</div>}
        {filteredEmpty && filter !== "all" && (
          <div className="dim" style={{ padding: "10px 14px", fontSize: 12 }}>
            Nichts mit Status „{STATE_INFO[filter].label}“.{" "}
            <button className="link-btn" onClick={() => setFilter("all")}>
              Alle zeigen
            </button>
          </div>
        )}

        {procList.length > 0 && (
          <>
            <div className="side-section">
              <span>Gameserver (Prozess)</span>
              <span>{procList.length}</span>
            </div>
            {procList.map((p) => (
              <div
                key={p.pid}
                className={`console-item ${sel?.kind === "proc" && sel.name === String(p.pid) ? "on" : ""}`}
                onClick={() => setSel({ kind: "proc", name: String(p.pid) })}
              >
                <StateDot s="up" filter={filter} onFilter={setFilter} />
                <div className="grow">
                  <div className="ellipsis mono">{p.name}</div>
                  <div className="sub">
                    {p.game} · PID {p.pid}
                  </div>
                </div>
              </div>
            ))}
          </>
        )}

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

        {docker?.kind === "ok" && (filter === "all" || dockerList.length > 0) && (
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
                <StateDot s={dockerKind(c)} filter={filter} onFilter={setFilter} />
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
        ) : selProc ? (
          <ProcView
            key={selProc.pid}
            sessionId={sessionId}
            connId={connId}
            p={selProc}
            now={snap?.now}
            visible={visible}
            onGone={() => {
              setSel(null);
              refresh();
            }}
            onMoved={(name) => {
              refresh().then(() => setSel({ kind: "tmux", name }));
            }}
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
              Hier erscheinen alle tmux- und screen-Sitzungen, Docker-Container und laufende Gameserver (z.&nbsp;B.{" "}
              <span className="mono">java -jar paper.jar</span>) – mit Live-Ausgabe und Eingabe. Am meisten geht mit tmux:{" "}
              <span className="mono">tmux new -d -s minecraft ./start.sh</span>
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

// ---------------------------------------------------------------- Lose laufende Gameserver

interface ProcDetail {
  cwd: string;
  user: string;
  unit: string;
  log: string;
  rcon: boolean;
  /** Läuft unter einem anderen Benutzer, auf dessen Dateien wir keinen Zugriff haben */
  foreign: boolean;
}

/** Datei lesen – erst normal, dann per sudo ohne Passwort (z.B. bei Servern, die als root laufen) */
const RD = `rd(){ cat -- "$1" 2>/dev/null || sudo -n cat -- "$1" 2>/dev/null; }`;

function detailCmd(pid: number): string {
  const P = String(pid);
  return [
    RD,
    `cwd=$(readlink /proc/${P}/cwd 2>/dev/null || sudo -n readlink /proc/${P}/cwd 2>/dev/null)`,
    `echo "@@cwd $cwd"`,
    `echo "@@user $(ps -o user= -p ${P} 2>/dev/null)"`,
    // systemd-Dienst aus der cgroup, z.B. „0::/system.slice/minecraft.service“
    `echo "@@unit $(sed -n 's#.*/\\([^/]*\\.service\\)$#\\1#p' /proc/${P}/cgroup 2>/dev/null | head -n1)"`,
    `if [ -n "$cwd" ]; then for f in "$cwd/logs/latest.log" "$cwd/server.log" "$cwd/log.txt"; do if rd "$f" >/dev/null; then echo "@@log $f"; break; fi; done; rd "$cwd/server.properties" | grep -E '^(enable-rcon|rcon\\.password)=' | sed 's/^rcon\\.password=.\\+/rcon.password=SET/'; fi`,
  ].join("; ");
}

function parseDetail(out: string, me: string): ProcDetail {
  const get = (k: string) => out.match(new RegExp(`^@@${k} ?(.*)$`, "m"))?.[1].trim() ?? "";
  const cwd = get("cwd");
  const user = get("user");
  return {
    cwd,
    user,
    unit: get("unit"),
    log: get("log"),
    rcon: /^enable-rcon=true/m.test(out) && /^rcon\.password=SET/m.test(out),
    foreign: !cwd && user !== me,
  };
}

/**
 * Minimaler RCON-Client (Minecraft/Source-Protokoll) in Python – liest Port und Passwort selbst
 * aus server.properties, damit das Passwort nie über die Leitung oder in die Prozessliste geht.
 */
const RCON_PY = `
import socket, struct, sys, re
cwd, cmd = sys.argv[1], sys.argv[2]
props = {}
try:
    raw = open(cwd + "/server.properties", encoding="utf-8", errors="replace").read()
except PermissionError:
    import subprocess
    raw = subprocess.run(["sudo", "-n", "cat", cwd + "/server.properties"], capture_output=True, text=True).stdout
for line in raw.splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        props[k.strip()] = v.strip()
if props.get("enable-rcon") != "true" or not props.get("rcon.password"):
    sys.exit("RCON ist in server.properties nicht aktiv")
s = socket.create_connection(("127.0.0.1", int(props.get("rcon.port") or 25575)), 5)
def rx(n):
    b = b""
    while len(b) < n:
        c = s.recv(n - len(b))
        if not c:
            sys.exit("RCON-Verbindung getrennt")
        b += c
    return b
def send(i, t, body):
    d = struct.pack("<ii", i, t) + body.encode() + b"\\x00\\x00"
    s.sendall(struct.pack("<i", len(d)) + d)
def recv():
    n = struct.unpack("<i", rx(4))[0]
    d = rx(n)
    return struct.unpack("<i", d[:4])[0], d[8:-2].decode("utf-8", "replace")
send(1, 3, props["rcon.password"])
if recv()[0] == -1:
    sys.exit("RCON-Passwort falsch")
send(2, 2, cmd)
print(re.sub("\\u00a7.", "", recv()[1]))
`;

const rconCmd = (cwd: string, cmd: string) =>
  `command -v python3 >/dev/null || { echo "python3 fehlt auf dem Server" >&2; exit 1; }; python3 -c ${q(RCON_PY)} ${q(cwd)} ${q(cmd)}`;

/**
 * Beendet den Prozess (falls noch nicht geschehen) und startet dieselbe Befehlszeile
 * im selben Ordner in einer tmux- bzw. screen-Sitzung neu.
 */
function takeoverCmd(pid: number, cwd: string, session: string, alreadyStopping: boolean): string {
  const P = String(pid);
  const script = [
    `set -e`,
    `[ -r /proc/${P}/cmdline ] || { echo "Prozess ${P} läuft nicht mehr" >&2; exit 1; }`,
    `mapfile -d '' -t ARGS < /proc/${P}/cmdline`,
    `[ \${#ARGS[@]} -gt 0 ] || { echo "Befehlszeile nicht lesbar" >&2; exit 1; }`,
    alreadyStopping ? `true` : `kill -TERM ${P}`,
    `for i in $(seq 1 120); do kill -0 ${P} 2>/dev/null || break; sleep 1; done`,
    `if kill -0 ${P} 2>/dev/null; then echo "Server hat sich nach 2 Minuten nicht beendet" >&2; exit 1; fi`,
    `cd ${q(cwd)}`,
    `if command -v tmux >/dev/null; then tmux new-session -d -s ${q(session)} -c ${q(cwd)} -- "\${ARGS[@]}"; echo "@@tmux";`,
    `elif command -v screen >/dev/null; then screen -dmS ${q(session)} "\${ARGS[@]}"; echo "@@screen";`,
    `else echo "Weder tmux noch screen installiert" >&2; exit 1; fi`,
  ].join("\n");
  return `bash -c ${q(script)}`;
}

function ProcView({
  sessionId,
  connId,
  p,
  now,
  visible,
  onGone,
  onMoved,
}: {
  sessionId: string;
  connId: string;
  p: ProcInfo;
  now: number | undefined;
  visible: boolean;
  onGone: () => void;
  onMoved: (session: string) => void;
}) {
  const me = useStore((s) => s.sessions.find((x) => x.id === sessionId)?.username ?? "");
  const [d, setD] = useState<ProcDetail | null>(null);
  const [text, setText] = useState("");
  const [extra, setExtra] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const minecraft = /minecraft/i.test(p.game);

  useEffect(() => {
    api
      .exec(connId, detailCmd(p.pid))
      .then((r) => setD(parseDetail(r.stdout, me)))
      .catch(() => setD({ cwd: "", user: "", unit: "", log: "", rcon: false, foreign: true }));
  }, [connId, p.pid, me]);

  const poll = useCallback(async () => {
    if (!d) return;
    let cmd = "";
    if (d.log) cmd = `${RD}; rd ${q(d.log)} | tail -n 500`;
    else if (d.unit) cmd = `journalctl -u ${q(d.unit)} -n 500 --no-pager -o cat 2>/dev/null || sudo -n journalctl -u ${q(d.unit)} -n 500 --no-pager -o cat 2>/dev/null`;
    if (!cmd) return;
    const r = await api.exec(connId, cmd).catch(() => null);
    if (r) setText(r.stdout.replace(/\s+$/, ""));
  }, [connId, d]);

  useEffect(() => {
    if (!visible || !d) return;
    poll();
    const t = setInterval(poll, 1500);
    return () => clearInterval(t);
  }, [visible, d, poll]);

  const send = async (cmd: string) => {
    if (!d?.rcon || !cmd.trim()) return;
    const r = await api.exec(connId, rconCmd(d.cwd, cmd)).catch((e) => ({ code: 1, stdout: "", stderr: errText(e) }));
    const out = (r.code === 0 ? r.stdout : r.stderr || r.stdout).replace(/\s+$/, "");
    setExtra((x) => `${x}${x ? "\n" : ""}» ${cmd}${out ? `\n${out}` : ""}`);
    setTimeout(poll, 400);
  };

  const stop = async () => {
    if (!(await confirm("Server stoppen", `${p.name} (PID ${p.pid}) beenden? Minecraft speichert die Welten dabei.`, "Stoppen", true))) return;
    setBusy(true);
    if (d?.unit) {
      await run(() => withSudo(sessionId, (pw) => api.serviceAction(connId, d.unit, "stop", pw)), `${d.unit} gestoppt`);
    } else if (minecraft && d?.rcon) {
      await send("stop");
    } else {
      // SIGTERM: Minecraft/Paper fahren dabei sauber herunter
      await run(() => withSudo(sessionId, (pw) => api.processKill(connId, p.pid, "TERM", pw)), "Stoppsignal gesendet");
    }
    setBusy(false);
    setTimeout(onGone, 1500);
  };

  const restart = async () => {
    if (!d?.unit) return;
    setBusy(true);
    await run(() => withSudo(sessionId, (pw) => api.serviceAction(connId, d.unit, "restart", pw)), `${d.unit} neu gestartet`);
    setBusy(false);
    setTimeout(onGone, 1500);
  };

  const takeover = async () => {
    if (!d?.cwd) return;
    const base = (d.cwd.split("/").pop() || p.name).replace(/[^\w-]/g, "") || "server";
    const r = await ask({
      title: "In Konsole übernehmen",
      message:
        "Der Server wird sauber gestoppt und mit derselben Befehlszeile im selben Ordner in einer tmux-Sitzung neu gestartet. Danach hast du hier die volle Konsole mit Eingabe. Spieler fliegen dabei kurz raus.",
      detail: `${d.cwd}\n$ ${p.args}`,
      fields: [{ name: "name", label: "Name der Sitzung", value: base }],
      confirm: "Übernehmen",
    });
    if (!r) return;
    const name = String(r.name).trim().replace(/[^\w-]/g, "") || base;
    setBusy(true);
    let stopping = false;
    if (minecraft && d.rcon) {
      await send("stop");
      stopping = true;
    }
    const res = await api.exec(connId, takeoverCmd(p.pid, d.cwd, name, stopping)).catch((e) => ({ code: 1, stdout: "", stderr: errText(e) }));
    setBusy(false);
    if (res.code !== 0) return toast("error", `Übernehmen fehlgeschlagen: ${(res.stderr || res.stdout).trim()}`);
    toast("ok", `Läuft jetzt in der Sitzung „${name}“`);
    onMoved(name);
  };

  const canTakeover = !!d?.cwd && !d.unit && d.user === me;
  const out = extra ? `${text}${text ? "\n\n" : ""}${extra}` : text;
  const players = useMemo(() => {
    if (!minecraft) return null;
    const all = [...out.matchAll(/There are (\d+)(?:\/| of a max(?: of)? )(\d+) players online:?[ \t]*(.*)$/gm)];
    const m = all[all.length - 1];
    return m ? { n: Number(m[1]), max: Number(m[2]), names: m[3].trim() } : null;
  }, [out, minecraft]);
  const noOutput = d && !d.log && !d.unit;

  return (
    <>
      <div className="console-head">
        <Cpu size={18} className="gold" />
        <div className="grow" style={{ minWidth: 0 }}>
          <h2 className="ellipsis">{p.name}</h2>
          <div className="mono dim ellipsis" style={{ fontSize: 11 }} title={p.args}>
            {p.game} · PID {p.pid}
            {d?.unit ? ` · Dienst ${d.unit}` : ""}
            {d?.cwd ? ` · ${d.cwd}` : ""}
          </div>
        </div>
        {canTakeover && (
          <button className="btn ghost" disabled={busy} title="Neu in tmux starten – danach volle Konsole mit Eingabe" onClick={takeover}>
            <ArrowRightLeft size={14} /> In Konsole übernehmen
          </button>
        )}
        {d?.unit && (
          <button className="btn" disabled={busy} onClick={restart}>
            <RotateCw size={14} /> Neustart
          </button>
        )}
        <button className="btn ghost danger" disabled={busy} onClick={stop}>
          <CirclePower size={14} /> Stoppen
        </button>
      </div>

      <div className="console-meta">
        <div>
          <span>Status</span>
          <b>{STATE_INFO.up.label}</b>
        </div>
        <div>
          <span>Laufzeit</span>
          <b>{now && p.created ? duration(Math.max(0, now - p.created)) : "–"}</b>
        </div>
        <div>
          <span>CPU</span>
          <b>{`${p.cpu.toFixed(0)} %`}</b>
        </div>
        <div>
          <span>RAM</span>
          <b>{bytes(p.rss)}</b>
        </div>
        <div>
          <span>Benutzer</span>
          <b>{d?.user || "–"}</b>
        </div>
        {minecraft && (
          <div title={players?.names || (d?.rcon ? "„list“ senden, um die Spieler zu sehen" : undefined)}>
            <span>Spieler</span>
            <b className="ellipsis">{players ? `${players.n} / ${players.max}` : "–"}</b>
          </div>
        )}
        <div className="grow">
          <span>Eingabe</span>
          <b className={d?.rcon ? "" : "muted"}>{d ? (d.rcon ? "RCON" : "nur lesen") : "…"}</b>
        </div>
      </div>

      {d && !d.rcon && (
        <div className="console-hint">
          {d.foreign ? (
            <>
              Der Server läuft als <span className="mono">{d.user || "anderer Benutzer"}</span> – Fernwerk kann seine Dateien nicht
              lesen. Verbinde dich als dieser Benutzer bzw. als root, oder erlaube <span className="mono">sudo</span> ohne Passwort.
            </>
          ) : (
            <>
              Dieser Server läuft außerhalb von tmux/screen, deshalb gehen keine Befehle direkt hinein.{" "}
              {canTakeover ? (
                <>
                  Klick auf <b>In Konsole übernehmen</b>
                  {minecraft ? (
                    <>
                      {" "}oder setze <span className="mono">enable-rcon=true</span> und ein <span className="mono">rcon.password</span>{" "}
                      in der server.properties
                    </>
                  ) : null}
                  .
                </>
              ) : minecraft ? (
                <>
                  Setze <span className="mono">enable-rcon=true</span> und ein <span className="mono">rcon.password</span> in der
                  server.properties und starte den Server neu.
                </>
              ) : (
                <>Starte ihn künftig in tmux, z.&nbsp;B. <span className="mono">tmux new -d -s server ./start.sh</span>.</>
              )}
            </>
          )}
        </div>
      )}

      {noOutput ? (
        <div className="console-out dim">
          Keine Logdatei gefunden ({d?.cwd ? `${d.cwd}/logs/latest.log` : "Arbeitsordner unbekannt"}). Die Ausgabe des Servers geht
          an das Terminal, in dem er gestartet wurde.
          {extra ? `\n\n${extra}` : ""}
        </div>
      ) : (
        <OutputView text={out || (d ? "" : "Lade…")} />
      )}

      {minecraft && d?.rcon && (
        <div className="quick">
          {MC_QUICK.map((c) => (
            <button
              key={c.label}
              className="btn ghost"
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
          placeholder={d?.rcon ? "Befehl per RCON senden" : "Keine Eingabe möglich – siehe Hinweis oben"}
          disabled={!d?.rcon}
          value={input}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn sm primary" type="submit" disabled={!d?.rcon}>
          <SendHorizontal size={13} /> Senden
        </button>
      </form>
    </>
  );
}
