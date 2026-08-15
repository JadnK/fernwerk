//! SSH-Schlüssel: erzeugen (Ed25519), importieren, auf Server verteilen,
//! authorized_keys des angemeldeten Benutzers verwalten.

use std::fs;
use std::path::Path;

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

#[tauri::command]
pub async fn keys_generate(
    state: State<'_, AppState>,
    name: String,
    comment: String,
) -> AppResult<KeyEntry> {
    let mut seed = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut seed);
    let pair = Ed25519Keypair::from_seed(&seed);
    let comment = if comment.trim().is_empty() {
        "fernwerk".to_string()
    } else {
        comment
    };
    let key = PrivateKey::new(KeypairData::Ed25519(pair), comment)
        .map_err(|e| AppError::msg(e.to_string()))?;

    let private = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| AppError::msg(e.to_string()))?;
    let public = key
        .public_key()
        .to_openssh()
        .map_err(|e| AppError::msg(e.to_string()))?;
    let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();

    let mut v = state.vault.lock().await;
    let dir = v.keys_dir();
    fs::create_dir_all(&dir)?;
    let mut file = dir.join(slug(&name));
    let mut i = 1;
    while file.exists() {
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

fn validate_pubkey(line: &str) -> AppResult<()> {
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
                 else printf '%s\\n' {k} >> ~/.ssh/authorized_keys && echo ADDED; fi"
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
    fn slugs() {
        assert_eq!(slug("Mein Laptop!"), "mein-laptop");
        assert_eq!(slug("///"), "key");
    }
}
