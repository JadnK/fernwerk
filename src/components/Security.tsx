import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, HelpCircle, Info, RefreshCw, ShieldAlert, SquareTerminal, XCircle } from "lucide-react";
import { api, errText } from "../lib/api";
import { evaluate, GROUPS, type AuditResult, type Check, type CheckStatus } from "../lib/security";
import { toast, useStore, withSudo } from "../lib/store";
import { sendToActiveTerminal } from "./TerminalPane";
import { Empty } from "./ui";

const ICON: Record<CheckStatus, { icon: typeof Info; cls: string; label: string }> = {
  bad: { icon: XCircle, cls: "err", label: "Kritisch" },
  warn: { icon: AlertTriangle, cls: "warn", label: "Warnung" },
  ok: { icon: CheckCircle2, cls: "ok", label: "OK" },
  info: { icon: Info, cls: "muted", label: "Info" },
  unknown: { icon: HelpCircle, cls: "dim", label: "Unbekannt" },
};
const ORDER: CheckStatus[] = ["bad", "warn", "unknown", "ok", "info"];

/** Sicherheits-Check des verbundenen Servers – liest nur, Korrekturen landen als Befehl im Terminal. */
export function Security({
  sessionId,
  connId,
  hostId,
  username,
  visible,
}: {
  sessionId: string;
  connId: string;
  hostId: string;
  username: string;
  visible: boolean;
}) {
  const usesPassword = useStore((s) => s.vault?.hosts.find((h) => h.id === hostId)?.auth.type === "password");
  const [result, setResult] = useState<AuditResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);

  const load = useCallback(
    async (root: boolean) => {
      setBusy(true);
      try {
        let raw: Record<string, string>;
        try {
          raw = root ? await withSudo(sessionId, (pw) => api.securityAudit(connId, true, pw)) : await api.securityAudit(connId, false, undefined);
        } catch (e) {
          // sudo abgebrochen → eingeschränkter Check ohne root
          if (!root || !errText(e).includes("Abgebrochen")) throw e;
          raw = await api.securityAudit(connId, false, undefined);
        }
        setResult(evaluate(raw, { username, usesPassword }));
      } catch (e) {
        toast("error", errText(e));
      } finally {
        setBusy(false);
      }
    },
    [sessionId, connId, username, usesPassword],
  );

  useEffect(() => {
    if (visible && !started) {
      setStarted(true);
      load(true);
    }
  }, [visible, started, load]);

  const insertFix = (c: Check) => {
    if (!c.fix) return;
    // Ohne Enter: der Befehl steht in der Shell und wird erst nach Prüfen abgeschickt.
    if (!sendToActiveTerminal(c.fix)) toast("info", "Öffne zuerst eine Shell im Terminal-Tab");
  };

  if (!result)
    return (
      <div className="pane">
        <div className="pane-scroll">
          <Empty icon={<ShieldAlert size={28} />} title={busy ? "Server wird geprüft…" : "Sicherheits-Check"}>
            {!busy && (
              <button className="btn primary" onClick={() => load(true)}>
                Prüfen
              </button>
            )}
          </Empty>
        </div>
      </div>
    );

  const counts = ORDER.map((s) => [s, result.checks.filter((c) => c.status === s).length] as const);
  const scoreCls = result.score >= 80 ? "ok" : result.score >= 50 ? "warn" : "err";
  const sortedPorts = [...result.ports.filter((p) => p.public), ...result.ports.filter((p) => !p.public)];

  return (
    <div className="pane">
      <div className="pane-scroll">
        <div className="sec-head">
          <div className={`sec-score ${scoreCls}`}>
            <b>{result.score}</b>
            <span>/ 100</span>
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{result.os || "Linux"}</div>
            <div className="mono dim ellipsis" style={{ fontSize: 12 }}>
              Kernel {result.kernel}
            </div>
            <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {counts
                .filter(([, n]) => n > 0)
                .map(([s, n]) => (
                  <span key={s} className={`pill ${s === "bad" ? "err" : s === "warn" ? "warn" : s === "ok" ? "ok" : ""}`}>
                    {n} {ICON[s].label}
                  </span>
                ))}
            </div>
          </div>
          <button className="btn" disabled={busy} onClick={() => load(true)}>
            <RefreshCw size={14} /> {busy ? "Prüfe…" : "Erneut prüfen"}
          </button>
        </div>

        {!result.root && (
          <div className="sec-banner">
            <AlertTriangle size={15} className="warn" />
            <span className="grow">Eingeschränkter Check ohne root – sshd-Konfiguration, Firewall und Logs sind teils nicht lesbar.</span>
            <button className="btn sm" disabled={busy} onClick={() => load(true)}>
              Mit sudo prüfen
            </button>
          </div>
        )}

        {GROUPS.map((g) => {
          const items = result.checks
            .filter((c) => c.group === g.id)
            .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
          if (!items.length) return null;
          return (
            <div key={g.id}>
              <div className="section-title">{g.label}</div>
              {items.map((c) => {
                const I = ICON[c.status];
                return (
                  <div className="list-item sec-item" key={c.id}>
                    <I.icon size={16} className={I.cls} style={{ flexShrink: 0, marginTop: 2 }} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 500 }}>{c.title}</div>
                      <div className="dim sec-detail">{c.detail}</div>
                      {!c.fix && c.fixNote && (
                        <div className="warn" style={{ fontSize: 12, marginTop: 6 }}>
                          <AlertTriangle size={11} /> {c.fixNote}
                        </div>
                      )}
                      {c.fix && (
                        <div className="sec-fix">
                          <code className="mono">{c.fix}</code>
                          {c.fixNote && (
                            <div className="warn" style={{ fontSize: 12 }}>
                              <AlertTriangle size={11} /> {c.fixNote}
                            </div>
                          )}
                          <div className="row" style={{ gap: 6 }}>
                            <button className="btn sm" title="Wird eingefügt, nicht ausgeführt – mit Enter bestätigen" onClick={() => insertFix(c)}>
                              <SquareTerminal size={12} /> Ins Terminal
                            </button>
                            <button className="btn sm ghost" onClick={() => navigator.clipboard.writeText(c.fix!).then(() => toast("ok", "Befehl kopiert"))}>
                              <Copy size={12} /> Kopieren
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}

        <div className="section-title">Lauschende Ports</div>
        {sortedPorts.length === 0 ? (
          <div className="muted">Keine Daten (ss nicht verfügbar).</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Port</th>
                <th>Protokoll</th>
                <th>Adresse</th>
                <th>Prozess</th>
                <th>Erreichbar</th>
              </tr>
            </thead>
            <tbody>
              {sortedPorts.map((p) => (
                <tr key={`${p.proto}-${p.address}-${p.port}`}>
                  <td className="mono">{p.port}</td>
                  <td className="mono dim">{p.proto}</td>
                  <td className="mono dim">{p.address}</td>
                  <td className="mono">{p.process || <span className="dim">{result.root ? "–" : "(root nötig)"}</span>}</td>
                  <td>
                    {p.public ? (
                      <span className={`pill ${p.risky ? "err" : "warn"}`}>{p.risky ? `öffentlich · ${p.risky}` : "öffentlich"}</span>
                    ) : (
                      <span className="pill ok">nur lokal</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>
          „Öffentlich“ heißt: der Dienst lauscht auf allen Adressen. Ob er von außen erreichbar ist, entscheidet zusätzlich die Firewall.
        </div>

        {(result.topPeers.length > 0 || result.failedIps.length > 0) && (
          <div className="grid-2" style={{ marginTop: 6 }}>
            <PeerList title="Meiste Verbindungen (jetzt)" peers={result.topPeers} />
            <PeerList title="Fehlgeschlagene Logins nach IP (24 h)" peers={result.failedIps} />
          </div>
        )}

        <div className="dim" style={{ fontSize: 12, marginTop: 18 }}>
          Zu DDoS: Von innen sind nur Anzeichen sichtbar (SYN-Flood, Verbindungsspitzen, Last). Große Angriffe auf die Leitung lassen sich am Server
          weder sicher erkennen noch abwehren – dafür braucht es Schutz beim Hoster oder einen Dienst wie Cloudflare.
        </div>
      </div>
    </div>
  );
}

function PeerList({ title, peers }: { title: string; peers: { count: number; ip: string }[] }) {
  return (
    <div>
      <div className="section-title">{title}</div>
      {peers.length === 0 ? (
        <div className="muted">Keine.</div>
      ) : (
        peers.map((p) => (
          <div key={p.ip} className="row mono" style={{ fontSize: 12, padding: "3px 0" }}>
            <span className="grow ellipsis">{p.ip}</span>
            <span className="dim">{p.count}</span>
          </div>
        ))
      )}
    </div>
  );
}
