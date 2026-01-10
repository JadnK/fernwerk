import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// Kontextmenü des Browsers außerhalb von Eingabefeldern unterdrücken
document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea, .selectable")) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(<App />);
