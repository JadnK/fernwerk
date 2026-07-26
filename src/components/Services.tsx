import { useCallback, useEffect, useMemo, useState } from "react";
import { FileClock, Play, RefreshCw, RotateCw, Square, ToggleLeft, ToggleRight } from "lucide-react";
import { api, errText } from "../lib/api";
import { run, withSudo } from "../lib/store";
import type { Service } from "../lib/types";
import { Empty, Modal } from "./ui";

type Filter = "running" | "failed" | "all";

export function Services({ sessionId, connId, visible }: { sessionId: string; connId: string; visible: boolean }) {
  const [list, setList] = useState<Service[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("running");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ unit: string; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.services(connId));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [connId]);

  useEffect(() => {
    if (visible && list === null) load();
  }, [visible, list, load]);

  const shown = useMemo(() => {
    if (!list) return [];
    return list.filter((s) => {
      if (filter === "running" && s.sub !== "running") return false;
      if (filter === "failed" && s.active !== "failed") return false;
      if (query && !`${s.unit} ${s.description}`.toLowerCase().includes(query.toLowerCase())) return false;
      return true;
    });
  }, [list, filter, query]);

  const counts = useMemo(
    () => ({
      running: list?.filter((s) => s.sub === "running").length ?? 0,
      failed: list?.filter((s) => s.active === "failed").length ?? 0,
      all: list?.length ?? 0,
    }),
    [list],
  );

  const act = async (unit: string, action: string) => {
    setBusy(unit + action);
    await run(() => withSudo(sessionId, (pw) => api.serviceAction(connId, unit, action, pw)), `${unit}: ${action} ausgeführt`);
    setBusy(null);
    load();
  };

  const showLogs = async (unit: string) => {
    const text = await run(() => withSudo(sessionId, (pw) => api.serviceLogs(connId, unit, 300, pw)));
    if (text !== undefined) setLogs({ unit, text: text || "(keine Einträge)" });
  };

  if (error) {
    return (
      <div className="pane">
        <Empty title="Dienste nicht verfügbar">
          <div className="muted">{error}</div>
        </Empty>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="toolbar">
        <div className="seg">
          <button className={filter === "running" ? "on" : ""} onClick={() => setFilter("running")}>
            Laufend <span className="dim">{counts.running}</span>
          </button>
          <button className={filter === "failed" ? "on" : ""} onClick={() => setFilter("failed")}>
            Fehler <span className={counts.failed ? "err" : "dim"}>{counts.failed}</span>
          </button>
          <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
            Alle <span className="dim">{counts.all}</span>
          </button>
        </div>
        <input className="input" style={{ width: 240 }} placeholder="Dienst suchen…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="btn icon ghost" style={{ marginLeft: "auto" }} onClick={load} title="Aktualisieren">
          <RefreshCw size={15} />
        </button>
      </div>
      <div className="file-list">
        <table className="table">
          <thead>
            <tr>
              <th>Dienst</th>
              <th>Status</th>
              <th>Autostart</th>
              <th>Beschreibung</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => {
              const running = s.sub === "running";
              const failed = s.active === "failed";
              const enabled = s.enabled === "enabled";
              return (
                <tr key={s.unit}>
                  <td className="mono">{s.unit.replace(/\.service$/, "")}</td>
                  <td>
                    <span className={`pill ${failed ? "err" : running ? "ok" : ""}`}>
                      <span className="status-dot" />
                      {s.sub}
                    </span>
                  </td>
                  <td className="dim">{s.enabled || "–"}</td>
                  <td className="muted ellipsis" style={{ maxWidth: 380 }}>
                    {s.description}
                  </td>
                  <td>
                    <div className="row-actions">
                      {running ? (
                        <button className="btn sm icon ghost" title="Stoppen" disabled={!!busy} onClick={() => act(s.unit, "stop")}>
                          <Square size={12} />
                        </button>
                      ) : (
                        <button className="btn sm icon ghost" title="Starten" disabled={!!busy} onClick={() => act(s.unit, "start")}>
                          <Play size={13} />
                        </button>
                      )}
                      <button className="btn sm icon ghost" title="Neu starten" disabled={!!busy} onClick={() => act(s.unit, "restart")}>
                        <RotateCw size={13} />
                      </button>
                      {(s.enabled === "enabled" || s.enabled === "disabled") && (
                        <button
                          className="btn sm icon ghost"
                          title={enabled ? "Autostart deaktivieren" : "Autostart aktivieren"}
                          disabled={!!busy}
                          onClick={() => act(s.unit, enabled ? "disable" : "enable")}
                        >
                          {enabled ? <ToggleRight size={14} className="ok" /> : <ToggleLeft size={14} />}
                        </button>
                      )}
                      <button className="btn sm icon ghost" title="Logs" onClick={() => showLogs(s.unit)}>
                        <FileClock size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {list && shown.length === 0 && <div className="empty dim">Keine Dienste</div>}
        {!list && <div className="empty dim">Lade Dienste…</div>}
      </div>

      {logs && (
        <Modal
          size="full"
          title={<span className="mono">journalctl -u {logs.unit}</span>}
          onClose={() => setLogs(null)}
          footer={
            <>
              <button className="btn" onClick={() => showLogs(logs.unit)}>
                <RefreshCw size={14} /> Neu laden
              </button>
              <button className="btn primary" onClick={() => setLogs(null)}>
                Schließen
              </button>
            </>
          }
        >
          <LogView text={logs.text} />
        </Modal>
      )}
    </div>
  );
}

function LogView({ text }: { text: string }) {
  return (
    <div
      className="logs"
      ref={(el) => {
        if (el) el.scrollTop = el.scrollHeight;
      }}
    >
      {text}
    </div>
  );
}
