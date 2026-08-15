//! Lokaler Datenspeicher: Hosts, Snippets, Schlüssel, Known-Hosts.
//! Passwörter/Passphrasen liegen getrennt und verschlüsselt (ChaCha20-Poly1305)
//! in `secrets.bin`, der Schlüssel dafür in `vault.key` (0600 auf Unix).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AuthMethod {
    #[serde(rename = "password")]
    Password,
    #[serde(rename = "key", rename_all = "camelCase")]
    Key { key_path: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelDef {
    pub id: String,
    pub name: String,
    /// "local" (-L) oder "dynamic" (-D, SOCKS5)
    pub kind: String,
    pub bind_host: String,
    pub bind_port: u16,
    #[serde(default)]
    pub remote_host: String,
    #[serde(default)]
    pub remote_port: u16,
    #[serde(default)]
    pub auto_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub tunnels: Vec<TunnelDef>,
    #[serde(default)]
    pub startup_command: String,
    /// Nur für das Frontend: ist ein Passwort/Passphrase hinterlegt?
    #[serde(default)]
    pub has_secret: bool,
    #[serde(default)]
    pub last_used: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub public_key: String,
    pub fingerprint: String,
    pub created: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub font_size: u16,
    pub font_family: String,
    pub cursor_blink: bool,
    pub scrollback: u32,
    pub copy_on_select: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            font_size: 14,
            font_family: "JetBrains Mono".into(),
            cursor_blink: true,
            scrollback: 10_000,
            copy_on_select: false,
        }
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultData {
    #[serde(default)]
    pub hosts: Vec<HostProfile>,
    #[serde(default)]
    pub snippets: Vec<Snippet>,
    #[serde(default)]
    pub keys: Vec<KeyEntry>,
    /// "host:port" -> SHA256-Fingerprint
    #[serde(default)]
    pub known_hosts: HashMap<String, String>,
    #[serde(default)]
    pub settings: Settings,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Secret {
    pub password: Option<String>,
    pub passphrase: Option<String>,
}

pub struct Vault {
    dir: PathBuf,
    cipher: ChaCha20Poly1305,
    pub data: VaultData,
    secrets: HashMap<String, Secret>,
}

impl Vault {
    pub fn open(dir: &Path) -> AppResult<Self> {
        fs::create_dir_all(dir)?;
        let cipher = ChaCha20Poly1305::new(&load_or_create_key(&dir.join("vault.key"))?);

        let data_path = dir.join("data.json");
        let data = if data_path.exists() {
            serde_json::from_str(&fs::read_to_string(&data_path)?)?
        } else {
            VaultData::default()
        };

        let mut vault = Self {
            dir: dir.to_path_buf(),
            cipher,
            data,
            secrets: HashMap::new(),
        };
        vault.secrets = vault.read_secrets().unwrap_or_default();
        vault.refresh_flags();
        Ok(vault)
    }

    pub fn keys_dir(&self) -> PathBuf {
        self.dir.join("keys")
    }

    fn refresh_flags(&mut self) {
        for h in &mut self.data.hosts {
            h.has_secret = self
                .secrets
                .get(&h.id)
                .map(|s| s.password.is_some() || s.passphrase.is_some())
                .unwrap_or(false);
        }
    }

    fn read_secrets(&self) -> AppResult<HashMap<String, Secret>> {
        let path = self.dir.join("secrets.bin");
        if !path.exists() {
            return Ok(HashMap::new());
        }
        let raw = fs::read(path)?;
        if raw.len() < 12 {
            return Err(AppError::msg("secrets.bin beschädigt"));
        }
        let (nonce, body) = raw.split_at(12);
        let plain = self
            .cipher
            .decrypt(Nonce::from_slice(nonce), body)
            .map_err(|_| AppError::msg("Secrets konnten nicht entschlüsselt werden"))?;
        Ok(serde_json::from_slice(&plain)?)
    }

    pub fn save(&mut self) -> AppResult<()> {
        self.refresh_flags();
        atomic_write(
            &self.dir.join("data.json"),
            serde_json::to_string_pretty(&self.data)?.as_bytes(),
        )?;

        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let plain = serde_json::to_vec(&self.secrets)?;
        let enc = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), plain.as_ref())
            .map_err(|_| AppError::msg("Verschlüsselung fehlgeschlagen"))?;
        let mut out = nonce.to_vec();
        out.extend(enc);
        atomic_write(&self.dir.join("secrets.bin"), &out)?;
        Ok(())
    }

    pub fn host(&self, id: &str) -> AppResult<HostProfile> {
        self.data
            .hosts
            .iter()
            .find(|h| h.id == id)
            .cloned()
            .ok_or_else(|| AppError::msg("Host nicht gefunden"))
    }

    pub fn secret(&self, id: &str) -> Secret {
        self.secrets.get(id).cloned().unwrap_or_default()
    }

    pub fn touch(&mut self, id: &str) {
        if let Some(h) = self.data.hosts.iter_mut().find(|h| h.id == id) {
            h.last_used = Some(now());
        }
        let _ = self.save();
    }
}

