# Fernwerk

SSH-Client für Leute, die mehr als nur eine Shell brauchen. Terminal, SFTP, Monitoring, Dienste, Tunnel und Benutzerverwaltung – alles in einem Fenster, ohne Agent auf dem Server.

Läuft auf Windows, macOS und Linux.

## Funktionen

**Terminal**
- Mehrere Shells pro Verbindung (gleiche SSH-Session, kein erneuter Login)
- xterm-256color, Truecolor, Suche im Scrollback (`Strg+Shift+F`)
- Snippets: häufige Befehle speichern und per Klick oder `Strg+K` ausführen
- Startbefehl pro Host (z.B. `cd /var/www && git status`)

**Dateien (SFTP)**
- Dateibrowser mit Mehrfachauswahl, Filter, versteckten Dateien
- Upload/Download von Dateien *und* Ordnern (rekursiv), mit Fortschritt und Abbrechen
- Drag & Drop aus dem Dateimanager
- Dateien direkt bearbeiten (bis 5 MB), Rechte setzen, umbenennen, löschen
- Verschieben und Kopieren per Ziehen, Strg+X/C/V oder „Verschieben nach…“
- Zurück/Vor durch besuchte Ordner (Maustasten 4/5, Alt+←/→)

**Monitor**
- CPU, RAM, Swap, Load, Netzwerk-Durchsatz live mit Verlauf
- Datenträger-Belegung
- Top-Prozesse mit Beenden (`TERM`/`KILL`)

**Dienste**
- Alle systemd-Units mit Status und Autostart
- Starten, Stoppen, Neustarten, Aktivieren/Deaktivieren
- `journalctl`-Logs pro Dienst

**Tunnel**
- Local Forward (`-L`) und SOCKS5-Proxy (`-D`)
- Pro Host gespeichert, optional Autostart beim Verbinden
- Liste der lauschenden Server-Ports mit Ein-Klick-Weiterleitung
- Live-Statistik: offene Verbindungen, übertragene Bytes

**Benutzer**
- Benutzer und Gruppen anzeigen, anlegen, bearbeiten, löschen
- Passwort setzen, sperren/entsperren, Admin-Rechte (`sudo`/`wheel`)
- Beim Anlegen direkt einen SSH-Key hinterlegen
- sudo-Passwort wird bei Bedarf abgefragt und nur im Speicher gehalten

**SSH-Keys**
- Ed25519-Schlüssel erzeugen oder vorhandene importieren
- Mit einem Klick in `authorized_keys` auf dem Server kopieren
- Hinterlegte Schlüssel einsehen und entfernen

**Sicherheit**
- Host-Key-Prüfung (Trust on first use), Warnung bei geändertem Fingerprint
- Passwörter und Passphrasen lokal mit ChaCha20-Poly1305 verschlüsselt
- Export der Hosts ohne Zugangsdaten

## Installation

Fertige Builds gibt es unter [Releases](../../releases):

| System | Datei |
|---|---|
| Windows | `Fernwerk_x.y.z_x64-setup.exe` oder `.msi` |
| macOS | `.dmg` (Apple Silicon und Intel) |
| Linux | `.AppImage`, `.deb`, `.rpm` (x64 und ARM64) |

## Entwicklung

Voraussetzungen: Node 22, Rust (stable), unter Linux zusätzlich:

```sh
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
```

```sh
npm install
npm run tauri dev      # Entwicklungsmodus
npm run tauri build    # Release-Build für das aktuelle System
```

Tests:

```sh
cd src-tauri && cargo test
```

### Aufbau

```
src/                    React-Frontend
  components/           Terminal, Dateibrowser, Monitor, Dienste, Tunnel, Benutzer …
  lib/                  API-Wrapper, Store, Typen
src-tauri/src/
  ssh.rs                Verbindungsaufbau, Host-Key-Prüfung, exec/sudo
  terminal.rs           PTY-Kanäle
  sftp.rs               Dateioperationen und Transfers
  stats.rs              Monitoring und systemd
  tunnels.rs            Local Forward und SOCKS5
  users.rs              Benutzer- und Gruppenverwaltung
  keys.rs               Schlüsselverwaltung
  vault.rs              Lokaler, verschlüsselter Speicher
```

SSH läuft komplett in Rust ([russh](https://github.com/Eugeny/russh)), kein OpenSSH auf dem Client nötig.

### Releases

Jeder Push auf `main` baut über GitHub Actions alle Plattformen und veröffentlicht das Release `v<version>` aus `src-tauri/tauri.conf.json`. Für ein neues Release die Version dort und in `package.json` / `Cargo.toml` erhöhen und einen Abschnitt `## <version> – <datum>` im `CHANGELOG.md` anlegen – der wird zu den Release-Notes und erscheint im Update-Popup.

### Updates

Fernwerk prüft beim Start und alle 6 Stunden `releases/latest/download/latest.json` und bietet neue Versionen zur Installation an. Die Pakete sind mit einem eigenen Schlüssel signiert (Public Key in `tauri.conf.json`).

Einmalig einrichten: *Settings → Secrets and variables → Actions → New repository secret*

| Secret | Inhalt |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Inhalt der privaten Schlüsseldatei |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | leer lassen bzw. nicht anlegen (Schlüssel ohne Passwort) |

Den privaten Schlüssel sicher aufbewahren – geht er verloren, können installierte Versionen keine Updates mehr annehmen.

Lokaler Release-Build ohne Schlüssel: `npm run tauri build -- --no-bundle` oder die Umgebungsvariable `TAURI_SIGNING_PRIVATE_KEY` setzen.

## Hinweise

- Monitoring, Dienste und Benutzerverwaltung setzen einen Linux-Server voraus. Terminal, SFTP und Tunnel funktionieren mit jedem SSH-Server.
- Der Schlüssel für den lokalen Tresor liegt neben den Daten im App-Verzeichnis. Das schützt vor beiläufigem Mitlesen, nicht vor jemandem mit Zugriff auf dein Benutzerkonto.
