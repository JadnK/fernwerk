const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return "–";
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${UNITS[i]}`;
}

export function rate(n: number | null | undefined): string {
  return n == null ? "–" : `${bytes(n)}/s`;
}

export function pct(n: number | null | undefined, digits = 0): string {
  return n == null || !isFinite(n) ? "–" : `${n.toFixed(digits)} %`;
}

export function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} T ${h} Std`;
  if (h > 0) return `${h} Std ${m} Min`;
  return `${m} Min`;
}

const dateFmt = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function unixDate(sec: number | null | undefined): string {
  return sec ? dateFmt.format(new Date(sec * 1000)) : "–";
}

export function relative(sec: number | null | undefined): string {
  if (!sec) return "nie";
  const diff = Date.now() / 1000 - sec;
  if (diff < 60) return "gerade eben";
  if (diff < 3600) return `vor ${Math.floor(diff / 60)} Min`;
  if (diff < 86400) return `vor ${Math.floor(diff / 3600)} Std`;
  return `vor ${Math.floor(diff / 86400)} T`;
}

export function uid(): string {
  return crypto.randomUUID();
}

export function parentDir(path: string): string {
  if (path === "/" || !path.includes("/")) return "/";
  const p = path.replace(/\/+$/, "");
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Einfaches Fuzzy-Matching: alle Zeichen der Suche in Reihenfolge enthalten. */
export function fuzzy(haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase();
  let i = 0;
  for (const c of needle.toLowerCase()) {
    i = h.indexOf(c, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}
