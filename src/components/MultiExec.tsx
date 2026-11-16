import { useEffect, useState } from "react";
import { Network, Play } from "lucide-react";
import { api, errText } from "../lib/api";
import { fillSnippet } from "../lib/snippets";
import { useStore } from "../lib/store";
import { Modal } from "./ui";

interface Result {
  sessionId: string;
  label: string;
  state: "running" | "done" | "error";
  code: number | null;
  out: string;
  ms: number;
}

/** Einen Befehl gleichzeitig auf mehreren verbundenen Hosts ausführen und die Ausgaben vergleichen. */
export function MultiExec() {
  const initial = useStore((s) => s.multiExec);
  const sessions = useStore((s) => s.sessions);
  const live = sessions.filter((s) => s.status === "connected");
  const [cmd, setCmd] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Result[]>([]);

  useEffect(() => {
    if (initial === null) return;
    setCmd(initial);
    setResults([]);
    setPicked(new Set(useStore.getState().sessions.filter((s) => s.status === "connected").map((s) => s.id)));
  }, [initial]);

  if (initial === null) return null;
  const close = () => useStore.setState({ multiExec: null });
  const running = results.some((r) => r.state === "running");

  const exec = async () => {
    const command = await fillSnippet("Platzhalter ausfüllen", cmd);
    if (!command?.trim()) return;
    const targets = live.filter((s) => picked.has(s.id));
    const t0 = performance.now();
    setResults(targets.map((s) => ({ sessionId: s.id, label: s.label, state: "running", code: null, out: "", ms: 0 })));
    await Promise.all(
      targets.map(async (s) => {
        let patch: Partial<Result>;
        try {
          const r = await api.exec(s.id, command);
          const out = [r.stdout, r.stderr].filter((x) => x.trim()).join("\n").replace(/\s+$/, "");
          patch = { state: r.code === 0 ? "done" : "error", code: r.code, out };
        } catch (e) {
          patch = { state: "error", out: errText(e) };
        }
        patch.ms = Math.round(performance.now() - t0);
        setResults((rs) => rs.map((x) => (x.sessionId === s.id ? { ...x, ...patch } : x)));
      }),
    );
  };

  return (
    <Modal
      size="wide"
      title="Auf mehreren Hosts ausführen"
      icon={<Network size={16} className="gold" />}
      onClose={close}
      footer={
        <>
          <span className="dim" style={{ marginRight: "auto", fontSize: 12 }}>
            Läuft nicht-interaktiv (kein sudo-Passwort, kein Pager). {"{{name}}"} wird vorher abgefragt.
          </span>
          <button className="btn" onClick={close}>
            Schließen
          </button>
          <button className="btn primary" disabled={running || !cmd.trim() || picked.size === 0} onClick={exec}>
            <Play size={13} /> Auf {picked.size} Host{picked.size === 1 ? "" : "s"} ausführen
          </button>
        </>
      }
    >
      {live.length === 0 ? (
        <div className="muted">Keine verbundenen Hosts. Verbinde dich zuerst mit den Servern, auf denen der Befehl laufen soll.</div>
      ) : (
        <>
          <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
            {live.map((s) => (
              <label key={s.id} className={`pill ${picked.has(s.id) ? "ok" : ""}`} style={{ cursor: "pointer", height: 24 }}>
                <input
                  type="checkbox"
                  style={{ display: "none" }}
                  checked={picked.has(s.id)}
                  onChange={(e) =>
                    setPicked((p) => {
                      const n = new Set(p);
                      if (e.target.checked) n.add(s.id);
                      else n.delete(s.id);
                      return n;
                    })
                  }
                />
                {s.label}
              </label>
            ))}
          </div>
          <textarea
            className="textarea"
            rows={3}
            autoFocus
            placeholder="uptime && df -h /"
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (!running) exec();
              }
            }}
          />
        </>
      )}
      {results.length > 0 && (
        <div>
          {results.map((r) => (
            <div key={r.sessionId} className="result-block">
              <div className="result-head">
                <span className={`console-state ${r.state === "done" ? "up" : r.state === "error" ? "crash" : ""}`} />
                <b className="grow">{r.label}</b>
                <span className="mono dim" style={{ fontSize: 11 }}>
                  {r.state === "running" ? "läuft…" : `${r.code != null ? `exit ${r.code} · ` : ""}${r.ms} ms`}
                </span>
              </div>
              {r.out && <pre>{r.out}</pre>}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
