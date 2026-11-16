import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Box,
  CirclePower,
  Container,
  Eraser,
  ExternalLink,
  Gamepad2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  SendHorizontal,
  Square,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { api, errText } from "../lib/api";
import { bytes, duration } from "../lib/format";
import { q, qPath, writeFileCmd } from "../lib/shell";
import { ask, confirm, run, toast, useStore } from "../lib/store";
import { Empty, Field, Modal } from "./ui";

/*
 * Konsolen: lang laufende Programme (Gameserver, Bots, …) auf dem Server.
 *
 * Kein Agent: jedes Programm läuft in einer eigenen tmux-Sitzung „fw-<id>“, gestartet über ein
 * kleines Startskript unter ~/.config/fernwerk/consoles/. Die Ausgabe holt Fernwerk per
 * `tmux capture-pane`, Eingaben gehen per `tmux send-keys` hinein. Dadurch läuft der Server
 * weiter, wenn Fernwerk geschlossen wird, und lässt sich jederzeit auch per `tmux attach` öffnen.
 */

const CONF_DIR = "~/.config/fernwerk/consoles";
const CONF_FILE = "~/.config/fernwerk/consoles.json";

interface ConsoleDef {
  id: string;
  name: string;
  preset: string;
  dir: string;
  command: string;
  /** Befehl zum sauberen Beenden, leer = Strg+C */
  stopCommand: string;
  autoRestart: boolean;
  bootStart: boolean;
}

interface QuickCmd {
  label: string;
  cmd: string;
  /** nur ins Eingabefeld übernehmen (braucht noch ein Argument) */
  fill?: boolean;
}

interface Preset {
  id: string;
  label: string;
  hint: string;
  dir: string;
  command: string;
  stop: string;
  quick: QuickCmd[];
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

const PRESETS: Preset[] = [
  {
    id: "minecraft",
    label: "Minecraft Java",
    hint: "Paper, Purpur, Fabric, Vanilla",
    dir: "~/minecraft",
    command: "java -Xms1G -Xmx4G -jar server.jar nogui",
    stop: "stop",
    quick: MC_QUICK,
  },
  {
    id: "bedrock",
    label: "Minecraft Bedrock",
    hint: "bedrock_server",
    dir: "~/bedrock",
    command: "LD_LIBRARY_PATH=. ./bedrock_server",
    stop: "stop",
    quick: [
      { label: "list", cmd: "list" },
      { label: "save hold", cmd: "save hold" },
      { label: "save resume", cmd: "save resume" },
      { label: "say …", cmd: "say ", fill: true },
      { label: "op …", cmd: "op ", fill: true },
      { label: "allowlist add …", cmd: "allowlist add ", fill: true },
    ],
  },
  {
    id: "terraria",
    label: "Terraria",
    hint: "Vanilla oder TShock",
    dir: "~/terraria",
    command: "./TerrariaServer.bin.x86_64 -config serverconfig.txt",
    stop: "exit",
    quick: [
      { label: "playing", cmd: "playing" },
      { label: "save", cmd: "save" },
      { label: "say …", cmd: "say ", fill: true },
      { label: "kick …", cmd: "kick ", fill: true },
      { label: "dawn", cmd: "dawn" },
    ],
  },
  {
    id: "factorio",
    label: "Factorio",
    hint: "Headless-Server",
    dir: "~/factorio",
    command: "./bin/x64/factorio --start-server saves/world.zip",
    stop: "",
    quick: [
      { label: "/players", cmd: "/players" },
      { label: "/save", cmd: "/save" },
      { label: "/admins", cmd: "/admins" },
    ],
  },
  {
    id: "app",
    label: "Node / Python",
    hint: "Bots, Webhooks, Skripte",
    dir: "~/app",
    command: "node index.js",
    stop: "",
    quick: [],
  },
  {
    id: "custom",
    label: "Eigener Befehl",
    hint: "Alles, was im Vordergrund läuft",
    dir: "~",
    command: "",
    stop: "",
    quick: [],
  },
];

const presetOf = (id: string) => PRESETS.find((p) => p.id === id) ?? PRESETS[PRESETS.length - 1];
const tmuxName = (id: string) => `fw-${id}`;

// ---------------------------------------------------------------- Server-Zugriff

async function sh(connId: string, cmd: string): Promise<string> {
  const r = await api.exec(connId, cmd);
  if (r.code !== 0 && r.code !== null) throw new Error((r.stderr || r.stdout).trim() || `Exit ${r.code}`);
  return r.stdout;
}

interface PaneInfo {
  name: string;
  dead: boolean;
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
  panes: Map<string, PaneInfo>;
}

const STATUS_CMD = [
  `echo "@@now $(date +%s)"`,
  `echo "@@tmux $(command -v tmux 2>/dev/null)"`,
  `tmux list-panes -a -F '#{session_name}\t#{pane_dead}\t#{pane_pid}\t#{pane_dead_status}\t#{session_created}\t#{session_attached}' 2>/dev/null`,
  `echo "@@ps"`,
  `ps -eo pid=,ppid=,pcpu=,rss= 2>/dev/null`,
].join("; ");

function parseSnapshot(out: string): Snapshot {
  let now = Math.floor(Date.now() / 1000);
  let tmux: string | null = null;
  const panes = new Map<string, PaneInfo>();
  const children = new Map<number, number[]>();
  const usage = new Map<number, { cpu: number; rss: number }>();
  let section = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("@@now ")) now = Number(line.slice(6)) || now;
    else if (line.startsWith("@@tmux")) {
      tmux = line.slice(6).trim() || null;
      section = "panes";
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
    } else if (section === "ps") {
      const [pid, ppid, cpu, rss] = line.trim().split(/\s+/).map(Number);
      if (!pid) continue;
      usage.set(pid, { cpu: cpu || 0, rss: (rss || 0) * 1024 });
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid)!.push(pid);
    }
  }
  // CPU/RAM über den ganzen Prozessbaum der Pane summieren
  for (const p of panes.values()) {
    if (p.dead) continue;
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
  return { now, tmux, panes };
}

