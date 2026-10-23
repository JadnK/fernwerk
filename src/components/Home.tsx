import { useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Copy, Download, FileUp, KeyRound, Pencil, Play, Plus, Server, Sparkles, Trash2 } from "lucide-react";
import { api, errText } from "../lib/api";
import { relative, unixDate } from "../lib/format";
import { ask, confirm, run, toast, useStore } from "../lib/store";
import type { Settings } from "../lib/types";
import { Empty, Field } from "./ui";
import { UpdateSettings } from "./Updater";

export function HomeView() {
  const vault = useStore((s) => s.vault);
  const sessions = useStore((s) => s.sessions);
  const connecting = useStore((s) => s.connecting);
  const { connectHost, setActive } = useStore.getState();
  if (!vault) return null;

  const hosts = [...vault.hosts].sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || a.name.localeCompare(b.name));
  const live = sessions.filter((s) => s.status === "connected").length;

  return (
    <div className="home">
      <div className="row">
        <div className="grow">
          <h1>Übersicht</h1>
          <div className="muted">
            {vault.hosts.length} Hosts · {live} aktive Sitzung{live === 1 ? "" : "en"} · {vault.keys.length} Schlüssel
          </div>
        </div>
        <button className="btn primary" onClick={() => useStore.setState({ editingHost: "new" })}>
          <Plus size={14} /> Neuer Host
        </button>
      </div>

      {hosts.length === 0 ? (
        <Empty icon={<Server size={30} />} title="Willkommen bei Fernwerk">
          <div className="muted" style={{ maxWidth: 420 }}>
            Lege deinen ersten Server an. Danach hast du Terminal, Dateien, Monitoring, Dienste, Tunnel und Benutzerverwaltung
            in einem Fenster.
          </div>
          <button className="btn primary" onClick={() => useStore.setState({ editingHost: "new" })}>
            <Plus size={14} /> Server hinzufügen
          </button>
        </Empty>
      ) : (
        <div className="home-grid">
          {hosts.map((h) => {
            const s = sessions.find((x) => x.hostId === h.id && x.status === "connected");
            return (
              <div key={h.id} className="host-card" style={{ ["--card-color" as string]: h.color || undefined }}>
                <div className="row">
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }} className="ellipsis">
                      {h.name}
                    </div>
                    <div className="mono dim ellipsis" style={{ fontSize: 12 }}>
                      {h.username}@{h.host}
                      {h.port !== 22 ? `:${h.port}` : ""}
                    </div>
                  </div>
                  {s && (
                    <span className="pill ok">
                      <span className="status-dot" /> verbunden
                    </span>
                  )}
                </div>
                <div className="row dim" style={{ fontSize: 12, flexWrap: "wrap", gap: 6 }}>
                  {h.group && <span className="pill">{h.group}</span>}
                  {h.tags.map((t) => (
                    <span key={t} className="pill">
                      {t}
                    </span>
                  ))}
                  {h.auth.type === "key" && (
                    <span className="pill">
                      <KeyRound size={10} /> Key
                    </span>
                  )}
                  <span style={{ marginLeft: "auto" }}>{relative(h.lastUsed)}</span>
                </div>
                <div className="row">
                  {s ? (
                    <button className="btn sm wide" onClick={() => setActive(s.id)}>
                      Öffnen
                    </button>
                  ) : (
                    <button className="btn sm primary wide" disabled={connecting[h.id]} onClick={() => connectHost(h.id)}>
                      <Play size={12} /> {connecting[h.id] ? "Verbinde…" : "Verbinden"}
                    </button>
                  )}
                  <button className="btn sm icon" title="Bearbeiten" onClick={() => useStore.setState({ editingHost: h })}>
                    <Pencil size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function KeysView() {
  const keys = useStore((s) => s.vault?.keys ?? []);
  const reloadVault = useStore((s) => s.reloadVault);

  const generate = async () => {
    const r = await ask({
      title: "Neuen Schlüssel erzeugen",
      message: "Ed25519 – kurz, schnell und von allen aktuellen OpenSSH-Servern unterstützt.",
      fields: [
        { name: "name", label: "Name", value: "fernwerk-ed25519" },
        { name: "comment", label: "Kommentar", value: "fernwerk" },
      ],
      confirm: "Erzeugen",
    });
    if (!r) return;
    await run(async () => {
      await api.keysGenerate(String(r.name).trim() || "key", String(r.comment));
      await reloadVault();
    }, "Schlüssel erzeugt");
  };

  const importKey = async () => {
    const path = await openDialog({ title: "Private Key importieren", multiple: false, directory: false });
    if (typeof path !== "string") return;
    const name = path.split(/[\\/]/).pop() ?? "key";
    try {
      await api.keysImport(name, path);
    } catch (e) {
      if (!errText(e).includes("PASSPHRASE_REQUIRED")) return toast("error", errText(e));
      const r = await ask({ title: "Passphrase", message: "Der Schlüssel ist verschlüsselt und hat keine .pub-Datei.", fields: [{ name: "p", label: "Passphrase", type: "password" }] });
      if (!r) return;
      if ((await run(() => api.keysImport(name, path, String(r.p)))) === undefined) return;
    }
    await reloadVault();
    toast("ok", "Schlüssel importiert");
  };

  const remove = async (id: string, name: string, path: string) => {
    const r = await ask({
      title: "Schlüssel entfernen",
      message: `„${name}“ aus Fernwerk entfernen?`,
      fields: [{ name: "file", label: "Datei auch löschen (nur bei in Fernwerk erzeugten Schlüsseln)", type: "checkbox", value: false }],
      detail: path,
      confirm: "Entfernen",
      danger: true,
    });
    if (!r) return;
    await run(async () => {
      await api.keysDelete(id, !!r.file);
      await reloadVault();
    });
  };

  return (
    <div className="home">
      <div className="row">
        <div className="grow">
          <h1>Schlüssel</h1>
          <div className="muted">SSH-Schlüssel erzeugen, importieren und über „SSH-Keys“ in einer Sitzung auf Server verteilen.</div>
        </div>
        <button className="btn" onClick={importKey}>
          <FileUp size={14} /> Importieren
        </button>
        <button className="btn primary" onClick={generate}>
          <Sparkles size={14} /> Erzeugen
        </button>
      </div>
      <div style={{ marginTop: 18 }}>
        {keys.length === 0 && <Empty icon={<KeyRound size={28} />} title="Noch keine Schlüssel" />}
        {keys.map((k) => (
          <div className="list-item" key={k.id}>
            <KeyRound size={18} style={{ color: "var(--accent)" }} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>{k.name}</div>
              <div className="mono dim ellipsis" style={{ fontSize: 12 }}>
                {k.fingerprint} · {unixDate(k.created)}
              </div>
              <div className="mono dim ellipsis" style={{ fontSize: 11 }}>{k.path}</div>
            </div>
            <button
              className="btn sm"
              onClick={() => navigator.clipboard.writeText(k.publicKey).then(() => toast("ok", "Public Key kopiert"))}
            >
              <Copy size={13} /> Public Key
            </button>
            <button className="btn sm icon ghost" title="Entfernen" onClick={() => remove(k.id, k.name, k.path)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SettingsView() {
  const settings = useStore((s) => s.vault?.settings);
  const reloadVault = useStore((s) => s.reloadVault);
  const [s, setS] = useState<Settings | undefined>(settings);
  if (!s) return null;

  const update = async (patch: Partial<Settings>) => {
    const next = { ...s, ...patch };
    setS(next);
    await run(async () => {
      await api.settingsSave(next);
      await reloadVault();
    });
  };

  const exportVault = async () => {
    const path = await saveDialog({ title: "Hosts exportieren", defaultPath: "fernwerk-hosts.json" });
    if (path) await run(() => api.vaultExport(path), "Export gespeichert (ohne Passwörter)");
  };

  const importVault = async () => {
    const path = await openDialog({ title: "Hosts importieren", multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    if (!(await confirm("Importieren", "Hosts und Snippets aus der Datei hinzufügen?", "Importieren"))) return;
    const n = await run(() => api.vaultImport(path));
    if (n !== undefined) {
      await reloadVault();
      toast("ok", `${n} Hosts importiert`);
    }
  };

  return (
    <div className="home" style={{ maxWidth: 720 }}>
      <h1>Einstellungen</h1>
      <div className="section-title" style={{ marginTop: 20 }}>
        Terminal
      </div>
      <div className="grid-2">
        <Field label="Schriftart">
          <select className="select" value={s.fontFamily} onChange={(e) => update({ fontFamily: e.target.value })}>
            {["JetBrains Mono", "Cascadia Code", "Fira Code", "Menlo", "Consolas", "Ubuntu Mono"].map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </Field>
        <Field label={`Schriftgröße (${s.fontSize}px)`}>
          <input type="range" min={10} max={22} value={s.fontSize} onChange={(e) => update({ fontSize: Number(e.target.value) })} />
        </Field>
        <Field label="Scrollback (Zeilen)">
          <select className="select" value={s.scrollback} onChange={(e) => update({ scrollback: Number(e.target.value) })}>
            {[1000, 5000, 10000, 50000, 100000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString("de-DE")}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="col" style={{ marginTop: 12 }}>
        <label className="check">
          <input type="checkbox" checked={s.cursorBlink} onChange={(e) => update({ cursorBlink: e.target.checked })} />
          Blinkender Cursor
        </label>
        <label className="check">
          <input type="checkbox" checked={s.copyOnSelect} onChange={(e) => update({ copyOnSelect: e.target.checked })} />
          Markierten Text automatisch kopieren
        </label>
      </div>

      <div className="section-title">Daten</div>
      <div className="row">
        <button className="btn" onClick={exportVault}>
          <Download size={14} /> Hosts exportieren
        </button>
        <button className="btn" onClick={importVault}>
          <FileUp size={14} /> Hosts importieren
        </button>
      </div>
      <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>
        Passwörter und Passphrasen werden lokal verschlüsselt gespeichert und nie exportiert.
      </div>

      <div className="section-title">Updates</div>
      <UpdateSettings />
      <div className="dim" style={{ fontSize: 12, marginTop: 8 }}>
        Fernwerk prüft beim Start und alle 6 Stunden auf neue Versionen.
      </div>

      <div className="section-title">Tastenkürzel</div>
      <table className="table" style={{ maxWidth: 520 }}>
        <tbody>
          {[
            ["Strg + K", "Befehlspalette (im Terminal: Strg + Shift + K)"],
            ["Strg + 1 … 7", "Werkzeug wechseln (im Terminal: Strg + Shift + 1 … 7)"],
            ["Strg + Shift + T", "Neue Shell"],
            ["Strg + Tab", "Nächste Sitzung"],
            ["Strg + Shift + C / V", "Kopieren / Einfügen im Terminal"],
            ["Strg + Shift + F", "Im Terminal suchen"],
            ["Maustaste 4 / 5, Alt + ← / →", "Zurück / Vor (Ordner, Ansichten)"],
            ["Strg + X / C / V", "Dateien ausschneiden / kopieren / einfügen"],
            ["Ziehen (Strg = kopieren)", "Dateien in Ordner verschieben"],
            ["Rechtsklick", "Auswahl kopieren bzw. einfügen"],
          ].map(([k, v]) => (
            <tr key={k}>
              <td className="mono">{k}</td>
              <td className="muted">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
