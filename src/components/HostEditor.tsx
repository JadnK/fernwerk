import { useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, KeyRound, Lock } from "lucide-react";
import { api } from "../lib/api";
import { attempt, confirm, run, useStore } from "../lib/store";
import type { HostProfile } from "../lib/types";
import { Field, Modal } from "./ui";

export const COLORS = ["", "#e8a33d", "#e06c62", "#5fb37c", "#6aa6d8", "#c08ad6", "#5fb8b3", "#d9b44a"];

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
  const keyPath = h.auth.type === "key" ? h.auth.keyPath : "";

  const save = async () => {
    setBusy(true);
    const profile: HostProfile = { ...h, name: h.name.trim() || h.host.trim(), host: h.host.trim() };
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

  const browseKey = async () => {
    const p = await openDialog({ title: "Private Key wählen", multiple: false, directory: false });
    if (typeof p === "string") set("auth", { type: "key", keyPath: p });
  };

  const valid = h.host.trim() && h.username.trim() && h.port > 0 && (h.auth.type === "password" || keyPath);

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
        <Field label="Host / IP">
          <input
            className="input mono"
            value={h.host}
            placeholder="192.168.1.10"
            onChange={(e) => set("host", e.target.value)}
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
          onClick={() => set("auth", { type: "key", keyPath: vault?.keys[0]?.path ?? "~/.ssh/id_ed25519" })}
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
          <Field label="Private Key">
            <div className="row">
              {vault && vault.keys.length > 0 && (
                <select
                  className="select"
                  style={{ width: 200 }}
                  value={vault.keys.find((k) => k.path === keyPath)?.path ?? ""}
                  onChange={(e) => e.target.value && set("auth", { type: "key", keyPath: e.target.value })}
                >
                  <option value="">Eigener Pfad…</option>
                  {vault.keys.map((k) => (
                    <option key={k.id} value={k.path}>
                      {k.name}
                    </option>
                  ))}
                </select>
              )}
              <input
                className="input mono grow"
                value={keyPath}
                onChange={(e) => set("auth", { type: "key", keyPath: e.target.value })}
              />
              <button className="btn icon" title="Durchsuchen" onClick={browseKey}>
                <FolderOpen size={14} />
              </button>
            </div>
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