function runScript(d: ConsoleDef): string {
  return [
    "#!/bin/sh",
    "# Von Fernwerk erzeugt – wird bei jedem Start neu geschrieben.",
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
    `STOP="$HOME/.config/fernwerk/consoles/${d.id}.stop"`,
    'rm -f "$STOP"',
    `cd ${qPath(d.dir)} || { echo "[fernwerk] Ordner nicht gefunden: ${d.dir.replace(/["$`\\]/g, "")}"; exit 1; }`,
    "while :; do",
    d.command,
    "  code=$?",
    '  if [ -f "$STOP" ]; then rm -f "$STOP"; echo "[fernwerk] gestoppt"; exit 0; fi',
    d.autoRestart
      ? '  echo "[fernwerk] beendet (Exit $code) – Neustart in 5 s"; sleep 5'
      : '  echo "[fernwerk] beendet (Exit $code)"; exit $code',
    "done",
    "",
  ].join("\n");
}

/** Startet die tmux-Sitzung so, dass die Ausgabe nach dem Ende erhalten bleibt. */
function launchCmd(d: ConsoleDef, tmux = "tmux"): string {
  const n = tmuxName(d.id);
  return [
    `${tmux} kill-session -t ${n} 2>/dev/null`,
    `${tmux} new-session -d -s ${n} -x 200 -y 50 'sleep 60' && ${tmux} set-window-option -t ${n} remain-on-exit on >/dev/null && ${tmux} respawn-pane -k -t ${n} "sh '$HOME/.config/fernwerk/consoles/${d.id}.sh'"`,
  ].join("; ");
}

