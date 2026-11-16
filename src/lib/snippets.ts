import { ask } from "./store";

/**
 * Platzhalter in Snippets: {{name}} oder {{name:Standardwert}}.
 * Go-Templates wie `docker ps --format '{{.Names}}'` beginnen mit einem Punkt und bleiben unberührt.
 */
const VAR = /\{\{\s*([A-Za-z_][\w-]*)(?::([^}]*))?\s*\}\}/g;

export function snippetVars(command: string): { name: string; def: string }[] {
  const seen = new Map<string, string>();
  for (const m of command.matchAll(VAR)) {
    if (!seen.has(m[1])) seen.set(m[1], m[2]?.trim() ?? "");
  }
  return [...seen].map(([name, def]) => ({ name, def }));
}

/**
 * Fragt die Platzhalter eines Snippets ab und setzt sie ein.
 * Liefert null, wenn der Dialog abgebrochen wurde.
 */
export async function fillSnippet(title: string, command: string): Promise<string | null> {
  const vars = snippetVars(command);
  if (vars.length === 0) return command;
  const r = await ask({
    title,
    detail: command,
    fields: vars.map((v) => ({ name: v.name, label: v.name, value: v.def })),
    confirm: "Ausführen",
  });
  if (!r) return null;
  return command.replace(VAR, (_, name: string) => String(r[name] ?? ""));
}
