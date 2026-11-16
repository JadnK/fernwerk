// Hilfsskript für den Release-Workflow (Node 22, keine Abhängigkeiten).
//
//   node .github/scripts/release.mjs prepare   → Release v<version> als Entwurf anlegen bzw. wiederverwenden
//   node .github/scripts/release.mjs publish   → latest.json aus den hochgeladenen .sig-Dateien bauen,
//                                                hochladen und das Release veröffentlichen
//
// Umgebungsvariablen: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_OUTPUT, RELEASE_ID (nur publish)

import { appendFileSync, readFileSync } from "node:fs";

const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;

const version = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version;
const tag = `v${version}`;

async function gh(path, init = {}) {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  return res;
}
const json = async (path, init) => (await gh(path, init)).json();

/** Abschnitt „## <version> …“ aus dem CHANGELOG */
export function changelogSection(text = readFileSync("CHANGELOG.md", "utf8"), v = version) {
  const out = [];
  let on = false;
  for (const l of text.replace(/\r/g, "").split("\n")) {
    if (l.startsWith("## ")) {
      if (on) break;
      on = l.startsWith(`## ${v} `) || l.trim() === `## ${v}`;
      continue;
    }
    if (on) out.push(l);
  }
  return out.join("\n").trim();
}

function releaseBody(notes) {
  return `${notes}

### Downloads

| System | Datei |
|---|---|
| Windows | \`x64-setup.exe\` (Installer), \`.msi\` oder \`arm64-setup.exe\` |
| macOS Apple Silicon | \`aarch64.dmg\` |
| macOS Intel | \`x64.dmg\` |
| Linux | \`.AppImage\`, \`.deb\` oder \`.rpm\` (amd64 / arm64) |

Bereits installiert? Fernwerk meldet die neue Version selbst und installiert sie per Klick.
`;
}

/**
 * Sucht das Release zum Tag. Gibt es mehrere (z.B. Entwürfe aus früheren, abgebrochenen Läufen),
 * wird das veröffentlichte behalten und überzählige Entwürfe werden gelöscht.
 */
async function findRelease() {
  const hits = [];
  for (let page = 1; page < 20; page++) {
    const list = await json(`/repos/${repo}/releases?per_page=100&page=${page}`);
    hits.push(...list.filter((r) => r.tag_name === tag));
    if (list.length < 100) break;
  }
  if (hits.length === 0) return null;
  const keep = hits.find((r) => !r.draft) ?? hits[0];
  for (const r of hits) {
    if (r.id !== keep.id && r.draft) {
      console.log(`Lösche doppelten Entwurf für ${tag} (id ${r.id})`);
      await gh(`/repos/${repo}/releases/${r.id}`, { method: "DELETE" });
    }
  }
  return keep;
}

async function prepare() {
  const notes = changelogSection();
  if (!notes) console.log(`::warning::Kein Abschnitt „## ${version} …“ im CHANGELOG – Release-Notes bleiben leer`);
  const body = releaseBody(notes);

  let rel = await findRelease();
  if (rel) {
    console.log(`Release ${tag} existiert bereits (id ${rel.id}, draft=${rel.draft}) – wird wiederverwendet`);
    rel = await json(`/repos/${repo}/releases/${rel.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: `Fernwerk ${tag}`, body }),
    });
  } else {
    rel = await json(`/repos/${repo}/releases`, {
      method: "POST",
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: process.env.GITHUB_SHA,
        name: `Fernwerk ${tag}`,
        body,
        draft: true,
        prerelease: false,
      }),
    });
    console.log(`Release-Entwurf ${tag} angelegt (id ${rel.id})`);
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `id=${rel.id}\nversion=${version}\n`);
}

/**
 * Ordnet einen Asset-Namen dem Updater-Plattformschlüssel zu,
 * z.B. "Fernwerk_1.2.1_x64-setup.exe" → { os: "windows", arch: "x86_64", kind: "nsis" }.
 */
export function classify(name) {
  const arch = /aarch64|arm64/i.test(name) ? "aarch64" : /x64|x86_64|amd64/i.test(name) ? "x86_64" : null;
  let os, kind;
  if (name.endsWith("-setup.exe")) [os, kind] = ["windows", "nsis"];
  else if (name.endsWith(".msi")) [os, kind] = ["windows", "msi"];
  else if (name.endsWith(".app.tar.gz")) [os, kind] = ["darwin", "app"];
  else if (name.endsWith(".AppImage")) [os, kind] = ["linux", "appimage"];
  else if (name.endsWith(".deb")) [os, kind] = ["linux", "deb"];
  else if (name.endsWith(".rpm")) [os, kind] = ["linux", "rpm"];
  else return null;
  return arch ? { os, arch, kind } : null;
}

// Paket für den allgemeinen Schlüssel „<os>-<arch>“
const DEFAULT_KIND = { windows: "nsis", darwin: "app", linux: "appimage" };

export function buildPlatforms(assetNames, sigs, urlFor) {
  const platforms = {};
  for (const name of assetNames) {
    const c = classify(name);
    const sig = sigs[`${name}.sig`];
    if (!c || !sig) continue;
    const entry = { signature: sig.trim(), url: urlFor(name) };
    platforms[`${c.os}-${c.arch}-${c.kind}`] = entry;
    if (DEFAULT_KIND[c.os] === c.kind) platforms[`${c.os}-${c.arch}`] = entry;
  }
  return platforms;
}

async function publish() {
  const id = process.env.RELEASE_ID;
  const rel = await json(`/repos/${repo}/releases/${id}`);
  const assets = [];
  for (let page = 1; page < 10; page++) {
    const list = await json(`/repos/${repo}/releases/${id}/assets?per_page=100&page=${page}`);
    assets.push(...list);
    if (list.length < 100) break;
  }

  const sigs = {};
  for (const a of assets.filter((a) => a.name.endsWith(".sig"))) {
    const res = await gh(`/repos/${repo}/releases/assets/${a.id}`, { headers: { Accept: "application/octet-stream" } });
    sigs[a.name] = await res.text();
  }

  const urlFor = (name) => `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const platforms = buildPlatforms(assets.map((a) => a.name), sigs, urlFor);
  if (Object.keys(platforms).length === 0) {
    throw new Error("Keine signierten Update-Pakete gefunden – Release wird nicht veröffentlicht");
  }

  const latest = { version, notes: changelogSection(), pub_date: new Date().toISOString(), platforms };
  console.log("latest.json:", Object.keys(platforms).sort().join(", "));

  const old = assets.find((a) => a.name === "latest.json");
  if (old) await gh(`/repos/${repo}/releases/assets/${old.id}`, { method: "DELETE" });
  await gh(rel.upload_url.replace(/\{.*\}$/, "") + "?name=latest.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(latest, null, 2),
  });

  await json(`/repos/${repo}/releases/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ draft: false, make_latest: "true", tag_name: tag }),
  });
  console.log(`${tag} veröffentlicht`);
}

const cmd = process.argv[2];
if (cmd === "prepare") await prepare();
else if (cmd === "publish") await publish();
else if (cmd !== undefined) {
  console.error("Aufruf: release.mjs prepare|publish");
  process.exit(1);
}
