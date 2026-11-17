import { useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { ArrowUpCircle, Bug, Download, ExternalLink, Lightbulb, MessageSquarePlus, ScrollText } from "lucide-react";
import changelog from "../../CHANGELOG.md?raw";
import { errText } from "../lib/api";
import { bytes } from "../lib/format";
import { toast, useStore } from "../lib/store";
import { Bar, Field, Modal } from "./ui";

const SKIP_KEY = "fw-skip-version";

let pending: Update | null = null;
let checking = false;

function readSkip(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

function writeSkip(v: string | null) {
  try {
    if (v) localStorage.setItem(SKIP_KEY, v);
    else localStorage.removeItem(SKIP_KEY);
  } catch {
    /* ignorieren */
  }
}

/**
 * Prüft auf eine neue Version. Automatische Prüfungen bleiben still,
 * eine manuelle Prüfung meldet auch „aktuell“ und Fehler.
 */
export async function checkForUpdates(manual: boolean) {
  if (checking || useStore.getState().update) return;
  checking = true;
  try {
    const update = await check();
    if (!update) {
      if (manual) toast("ok", `Fernwerk ist aktuell (v${await getVersion()})`);
      return;
    }
    if (!manual && readSkip() === update.version) return;
    pending = update;
    useStore.setState({
      update: {
        version: update.version,
        current: update.currentVersion,
        notes: update.body ?? "",
        date: update.date ?? null,
      },
    });
  } catch (e) {
    if (manual) toast("error", `Update-Prüfung fehlgeschlagen: ${errText(e)}`);
  } finally {
    checking = false;
  }
}

/** Nur die Aufzählungspunkte aus den Release-Notes (CHANGELOG-Abschnitt). */
function noteItems(notes: string): string[] {
  return notes
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*] /.test(l))
    .map((l) => l.slice(2).replace(/`/g, ""));
}

type Phase = { kind: "idle" } | { kind: "download"; done: number; total: number } | { kind: "restart" } | { kind: "error"; msg: string };

export function UpdateDialog() {
  const info = useStore((s) => s.update);
  const liveSessions = useStore((s) => s.sessions.filter((x) => x.status === "connected").length);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  if (!info) return null;
  const busy = phase.kind === "download" || phase.kind === "restart";
  const items = noteItems(info.notes);

  const close = () => {
    if (busy) return;
    useStore.setState({ update: null });
    setPhase({ kind: "idle" });
  };

  const skip = () => {
    writeSkip(info.version);
    close();
  };

  const install = async () => {
    if (!pending) return;
    writeSkip(null);
    setPhase({ kind: "download", done: 0, total: 0 });
    try {
      let done = 0;
      let total = 0;
      await pending.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        if (ev.event === "Progress") done += ev.data.chunkLength;
        if (ev.event === "Finished") done = total || done;
        setPhase({ kind: "download", done, total });
      });
      setPhase({ kind: "restart" });
      // Offene Verbindungen sauber trennen, bevor die App neu startet
      const { sessions, disconnect } = useStore.getState();
      await Promise.allSettled(sessions.map((s) => disconnect(s.id)));
      await relaunch();
    } catch (e) {
      setPhase({ kind: "error", msg: errText(e) });
    }
  };

  const pct = phase.kind === "download" && phase.total > 0 ? (phase.done / phase.total) * 100 : 0;

  return (
    <Modal
      title={`Fernwerk ${info.version} ist verfügbar`}
      icon={<ArrowUpCircle size={16} style={{ color: "var(--accent)" }} />}
      onClose={close}
      footer={
        <>
          {!busy && (
            <button className="btn ghost" style={{ marginRight: "auto" }} onClick={skip}>
              Diese Version überspringen
            </button>
          )}
          <button className="btn" disabled={busy} onClick={close}>
            Später
          </button>
          <button className="btn primary" disabled={busy} onClick={install}>
            <Download size={14} /> {phase.kind === "error" ? "Erneut versuchen" : "Jetzt installieren"}
          </button>
        </>
      }
    >
      <div className="row muted">
        <span className="version-chip">v{info.current}</span>→<span className="version-chip" style={{ color: "var(--accent)" }}>v{info.version}</span>
        {info.date && <span className="dim">· {new Date(info.date).toLocaleDateString("de-DE")}</span>}
      </div>

      {items.length > 0 ? (
        <ul className="update-notes">
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      ) : (
        info.notes && <div className="detail">{info.notes}</div>
      )}

      {liveSessions > 0 && phase.kind === "idle" && (
        <div className="warn" style={{ fontSize: 12 }}>
          {liveSessions} offene Verbindung{liveSessions === 1 ? " wird" : "en werden"} beim Neustart getrennt.
        </div>
      )}

      {phase.kind === "download" && (
        <div className="col" style={{ gap: 4 }}>
          <Bar value={pct} tone="ok" />
          <span className="dim mono" style={{ fontSize: 11 }}>
            {phase.total > 0 ? `${bytes(phase.done)} / ${bytes(phase.total)}` : `${bytes(phase.done)} geladen`}
          </span>
        </div>
      )}
      {phase.kind === "restart" && <div className="ok">Installiert – Fernwerk startet neu…</div>}
      {phase.kind === "error" && <div className="err selectable">{phase.msg}</div>}
    </Modal>
  );
}

const REPO = "https://github.com/JadnK/fernwerk";

type Release = { version: string; date: string; items: string[] };

/** CHANGELOG.md in Versionen zerlegen: „## 1.2.3 – 2026-11-16“ + Aufzählungspunkte. */
function parseChangelog(md: string): Release[] {
  const out: Release[] = [];
  for (const line of md.split("\n")) {
    const head = line.match(/^##\s+(\S+)(?:\s+[–-]\s+(.+))?/);
    if (head) out.push({ version: head[1], date: head[2]?.trim() ?? "", items: [] });
    else if (out.length && /^\s*[-*] /.test(line)) out[out.length - 1].items.push(line.trim().slice(2).replace(/`/g, ""));
  }
  return out;
}

