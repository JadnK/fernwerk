# Changelog

## 1.2.10 – 2026-11-26

- Editor: Strg+S speichert jetzt überall im Editor-Fenster – auch wenn der Cursor im Suchfeld oder auf einem Knopf steht
- Editor: Strg+S ohne Änderungen zeigt „Keine Änderungen – bereits gespeichert“ statt nichts zu tun
- Strg+F und F3 funktionieren ebenfalls im ganzen Editor-Fenster

## 1.2.9 – 2026-11-25

- Dateien: Textdateien öffnen sich in einem eigenen Editor-Fenster außerhalb des Hauptfensters – mit Zeilennummern, Suche (Strg+F, F3), Zeile/Spalte und „Neu laden“
- Editor: Strg+S speichert, beim Schließen mit ungespeicherten Änderungen kommt eine Nachfrage; dieselbe Datei öffnet kein zweites Fenster
- Editor: Dateien mit Windows-Zeilenenden (CRLF) bleiben beim Speichern CRLF
- Übersicht: Hosts nach Gruppen sortiert, Suchfeld, Dateien-Knopf direkt an jeder Karte; keine grauen Flächen mehr neben den Karten

## 1.2.8 – 2026-11-25

- Terminal: Shell-Tab aus dem Fenster ziehen (oder „Fenster“) öffnet die Shell in einem eigenen Fenster – mit Verlauf; per Knopf wieder als Tab zurückholen
- Dateien | Terminal nebeneinander, Breite per Trenner anpassbar
- Monitor wahlweise als Statusleiste unten (CPU, RAM, Datenträger, Netzwerk) – Einstellung unter „Sitzung“
- sudo-Passwort pro Host im Tresor speicherbar – keine Abfrage mehr bei root-Aktionen und im root-Modus
- Als root angemeldet: wird per UID erkannt, der root-Schalter entfällt dann
- Übersicht: Doppelklick auf eine Host-Karte verbindet

## 1.2.7 – 2026-11-17

- root-Modus gilt jetzt für die ganze Verbindung: Schalter „root“ oben neben Benutzer@Host
- Terminal: neue Shells starten als root (`sudo -i`), das sudo-Passwort tippt Fernwerk selbst ein; root-Shells sind im Tab markiert
- Konsolen und Multi-Exec laufen über sudo – tmux-/screen-Sitzungen und Logs von root sind sichtbar und steuerbar
- Dateien, Dienste, Monitor und Benutzer nutzen das beim Einschalten bestätigte sudo-Passwort ohne erneute Abfrage
- Beim Ausschalten bleiben offene root-Shells root, neue Shells starten wieder als normaler Benutzer

## 1.2.6 – 2026-11-17

- Dateien: root-Modus (rotes Schild oben) – öffnen, bearbeiten, speichern, herunter- und hochladen, kopieren, umbenennen, löschen und Rechte ändern mit sudo, z.B. in `/root`, `/etc` oder bei Dateien anderer Benutzer
- Scheitert eine Dateiaktion an fehlenden Rechten, bietet Fernwerk direkt an, sie mit sudo zu wiederholen
- Dateien behalten beim Speichern als root Besitzer und Rechte; der Home-Button führt auch im root-Modus in dein eigenes Home

## 1.2.5 – 2026-11-17

- Benutzer: neue Aktion „SSH-Schlüssel erstellen / eintragen“ – erzeugt ein Ed25519-Schlüsselpaar mit Passphrase und trägt den öffentlichen Schlüssel beim Benutzer in `~/.ssh/authorized_keys` ein (in eigener Zeile; Ordner und Datei werden bei Bedarf mit 700/600 und richtigem Besitzer angelegt)
- Der private Schlüssel bleibt auf deinem PC – wahlweise in `~/.ssh` oder im Fernwerk-Ordner; auf Wunsch wird direkt ein Host-Eintrag für den Benutzer angelegt
- Schlüssel erzeugen (Schlüssel-Ansicht): optional mit Passphrase und Speicherort `~/.ssh`
- Schlüssel verteilen: hängt nicht mehr an die letzte Zeile an, wenn `authorized_keys` ohne Zeilenumbruch endet

## 1.2.4 – 2026-11-17

- Neues Werkzeug „Sicherheit“ (`Strg+9`): prüft SSH-Konfiguration, Firewall, offene Ports, fail2ban/CrowdSec, Updates, Kernel-Einstellungen und fehlgeschlagene Logins – mit Bewertung und passendem Korrektur-Befehl fürs Terminal; der Check selbst ändert nichts am Server
- Einstellungen: Changelog direkt in der App, Links zu GitHub für Fehlermeldungen und Ideen
- Schlüssel lassen sich umbenennen
- Host-Editor: Schlüssel werden aus den in Fernwerk angelegten Schlüsseln gewählt
- Snippets: verständlichere Erklärung der Platzhalter

## 1.2.3 – 2026-11-16

