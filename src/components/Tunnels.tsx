import { useCallback, useEffect, useState } from "react";
import { ArrowRightLeft, Globe, Pencil, Play, Plus, RefreshCw, Square, Trash2, Zap } from "lucide-react";
import { api, errText } from "../lib/api";
import { bytes, uid } from "../lib/format";
import { confirm, run, toast, useStore } from "../lib/store";
import type { ListeningPort, TunnelDef, TunnelStatus } from "../lib/types";
import { Field, Modal } from "./ui";

const blank = (): TunnelDef => ({
  id: "",
  name: "",
  kind: "local",
  bindHost: "127.0.0.1",
  bindPort: 8080,
  remoteHost: "127.0.0.1",
  remotePort: 80,
  autoStart: false,
});

export function Tunnels({ connId, hostId, visible }: { connId: string; hostId: string; visible: boolean }) {
  const host = useStore((s) => s.vault?.hosts.find((h) => h.id === hostId));
  const reloadVault = useStore((s) => s.reloadVault);
  const [running, setRunning] = useState<TunnelStatus[]>([]);
  const [ports, setPorts] = useState<ListeningPort[] | null>(null);
  const [editing, setEditing] = useState<TunnelDef | null>(null);

  const poll = useCallback(async () => {
    try {
      setRunning(await api.tunnelList());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    poll();
    const t = setInterval(poll, 1500);
    return () => clearInterval(t);
  }, [visible, poll]);

  const loadPorts = useCallback(async () => {
    try {
      setPorts(await api.remotePorts(connId));
    } catch (e) {
      toast("error", errText(e));
      setPorts([]);
    }
  }, [connId]);

  useEffect(() => {
    if (visible && ports === null) loadPorts();
  }, [visible, ports, loadPorts]);

  if (!host) return null;
  const saved = host.tunnels;
  const runningIds = new Set(running.filter((r) => r.connId === connId).map((r) => r.id));
  const adhoc = running.filter((r) => r.connId === connId && !saved.some((s) => s.id === r.id));

  const persist = async (tunnels: TunnelDef[]) => {
    await api.hostSave({ ...host, tunnels });
    await reloadVault();
  };

  const start = async (def: TunnelDef) => {
    await run(() => api.tunnelStart(connId, def), `Tunnel „${def.name || def.bindPort}“ aktiv`);
    poll();
  };

  const stop = async (id: string) => {
    await run(() => api.tunnelStop(id));
    poll();
  };

  const save = async (def: TunnelDef, startNow: boolean) => {
    const d = { ...def, id: def.id || uid(), name: def.name.trim() || describe(def) };
    const exists = saved.some((s) => s.id === d.id);
    await run(() => persist(exists ? saved.map((s) => (s.id === d.id ? d : s)) : [...saved, d]));
    setEditing(null);
    if (startNow) {
      if (runningIds.has(d.id)) await api.tunnelStop(d.id);
      await start(d);
    }
  };

  const remove = async (def: TunnelDef) => {
    if (!(await confirm("Tunnel löschen", `„${def.name}“ entfernen?`, "Löschen", true))) return;
    if (runningIds.has(def.id)) await api.tunnelStop(def.id);
    await run(() => persist(saved.filter((s) => s.id !== def.id)));
    poll();
  };

  const quickForward = async (p: ListeningPort) => {
    const local = p.port < 1024 ? p.port + 10000 : p.port;
    const def: TunnelDef = {
      ...blank(),
      id: uid(),
      name: `${p.process || "Port"} :${p.port}`,
      bindPort: local,
      remoteHost: p.address === "0.0.0.0" || p.address === "*" || p.address === "::" ? "127.0.0.1" : p.address,
      remotePort: p.port,
    };
    await start(def);
  };

  const stat = (id: string) => running.find((r) => r.id === id);

  return (
    <div className="pane">
      <div className="pane-scroll">
        <div className="section-title">
          <span className="grow">Gespeicherte Tunnel</span>
          <button className="btn sm primary" onClick={() => setEditing(blank())}>
            <Plus size={14} /> Tunnel
          </button>
        </div>

        {saved.length === 0 && adhoc.length === 0 && (
          <div className="muted" style={{ padding: "8px 0 4px" }}>
            Noch keine Tunnel. Lege einen Local Forward (-L) an oder starte einen SOCKS5-Proxy (-D), um über den Server zu
            surfen.
          </div>
        )}

        {[...saved, ...adhoc.map(statusToDef)].map((def) => {
          const s = stat(def.id);
          const isSaved = saved.some((x) => x.id === def.id);
          return (
            <div className="list-item" key={def.id}>
              {def.kind === "dynamic" ? <Globe size={18} className="muted" /> : <ArrowRightLeft size={18} className="muted" />}
              <div className="grow">
                <div className="row">
                  <span style={{ fontWeight: 500 }}>{def.name}</span>
                  {s ? (
                    <span className="pill ok">
                      <span className="status-dot" /> aktiv
                    </span>
                  ) : (
                    <span className="pill">gestoppt</span>
                  )}
                  {def.autoStart && <span className="pill accent">Autostart</span>}
                  {!isSaved && <span className="pill warn">temporär</span>}
                </div>
                <div className="mono dim" style={{ fontSize: 12 }}>{describe(def)}</div>
              </div>
              {s && (
                <div className="mono dim" style={{ fontSize: 12, textAlign: "right" }}>
                  {s.active} offen · {s.totalConns} gesamt
                  <br />↑ {bytes(s.bytesUp)} ↓ {bytes(s.bytesDown)}
                </div>
              )}
              {s ? (
                <button className="btn sm" onClick={() => stop(def.id)}>
                  <Square size={12} /> Stoppen
                </button>
              ) : (
                <button className="btn sm primary" onClick={() => start(def)}>
                  <Play size={12} /> Starten
                </button>
              )}
              {isSaved ? (
                <>
                  <button className="btn sm icon ghost" title="Bearbeiten" onClick={() => setEditing(def)}>
                    <Pencil size={13} />
                  </button>
                  <button className="btn sm icon ghost" title="Löschen" onClick={() => remove(def)}>
                    <Trash2 size={13} />
                  </button>
                </>
              ) : (
                <button className="btn sm ghost" onClick={() => save(def, false)}>
                  Speichern
                </button>
              )}
            </div>
          );
        })}

        <div className="section-title">
          <span className="grow">Lauschende Ports auf dem Server</span>
          <button className="btn sm icon ghost" onClick={loadPorts} title="Aktualisieren">
            <RefreshCw size={14} />
          </button>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th className="num">Port</th>
              <th>Adresse</th>
              <th>Prozess</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(ports ?? []).map((p) => (
              <tr key={`${p.address}:${p.port}`}>
                <td className="num mono">{p.port}</td>
                <td className="mono dim">{p.address}</td>
                <td>{p.process || <span className="dim">–</span>}</td>
                <td>
                  <div className="row-actions" style={{ opacity: 1 }}>
                    <button className="btn sm ghost" onClick={() => quickForward(p)} title="Auf localhost weiterleiten">
                      <Zap size={13} /> Weiterleiten
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {ports?.length === 0 && <div className="dim" style={{ padding: 12 }}>Keine Ports gefunden (ss/netstat nicht verfügbar?)</div>}
      </div>

      {editing && <TunnelEditor def={editing} onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function describe(d: TunnelDef): string {
  return d.kind === "dynamic"
    ? `SOCKS5 ${d.bindHost}:${d.bindPort}`
    : `${d.bindHost}:${d.bindPort} → ${d.remoteHost}:${d.remotePort}`;
}

function statusToDef(s: TunnelStatus): TunnelDef {
  return { ...s, autoStart: false };
}

function TunnelEditor({
  def,
  onClose,
  onSave,
}: {
  def: TunnelDef;
  onClose: () => void;
  onSave: (d: TunnelDef, startNow: boolean) => void;
}) {
  const [d, setD] = useState(def);
  const set = <K extends keyof TunnelDef>(k: K, v: TunnelDef[K]) => setD((x) => ({ ...x, [k]: v }));
  const valid = d.bindPort > 0 && (d.kind === "dynamic" || (d.remoteHost.trim() && d.remotePort > 0));

  return (
    <Modal
      title={def.id ? "Tunnel bearbeiten" : "Neuer Tunnel"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn" disabled={!valid} onClick={() => onSave(d, false)}>
            Speichern
          </button>
          <button className="btn primary" disabled={!valid} onClick={() => onSave(d, true)}>
            Speichern & starten
          </button>
        </>
      }
    >
      <div className="seg" style={{ alignSelf: "flex-start" }}>
        <button className={d.kind === "local" ? "on" : ""} onClick={() => set("kind", "local")}>
          <ArrowRightLeft size={13} /> Local Forward (-L)
        </button>
        <button className={d.kind === "dynamic" ? "on" : ""} onClick={() => set("kind", "dynamic")}>
          <Globe size={13} /> SOCKS5 Proxy (-D)
        </button>
      </div>
      <Field label="Name">
        <input className="input" placeholder={describe(d)} value={d.name} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <div className="grid-3">
        <Field label="Lokal binden an">
          <input className="input mono" value={d.bindHost} onChange={(e) => set("bindHost", e.target.value)} />
        </Field>
        <Field label="Lokaler Port">
          <input
            className="input mono"
            type="number"
            value={d.bindPort}
            onChange={(e) => set("bindPort", Number(e.target.value))}
          />
        </Field>
        <div />
      </div>
      {d.kind === "local" && (
        <div className="grid-3">
          <Field label="Ziel (vom Server aus gesehen)">
            <input className="input mono" value={d.remoteHost} onChange={(e) => set("remoteHost", e.target.value)} />
          </Field>
          <Field label="Zielport">
            <input
              className="input mono"
              type="number"
              value={d.remotePort}
              onChange={(e) => set("remotePort", Number(e.target.value))}
            />
          </Field>
          <div />
        </div>
      )}
      {d.kind === "dynamic" && (
        <div className="muted" style={{ fontSize: 12 }}>
          Trage im Browser oder System einen SOCKS5-Proxy auf {d.bindHost}:{d.bindPort} ein – der gesamte Verkehr läuft dann
          über den Server.
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={d.autoStart} onChange={(e) => set("autoStart", e.target.checked)} />
        Beim Verbinden automatisch starten
      </label>
    </Modal>
  );
}