function ChangelogDialog({ current, onClose }: { current: string | null; onClose: () => void }) {
  const releases = parseChangelog(changelog);
  return (
    <Modal
      size="wide"
      title="Releases & Changelog"
      icon={<ScrollText size={16} style={{ color: "var(--accent)" }} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" style={{ marginRight: "auto" }} onClick={() => openUrl(`${REPO}/releases`)}>
            <ExternalLink size={13} /> Alle Releases auf GitHub
          </button>
          <button className="btn" onClick={onClose}>
            Schließen
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 18, maxHeight: "60vh", overflow: "auto" }}>
        {releases.map((r) => (
          <div key={r.version}>
            <div className="row" style={{ gap: 8 }}>
              <span className="version-chip" style={r.version === current ? { color: "var(--accent)" } : undefined}>
                v{r.version}
              </span>
              {r.date && <span className="dim">{new Date(r.date).toLocaleDateString("de-DE")}</span>}
              {r.version === current && <span className="pill ok">installiert</span>}
            </div>
            <ul className="update-notes">
              {r.items.map((t, i) => (
                <li key={i}>{t}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** Öffnet ein vorausgefülltes GitHub-Issue im Browser – abschicken passiert dort mit dem eigenen Konto. */
function FeedbackDialog({ version, onClose }: { version: string | null; onClose: () => void }) {
  const [kind, setKind] = useState<"bug" | "idea">("bug");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");

  const submit = async () => {
    const env = `Fernwerk v${version ?? "?"} · ${navigator.userAgent.match(/\(([^)]+)\)/)?.[1] ?? navigator.platform}`;
    const body =
      kind === "bug"
        ? `## Was ist passiert?\n\n${text}\n\n## Schritte zum Nachstellen\n\n1. \n\n## Erwartet\n\n\n---\n${env}`
        : `## Idee\n\n${text}\n\n---\n${env}`;
    const params = new URLSearchParams({
      title: `${kind === "bug" ? "[Bug]" : "[Idee]"} ${title.trim()}`,
      body,
      labels: kind === "bug" ? "bug" : "enhancement",
    });
    try {
      await openUrl(`${REPO}/issues/new?${params}`);
      onClose();
    } catch (e) {
      toast("error", errText(e));
    }
  };

  return (
    <Modal
      title="Bug melden oder Idee vorschlagen"
      icon={<MessageSquarePlus size={16} style={{ color: "var(--accent)" }} />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn primary" disabled={!title.trim()} onClick={submit}>
            <ExternalLink size={13} /> Auf GitHub erstellen
          </button>
        </>
      }
    >
      <div className="seg" style={{ alignSelf: "flex-start" }}>
        <button className={kind === "bug" ? "on" : ""} onClick={() => setKind("bug")}>
          <Bug size={13} /> Bug
        </button>
        <button className={kind === "idea" ? "on" : ""} onClick={() => setKind("idea")}>
          <Lightbulb size={13} /> Idee
        </button>
      </div>
      <Field label="Titel">
        <input
          className="input"
          autoFocus
          value={title}
          placeholder={kind === "bug" ? "z.B. Schlüssel lässt sich nicht auswählen" : "z.B. Hosts per Drag & Drop sortieren"}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label="Beschreibung">
        <textarea className="textarea" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="dim" style={{ fontSize: 12 }}>
        Öffnet GitHub im Browser mit allem vorausgefüllt – dort nur noch auf „Create“ klicken. Version und Betriebssystem werden
        angehängt, sonst nichts.
      </div>
    </Modal>
  );
}

/** Einstellungs-Sektion: aktuelle Version, manuelle Prüfung, Changelog und Feedback. */
export function UpdateSettings() {
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"changelog" | "feedback" | null>(null);
  if (version === null) getVersion().then(setVersion).catch(() => setVersion("?"));

  return (
    <div className="row" style={{ flexWrap: "wrap" }}>
      <span className="muted">
        Installiert: <span className="version-chip">v{version ?? "…"}</span>
      </span>
      <button
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await checkForUpdates(true);
          setBusy(false);
        }}
      >
        {busy ? "Prüfe…" : "Nach Updates suchen"}
      </button>
      <button className="btn" onClick={() => setDialog("changelog")}>
        <ScrollText size={14} /> Changelog
      </button>
      <button className="btn" onClick={() => setDialog("feedback")}>
        <MessageSquarePlus size={14} /> Bug / Idee melden
      </button>
      {dialog === "changelog" && <ChangelogDialog current={version} onClose={() => setDialog(null)} />}
      {dialog === "feedback" && <FeedbackDialog version={version} onClose={() => setDialog(null)} />}
    </div>
  );
}
