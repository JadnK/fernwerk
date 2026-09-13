import { useCallback, useEffect, useState } from "react";
import { KeyRound, RefreshCw, Trash2, Upload } from "lucide-react";
import { api, errText } from "../lib/api";
import { confirm, run, toast, useStore } from "../lib/store";
import type { AuthorizedKey } from "../lib/types";

/** Verwaltet ~/.ssh/authorized_keys des angemeldeten Benutzers. */
export function Access({ connId, username, visible }: { connId: string; username: string; visible: boolean }) {
  const keys = useStore((s) => s.vault?.keys ?? []);
  const [list, setList] = useState<AuthorizedKey[] | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await api.authorizedKeys(connId));
    } catch (e) {
      toast("error", errText(e));
      setList([]);
    }
  }, [connId]);

  useEffect(() => {
    if (visible && list === null) load();
  }, [visible, list, load]);

  const deploy = async (publicKey: string, name: string) => {
    const added = await run(() => api.keyDeploy(connId, publicKey));
    if (added === true) toast("ok", `${name} hinterlegt – Login ohne Passwort möglich`);
    if (added === false) toast("info", `${name} war bereits hinterlegt`);
    load();
  };

  const remove = async (k: AuthorizedKey) => {
    const ok = await confirm(
      "Schlüssel entfernen",
      `${k.comment || k.fingerprint} aus authorized_keys entfernen? Wer nur diesen Schlüssel hat, kommt danach nicht mehr rein.`,
      "Entfernen",
      true,
    );
    if (!ok) return;
    await run(() => api.authorizedKeyRemove(connId, k.line), "Entfernt");
    load();
  };

  const installed = new Set((list ?? []).map((k) => k.fingerprint));

  return (
    <div className="pane">
      <div className="pane-scroll">
        <div className="section-title">
          <span className="grow">
            Hinterlegte Schlüssel für <span className="mono" style={{ textTransform: "none" }}>{username}</span>
          </span>
          <button className="btn sm icon ghost" onClick={load} title="Aktualisieren">
            <RefreshCw size={14} />
          </button>
        </div>
        {list?.length === 0 && <div className="muted">Keine Einträge in ~/.ssh/authorized_keys.</div>}
        {list?.map((k) => (
          <div className="list-item" key={k.line}>
            <KeyRound size={16} className="muted" />
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>{k.comment || <span className="dim">ohne Kommentar</span>}</div>
              <div className="mono dim ellipsis" style={{ fontSize: 12 }}>
                {k.kind} · {k.fingerprint}
              </div>
            </div>
            <button className="btn sm icon ghost" title="Entfernen" onClick={() => remove(k)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}

        <div className="section-title">Eigene Schlüssel verteilen</div>
        {keys.length === 0 && (
          <div className="muted">Erzeuge oder importiere zuerst einen Schlüssel unter „Schlüssel“ in der Seitenleiste.</div>
        )}
        {keys.map((k) => (
          <div className="list-item" key={k.id}>
            <KeyRound size={16} style={{ color: "var(--accent)" }} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>{k.name}</div>
              <div className="mono dim ellipsis" style={{ fontSize: 12 }}>{k.fingerprint}</div>
            </div>
            {installed.has(k.fingerprint) ? (
              <span className="pill ok">hinterlegt</span>
            ) : (
              <button className="btn sm primary" onClick={() => deploy(k.publicKey, k.name)}>
                <Upload size={13} /> Auf Server kopieren
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
