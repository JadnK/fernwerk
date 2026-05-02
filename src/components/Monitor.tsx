import { useEffect, useRef, useState } from "react";
import { Activity, Pause, Play, Skull, XCircle } from "lucide-react";
import { api, errText } from "../lib/api";
import { bytes, duration, pct, rate } from "../lib/format";
import { confirm, run, withSudo } from "../lib/store";
import type { Stats } from "../lib/types";
import { Bar, Empty, Sparkline } from "./ui";

interface History {
  cpu: number[];
  mem: number[];
  rx: number[];
  tx: number[];
}

const HISTORY = 60;
const push = (arr: number[], v: number) => [...arr, v].slice(-HISTORY);

export function Monitor({ sessionId, connId, visible }: { sessionId: string; connId: string; visible: boolean }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [interval, setIntervalMs] = useState(2000);
  const hist = useRef<History>({ cpu: [], mem: [], rx: [], tx: [] });
  const [, force] = useState(0);

  useEffect(() => {
    if (!visible || paused) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await api.stats(connId);
        if (!alive) return;
        const h = hist.current;
        if (s.cpu != null) h.cpu = push(h.cpu, s.cpu);
        h.mem = push(h.mem, s.mem.total ? (s.mem.used / s.mem.total) * 100 : 0);
        if (s.rxRate != null) h.rx = push(h.rx, s.rxRate);
        if (s.txRate != null) h.tx = push(h.tx, s.txRate);
        setStats(s);
        setError(null);
        force((x) => x + 1);
        // Erste Abfrage liefert noch keine CPU-Differenz → schnell nachlegen
        timer = setTimeout(tick, s.cpu == null ? 500 : interval);
      } catch (e) {
        if (!alive) return;
        setError(errText(e));
        timer = setTimeout(tick, interval * 3);
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [visible, paused, connId, interval]);

  const kill = async (pid: number, cmd: string, signal: "TERM" | "KILL") => {
    if (!(await confirm("Prozess beenden", `${cmd} (PID ${pid}) mit SIG${signal} beenden?`, "Beenden", signal === "KILL")))
      return;
    await run(() => withSudo(sessionId, (pw) => api.processKill(connId, pid, signal, pw)), `SIG${signal} an ${pid} gesendet`);
  };

  if (error && !stats) {
    return (
      <div className="pane">
        <Empty icon={<Activity size={28} />} title="Monitoring nicht verfügbar">
          <div className="muted">{error}</div>
        </Empty>
      </div>
    );
  }
  if (!stats) {
    return (
      <div className="pane">
        <Empty icon={<Activity size={28} />} title="Lade Serverdaten…" />
      </div>
    );
  }

  const h = hist.current;
  const memPct = stats.mem.total ? (stats.mem.used / stats.mem.total) * 100 : 0;
  const swapPct = stats.mem.swapTotal ? (stats.mem.swapUsed / stats.mem.swapTotal) * 100 : 0;
  const netMax = Math.max(1024, ...h.rx, ...h.tx);

  return (
    <div className="pane">
      <div className="pane-scroll">
        <div className="row" style={{ marginBottom: 16 }}>
          <div className="grow">
            <div style={{ fontSize: 16, fontWeight: 600 }}>{stats.hostname}</div>
            <div className="dim mono" style={{ fontSize: 12 }}>
              {stats.os} · Kernel {stats.kernel} · {stats.cores} Kerne · up {duration(stats.uptime)} · {stats.sessions}{" "}
              Sitzung{stats.sessions === 1 ? "" : "en"}
            </div>
          </div>
          {error && <span className="pill err">{error}</span>}
          <div className="seg">
            {[1000, 2000, 5000].map((ms) => (
              <button key={ms} className={interval === ms ? "on" : ""} onClick={() => setIntervalMs(ms)}>
                {ms / 1000}s
              </button>
            ))}
          </div>
          <button className="btn icon" title={paused ? "Fortsetzen" : "Pausieren"} onClick={() => setPaused(!paused)}>
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
        </div>

        <div className="cards">
          <div className="card">
            <h4>CPU</h4>
            <div className="metric">
              {pct(stats.cpu, 1)}
              <small>
                Load {stats.load.map((l) => l.toFixed(2)).join(" ")}
              </small>
            </div>
            <Sparkline data={h.cpu} max={100} />
          </div>
          <div className="card">
            <h4>Arbeitsspeicher</h4>
            <div className="metric">
              {bytes(stats.mem.used)}
              <small>von {bytes(stats.mem.total)}</small>
            </div>
            <Sparkline data={h.mem} max={100} color="var(--info)" />
            {stats.mem.swapTotal > 0 && (
              <div className="col" style={{ gap: 4 }}>
                <div className="row dim" style={{ fontSize: 12 }}>
                  <span className="grow">Swap</span>
                  <span className="mono">
                    {bytes(stats.mem.swapUsed)} / {bytes(stats.mem.swapTotal)}
                  </span>
                </div>
                <Bar value={swapPct} />
              </div>
            )}
          </div>
          <div className="card">
            <h4>Netzwerk</h4>
            <div className="row mono" style={{ fontSize: 13 }}>
              <span className="grow">
                <span className="ok">↓</span> {rate(stats.rxRate)}
              </span>
              <span>
                <span style={{ color: "var(--accent)" }}>↑</span> {rate(stats.txRate)}
              </span>
            </div>
            <Sparkline data={h.rx} max={netMax} color="var(--ok)" />
            <Sparkline data={h.tx} max={netMax} />
            <div className="dim mono" style={{ fontSize: 11 }}>
              gesamt ↓ {bytes(stats.rxTotal)} · ↑ {bytes(stats.txTotal)}
            </div>
          </div>
          <div className="card">
            <h4>Auslastung</h4>
            <div className="col" style={{ gap: 10 }}>
              <div className="col" style={{ gap: 4 }}>
                <div className="row" style={{ fontSize: 12 }}>
                  <span className="grow muted">CPU</span>
                  <span className="mono">{pct(stats.cpu)}</span>
                </div>
                <Bar value={stats.cpu ?? 0} />
              </div>
              <div className="col" style={{ gap: 4 }}>
                <div className="row" style={{ fontSize: 12 }}>
                  <span className="grow muted">RAM</span>
                  <span className="mono">{pct(memPct)}</span>
                </div>
                <Bar value={memPct} />
              </div>
              <div className="col" style={{ gap: 4 }}>
                <div className="row" style={{ fontSize: 12 }}>
                  <span className="grow muted">Load / Kern</span>
                  <span className="mono">{(stats.load[0] / Math.max(1, stats.cores)).toFixed(2)}</span>
                </div>
                <Bar value={(stats.load[0] / Math.max(1, stats.cores)) * 100} />
              </div>
            </div>
          </div>
        </div>

        <div className="section-title">Datenträger</div>
        <div className="cards">
          {stats.disks.map((d) => {
            const p = d.size ? (d.used / d.size) * 100 : 0;
            return (
              <div className="card" key={d.mount + d.fs}>
                <div className="row">
                  <span className="mono grow ellipsis" title={d.fs}>
                    {d.mount}
                  </span>
                  <span className={`mono ${p > 90 ? "err" : p > 75 ? "warn" : "muted"}`}>{pct(p)}</span>
                </div>
                <Bar value={p} />
                <div className="dim mono" style={{ fontSize: 11 }}>
                  {bytes(d.used)} / {bytes(d.size)} · {d.fs}
                </div>
              </div>
            );
          })}
        </div>

        <div className="section-title">Prozesse (Top nach CPU)</div>
        <table className="table">
          <thead>
            <tr>
              <th className="num">PID</th>
              <th>Benutzer</th>
              <th className="num">CPU</th>
              <th className="num">RAM</th>
              <th className="num">RSS</th>
              <th>Befehl</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {stats.procs.map((p) => (
              <tr key={p.pid}>
                <td className="num mono dim">{p.pid}</td>
                <td>{p.user}</td>
                <td className="num mono">{p.cpu.toFixed(1)}</td>
                <td className="num mono">{p.mem.toFixed(1)}</td>
                <td className="num mono dim">{bytes(p.rss)}</td>
                <td className="mono">{p.command}</td>
                <td>
                  <div className="row-actions">
                    <button className="btn sm icon ghost" title="Beenden (TERM)" onClick={() => kill(p.pid, p.command, "TERM")}>
                      <XCircle size={13} />
                    </button>
                    <button className="btn sm icon ghost danger" title="Erzwingen (KILL)" onClick={() => kill(p.pid, p.command, "KILL")}>
                      <Skull size={13} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
