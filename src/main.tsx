import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { EditorWindow } from "./components/EditorWindow";
import { PopoutShell } from "./components/Popout";
import { EDITOR_PREFIX } from "./lib/editwin";
import { POPOUT_PREFIX } from "./lib/popout";
import "./styles.css";

// Kontextmenü des Browsers außerhalb von Eingabefeldern unterdrücken
document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea, .selectable")) e.preventDefault();
});

// Über der Scrollleiste von Textfeldern den normalen Pfeil statt des Text-Cursors zeigen.
// Chromium/WebView2 übernimmt sonst den I-Beam des Textfelds auch für die Scrollleiste.
document.addEventListener(
  "mousemove",
  (e) => {
    const el = e.target;
    if (!(el instanceof HTMLTextAreaElement)) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left - el.clientLeft;
    const y = e.clientY - r.top - el.clientTop;
    const onBar = x >= el.clientWidth || y >= el.clientHeight;
    const want = onBar ? "default" : "";
    if (el.style.cursor !== want) el.style.cursor = want;
  },
  { passive: true },
);

// Ausgelagerte Shells und der Datei-Editor laufen in eigenen Fenstern mit eigener, schlanker Oberfläche
const label = getCurrentWindow().label;
createRoot(document.getElementById("root")!).render(
  label.startsWith(POPOUT_PREFIX) ? (
    <PopoutShell label={label} />
  ) : label.startsWith(EDITOR_PREFIX) ? (
    <EditorWindow label={label} />
  ) : (
    <App />
  ),
);
