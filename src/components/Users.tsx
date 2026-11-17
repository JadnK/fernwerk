import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, KeySquare, Lock, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, Unlock, UserPlus, Users as UsersIcon } from "lucide-react";
import { api, errText } from "../lib/api";
import { ask, attempt, run, toast, useStore, withSudo } from "../lib/store";
import type { UserInfo, UsersOverview } from "../lib/types";
import { Empty, Field, Modal } from "./ui";

export function Users({ sessionId, connId, visible }: { sessionId: string; connId: string; visible: boolean }) {
  const sudoPassword = useStore((s) => s.sessions.find((x) => x.id === sessionId)?.sudoPassword);
  const me = useStore((s) => s.sessions.find((x) => x.id === sessionId)?.username);
  const [data, setData] = useState<UsersOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const [editor, setEditor] = useState<UserInfo | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.users(connId, sudoPassword));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [connId, sudoPassword]);

  useEffect(() => {
    if (visible && data === null) load();
  }, [visible, data, load]);

  const users = useMemo(() => data?.users.filter((u) => showSystem || !u.system) ?? [], [data, showSystem]);
  const sudo = <T,>(fn: (pw: string | undefined) => Promise<T>) => withSudo(sessionId, fn);

  const setPassword = async (u: UserInfo) => {
    const r = await ask({
      title: `Passwort für ${u.name} setzen`,
      fields: [
        { name: "a", label: "Neues Passwort", type: "password" },
        { name: "b", label: "Wiederholen", type: "password" },
      ],
      confirm: "Setzen",
    });
    if (!r) return;
    if (r.a !== r.b) return toast("error", "Passwörter stimmen nicht überein");
    if (String(r.a).length < 8) return toast("error", "Mindestens 8 Zeichen");
    await run(() => sudo((pw) => api.userPassword(connId, u.name, String(r.a), pw)), "Passwort geändert");
  };

  const toggleLock = async (u: UserInfo) => {
    const lock = !u.locked;
    await run(() => sudo((pw) => api.userLock(connId, u.name, lock, pw)), lock ? `${u.name} gesperrt` : `${u.name} entsperrt`);
    load();
  };

  const remove = async (u: UserInfo) => {
    const r = await ask({
      title: `Benutzer ${u.name} löschen`,
      message: "Der Benutzer wird vom Server entfernt. Laufende Prozesse des Benutzers können das verhindern.",
      fields: [{ name: "home", label: `Home-Verzeichnis ${u.home} mitlöschen`, type: "checkbox", value: false }],
      confirm: "Löschen",
      danger: true,
    });
    if (!r) return;
    await run(() => sudo((pw) => api.userDelete(connId, u.name, !!r.home, pw)), `${u.name} gelöscht`);
    load();
  };

  /**
   * Schlüssel für einen Server-Benutzer: Das Paar entsteht auf diesem PC (der private Schlüssel bleibt hier),
   * der öffentliche Schlüssel wird beim Benutzer in ~/.ssh/authorized_keys eingetragen.
   */
  const setupKey = async (u: UserInfo) => {
    const st = useStore.getState();
    const session = st.sessions.find((x) => x.id === sessionId);
    const host = st.vault?.hosts.find((h) => h.id === session?.hostId);
    const keys = st.vault?.keys ?? [];
    const server = host?.host ?? "server";
    const r = await ask({
      title: `SSH-Schlüssel für ${u.name}`,
      message: `Das Schlüsselpaar wird auf diesem PC erzeugt. Der private Schlüssel bleibt bei dir, der öffentliche Schlüssel wird auf dem Server in ~${u.name}/.ssh/authorized_keys eingetragen (Ordner und Datei werden bei Bedarf angelegt).`,
      fields: [
        {
          name: "key",
          label: "Schlüssel",
          type: "select",
          options: [
            { value: "new", label: "Neuen Schlüssel erzeugen (Ed25519)" },
            ...keys.map((k) => ({ value: k.id, label: `Vorhandenen eintragen: ${k.name}` })),
          ],
        },
        { name: "name", label: "Name des neuen Schlüssels", value: `${u.name}@${server}` },
        { name: "pass1", label: "Passphrase (empfohlen, leer = ohne)", type: "password" },
        { name: "pass2", label: "Passphrase wiederholen", type: "password" },
        {
          name: "location",
          label: "Privaten Schlüssel speichern in",
          type: "select",
          options: [
            { value: "ssh", label: "~/.ssh auf diesem PC" },
            { value: "app", label: "Fernwerk-Schlüsselordner" },
          ],
        },
        ...(host
          ? [{ name: "profile", label: `Host-Eintrag „${host.name} (${u.name})“ mit diesem Schlüssel anlegen`, type: "checkbox" as const, value: true }]
          : []),
        { name: "savePass", label: "Passphrase im Fernwerk-Tresor speichern (sonst Abfrage beim Verbinden)", type: "checkbox", value: false },
      ],
      confirm: "Erstellen & eintragen",
    });
    if (!r) return;

    const isNew = r.key === "new";
    const pass = String(r.pass1 ?? "");
    if (isNew && pass !== String(r.pass2 ?? "")) return toast("error", "Die Passphrasen stimmen nicht überein");
    if (isNew && pass && pass.length < 8) return toast("error", "Passphrase: mindestens 8 Zeichen");

    await run(async () => {
      const key = isNew
        ? await api.keysGenerate(String(r.name).trim() || `${u.name}-key`, `${u.name}@${server}`, pass, r.location === "app" ? "app" : "ssh")
        : keys.find((k) => k.id === r.key);
      if (!key) throw new Error("Schlüssel nicht gefunden");
      const added = await withSudo(sessionId, (pw) => api.userAuthorizeKey(connId, u.name, key.publicKey, pw));

      let profileNote = "";
      if (r.profile && host) {
        await api.hostSave(
          {
            ...host,
            id: "",
            name: `${host.name} (${u.name})`,
            username: u.name,
            auth: { type: "key", keyPath: key.path },
            tunnels: [],
            startupCommand: "",
            hasSecret: false,
            lastUsed: null,
          },
          isNew && pass && r.savePass ? { passphrase: pass } : undefined,
        );
        profileNote = `\nHost:        ${host.name} (${u.name}) angelegt`;
      }
      await st.reloadVault();

      await ask({
        title: "Schlüssel eingerichtet",
        message: added
          ? `${u.name} kann sich jetzt mit diesem Schlüssel anmelden.`
          : `Der Schlüssel war bei ${u.name} schon eingetragen.`,
        detail:
          `Privat:      ${key.path}\n` +
          `Öffentlich:  ${key.path}.pub\n` +
          `Fingerprint: ${key.fingerprint}\n` +
          `Server:      ~${u.name}/.ssh/authorized_keys${added ? " (neue Zeile)" : ""}` +
          (isNew ? `\nPassphrase:  ${pass ? "ja" : "nein"}` : "") +
          profileNote,
        confirm: "OK",
        cancel: null,
      });
    });
  };

  const newGroup = async () => {
    const r = await ask({ title: "Neue Gruppe", fields: [{ name: "name", label: "Gruppenname" }], confirm: "Anlegen" });
    if (!r) return;
    await run(() => sudo((pw) => api.groupCreate(connId, String(r.name).trim(), pw)), "Gruppe angelegt");
    load();
  };

  if (error) {
    return (
      <div className="pane">
        <Empty icon={<UsersIcon size={28} />} title="Benutzer konnten nicht geladen werden">
          <div className="muted">{error}</div>
          <button className="btn" onClick={load}>
            Erneut versuchen
          </button>
        </Empty>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="toolbar">
        <button className="btn sm primary" onClick={() => setEditor("new")} disabled={!data}>
          <UserPlus size={14} /> Benutzer anlegen
        </button>
        <button className="btn sm" onClick={newGroup} disabled={!data}>
          <Plus size={14} /> Gruppe
        </button>
        <label className="check" style={{ marginLeft: 8 }}>
          <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
          Systembenutzer
        </label>
        {data && !data.shadowReadable && (
          <span className="dim" style={{ fontSize: 12 }}>
            Sperrstatus erst nach sudo-Freigabe sichtbar
          </span>
        )}
        <button className="btn icon ghost" style={{ marginLeft: "auto" }} onClick={load} title="Aktualisieren">
          <RefreshCw size={15} />
        </button>
      </div>
      <div className="file-list">
        <table className="table">
          <thead>
            <tr>
              <th>Benutzer</th>
              <th className="num">UID</th>
              <th>Gruppen</th>
              <th>Shell</th>
              <th>Home</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.name}>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    <span style={{ fontWeight: 500 }}>{u.name}</span>
                    {u.admin && <ShieldCheck size={13} style={{ color: "var(--accent)" }} />}
                    {u.name === me && <span className="pill accent">du</span>}
                  </div>
                  {u.gecos && <div className="dim" style={{ fontSize: 12 }}>{u.gecos}</div>}
                </td>
                <td className="num mono dim">{u.uid}</td>
                <td className="dim" style={{ whiteSpace: "normal", maxWidth: 280 }}>
                  {u.groups.join(", ")}
                </td>
                <td className="mono dim">{u.shell}</td>
                <td className="mono dim">{u.home}</td>
                <td>
                  {u.locked === true ? (
                    <span className="pill err">gesperrt</span>
                  ) : u.locked === false ? (
                    <span className="pill ok">aktiv</span>
                  ) : (
                    <span className="dim">–</span>
                  )}
                </td>
                <td>
                  <div className="row-actions">
                    <button className="btn sm icon ghost" title="Bearbeiten" onClick={() => setEditor(u)}>
                      <Pencil size={13} />
                    </button>
                    <button className="btn sm icon ghost" title="SSH-Schlüssel erstellen / eintragen" onClick={() => setupKey(u)}>
                      <KeySquare size={13} />
                    </button>
                    <button className="btn sm icon ghost" title="Passwort setzen" onClick={() => setPassword(u)}>
                      <KeyRound size={13} />
                    </button>
                    {u.uid !== 0 && (
                      <button className="btn sm icon ghost" title={u.locked ? "Entsperren" : "Sperren"} onClick={() => toggleLock(u)}>
                        {u.locked ? <Unlock size={13} /> : <Lock size={13} />}
                      </button>
                    )}
                    {u.uid !== 0 && u.name !== me && (
                      <button className="btn sm icon ghost" title="Löschen" onClick={() => remove(u)}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data && <div className="empty dim">Lade Benutzer…</div>}
      </div>

      {editor && data && (
        <UserEditor
          user={editor === "new" ? null : editor}
          overview={data}
          onClose={() => setEditor(null)}
          onDone={() => {
            setEditor(null);
            load();
          }}
          sessionId={sessionId}
          connId={connId}
        />
      )}
    </div>
  );
}

