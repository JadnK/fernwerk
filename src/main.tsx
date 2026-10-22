import { createRoot } from "react-dom/client";
import App from "./App";
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

createRoot(document.getElementById("root")!).render(<App />);