- Konsolen: Status-Filter oben – Alle, Läuft, Abgestürzt, Beendet mit Anzahl; ein Klick auf eine Raute in der Liste filtert ebenfalls
- Konsolen: Gameserver, die außerhalb von tmux/screen laufen (z.B. per start.sh, nohup oder systemd), werden jetzt erkannt
- Für diese Server: Live-Log aus logs/latest.log bzw. dem Journal, Befehle per RCON, sauberes Stoppen, Spieleranzeige
- „In Konsole übernehmen“: startet einen lose laufenden Server in tmux neu – danach volle Konsole mit Eingabe

## 1.2.2 – 2026-11-16

- Konsolen: die Rauten sortieren jetzt die Konsolenliste
- Releases werden wieder zuverlässig veröffentlicht, das Update-Popup erscheint wieder

## 1.2.1 – 2026-11-16

- Überarbeitete Farbpalette
- Konsolen: überflüssiges „+“ über der Konsolenliste entfernt

## 1.2.0 – 2026-11-16

- Neues Design in Schwarz und Gold
- Neues Werkzeug „Konsolen“ (`Strg+8`): Gameserver und andere Dauerläufer in tmux betreiben – Live-Konsole, Befehle senden, sauber stoppen, Auto-Neustart, Start beim Hochfahren
- Minecraft-Vorlage mit Schnellbefehlen, Spieleranzeige und EULA-Hinweis; Vorlagen für Bedrock, Terraria, Factorio und Node/Python
- Vorhandene tmux-Sitzungen und Docker-Container in den Konsolen anzeigen und steuern
- Terminal: geteilte Ansicht mit zwei Shells nebeneinander
- Broadcast (`Strg+Shift+B`): Eingabe geht an alle offenen Shells
- Snippets mit Platzhaltern (`{{name}}`, `{{name:Standard}}`)
- Multi-Exec: einen Befehl auf mehreren verbundenen Hosts gleichzeitig ausführen

## 1.1.2 – 2026-10-23

- Terminal: Strg-Kürzel gehen an die Shell (nano, bash, vim) statt an Fernwerk – z.B. Strg+K schneidet in nano wieder die Zeile aus
- App-Kürzel im Terminal mit Shift: Befehlspalette Strg+Shift+K, Werkzeuge Strg+Shift+1…7

## 1.1.1 – 2026-10-23

- Terminal: Einfügen mit Strg+V bzw. Strg+Shift+V fügt den Text nicht mehr doppelt ein
- Mehrzeiliges Einfügen nutzt Bracketed Paste – Befehle werden nicht sofort ausgeführt

## 1.1.0 – 2026-10-23

- Automatische Updates: Hinweis bei neuer Version, Installation mit einem Klick
- Dateien verschieben und kopieren: Ziehen auf Ordner oder Pfadleiste, Strg+X/C/V, „Verschieben nach…“
- Zurück/Vor im Dateibrowser und zwischen Ansichten (Maustasten 4/5, Alt+←/→)
- Editor: Strg+A markiert den ganzen Text, Entf und Backspace löschen nicht mehr Dateien im Hintergrund
- Normaler Mauszeiger über Scrollleisten von Textfeldern
- F2 benennt die ausgewählte Datei um

## 1.0.0 – 2026-10-20

- Befehlspalette (`Strg+K`) für Hosts, Werkzeuge und Snippets
- Tastenkürzel für Werkzeuge (`Strg+1…7`) und Sitzungswechsel (`Strg+Tab`)
- Export/Import der Hosts als JSON (ohne Zugangsdaten)
- Builds für Windows ARM64 und Linux ARM64
- Viele kleine UI-Korrekturen

## 0.6.0 – 2026-09-14

- SSH-Keys: Ed25519 erzeugen, vorhandene importieren
- Schlüssel per Klick in `authorized_keys` kopieren, hinterlegte Schlüssel verwalten
- Snippets in der Seitenleiste
- Startbefehl pro Host

## 0.5.0 – 2026-08-09

- Benutzerverwaltung: anlegen, bearbeiten, löschen, Passwort setzen, sperren
- Gruppen anlegen, Admin-Rechte per Checkbox
- systemd-Dienste: Status, Start/Stop/Restart, Autostart, Logs
- sudo-Passwort wird bei Bedarf abgefragt und pro Sitzung gemerkt

## 0.4.0 – 2026-07-05

- Tunnel: Local Forward (`-L`) und SOCKS5-Proxy (`-D`)
- Tunnel pro Host speichern, Autostart beim Verbinden
- Lauschende Server-Ports mit Ein-Klick-Weiterleitung

## 0.3.0 – 2026-05-31

- Monitor: CPU, RAM, Swap, Load, Netzwerk mit Verlauf
- Datenträger und Top-Prozesse, Prozesse beenden

## 0.2.0 – 2026-04-12

- SFTP-Dateibrowser mit Upload/Download, auch rekursiv
- Drag & Drop, Fortschrittsanzeige, Abbrechen
- Texteditor für Remote-Dateien, Rechte setzen

## 0.1.0 – 2026-02-22

- Erste Version: Hosts verwalten, SSH-Terminal mit mehreren Shells
- Host-Key-Prüfung (TOFU), verschlüsselte Zugangsdaten
