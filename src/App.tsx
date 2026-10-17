import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LayoutGrid, Plus, X } from "lucide-react";
import { CommandPalette } from "./components/CommandPalette";
import { HomeView, KeysView, SettingsView } from "./components/Home";
import { HostEditor } from "./components/HostEditor";
import { SessionView, TOOLS } from "./components/SessionView";
import { Sidebar } from "./components/Sidebar";
import { DialogHost, Toasts } from "./components/ui";
import { errText } from "./lib/api";
import { confirm, toast, useStore } from "./lib/store";

export default function App() {
  const vault = useStore((s) => s.vault);
  const sessions = useStore((s) => s.sessions);
  const active = useStore((s) => s.active);
  const view = useStore((s) => s.view);
  const editingHost = useStore((s) => s.editingHost);

  useEffect(() => {
    useStore
      .getState()
      .reloadVault()
      .catch((e) => toast("error", `Daten konnten nicht geladen werden: ${errText(e)}`));

    const un = listen<string>("conn-closed", (ev) => {
      const s = useStore.getState().sessions.find((x) => x.id === ev.payload);
      if (!s || s.status === "closed") return;
      useStore.getState().updateSession(s.id, { status: "closed" });
      toast("error", `Verbindung zu ${s.label} getrennt`);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Fenstertitel
  useEffect(() => {
    const s = sessions.find((x) => x.id === active);
    getCurrentWindow()
      .setTitle(s ? `${s.label} – Fernwerk` : "Fernwerk")
      .catch(() => {});
  }, [active, sessions]);

  // Globale Tastenkürzel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "k" && !e.shiftKey) {
        e.preventDefault();
        useStore.setState({ paletteOpen: !st.paletteOpen });
        return;
      }
      if (e.key === "Tab" && st.sessions.length > 0) {
        e.preventDefault();
        const i = st.sessions.findIndex((s) => s.id === st.active);
        const n = (i + (e.shiftKey ? -1 : 1) + st.sessions.length) % st.sessions.length;
        st.setActive(st.sessions[n].id);
        return;
      }
      if (!st.active) return;
      const tool = TOOLS.find((t) => t.key === e.key && !e.shiftKey && !e.altKey);
      if (tool) {
        e.preventDefault();
        st.setTool(st.active, tool.id);
        return;
      }
      if (e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        st.addTerminal(st.active);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const closeSession = async (id: string) => {
    const s = sessions.find((x) => x.id === id);
    if (s?.status === "connected" && !(await confirm("Sitzung trennen", `Verbindung zu ${s.label} trennen? Laufende Tunnel werden beendet.`, "Trennen")))
      return;
    useStore.getState().disconnect(id);
  };

  if (!vault) {
    return (
      <div className="app">
        <Toasts />
      </div>
    );
  }

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <div className="tabbar">
          <div
            className={`tab ${active === null ? "active" : ""}`}
            style={{ minWidth: 0, padding: "0 14px" }}
            onClick={() => useStore.getState().setActive(null)}
            title="Übersicht"
          >
            <LayoutGrid size={15} />
          </div>
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`tab ${active === s.id ? "active" : ""}`}
              style={{ ["--tab-color" as string]: s.color || undefined }}
              onClick={() => useStore.getState().setActive(s.id)}
              onAuxClick={(e) => e.button === 1 && closeSession(s.id)}
            >
              <span className="tab-stripe" style={s.status === "closed" ? { background: "var(--err)" } : undefined} />
              <span className="ellipsis">{s.label}</span>
              <button
                className="btn sm icon ghost x"
                onClick={(e) => {
                  e.stopPropagation();
                  closeSession(s.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            className="btn ghost icon"
            style={{ alignSelf: "center", marginLeft: 4 }}
            title="Verbinden… (Strg+K)"
            onClick={() => useStore.setState({ paletteOpen: true })}
          >
            <Plus size={15} />
          </button>
        </div>

        {sessions.map((s) => (
          <SessionView key={s.id} session={s} visible={active === s.id} />
        ))}

        {active === null && (view === "keys" ? <KeysView /> : view === "settings" ? <SettingsView /> : <HomeView />)}
      </main>

      {editingHost && (
        <HostEditor host={editingHost === "new" ? null : editingHost} onClose={() => useStore.setState({ editingHost: null })} />
      )}
      <CommandPalette />
      <DialogHost />
      <Toasts />
    </div>
  );
}