fn load_or_create_key(path: &Path) -> AppResult<Key> {
    if path.exists() {
        let raw = B64
            .decode(fs::read_to_string(path)?.trim())
            .map_err(|e| AppError::msg(e.to_string()))?;
        if raw.len() == 32 {
            return Ok(*Key::from_slice(&raw));
        }
        return Err(AppError::msg("vault.key hat ein ungültiges Format"));
    }
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    fs::write(path, B64.encode(key))?;
    restrict_permissions(path);
    Ok(*Key::from_slice(&key))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)?;
    restrict_permissions(path);
    Ok(())
}

#[cfg(unix)]
pub fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
pub fn restrict_permissions(_path: &Path) {}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- Commands

#[tauri::command]
pub async fn vault_load(state: State<'_, AppState>) -> AppResult<VaultData> {
    Ok(state.vault.lock().await.data.clone())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretInput {
    pub password: Option<String>,
    pub passphrase: Option<String>,
}

#[tauri::command]
pub async fn host_save(
    state: State<'_, AppState>,
    mut host: HostProfile,
    secret: Option<SecretInput>,
) -> AppResult<HostProfile> {
    let mut v = state.vault.lock().await;
    if host.id.is_empty() {
        host.id = uuid::Uuid::new_v4().to_string();
    }
    if host.port == 0 {
        host.port = 22;
    }
    for t in &mut host.tunnels {
        if t.id.is_empty() {
            t.id = uuid::Uuid::new_v4().to_string();
        }
    }
    if let Some(s) = secret {
        let entry = v.secrets.entry(host.id.clone()).or_default();
        if let Some(p) = s.password {
            entry.password = (!p.is_empty()).then_some(p);
        }
        if let Some(p) = s.passphrase {
            entry.passphrase = (!p.is_empty()).then_some(p);
        }
    }
    match v.data.hosts.iter_mut().find(|h| h.id == host.id) {
        Some(existing) => {
            host.last_used = existing.last_used;
            *existing = host.clone();
        }
        None => v.data.hosts.push(host.clone()),
    }
    v.save()?;
    v.host(&host.id)
}

#[tauri::command]
pub async fn host_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let mut v = state.vault.lock().await;
    v.data.hosts.retain(|h| h.id != id);
    v.secrets.remove(&id);
    v.save()
}

#[tauri::command]
pub async fn host_forget_key(state: State<'_, AppState>, host: String, port: u16) -> AppResult<()> {
    let mut v = state.vault.lock().await;
    v.data.known_hosts.remove(&format!("{host}:{port}"));
    v.save()
}

#[tauri::command]
pub async fn snippet_save(state: State<'_, AppState>, mut snippet: Snippet) -> AppResult<Snippet> {
    let mut v = state.vault.lock().await;
    if snippet.id.is_empty() {
        snippet.id = uuid::Uuid::new_v4().to_string();
    }
    match v.data.snippets.iter_mut().find(|s| s.id == snippet.id) {
        Some(s) => *s = snippet.clone(),
        None => v.data.snippets.push(snippet.clone()),
    }
    v.save()?;
    Ok(snippet)
}

#[tauri::command]
pub async fn snippet_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    let mut v = state.vault.lock().await;
    v.data.snippets.retain(|s| s.id != id);
    v.save()
}

#[tauri::command]
pub async fn settings_save(state: State<'_, AppState>, settings: Settings) -> AppResult<()> {
    let mut v = state.vault.lock().await;
    v.data.settings = settings;
    v.save()
}