function bootCmd(d: ConsoleDef, tmux: string): string {
  const strip = `crontab -l 2>/dev/null | grep -v ${q(`# fernwerk:${d.id}`)}`;
  if (!d.bootStart) return `(${strip}) | crontab -`;
  const n = tmuxName(d.id);
  const line = `@reboot sleep 10 && ${tmux} new-session -d -s ${n} -x 200 -y 50 'sleep 60' && ${tmux} set-window-option -t ${n} remain-on-exit on && ${tmux} respawn-pane -k -t ${n} "sh $HOME/.config/fernwerk/consoles/${d.id}.sh" # fernwerk:${d.id}`;
  return `(${strip}; printf '%s\\n' ${q(line)}) | crontab -`;
}

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

// ---------------------------------------------------------------- Hauptansicht

type Sel = { kind: "console"; id: string } | { kind: "tmux"; name: string } | { kind: "docker"; name: string };

export function Consoles({ sessionId, connId, visible }: { sessionId: string; connId: string; visible: boolean }) {
  const [defs, setDefs] = useState<ConsoleDef[] | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [docker, setDocker] = useState<DockerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const [editing, setEditing] = useState<ConsoleDef | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadDefs = useCallback(async () => {
    try {
      const out = await sh(connId, `cat ${qPath(CONF_FILE)} 2>/dev/null || true`);
      const parsed = out.trim() ? JSON.parse(out) : { consoles: [] };
      setDefs(Array.isArray(parsed.consoles) ? parsed.consoles : []);
      setError(null);
    } catch (e) {
      setError(errText(e));
      setDefs([]);
    }
  }, [connId]);

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
    if (defs === null) loadDefs();
    refreshDocker();
    refresh();
    const t = setInterval(refresh, 3000);
    const d = setInterval(refreshDocker, 10000);
    return () => {
      clearInterval(t);
      clearInterval(d);
    };
  }, [visible, defs, loadDefs, refresh, refreshDocker]);

  // Erste Konsole automatisch auswählen
  useEffect(() => {
    if (!sel && defs && defs.length > 0) setSel({ kind: "console", id: defs[0].id });
  }, [defs, sel]);

  const saveDefs = async (next: ConsoleDef[]) => {
    await sh(
      connId,
      `mkdir -p ${qPath(CONF_DIR)} && ${writeFileCmd(CONF_FILE, JSON.stringify({ version: 1, consoles: next }, null, 2))}`,
    );
    setDefs(next);
  };

  const tmux = snap?.tmux ?? null;

  const start = async (d: ConsoleDef) => {
    if (!tmux) return toast("error", "tmux ist auf dem Server nicht installiert");
    setBusy(d.id);
    await run(
      () =>
        sh(
          connId,
          `mkdir -p ${qPath(CONF_DIR)} && ${writeFileCmd(`${CONF_DIR}/${d.id}.sh`, runScript(d))} && ${launchCmd(d, tmux)}`,
        ),
      `${d.name} gestartet`,
    );
    setBusy(null);
    refresh();
  };

  const waitDead = async (name: string, seconds: number) => {
    for (let i = 0; i < seconds; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = parseSnapshot((await api.exec(connId, STATUS_CMD)).stdout);
      setSnap(s);
      const p = s.panes.get(name);
      if (!p || p.dead) return true;
    }
    return false;
  };

  const stop = async (d: ConsoleDef, then?: () => Promise<void>) => {
    const n = tmuxName(d.id);
    setBusy(d.id);
    try {
      const keys = d.stopCommand.trim() ? `-l -- ${q(d.stopCommand.trim())} && tmux send-keys -t ${n} Enter` : "C-c";
      await sh(connId, `touch ${qPath(`${CONF_DIR}/${d.id}.stop`)}; tmux send-keys -t ${n} ${keys}`);
      toast("info", `${d.name} wird beendet…`);
      if (!(await waitDead(n, 45))) {
        if (await confirm("Reagiert nicht", `${d.name} läuft nach 45 Sekunden noch. Prozess hart beenden?`, "Beenden erzwingen", true)) {
          await sh(connId, `tmux kill-session -t ${n}`);
        } else return;
      }
      if (then) await then();
      else toast("ok", `${d.name} gestoppt`);
    } catch (e) {
      toast("error", errText(e));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const restart = (d: ConsoleDef) => stop(d, () => start(d));

  const remove = async (d: ConsoleDef) => {
    const r = await ask({
      title: `${d.name} entfernen`,
      message: "Entfernt den Eintrag aus Fernwerk und beendet eine laufende Sitzung sofort. Der Server-Ordner bleibt unangetastet.",
      detail: d.dir,
      confirm: "Entfernen",
      danger: true,
    });
    if (!r) return;
    await run(async () => {
      await sh(
        connId,
        `tmux kill-session -t ${tmuxName(d.id)} 2>/dev/null; rm -f ${qPath(`${CONF_DIR}/${d.id}.sh`)} ${qPath(`${CONF_DIR}/${d.id}.stop`)}; ${d.bootStart && tmux ? `${bootCmd({ ...d, bootStart: false }, tmux)} || true` : "true"}`,
      );
      await saveDefs((defs ?? []).filter((x) => x.id !== d.id));
      setSel(null);
    }, `${d.name} entfernt`);
    refresh();
  };

  const saveDef = async (d: ConsoleDef, extra: { eula: boolean; download: string }) => {
    const prev = (defs ?? []).find((x) => x.id === d.id);
    const isNew = !prev;
    const ok = await run(async () => {
      const steps = [`mkdir -p ${qPath(d.dir)}`];
      if (extra.eula) steps.push(`printf 'eula=true\\n' > ${qPath(d.dir)}/eula.txt`);
      if (extra.download.trim()) {
        const jar = d.command.match(/-jar\s+(\S+)/)?.[1] ?? "server.jar";
        const url = q(extra.download.trim());
        steps.push(
          `cd ${qPath(d.dir)} && { curl -fsSL -o ${q(jar)} ${url} || wget -q -O ${q(jar)} ${url}; }`,
        );
      }
      if (tmux && d.bootStart) steps.push(bootCmd(d, tmux));
      else if (tmux && prev?.bootStart) steps.push(`{ ${bootCmd(d, tmux)} || true; }`);
      await sh(connId, steps.join(" && "));
      await saveDefs(isNew ? [...(defs ?? []), d] : (defs ?? []).map((x) => (x.id === d.id ? d : x)));
      return true;
    }, isNew ? `${d.name} angelegt` : "Gespeichert");
    if (ok) {
      setEditing(null);
      setSel({ kind: "console", id: d.id });
    }
  };

  const installTmux = async () => {
    const pm = (await api.exec(connId, "for p in apt-get dnf yum pacman apk zypper; do command -v $p >/dev/null 2>&1 && { echo $p; break; }; done")).stdout.trim();
    const cmd: Record<string, string> = {
      "apt-get": "sudo apt-get install -y tmux",
      dnf: "sudo dnf install -y tmux",
      yum: "sudo yum install -y tmux",
      pacman: "sudo pacman -S --noconfirm tmux",
      apk: "sudo apk add tmux",
      zypper: "sudo zypper install -y tmux",
    };
    if (!cmd[pm]) return toast("error", "Paketmanager nicht erkannt – bitte tmux manuell installieren");
    useStore.getState().addTerminal(sessionId, cmd[pm]);
  };

  // tmux-Sitzungen, die nicht von Fernwerk stammen
  const foreign = useMemo(
    () => [...(snap?.panes.values() ?? [])].filter((p) => !p.name.startsWith("fw-")).sort((a, b) => a.name.localeCompare(b.name)),
    [snap],
  );

  if (error && !defs?.length) {
    return (
      <div className="pane">
        <Empty icon={<Gamepad2 size={30} />} title="Konsolen nicht verfügbar">
          <div className="muted">{error}</div>
        </Empty>
      </div>
    );
  }

  const selDef = sel?.kind === "console" ? defs?.find((d) => d.id === sel.id) : undefined;
  const selPane =
    sel?.kind === "console" ? snap?.panes.get(tmuxName(sel.id)) : sel?.kind === "tmux" ? snap?.panes.get(sel.name) : undefined;
  const selContainer = sel?.kind === "docker" && docker?.kind === "ok" ? docker.list.find((c) => c.name === sel.name) : undefined;

  return (
    <div className="consoles">
      <div className="console-list">
        <div className="side-section">
          <span>Server &amp; Programme</span>
        </div>
        {defs === null && <div className="dim" style={{ padding: "6px 14px" }}>Lade…</div>}
        {defs?.map((d) => {
          const p = snap?.panes.get(tmuxName(d.id));
          const st = paneState(p);
          return (
            <div
              key={d.id}
              className={`console-item ${sel?.kind === "console" && sel.id === d.id ? "on" : ""}`}
              onClick={() => setSel({ kind: "console", id: d.id })}
            >
              <span className={`console-state ${st === "up" ? "up" : st === "crash" ? "crash" : ""}`} />
              <div className="grow">
                <div className="ellipsis">{d.name}</div>
                <div className="sub ellipsis">
                  {presetOf(d.preset).label} · {stateLabel(st)}
                </div>
              </div>
            </div>
          );
        })}
        {defs?.length === 0 && (
          <div className="dim" style={{ padding: "4px 14px 10px", fontSize: 12 }}>
            Minecraft-Server, Discord-Bot oder ein anderes Programm dauerhaft im Hintergrund laufen lassen – mit Live-Konsole.
          </div>
        )}

        {foreign.length > 0 && (
          <>
            <div className="side-section">
              <span>tmux-Sitzungen</span>
              <span>{foreign.length}</span>
            </div>
            {foreign.map((p) => (
              <div
                key={p.name}
                className={`console-item ${sel?.kind === "tmux" && sel.name === p.name ? "on" : ""}`}
                onClick={() => setSel({ kind: "tmux", name: p.name })}
              >
                <span className={`console-state ${p.dead ? "" : "up"}`} />
                <div className="grow">
                  <div className="ellipsis mono">{p.name}</div>
                  <div className="sub">{p.attached ? "angehängt" : "losgelöst"}</div>
                </div>
              </div>
            ))}
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
            {docker.list.length === 0 && <div className="dim" style={{ padding: "4px 14px", fontSize: 12 }}>Keine Container</div>}
            {docker.list.map((c) => (
              <div
                key={c.id}
                className={`console-item ${sel?.kind === "docker" && sel.name === c.name ? "on" : ""}`}
                onClick={() => setSel({ kind: "docker", name: c.name })}
              >
                <span className={`console-state ${c.state === "running" ? "up" : c.state === "exited" && !/\(0\)/.test(c.status) ? "crash" : ""}`} />
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
        {snap && !snap.tmux ? (
          <Empty icon={<SquareTerminal size={30} />} title="tmux fehlt auf dem Server">
            <div className="muted" style={{ maxWidth: 440 }}>
              Fernwerk startet Programme in tmux, damit sie weiterlaufen, wenn du die Verbindung trennst. tmux ist klein und in
              jeder Distribution enthalten.
            </div>
            <button className="btn primary" onClick={installTmux}>
              <SquareTerminal size={14} /> Im Terminal installieren
            </button>
            <button className="btn ghost" onClick={refresh}>
              <RefreshCw size={13} /> Erneut prüfen
            </button>
          </Empty>
        ) : selDef ? (
          <ConsoleView
            key={selDef.id}
            connId={connId}
            target={tmuxName(selDef.id)}
            title={selDef.name}
            subtitle={`${selDef.dir} · ${selDef.command.split("\n")[0]}`}
            pane={selPane}
            now={snap?.now}
            quick={presetOf(selDef.preset).quick}
            minecraft={selDef.preset === "minecraft" || selDef.preset === "bedrock"}
            busy={busy === selDef.id}
            visible={visible}
            onAcceptEula={selDef.preset !== "minecraft" ? undefined : async () => {
              await run(() => sh(connId, `printf 'eula=true\\n' > ${qPath(selDef.dir)}/eula.txt`), "EULA akzeptiert");
              await start(selDef);
            }}
            actions={
              <>
                {paneState(selPane) === "up" ? (
                  <>
                    <button className="btn" disabled={busy === selDef.id} onClick={() => restart(selDef)}>
                      <RotateCw size={14} /> Neustart
                    </button>
                    <button className="btn" disabled={busy === selDef.id} onClick={() => stop(selDef)}>
                      <Square size={13} /> Stoppen
                    </button>
                  </>
                ) : (
                  <button className="btn primary" disabled={busy === selDef.id} onClick={() => start(selDef)}>
                    <Play size={14} /> Starten
                  </button>
                )}
                <button className="btn icon" title="Bearbeiten" onClick={() => setEditing(selDef)}>
                  <Pencil size={14} />
                </button>
                <button className="btn icon ghost danger" title="Entfernen" onClick={() => remove(selDef)}>
                  <Trash2 size={14} />
                </button>
              </>
            }
            attach={
              selPane && !selPane.dead
                ? () => useStore.getState().addTerminal(sessionId, `tmux attach -t ${tmuxName(selDef.id)}`)
                : undefined
            }
          />
        ) : sel?.kind === "tmux" && selPane ? (
          <ConsoleView
            key={sel.name}
            connId={connId}
            target={sel.name}
            title={sel.name}
            subtitle="tmux-Sitzung"
            pane={selPane}
            now={snap?.now}
            quick={[]}
            visible={visible}
            actions={
              <button
                className="btn ghost danger"
                onClick={async () => {
                  if (!(await confirm("Sitzung beenden", `tmux-Sitzung „${sel.name}“ mit allen Programmen darin beenden?`, "Beenden", true))) return;
                  await run(() => sh(connId, `tmux kill-session -t ${q(sel.name)}`));
                  setSel(null);
                  refresh();
                }}
              >
                <CirclePower size={14} /> Beenden
              </button>
            }
            attach={() => useStore.getState().addTerminal(sessionId, `tmux attach -t ${q(sel.name)}`)}
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
          <Empty icon={<Gamepad2 size={30} />} title="Konsolen">
            <div className="muted" style={{ maxWidth: 460 }}>
              Gameserver und andere Dauerläufer direkt auf dem Server betreiben: starten, stoppen, Live-Konsole, Befehle senden,
              Auto-Neustart nach Absturz und Start beim Hochfahren. Läuft in tmux weiter, auch wenn Fernwerk geschlossen ist.
            </div>
            <button className="btn primary" disabled={!snap} onClick={() => setEditing("new")}>
              <Plus size={14} /> Konsole anlegen
            </button>
          </Empty>
        )}
      </div>

      {editing && (
        <ConsoleEditor def={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSave={saveDef} />
      )}
    </div>
  );
}

type PaneStateKind = "up" | "off" | "stopped" | "crash";

function paneState(p: PaneInfo | undefined): PaneStateKind {
  if (!p) return "off";
  if (!p.dead) return "up";
  return p.exit && p.exit !== 0 && p.exit !== 130 ? "crash" : "stopped";
}

function stateLabel(s: PaneStateKind) {
  return { up: "läuft", off: "aus", stopped: "beendet", crash: "abgestürzt" }[s];
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
  target,
  title,
  subtitle,
  pane,
  now,
  quick,
  minecraft,
  busy,
  visible,
  actions,
  attach,
  onAcceptEula,
}: {
  connId: string;
  target: string;
  title: string;
  subtitle: string;
  pane: PaneInfo | undefined;
  now: number | undefined;
  quick: QuickCmd[];
  minecraft?: boolean;
  busy?: boolean;
  visible: boolean;
  actions: ReactNode;
  attach?: () => void;
  onAcceptEula?: () => void;
}) {
  const [text, setText] = useState("");
  const [input, setInput] = useState("");
  const history = useRef<string[]>([]);
  const histIdx = useRef(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const exists = !!pane;
  const alive = !!pane && !pane.dead;

  const poll = useCallback(async () => {
    try {
      const r = await api.exec(connId, `tmux capture-pane -p -J -S -2000 -t ${q(target)} 2>/dev/null`);
      if (r.code === 0) setText(r.stdout.replace(/\s+$/, ""));
    } catch {
      /* ignorieren */
    }
  }, [connId, target]);

  useEffect(() => {
    if (!visible || !exists) return;
    poll();
    const t = setInterval(poll, alive ? 1000 : 4000);
    return () => clearInterval(t);
  }, [visible, exists, alive, poll]);

  const send = async (cmd: string) => {
    if (!alive) return toast("info", "Das Programm läuft gerade nicht");
    if (cmd.trim()) {
      history.current = [cmd, ...history.current.filter((h) => h !== cmd)].slice(0, 100);
    }
    histIdx.current = -1;
    await run(() =>
      api.exec(connId, `tmux send-keys -t ${q(target)} -l -- ${q(cmd)} && tmux send-keys -t ${q(target)} Enter`).then((r) => {
        if (r.code !== 0) throw new Error(r.stderr.trim() || "Senden fehlgeschlagen");
      }),
    );
    setTimeout(poll, 250);
  };

  const players = useMemo(() => {
    if (!minecraft) return null;
    const all = [...text.matchAll(/There are (\d+)(?:\/| of a max(?: of)? )(\d+) players online:?[ 	]*(.*)$/gm)];
    const m = all[all.length - 1];
    return m ? { n: Number(m[1]), max: Number(m[2]), names: m[3].trim() } : null;
  }, [text, minecraft]);

  const needsEula = minecraft && !alive && /agree to the EULA|eula\.txt/i.test(text.slice(-3000));
  const st = paneState(pane);

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
          <button className="btn ghost" title="In einer Shell öffnen (tmux attach – Strg+B, D zum Lösen)" onClick={attach}>
            <ExternalLink size={14} /> Im Terminal
          </button>
        )}
        {actions}
      </div>

      <div className="console-meta">
        <div>
          <span>Status</span>
          <b className={st === "crash" ? "err" : st === "up" ? "" : "muted"}>
            {busy ? "…" : stateLabel(st)}
            {pane?.dead && pane.exit != null ? ` (${pane.exit})` : ""}
          </b>
        </div>
        <div>
          <span>Laufzeit</span>
          <b>{alive && now ? duration(Math.max(0, now - pane!.created)) : "–"}</b>
        </div>
        <div>
          <span>CPU</span>
          <b>{alive ? `${pane!.cpu.toFixed(0)} %` : "–"}</b>
        </div>
        <div>
          <span>RAM</span>
          <b>{alive ? bytes(pane!.rss) : "–"}</b>
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

      {needsEula && onAcceptEula && (
        <div className="broadcast-bar" style={{ textTransform: "none", letterSpacing: 0 }}>
          <span className="grow">
            Der Server startet erst, wenn die Minecraft-EULA (aka.ms/MinecraftEULA) akzeptiert ist.
          </span>
          <button className="btn sm" onClick={onAcceptEula}>
            Akzeptieren &amp; starten
          </button>
        </div>
      )}

      {exists ? (
        <OutputView text={text} />
      ) : (
        <div className="console-out">
          <span className="dim">Nicht gestartet. Die Ausgabe erscheint hier, sobald das Programm läuft.</span>
        </div>
      )}

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
              api.exec(connId, `tmux send-keys -t ${q(target)} C-c`).then(() => setTimeout(poll, 300));
            }
          }}
        />
        <button className="btn sm ghost" type="button" title="Ansicht leeren (tmux clear-history)" disabled={!exists}
          onClick={() => api.exec(connId, `tmux clear-history -t ${q(target)}`).then(poll)}>
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

// ---------------------------------------------------------------- Editor

function ConsoleEditor({
  def,
  onClose,
  onSave,
}: {
  def: ConsoleDef | null;
  onClose: () => void;
  onSave: (d: ConsoleDef, extra: { eula: boolean; download: string }) => Promise<void>;
}) {
  const [d, setD] = useState<ConsoleDef>(
    def ?? {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 8),
      name: "",
      preset: "minecraft",
      dir: PRESETS[0].dir,
      command: PRESETS[0].command,
      stopCommand: PRESETS[0].stop,
      autoRestart: true,
      bootStart: false,
    },
  );
  const [eula, setEula] = useState(false);
  const [download, setDownload] = useState("");
  const [ram, setRam] = useState(() => d.command.match(/-Xmx(\d+[GM])/)?.[1] ?? "4G");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ConsoleDef>(k: K, v: ConsoleDef[K]) => setD((x) => ({ ...x, [k]: v }));

  const pickPreset = (p: Preset) => {
    setD((x) => ({
      ...x,
      preset: p.id,
      dir: def ? x.dir : p.dir,
      command: p.command,
      stopCommand: p.stop,
    }));
  };

  const setRamValue = (v: string) => {
    setRam(v);
    setD((x) => ({ ...x, command: x.command.replace(/-Xmx\S+/, `-Xmx${v}`) }));
  };

  const valid = d.dir.trim() && d.command.trim();

  return (
    <Modal
      size="wide"
      title={def ? `${def.name} bearbeiten` : "Neue Konsole"}
      icon={<Box size={16} className="gold" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button
            className="btn primary"
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              await onSave({ ...d, name: d.name.trim() || presetOf(d.preset).label }, { eula, download });
              setBusy(false);
            }}
          >
            {busy ? "Speichere…" : def ? "Speichern" : "Anlegen"}
          </button>
        </>
      }
    >
      {!def && (
        <div className="preset-grid">
          {PRESETS.map((p) => (
            <div key={p.id} className={`preset ${d.preset === p.id ? "on" : ""}`} onClick={() => pickPreset(p)}>
              <b>{p.label}</b>
              <span>{p.hint}</span>
            </div>
          ))}
        </div>
      )}
      <div className="grid-2">
        <Field label="Name">
          <input className="input" autoFocus placeholder={presetOf(d.preset).label} value={d.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Ordner auf dem Server">
          <input className="input mono" value={d.dir} onChange={(e) => set("dir", e.target.value)} />
        </Field>
      </div>
      <Field label="Startbefehl (läuft im Ordner, im Vordergrund)">
        <textarea className="textarea" rows={2} value={d.command} onChange={(e) => set("command", e.target.value)} />
      </Field>
      <div className="grid-2">
        {d.preset === "minecraft" && (
          <Field label="Max. Arbeitsspeicher">
            <div className="seg" style={{ width: "fit-content" }}>
              {["2G", "4G", "6G", "8G", "12G", "16G"].map((v) => (
                <button key={v} type="button" className={ram === v ? "on" : ""} onClick={() => setRamValue(v)}>
                  {v}
                </button>
              ))}
            </div>
          </Field>
        )}
        <Field label="Stopp-Befehl (leer = Strg+C)">
          <input className="input mono" value={d.stopCommand} placeholder="Strg+C" onChange={(e) => set("stopCommand", e.target.value)} />
        </Field>
      </div>
      {d.preset === "minecraft" && !def && (
        <Field label="Server-JAR herunterladen (optional, URL)">
          <input
            className="input mono"
            placeholder="https://… (z.B. Download-Link von papermc.io)"
            value={download}
            onChange={(e) => setDownload(e.target.value)}
          />
        </Field>
      )}
      <div className="col">
        <label className="check">
          <input type="checkbox" checked={d.autoRestart} onChange={(e) => set("autoRestart", e.target.checked)} />
          Nach Absturz automatisch neu starten (5 s Pause)
        </label>
        <label className="check">
          <input type="checkbox" checked={d.bootStart} onChange={(e) => set("bootStart", e.target.checked)} />
          Beim Hochfahren des Servers starten (Eintrag in deiner crontab)
        </label>
        {d.preset === "minecraft" && !def && (
          <label className="check">
            <input type="checkbox" checked={eula} onChange={(e) => setEula(e.target.checked)} />
            Minecraft-EULA akzeptieren (aka.ms/MinecraftEULA)
          </label>
        )}
      </div>
    </Modal>
  );
}
