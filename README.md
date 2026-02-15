# Fernwerk

SSH-Client mit SFTP, Monitoring und Server-Verwaltung in einem Fenster.

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
