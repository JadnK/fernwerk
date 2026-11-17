import { useMemo, useState } from "react";
import { KeyRound, Lock } from "lucide-react";
import { api } from "../lib/api";
import { attempt, confirm, run, useStore } from "../lib/store";
import type { HostProfile } from "../lib/types";
import { Field, Modal } from "./ui";

/** Markierungsfarben – nur Gold-Abstufungen, passend zum zweifarbigen Design. */
export const COLORS = ["", "#ecc766", "#d1a53c", "#a8822e", "#7a5f22", "#efe2bf", "#b8a47a", "#c9553e"];

const empty = (): HostProfile => ({
  id: "",
  name: "",
  group: "",
  host: "",
  port: 22,
  username: "root",
  auth: { type: "password" },
  color: "",
  tags: [],
  tunnels: [],
  startupCommand: "",
  hasSecret: false,
  lastUsed: null,
});

export function HostEditor({ host, onClose }: { host: HostProfile | null; onClose: () => void }) {
  const vault = useStore((s) => s.vault);
  const reloadVault = useStore((s) => s.reloadVault);
  const [h, setH] = useState<HostProfile>(host ?? empty());
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof HostProfile>(k: K, v: HostProfile[K]) => setH((x) => ({ ...x, [k]: v }));

  const groups = useMemo(
    () => [...new Set((vault?.hosts ?? []).map((x) => x.group).filter(Boolean))].sort(),
    [vault],
  );
  const keys = vault?.keys ?? [];
  const keyPath = h.auth.type === "key" ? h.auth.keyPath : "";
  /** Nur in Fernwerk angelegte Schlüssel sind wählbar – Zuordnung über den gespeicherten Pfad. */
  const samePath = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
  const selectedKey = keys.find((k) => samePath(k.path, keyPath));

  /** "user@host:port" im Host-Feld in die Einzelfelder aufteilen (beim Verlassen des Felds und beim Speichern). */
  const parseQuick = (x: HostProfile): HostProfile => {
    const m = x.host.trim().match(/^(?:([^@\s]+)@)?([^:\s@]+)(?::(\d+))?$/);
    if (!m || (!m[1] && !m[3])) return x;
    return {
      ...x,
      username: m[1] ?? x.username,
      host: m[2],
      port: m[3] ? Number(m[3]) : x.port,
      name: x.name || m[2],
    };
  };

  const save = async () => {
    setBusy(true);
    const parsed = parseQuick(h);
    const profile: HostProfile = { ...parsed, name: parsed.name.trim() || parsed.host.trim(), host: parsed.host.trim() };
    let secret: { password?: string; passphrase?: string } | undefined;
    if (clearSecret) secret = { password: "", passphrase: "" };
    else if (password || passphrase) secret = { password: password || undefined, passphrase: passphrase || undefined };
    const ok = await attempt(async () => {
      await api.hostSave(profile, secret);
      await reloadVault();
    }, host ? "Host gespeichert" : "Host angelegt");
    setBusy(false);
    if (ok) onClose();
  };

  const remove = async () => {
    if (!host) return;
    if (!(await confirm("Host löschen", `„${host.name}“ inklusive gespeicherter Zugangsdaten löschen?`, "Löschen", true))) return;
    await run(async () => {
      await api.hostDelete(host.id);
      await reloadVault();
    });
    onClose();
  };

  const valid = h.host.trim() && h.username.trim() && h.port > 0 && (h.auth.type === "password" || selectedKey);

  return (
    <Modal
      size="wide"
      title={host ? `Host bearbeiten` : "Neuer Host"}
      onClose={onClose}
      footer={
        <>
          {host && (
            <button className="btn danger" style={{ marginRight: "auto" }} onClick={remove}>
              Löschen
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" disabled={!valid || busy} onClick={save}>
            Speichern
          </button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Name">
          <input className="input" autoFocus value={h.name} placeholder="web-01" onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Gruppe">
          <input className="input" list="fw-groups" value={h.group} placeholder="z.B. Produktion" onChange={(e) => set("group", e.target.value)} />
          <datalist id="fw-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </Field>
      </div>
      <div className="grid-3">
        <Field label="Host / IP (oder user@host:port)">
          <input
            className="input mono"
            value={h.host}
            placeholder="192.168.1.10"
            onChange={(e) => set("host", e.target.value)}
            onBlur={() => setH(parseQuick)}
          />
        </Field>
        <Field label="Port">
          <input className="input mono" type="number" value={h.port} onChange={(e) => set("port", Number(e.target.value))} />
        </Field>
        <Field label="Benutzer">
          <input className="input mono" value={h.username} onChange={(e) => set("username", e.target.value)} />
        </Field>
      </div>

      <div className="seg" style={{ alignSelf: "flex-start" }}>
        <button className={h.auth.type === "password" ? "on" : ""} onClick={() => set("auth", { type: "password" })}>
          <Lock size={13} /> Passwort
        </button>
        <button
          className={h.auth.type === "key" ? "on" : ""}
          onClick={() => h.auth.type !== "key" && set("auth", { type: "key", keyPath: keys[0]?.path ?? "" })}
        >
          <KeyRound size={13} /> Schlüssel
        </button>
      </div>

      {h.auth.type === "password" ? (
        <Field label={h.hasSecret ? "Passwort (gespeichert – leer lassen für unverändert)" : "Passwort (optional, sonst Abfrage beim Verbinden)"}>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      ) : (
        <>
          <Field label="Schlüssel">
            {keys.length === 0 ? (
              <div className="row">
                <span className="muted grow">Noch keine Schlüssel angelegt.</span>
                <button
                  className="btn sm"
                  onClick={() => {
                    onClose();
                    useStore.getState().setView("keys");
                  }}
                >
                  <KeyRound size={12} /> Zu den Schlüsseln
                </button>
              </div>
            ) : (
              <select
                className="select"
                value={selectedKey?.id ?? ""}
                onChange={(e) => {
                  const k = keys.find((x) => x.id === e.target.value);
                  if (k) set("auth", { type: "key", keyPath: k.path });
                }}
              >
                {!selectedKey && <option value="">Schlüssel wählen…</option>}
                {keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={h.hasSecret ? "Passphrase (gespeichert – leer lassen für unverändert)" : "Passphrase (falls verschlüsselt)"}>
            <input className="input" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </Field>
        </>
      )}

      {h.hasSecret && (
        <label className="check">
          <input type="checkbox" checked={clearSecret} onChange={(e) => setClearSecret(e.target.checked)} />
          Gespeicherte Zugangsdaten entfernen
        </label>
      )}

      <Field label="Befehl nach dem Login (optional)">
        <input
          className="input mono"
          value={h.startupCommand}
          placeholder="cd /var/www && git status"
          onChange={(e) => set("startupCommand", e.target.value)}
        />
      </Field>

      <div className="grid-2">
        <Field label="Tags (kommagetrennt)">
          <input
            className="input"
            value={h.tags.join(", ")}
            onChange={(e) => set("tags", e.target.value.split(",").map((t) => t.trim()).filter(Boolean))}
          />
        </Field>
        <Field label="Farbe">
          <div className="row" style={{ height: 30 }}>
            {COLORS.map((c) => (
              <div
                key={c || "none"}
                className={`color-swatch ${h.color === c ? "on" : ""}`}
                style={{ background: c || "var(--panel-3)" }}
                onClick={() => set("color", c)}
              />
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}
