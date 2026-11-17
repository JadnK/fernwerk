//! SSH-Schlüssel: erzeugen (Ed25519), importieren, auf Server verteilen,
//! authorized_keys des angemeldeten Benutzers verwalten.

use std::fs;
use std::path::{Path, PathBuf};

use rand::RngCore;
use russh::keys::ssh_key::private::{Ed25519Keypair, KeypairData};
use russh::keys::ssh_key::{LineEnding, PrivateKey, PublicKey};
use russh::keys::HashAlg;
use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::ssh::{expand_home, sh_quote};
use crate::state::AppState;
use crate::vault::{now, restrict_permissions, KeyEntry};

/// Kryptografisch sicherer Zufall aus `rand::thread_rng` für ssh-key, das rand_core 0.10 erwartet.
struct KeyRng;

impl rand_core_10::TryRng for KeyRng {
    type Error = core::convert::Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        Ok(rand::thread_rng().next_u32())
    }

    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        Ok(rand::thread_rng().next_u64())
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
        rand::thread_rng().fill_bytes(dst);
        Ok(())
    }
}

impl rand_core_10::TryCryptoRng for KeyRng {}

/// `~/.ssh` des lokalen Benutzers (Windows: `%USERPROFILE%\.ssh`)
fn local_ssh_dir() -> AppResult<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| AppError::msg("Home-Verzeichnis nicht gefunden"))?;
    Ok(PathBuf::from(home).join(".ssh"))
}

#[cfg(unix)]
fn restrict_dir(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn restrict_dir(_path: &Path) {}

fn slug(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "key".into()
    } else {
        s
    }
}

/// Erzeugt ein Ed25519-Schlüsselpaar auf diesem Rechner.
/// `passphrase` verschlüsselt den privaten Schlüssel (OpenSSH-Format, AES-256-CTR + bcrypt).
/// `location`: `"ssh"` legt die Dateien in `~/.ssh` ab, sonst im Fernwerk-Datenordner.
#[tauri::command]
pub async fn keys_generate(
    state: State<'_, AppState>,
    name: String,
    comment: String,
    passphrase: Option<String>,
    location: Option<String>,
) -> AppResult<KeyEntry> {
    let mut seed = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut seed);
    let pair = Ed25519Keypair::from_seed(&seed);
    let comment = if comment.trim().is_empty() {
        "fernwerk".to_string()
    } else {
        comment
    };
    let mut key = PrivateKey::new(KeypairData::Ed25519(pair), comment)
        .map_err(|e| AppError::msg(e.to_string()))?;
    // Public Key vor dem Verschlüsseln lesen – danach fehlt dort der Kommentar
    let public = key
        .public_key()
        .to_openssh()
        .map_err(|e| AppError::msg(e.to_string()))?;
    let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
    if let Some(pw) = passphrase.as_deref().filter(|p| !p.is_empty()) {
        key = key
            .encrypt(&mut KeyRng, pw)
            .map_err(|e| AppError::msg(format!("Verschlüsseln fehlgeschlagen: {e}")))?;
    }

    let private = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| AppError::msg(e.to_string()))?;

    let mut v = state.vault.lock().await;
    let dir = if location.as_deref() == Some("ssh") {
        local_ssh_dir()?
    } else {
        v.keys_dir()
    };
    fs::create_dir_all(&dir)?;
    restrict_dir(&dir);
    let mut file = dir.join(slug(&name));
    let mut i = 1;
    while file.exists() || file.with_extension("pub").exists() {
        file = dir.join(format!("{}-{i}", slug(&name)));
        i += 1;
    }
    fs::write(&file, private.as_bytes())?;
    restrict_permissions(&file);
    fs::write(file.with_extension("pub"), format!("{public}\n"))?;

    let entry = KeyEntry {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        path: file.to_string_lossy().into_owned(),
        public_key: public,
        fingerprint,
        created: now(),
    };
    v.data.keys.push(entry.clone());
    v.save()?;
    Ok(entry)
}

/// Importiert einen vorhandenen Schlüssel (z.B. ~/.ssh/id_ed25519).
/// Der Public Key wird aus `<pfad>.pub` gelesen, sonst aus dem (unverschlüsselten) Private Key abgeleitet.
#[tauri::command]
pub async fn keys_import(
    state: State<'_, AppState>,
    name: String,
    path: String,
    passphrase: Option<String>,
) -> AppResult<KeyEntry> {
    let path = expand_home(&path);
    let pub_path = format!("{path}.pub");
    let public: PublicKey = if Path::new(&pub_path).exists() {
        PublicKey::from_openssh(fs::read_to_string(&pub_path)?.trim())
            .map_err(|e| AppError::msg(e.to_string()))?
    } else {
        match russh::keys::load_secret_key(&path, passphrase.as_deref()) {
            Ok(k) => k.public_key().clone(),
            Err(russh::keys::Error::KeyIsEncrypted) => {
                return Err(AppError::msg("PASSPHRASE_REQUIRED"));
            }
            Err(e) => return Err(e.into()),
        }
    };

    let entry = KeyEntry {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        path,
        public_key: public
            .to_openssh()
            .map_err(|e| AppError::msg(e.to_string()))?,
        fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
        created: now(),
    };
    let mut v = state.vault.lock().await;
    v.data.keys.push(entry.clone());
    v.save()?;
    Ok(entry)
}

