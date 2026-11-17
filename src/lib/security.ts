/**
 * Bewertet die Rohdaten aus `security_audit` (Rust) zu einzelnen Prüfpunkten.
 * Nur lesend – Korrekturen werden als Befehl vorgeschlagen und nie automatisch ausgeführt.
 */

export type CheckStatus = "ok" | "warn" | "bad" | "info" | "unknown";
export type CheckGroup = "ssh" | "firewall" | "attacks" | "system" | "accounts";

export interface Check {
  id: string;
  group: CheckGroup;
  title: string;
  status: CheckStatus;
  detail: string;
  /** Vorschlag zum Beheben – wird ins Terminal eingefügt, nicht ausgeführt. */
  fix?: string;
  /** Warnung zum Fix, z.B. Aussperr-Gefahr. */
  fixNote?: string;
}

export interface ListenPort {
  proto: string;
  address: string;
  port: number;
  process: string;
  public: boolean;
  risky?: string;
}

export interface Peer {
  count: number;
  ip: string;
}

export interface AuditResult {
  checks: Check[];
  ports: ListenPort[];
  topPeers: Peer[];
  failedIps: Peer[];
  os: string;
  kernel: string;
  score: number;
  /** Lief der Check mit root-Rechten? */
  root: boolean;
}

export const GROUPS: { id: CheckGroup; label: string }[] = [
  { id: "ssh", label: "SSH-Zugang" },
  { id: "firewall", label: "Firewall & Ports" },
  { id: "attacks", label: "Angriffe & DDoS" },
  { id: "system", label: "System & Updates" },
  { id: "accounts", label: "Konten & Rechte" },
];

/** Dienste, die praktisch nie offen im Internet hängen sollten. */
const RISKY: Record<number, [string, "bad" | "warn"]> = {
  21: ["FTP (unverschlüsselt)", "warn"],
  23: ["Telnet (unverschlüsselt)", "bad"],
  111: ["rpcbind", "warn"],
  445: ["SMB", "bad"],
  2375: ["Docker-API ohne TLS", "bad"],
  3306: ["MySQL/MariaDB", "warn"],
  3389: ["RDP", "warn"],
  5432: ["PostgreSQL", "warn"],
  5900: ["VNC", "warn"],
  6379: ["Redis", "bad"],
  9200: ["Elasticsearch", "bad"],
  11211: ["Memcached", "bad"],
  27017: ["MongoDB", "bad"],
};

/** Eigene Drop-in-Datei: „00-“ sortiert vor z.B. 50-cloud-init.conf, bei sshd gilt der erste Wert. */
const SSHD_DROPIN = "/etc/ssh/sshd_config.d/00-fernwerk.conf";
const sshdSet = (...settings: string[]) =>
  `printf '${settings.join("\\n")}\\n' | sudo tee -a ${SSHD_DROPIN} >/dev/null && sudo sshd -t && (sudo systemctl reload ssh 2>/dev/null || sudo systemctl reload sshd)`;

const num = (s: string | undefined) => {
  const n = parseInt((s ?? "").trim(), 10);
  return Number.isFinite(n) ? n : null;
};

const lines = (s: string | undefined) => (s ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

function parsePeers(s: string | undefined): Peer[] {
  return lines(s)
    .map((l) => l.match(/^(\d+)\s+(\S+)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ count: Number(m[1]), ip: m[2] }));
}

/** sshd -T (effektiv) bevorzugen, sonst die Konfigurationsdateien – dort gilt der erste Treffer. */
function parseSshd(raw: Record<string, string>): Record<string, string> | null {
  const src = raw.sshd?.trim() ? raw.sshd : raw.sshd_files;
  if (!src?.trim()) return null;
  const conf: Record<string, string> = {};
  for (const l of lines(src)) {
    const [k, ...v] = l.split(/\s+/);
    const key = k.toLowerCase();
    if (!(key in conf)) conf[key] = v.join(" ").toLowerCase();
  }
  return conf;
}

