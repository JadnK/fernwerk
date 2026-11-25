import { useEffect, useMemo, useState } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PanelLeftOpen } from "lucide-react";
import { api } from "../lib/api";
import { DOCK_EVENT, popoutKey, type DockPayload, type PopoutInfo } from "../lib/popout";
import type { Settings } from "../lib/types";
import { TerminalPane, releaseTerminal } from "./TerminalPane";

function readInfo(label: string): PopoutInfo | null {
  try {
    const raw = localStorage.getItem(popoutKey(label));
    return raw ? (JSON.parse(raw) as PopoutInfo) : null;
  } catch {
    return null;
  }
}

function forget(label: string) {
  try {
    localStorage.removeItem(popoutKey(label));
  } catch {
    /* egal */
  }
}

/** Eigenständiges Fenster mit einer einzelnen, aus dem Hauptfenster gelösten Shell. */
export function PopoutShell({ label }: { label: string }) {
  const info = useMemo(() => readInfo(label), [label]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [title, setTitle] = useState(info?.title ?? "Shell");
  const tab = useMemo(
    () => ({ key: label, title: info?.title ?? "Shell", attachId: info?.termId, root: info?.root }),
    [label, info],
  );

  useEffect(() => {
    api
      .vaultLoad()
      .then((v) => setSettings(v.settings))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!info) return;
    getCurrentWindow()
      .setTitle(`${title} – ${info.label}`)
      .catch(() => {});
  }, [title, info]);

  // Fenster schließen = Shell beenden (sofern sie nicht zurückgeholt wurde)
  useEffect(() => {
    if (!info) return;
    const un = getCurrentWindow().onCloseRequested(async () => {
      forget(label);
      if (releaseTerminal(label) !== null) await api.termClose(info.connId, info.termId).catch(() => {});
    });
    return () => {
      un.then((f) => f());
    };
  }, [info, label]);

  const dock = async () => {
    if (!info || releaseTerminal(label) === null) return;
    forget(label);
    const payload: DockPayload = { sessionId: info.sessionId, termId: info.termId, title, root: info.root };
    await emitTo("main", DOCK_EVENT, payload).catch(() => {});
    await getCurrentWindow().destroy();
  };

  if (!info) {
    return (
      <div className="popout">
        <div className="empty">Diese Shell ist nicht mehr verfügbar.</div>
      </div>
    );
  }

  return (
    <div className="popout">
      <div className="popout-bar" style={{ ["--tab-color" as string]: info.color || undefined }}>
        <span className="tab-stripe" />
        {info.root && <span className="root-chip">root</span>}
        <span className="ellipsis" style={{ fontWeight: 500 }}>
          {title}
        </span>
        <span className="session-meta">{info.host}</span>
        <button className="btn sm ghost" title="Shell wieder als Tab ins Hauptfenster holen" onClick={dock}>
          <PanelLeftOpen size={13} /> Zurück ins Hauptfenster
        </button>
      </div>
      {settings && (
        <div className="term-split">
          <TerminalPane
            connId={info.connId}
            tab={tab}
            settings={settings}
            visible
            focused
            onFocus={() => {}}
            onTitle={(t) => t && setTitle(t)}
            onExit={() => setTimeout(() => getCurrentWindow().close().catch(() => {}), 1200)}
          />
        </div>
      )}
    </div>
  );
}