function UserEditor({
  user,
  overview,
  onClose,
  onDone,
  sessionId,
  connId,
}: {
  user: UserInfo | null;
  overview: UsersOverview;
  onClose: () => void;
  onDone: () => void;
  sessionId: string;
  connId: string;
}) {
  const keys = useStore((s) => s.vault?.keys ?? []);
  const isNew = user === null;
  const [name, setName] = useState(user?.name ?? "");
  const [fullName, setFullName] = useState(user?.gecos ?? "");
  const [shell, setShell] = useState(user?.shell ?? (overview.shells.find((s) => s.endsWith("/bash")) ?? "/bin/sh"));
  const [groups, setGroups] = useState<Set<string>>(
    new Set(user ? user.groups.filter((g) => g !== user.name) : []),
  );
  const [password, setPassword] = useState("");
  const [createHome, setCreateHome] = useState(true);
  const [authorizedKey, setAuthorizedKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [groupFilter, setGroupFilter] = useState("");

  const selectableGroups = overview.groups
    .filter((g) => g.name !== name && (g.gid >= 1000 || ["sudo", "wheel", "admin", "docker", "adm", "www-data", "systemd-journal", "users"].includes(g.name)))
    .filter((g) => !groupFilter || g.name.includes(groupFilter))
    .sort((a, b) => a.name.localeCompare(b.name));

  const toggle = (g: string) =>
    setGroups((s) => {
      const n = new Set(s);
      if (n.has(g)) n.delete(g);
      else n.add(g);
      return n;
    });

  const submit = async () => {
    setBusy(true);
    const ok = await attempt(
      () =>
        withSudo(sessionId, (pw) =>
          isNew
            ? api.userCreate(
                connId,
                { name: name.trim(), fullName, shell, groups: [...groups], password, createHome, authorizedKey },
                pw,
              )
            : api.userUpdate(connId, { name: user!.name, fullName, shell, groups: [...groups] }, pw),
        ),
      isNew ? `Benutzer ${name} angelegt` : "Gespeichert",
    );
    setBusy(false);
    if (ok) onDone();
  };

  const admin = overview.adminGroup;

  return (
    <Modal
      size="wide"
      title={isNew ? "Benutzer anlegen" : `Benutzer ${user!.name} bearbeiten`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? "Läuft…" : isNew ? "Anlegen" : "Speichern"}
          </button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Benutzername">
          <input
            className="input mono"
            value={name}
            disabled={!isNew}
            autoFocus={isNew}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="deploy"
          />
        </Field>
        <Field label="Vollständiger Name">
          <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="Shell">
          <select className="select mono" value={shell} onChange={(e) => setShell(e.target.value)}>
            {[...new Set([...overview.shells, shell, "/usr/sbin/nologin"])].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        {isNew && (
          <Field label="Passwort (optional)">
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
      </div>

      <label className="check">
        <input type="checkbox" checked={groups.has(admin)} onChange={() => toggle(admin)} />
        <ShieldCheck size={14} style={{ color: "var(--accent)" }} /> Administrator (Gruppe <span className="mono">{admin}</span>)
      </label>

      <Field label="Zusatzgruppen">
        <div className="col" style={{ gap: 6 }}>
          <input className="input" placeholder="Gruppe filtern…" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 130, overflow: "auto" }}>
            {selectableGroups.map((g) => (
              <button
                key={g.name}
                className={`btn sm ${groups.has(g.name) ? "primary" : ""}`}
                onClick={() => toggle(g.name)}
                type="button"
              >
                {g.name}
              </button>
            ))}
          </div>
        </div>
      </Field>

      {isNew && (
        <>
          <label className="check">
            <input type="checkbox" checked={createHome} onChange={(e) => setCreateHome(e.target.checked)} />
            Home-Verzeichnis anlegen
          </label>
          <Field label="SSH Public Key hinterlegen (optional)">
            <div className="col" style={{ gap: 6 }}>
              {keys.length > 0 && (
                <select className="select" value="" onChange={(e) => setAuthorizedKey(e.target.value)}>
                  <option value="">Aus eigenen Schlüsseln wählen…</option>
                  {keys.map((k) => (
                    <option key={k.id} value={k.publicKey}>
                      {k.name} – {k.fingerprint}
                    </option>
                  ))}
                </select>
              )}
              <textarea
                className="textarea"
                rows={3}
                placeholder="ssh-ed25519 AAAA… kommentar"
                value={authorizedKey}
                onChange={(e) => setAuthorizedKey(e.target.value)}
              />
            </div>
          </Field>
        </>
      )}
    </Modal>
  );
}