#[tauri::command]
pub async fn keys_delete(
    state: State<'_, AppState>,
    id: String,
    delete_file: bool,
) -> AppResult<()> {
    let mut v = state.vault.lock().await;
    if let Some(k) = v.data.keys.iter().find(|k| k.id == id).cloned() {
        // Nur selbst erzeugte Dateien im App-Verzeichnis werden gelöscht
        if delete_file && Path::new(&k.path).starts_with(v.keys_dir()) {
            let _ = fs::remove_file(&k.path);
            let _ = fs::remove_file(format!("{}.pub", k.path));
        }
    }
    v.data.keys.retain(|k| k.id != id);
    v.save()
}

/// Ändert nur den angezeigten Namen – Datei und Pfad bleiben, Hosts behalten ihre Zuordnung.
#[tauri::command]
pub async fn keys_rename(state: State<'_, AppState>, id: String, name: String) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::msg("Name darf nicht leer sein"));
    }
    let mut v = state.vault.lock().await;
    let key = v
        .data
        .keys
        .iter_mut()
        .find(|k| k.id == id)
        .ok_or_else(|| AppError::msg("Schlüssel nicht gefunden"))?;
    key.name = name.to_string();
    v.save()
}

pub fn validate_pubkey(line: &str) -> AppResult<()> {
    PublicKey::from_openssh(line.trim())
        .map(|_| ())
        .map_err(|_| AppError::msg("Ungültiger Public Key"))
}

#[tauri::command]
pub async fn key_deploy(
    state: State<'_, AppState>,
    conn_id: String,
    public_key: String,
) -> AppResult<bool> {
    validate_pubkey(&public_key)?;
    let conn = state.conn(&conn_id).await?;
    let k = sh_quote(public_key.trim());
    let out = conn
        .exec(
            &format!(
                "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && \
                 if grep -qxF {k} ~/.ssh/authorized_keys; then echo EXISTS; \
                 else if [ -s ~/.ssh/authorized_keys ] && [ -n \"$(tail -c1 ~/.ssh/authorized_keys)\" ]; then echo >> ~/.ssh/authorized_keys; fi; \
                 printf '%s\\n' {k} >> ~/.ssh/authorized_keys && echo ADDED; fi"
            ),
            None,
        )
        .await?
        .check()?;
    Ok(out.stdout.contains("ADDED"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedKey {
    pub line: String,
    pub kind: String,
    pub comment: String,
    pub fingerprint: String,
}

#[tauri::command]
pub async fn authorized_keys_list(
    state: State<'_, AppState>,
    conn_id: String,
) -> AppResult<Vec<AuthorizedKey>> {
    let conn = state.conn(&conn_id).await?;
    let out = conn
        .exec("cat ~/.ssh/authorized_keys 2>/dev/null", None)
        .await?;
    Ok(out
        .stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|line| {
            let parsed = PublicKey::from_openssh(line).ok();
            AuthorizedKey {
                line: line.to_string(),
                kind: parsed
                    .as_ref()
                    .map(|p| p.algorithm().to_string())
                    .unwrap_or_else(|| "?".into()),
                comment: parsed
                    .as_ref()
                    .map(|p| p.comment().to_string())
                    .unwrap_or_default(),
                fingerprint: parsed
                    .map(|p| p.fingerprint(HashAlg::Sha256).to_string())
                    .unwrap_or_else(|| "(Optionen/unbekannt)".into()),
            }
        })
        .collect())
}

#[tauri::command]
pub async fn authorized_keys_remove(
    state: State<'_, AppState>,
    conn_id: String,
    line: String,
) -> AppResult<()> {
    let conn = state.conn(&conn_id).await?;
    let current = conn
        .exec("cat ~/.ssh/authorized_keys", None)
        .await?
        .check()?
        .stdout;
    let remaining: Vec<&str> = current
        .lines()
        .filter(|l| l.trim() != line.trim())
        .collect();
    if remaining.len() == current.lines().count() {
        return Err(AppError::msg("Schlüssel nicht gefunden"));
    }
    let mut content = remaining.join("\n");
    content.push('\n');
    conn.exec(
        "umask 077; cat > ~/.ssh/authorized_keys.fw && mv ~/.ssh/authorized_keys.fw ~/.ssh/authorized_keys",
        Some(content.as_bytes()),
    )
    .await?
    .check()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_key_needs_passphrase() {
        let pair = Ed25519Keypair::from_seed(&[7u8; 32]);
        let key = PrivateKey::new(KeypairData::Ed25519(pair), "test")
            .unwrap()
            .encrypt(&mut KeyRng, "geheim")
            .unwrap();
        let text = key.to_openssh(LineEnding::LF).unwrap();
        assert!(matches!(
            russh::keys::decode_secret_key(&text, None),
            Err(russh::keys::Error::KeyIsEncrypted)
        ));
        assert!(russh::keys::decode_secret_key(&text, Some("falsch")).is_err());
        let ok = russh::keys::decode_secret_key(&text, Some("geheim")).unwrap();
        assert_eq!(ok.public_key().key_data(), key.public_key().key_data());
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("Mein Laptop!"), "mein-laptop");
        assert_eq!(slug("///"), "key");
    }
}