function parsePorts(raw: string | undefined): ListenPort[] {
  const out: ListenPort[] = [];
  const seen = new Set<string>();
  for (const l of lines(raw)) {
    // tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))
    const cols = l.split(/\s+/);
    if (cols.length < 5) continue;
    const proto = cols[0];
    const m = cols[4].match(/^(.*):(\d+|\*)$/);
    if (!m || m[2] === "*") continue;
    const address = m[1].replace(/^\[|\]$/g, "").replace(/%\S+$/, "");
    const port = Number(m[2]);
    const process = l.match(/users:\(\("([^"]+)"/)?.[1] ?? "";
    const pub = !/^(127\.|::1$|localhost|::ffff:127\.)/.test(address);
    const key = `${proto}/${port}/${pub}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ proto, address: address || "*", port, process, public: pub, risky: pub ? RISKY[port]?.[0] : undefined });
  }
  return out.sort((a, b) => Number(b.public) - Number(a.public) || a.port - b.port);
}

export function evaluate(raw: Record<string, string>, ctx: { username: string; usesPassword: boolean }): AuditResult {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const root = raw.whoami?.trim() === "0";
  const needRoot = "Nur mit root-Rechten lesbar – Check mit sudo erneut ausführen.";

  // ------------------------------------------------------------ SSH
  const sshd = parseSshd(raw);
  // Ohne sshd -T kennen wir nur explizite Einträge – dann OpenSSH-Standardwerte annehmen.
  const val = (k: string, def: string) => (sshd ? (sshd[k] ?? def) : undefined);
  const sshPort = num(val("port", "22")) ?? 22;

  // Ziel ist „prohibit-password“: root bleibt per SSH-Key erreichbar, nur Passwörter sind gesperrt.
  // Wer als root per Passwort verbunden ist, würde sich damit aussperren – dann gibt es keinen Fix-Befehl.
  const rootViaPassword = ctx.username === "root" && ctx.usesPassword;
  const lockoutHint =
    "Du bist als root per Passwort verbunden – mit diesem Fix sperrst du dich aus. Hinterlege zuerst einen Schlüssel (Tab „SSH-Keys“) und stelle den Host in Fernwerk auf Schlüssel um, dann erneut prüfen.";
  const rootLogin = val("permitrootlogin", "prohibit-password");
  if (rootLogin === undefined) add({ id: "root-login", group: "ssh", title: "Root-Login", status: "unknown", detail: needRoot });
  else if (rootLogin === "prohibit-password" || rootLogin === "without-password")
    add({ id: "root-login", group: "ssh", title: "Root-Login nur mit SSH-Key", status: "ok", detail: `PermitRootLogin ${rootLogin} – root per Passwort ist gesperrt.` });
  else if (rootLogin === "no")
    add({ id: "root-login", group: "ssh", title: "Root-Login deaktiviert", status: "ok", detail: "PermitRootLogin no – root kommt gar nicht per SSH rein, auch nicht mit Schlüssel." });
  else
    add({
      id: "root-login",
      group: "ssh",
      title: rootLogin === "yes" ? "Root-Login per Passwort erlaubt" : `Root-Login: ${rootLogin}`,
      status: "bad",
      detail: "Bots probieren rund um die Uhr root-Passwörter durch. Empfohlen: root nur noch per SSH-Key (prohibit-password).",
      fix: rootViaPassword ? undefined : sshdSet("PermitRootLogin prohibit-password"),
      fixNote: rootViaPassword ? lockoutHint : undefined,
    });

  const pwAuth = val("passwordauthentication", "yes");
  const kbd = val("kbdinteractiveauthentication", val("challengeresponseauthentication", "no") ?? "no");
  if (pwAuth === undefined) add({ id: "key-only", group: "ssh", title: "Nur SSH-Key-Login", status: "unknown", detail: needRoot });
  else if (pwAuth === "no" && kbd !== "yes")
    add({ id: "key-only", group: "ssh", title: "Nur SSH-Key-Login", status: "ok", detail: "Passwort-Login ist abgeschaltet." });
  else
    add({
      id: "key-only",
      group: "ssh",
      title: "Passwort-Login ist erlaubt",
      status: "bad",
      detail:
        pwAuth === "no"
          ? "PasswordAuthentication no, aber KbdInteractiveAuthentication yes – über PAM sind Passwörter weiter möglich."
          : "PasswordAuthentication yes – Brute-Force auf Passwörter ist möglich. Nur Schlüssel zulassen.",
      fix: rootViaPassword ? undefined : sshdSet("PasswordAuthentication no", "KbdInteractiveAuthentication no"),
      fixNote: rootViaPassword
        ? lockoutHint
        : ctx.usesPassword
          ? "Dieser Host meldet sich in Fernwerk per Passwort an. Hinterlege vorher einen Schlüssel (Tab „SSH-Keys“) und stelle den Host auf Schlüssel um – sonst sperrst du dich aus."
          : undefined,
    });

  if (val("pubkeyauthentication", "yes") === "no")
    add({ id: "pubkey", group: "ssh", title: "Schlüssel-Login abgeschaltet", status: "bad", detail: "PubkeyAuthentication no", fix: sshdSet("PubkeyAuthentication yes") });
  if (val("permitemptypasswords", "no") === "yes")
    add({ id: "empty-pw-ssh", group: "ssh", title: "Leere Passwörter erlaubt", status: "bad", detail: "PermitEmptyPasswords yes", fix: sshdSet("PermitEmptyPasswords no") });

  const tries = num(val("maxauthtries", "6"));
  if (tries !== null)
    add({
      id: "max-tries",
      group: "ssh",
      title: "Anmeldeversuche pro Verbindung",
      status: tries > 4 ? "warn" : "ok",
      detail: `MaxAuthTries ${tries}${tries > 4 ? " – 3 reicht und bremst Brute-Force." : ""}`,
      fix: tries > 4 ? sshdSet("MaxAuthTries 3") : undefined,
    });
  if (val("x11forwarding", "no") === "yes")
    add({ id: "x11", group: "ssh", title: "X11-Forwarding aktiv", status: "warn", detail: "Auf Servern meist unnötig.", fix: sshdSet("X11Forwarding no") });
  if (sshd)
    add({
      id: "ssh-port",
      group: "ssh",
      title: `SSH auf Port ${sshPort}`,
      status: "info",
      detail: sshPort === 22 ? "Standardport – ein anderer Port reduziert Bot-Rauschen, ist aber kein echter Schutz." : "Abweichender Port reduziert automatische Scans.",
    });

  // ------------------------------------------------------------ Firewall
  const ufw = raw.ufw ?? "";
  const ufwActive = /Status:\s*active/i.test(ufw);
  const firewalld = /^running/m.test(raw.firewalld ?? "");
  const ipt = raw.iptables ?? "";
  const iptDrop = /^-P INPUT (DROP|REJECT)/m.test(ipt) || /-j (DROP|REJECT)/.test(ipt);
  const nftDrop = (num(raw.nft) ?? 0) > 0;

  if (ufwActive) {
    const deny = /Default:\s*(deny|reject)\s*\(incoming\)/i.test(ufw);
    add({
      id: "firewall",
      group: "firewall",
      title: "Firewall aktiv (ufw)",
      status: deny ? "ok" : "warn",
      detail: deny ? "Eingehend standardmäßig blockiert." : "ufw läuft, lässt eingehend aber standardmäßig alles durch.",
      fix: deny ? undefined : "sudo ufw default deny incoming",
    });
  } else if (firewalld) add({ id: "firewall", group: "firewall", title: "Firewall aktiv (firewalld)", status: "ok", detail: "firewalld läuft." });
  else if (iptDrop || nftDrop)
    add({ id: "firewall", group: "firewall", title: "Firewall-Regeln vorhanden", status: "ok", detail: `Blockierende Regeln in ${iptDrop ? "iptables" : "nftables"} gefunden.` });
  else if (!root) add({ id: "firewall", group: "firewall", title: "Firewall", status: "unknown", detail: needRoot });
  else
    add({
      id: "firewall",
      group: "firewall",
      title: "Keine aktive Firewall",
      status: "bad",
      detail: ufw ? "ufw ist installiert, aber inaktiv." : "Weder ufw, firewalld noch blockierende iptables/nftables-Regeln gefunden.",
      fix: `${ufw ? "" : "sudo apt install -y ufw && "}sudo ufw allow ${sshPort}/tcp && sudo ufw default deny incoming && sudo ufw --force enable`,
      fixNote: `Gib vorher alle Ports frei, die du brauchst (z.B. sudo ufw allow 80,443/tcp). Der SSH-Port ${sshPort} ist im Befehl schon enthalten.`,
    });

  const ufwRules = lines(ufw).filter((l) => /ALLOW|DENY|REJECT|LIMIT/.test(l) && !/^Default/i.test(l));
  if (ufwActive && ufwRules.length)
    add({ id: "ufw-rules", group: "firewall", title: `${ufwRules.length} ufw-Regeln`, status: "info", detail: ufwRules.join("\n") });

  const ports = parsePorts(raw.listen);
  const publicPorts = ports.filter((p) => p.public);
  const fwOn = ufwActive || firewalld || iptDrop || nftDrop;
  for (const p of publicPorts.filter((x) => x.risky)) {
    add({
      id: `port-${p.proto}-${p.port}`,
      group: "firewall",
      title: `${p.risky} auf allen Adressen`,
      status: fwOn ? "warn" : RISKY[p.port][1],
      detail: `${p.proto.toUpperCase()} ${p.address}:${p.port}${p.process ? ` (${p.process})` : ""} lauscht öffentlich. ${
        fwOn ? "Prüfe, ob die Firewall den Port blockt." : "Nur an 127.0.0.1 binden oder per Firewall sperren."
      }`,
      fix: ufwActive ? `sudo ufw deny ${p.port}/${p.proto.startsWith("udp") ? "udp" : "tcp"}` : undefined,
    });
  }

  // ------------------------------------------------------------ Angriffe & DDoS
  const syn = num(raw.syn_recv);
  const est = num(raw.established);
  const topPeers = parsePeers(raw.top_peers);
  const failedIps = parsePeers(raw.failed_ips);
  if (syn !== null)
    add({
      id: "syn",
      group: "attacks",
      title: syn > 100 ? "Möglicher SYN-Flood" : "Halboffene Verbindungen",
      status: syn > 100 ? "bad" : syn > 20 ? "warn" : "ok",
      detail: `${syn} Verbindungen im Zustand SYN-RECV${syn > 20 ? " – deutlich erhöht, typisch für SYN-Flood-Angriffe." : " – unauffällig."}`,
    });
  const heavy = topPeers.filter((p) => p.count >= 50);
  if (est !== null)
    add({
      id: "conns",
      group: "attacks",
      title: heavy.length ? "Viele Verbindungen von einzelnen IPs" : "Aktive Verbindungen",
      status: heavy.length ? "warn" : "ok",
      detail: `${est} aufgebaute TCP-Verbindungen.${heavy.length ? ` Spitzenreiter: ${heavy.map((p) => `${p.ip} (${p.count})`).join(", ")}.` : ""}`,
      fix: heavy.length && ufwActive ? `sudo ufw insert 1 deny from ${heavy[0].ip}` : undefined,
    });

  const up = lines(raw.uptime);
  const load1 = parseFloat(up[0] ?? "");
  const cores = num(up[1]) ?? 1;
  if (Number.isFinite(load1))
    add({
      id: "load",
      group: "attacks",
      title: "Systemlast",
      status: load1 / cores > 2 ? "warn" : "ok",
      detail: `Load ${load1.toFixed(2)} bei ${cores} Kern${cores === 1 ? "" : "en"}${load1 / cores > 2 ? " – überlastet (Angriff oder hängender Prozess?)." : "."}`,
    });

  const f2b = raw.fail2ban ?? "";
  const f2bOn = /Number of jail/i.test(f2b);
  const f2bSsh = !!raw.fail2ban_sshd?.trim();
  const banned = num(raw.fail2ban_sshd?.match(/Currently banned:\s*(\d+)/)?.[1]);
  const crowdsec = raw.crowdsec?.trim() === "active";
  if (f2bOn || crowdsec)
    add({
      id: "bruteforce",
      group: "attacks",
      title: `Brute-Force-Schutz aktiv (${f2bOn ? "fail2ban" : "CrowdSec"})`,
      status: f2bOn && !f2bSsh && !crowdsec ? "warn" : "ok",
      detail: f2bOn && !f2bSsh && !crowdsec ? "fail2ban läuft, aber ohne Jail für SSH." : banned !== null ? `${banned} IP${banned === 1 ? "" : "s"} gerade gesperrt.` : "Läuft.",
    });
  else if (f2b.trim() && !root) add({ id: "bruteforce", group: "attacks", title: "Brute-Force-Schutz (fail2ban)", status: "unknown", detail: needRoot });
  else
    add({
      id: "bruteforce",
      group: "attacks",
      title: "Kein Brute-Force-Schutz",
      status: pwAuth === "no" ? "warn" : "bad",
      detail: "Weder fail2ban noch CrowdSec aktiv – fehlgeschlagene Logins werden nicht automatisch gesperrt.",
      fix: "sudo apt install -y fail2ban && sudo systemctl enable --now fail2ban",
    });

  const failed = num(raw.failed_logins);
  if (failed !== null)
    add({
      id: "failed",
      group: "attacks",
      title: "Fehlgeschlagene SSH-Logins (24 h)",
      status: failed > 500 && !f2bOn && !crowdsec ? "warn" : "info",
      detail: failed === 0 && !root ? "Keine gefunden – ohne root sind die Logs oft nicht lesbar." : `${failed} Versuche.`,
    });

  const sysctl: Record<string, string> = Object.fromEntries(
    lines(raw.sysctl).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
  );
  const cookies = sysctl["net.ipv4.tcp_syncookies"];
  if (cookies)
    add({
      id: "syncookies",
      group: "attacks",
      title: "SYN-Cookies",
      status: cookies === "1" ? "ok" : "warn",
      detail: cookies === "1" ? "Aktiv – schützt vor SYN-Floods." : "Aus – der Server ist anfälliger für SYN-Floods.",
      fix: cookies === "1" ? undefined : "echo 'net.ipv4.tcp_syncookies = 1' | sudo tee -a /etc/sysctl.d/90-fernwerk.conf && sudo sysctl --system",
    });
  if (sysctl["net.ipv4.conf.all.accept_redirects"] === "1")
    add({
      id: "redirects",
      group: "attacks",
      title: "ICMP-Redirects werden akzeptiert",
      status: "warn",
      detail: "Erlaubt das Umbiegen von Routen (Man-in-the-Middle).",
      fix: "echo 'net.ipv4.conf.all.accept_redirects = 0' | sudo tee -a /etc/sysctl.d/90-fernwerk.conf && sudo sysctl --system",
    });
  const aslr = sysctl["kernel.randomize_va_space"];
  if (aslr && aslr !== "2") add({ id: "aslr", group: "attacks", title: "ASLR nicht voll aktiv", status: "warn", detail: `kernel.randomize_va_space = ${aslr}` });

  // ------------------------------------------------------------ System & Updates
  const apt = lines(raw.updates_apt).map(Number);
  const dnf = lines(raw.updates_dnf).map(Number);
  const pm = apt.length ? "apt" : dnf.length ? "dnf" : null;
  const [upd, sec] = pm === "apt" ? apt : dnf;
  if (pm && Number.isFinite(upd))
    add({
      id: "updates",
      group: "system",
      title: upd ? `${upd} Updates ausstehend` : "System ist aktuell",
      status: sec ? "bad" : upd ? "warn" : "ok",
      detail: sec
        ? `Davon ${sec} Sicherheitsupdates.`
        : upd
          ? "Keines davon als Sicherheitsupdate markiert."
          : "Keine ausstehenden Pakete (Stand des lokalen Paketindex – evtl. vorher apt update).",
      fix: upd ? (pm === "apt" ? "sudo apt update && sudo apt upgrade -y" : "sudo dnf upgrade -y") : undefined,
    });
  const auto = lines(raw.auto_updates);
  if (pm)
    add({
      id: "auto-updates",
      group: "system",
      title: auto.length ? "Automatische Sicherheitsupdates aktiv" : "Keine automatischen Updates",
      status: auto.length ? "ok" : "warn",
      detail: auto.length ? (auto.includes("apt") ? "unattended-upgrades" : "dnf-automatic") : "Sicherheitslücken bleiben offen, bis jemand manuell aktualisiert.",
      fix: auto.length
        ? undefined
        : pm === "apt"
          ? "sudo apt install -y unattended-upgrades && sudo dpkg-reconfigure -f noninteractive unattended-upgrades"
          : "sudo dnf install -y dnf-automatic && sudo systemctl enable --now dnf-automatic-install.timer",
    });
  if (raw.reboot?.trim() === "yes")
    add({ id: "reboot", group: "system", title: "Neustart erforderlich", status: "warn", detail: "Ein Update (z.B. Kernel) wird erst nach einem Neustart wirksam." });

  // ------------------------------------------------------------ Konten
  const uid0 = lines(raw.uid0).filter((u) => u !== "root");
  add({
    id: "uid0",
    group: "accounts",
    title: uid0.length ? "Weitere Konten mit root-Rechten (UID 0)" : "Nur root hat UID 0",
    status: uid0.length ? "bad" : "ok",
    detail: uid0.length ? uid0.join(", ") : "Keine versteckten root-Konten.",
  });
  if (raw.shadow_readable?.trim() === "yes") {
    const empty = lines(raw.empty_pw);
    add({
      id: "empty-pw",
      group: "accounts",
      title: empty.length ? "Konten ohne Passwort" : "Keine Konten mit leerem Passwort",
      status: empty.length ? "bad" : "ok",
      detail: empty.length ? empty.join(", ") : "Alle Konten haben ein Passwort oder sind gesperrt.",
      fix: empty.length ? empty.map((u) => `sudo passwd -l ${u}`).join(" && ") : undefined,
    });
  } else add({ id: "empty-pw", group: "accounts", title: "Konten ohne Passwort", status: "unknown", detail: needRoot });

  const nopw = lines(raw.nopasswd);
  if (nopw.length) add({ id: "nopasswd", group: "accounts", title: "sudo ohne Passwort", status: "info", detail: nopw.join("\n") });
  const rootKeys = num(raw.root_keys);
  if (rootKeys !== null)
    add({ id: "root-keys", group: "accounts", title: `${rootKeys} Schlüssel für root hinterlegt`, status: "info", detail: "/root/.ssh/authorized_keys" });

  // ------------------------------------------------------------ Punkte
  const weight: Record<CheckStatus, number | null> = { ok: 1, warn: 0.5, bad: 0, info: null, unknown: null };
  const rated = checks.filter((x) => weight[x.status] !== null);
  const score = rated.length ? Math.round((rated.reduce((s, x) => s + (weight[x.status] ?? 0), 0) / rated.length) * 100) : 0;

  const os = lines(raw.os);
  return { checks, ports, topPeers, failedIps, os: os[0] ?? "", kernel: os[1] ?? "", score, root };
}
