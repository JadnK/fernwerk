/** Hilfen zum Bauen von Shell-Befehlen, die per SSH ausgeführt werden. */

/** Einfache Anführungszeichen für sh – sicher für beliebigen Text. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Wie q(), lässt aber ein führendes ~/ vom Server-Shell expandieren. */
export function qPath(p: string): string {
  const t = p.trim();
  if (t === "~") return `"$HOME"`;
  if (t.startsWith("~/")) return `"$HOME"/${q(t.slice(2))}`;
  return q(t);
}

/** UTF-8-Text als Base64 (für das Schreiben von Dateien über `base64 -d`). */
export function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Befehl, der `content` nach `path` (relativ zu $HOME erlaubt) schreibt. */
export function writeFileCmd(path: string, content: string): string {
  return `printf %s ${q(b64(content))} | base64 -d > ${qPath(path)}`;
}
