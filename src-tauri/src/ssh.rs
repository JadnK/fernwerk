//! SSH-Verbindungen: Aufbau, Host-Key-Prüfung (TOFU), Exec- und Sudo-Helfer.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handle, Msg};
use russh::keys::{load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{Mutex, OnceCell};

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::vault::{AuthMethod, HostProfile, Secret};

// ---------------------------------------------------------------- Handler

pub struct Client {
    expected: Option<String>,
    seen: Arc<std::sync::Mutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fp = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => {
                key.fingerprint(HashAlg::Sha256).to_string()
            }
            PublicKeyOrCertificate::Certificate(cert) => {
                cert.public_key().fingerprint(HashAlg::Sha256).to_string()
            }
        };
        *self.seen.lock().unwrap() = Some(fp.clone());
        Ok(match &self.expected {
            Some(expected) => *expected == fp,
            None => true, // Trust on first use – wird nach erfolgreichem Login gespeichert
        })
    }
}

// ---------------------------------------------------------------- Connection

pub struct Connection {
    pub username: String,
    pub handle: Handle<Client>,
    login_password: Option<String>,
    sudo_nopass: OnceCell<bool>,
    pub terminals: Mutex<HashMap<String, ChannelWriteHalf<Msg>>>,
    pub sftp: Mutex<Option<Arc<SftpSession>>>,
    pub stats_prev: Mutex<Option<crate::stats::Sample>>,
    pub cancels: std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Debug, Default)]
pub struct ExecOutput {
    pub code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
}

impl ExecOutput {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }

    /// Fehler mit stderr, falls der Exit-Code nicht 0 ist.
    pub fn check(self) -> AppResult<Self> {
        if self.ok() {
            Ok(self)
        } else {
            let msg = if self.stderr.trim().is_empty() {
                self.stdout.trim()
            } else {
                self.stderr.trim()
            };
            Err(AppError::msg(format!(
                "Befehl fehlgeschlagen (Exit {}): {}",
                self.code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "?".into()),
                msg
            )))
        }
    }
}

impl Connection {
    pub async fn exec(&self, cmd: &str, stdin: Option<&[u8]>) -> AppResult<ExecOutput> {
        let mut ch = self.handle.channel_open_session().await?;
        ch.exec(true, cmd).await?;
        if let Some(input) = stdin {
            ch.data(input).await?;
        }
        ch.eof().await?;

        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut code = None;
        while let Some(msg) = ch.wait().await {
            match msg {
                ChannelMsg::Data { data } => out.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, ext: 1 } => err.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(ExecOutput {
            code,
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr: String::from_utf8_lossy(&err).into_owned(),
        })
    }

    /// Führt `cmd` als root aus. Nutzt sudo ohne Passwort, wenn möglich,
    /// sonst das übergebene bzw. beim Login verwendete Passwort.
    pub async fn exec_root(
        &self,
        cmd: &str,
        sudo_password: Option<String>,
        stdin: Option<&[u8]>,
    ) -> AppResult<ExecOutput> {
        if self.username == "root" {
            return self.exec(&format!("sh -c {}", sh_quote(cmd)), stdin).await;
        }

        let nopass = *self
            .sudo_nopass
            .get_or_init(|| async {
                self.exec("sudo -n true", None)
                    .await
                    .map(|o| o.ok())
                    .unwrap_or(false)
            })
            .await;

        if nopass {
            return self
                .exec(&format!("sudo -n sh -c {}", sh_quote(cmd)), stdin)
                .await;
        }

        let pw = sudo_password
            .filter(|p| !p.is_empty())
            .or_else(|| self.login_password.clone())
            .ok_or_else(|| AppError::msg("SUDO_PASSWORD_REQUIRED"))?;
        let mut input = format!("{pw}\n").into_bytes();
        if let Some(extra) = stdin {
            input.extend_from_slice(extra);
        }
        let out = self
            .exec(
                &format!("sudo -S -p '' sh -c {}", sh_quote(cmd)),
                Some(&input),
            )
            .await?;
        if out.stderr.contains("incorrect password") || out.stderr.contains("Sorry, try again") {
            return Err(AppError::msg("SUDO_PASSWORD_WRONG"));
        }
        Ok(out)
    }

    pub async fn sftp(&self) -> AppResult<Arc<SftpSession>> {
        let mut guard = self.sftp.lock().await;
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let ch = self.handle.channel_open_session().await?;
        ch.request_subsystem(true, "sftp").await?;
        let session = Arc::new(SftpSession::new(ch.into_stream()).await?);
        *guard = Some(session.clone());
        Ok(session)
    }

    /// Verwirft die SFTP-Session, damit sie beim nächsten Zugriff neu aufgebaut wird.
    pub async fn reset_sftp(&self) {
        *self.sftp.lock().await = None;
    }
}

/// POSIX-sicheres Quoting für Shell-Argumente.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

// ---------------------------------------------------------------- Connect

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectInfo {
    pub id: String,
    pub host_id: String,
    pub label: String,
    pub username: String,
    pub fingerprint: String,
    pub new_host_key: bool,
}

async fn connect_profile(
    profile: &HostProfile,
    secret: Secret,
    expected: Option<String>,
) -> AppResult<(Handle<Client>, String, Option<String>)> {
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        ..Default::default()
    });

    let seen = Arc::new(std::sync::Mutex::new(None));
    let handler = Client {
        expected: expected.clone(),
        seen: seen.clone(),
    };

    let addr = (profile.host.as_str(), profile.port);
    let mut handle = match tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(config, addr, handler),
    )
    .await
    {
        Err(_) => return Err(AppError::msg("Zeitüberschreitung beim Verbindungsaufbau")),
        Ok(Err(russh::Error::UnknownKey)) => {
            let got = seen.lock().unwrap().clone().unwrap_or_default();
            return Err(AppError::msg(format!(
                "HOSTKEY_MISMATCH|{}|{}",
                expected.unwrap_or_default(),
                got
            )));
        }
        Ok(r) => r?,
    };

    let fingerprint = seen.lock().unwrap().clone().unwrap_or_default();

    let auth = match &profile.auth {
        AuthMethod::Password => {
            let pw = secret
                .password
                .clone()
                .ok_or_else(|| AppError::msg("PASSWORD_REQUIRED"))?;
            handle.authenticate_password(&profile.username, pw).await?
        }
        AuthMethod::Key { key_path } => {
            let path = expand_home(key_path);
            let key = match load_secret_key(&path, secret.passphrase.as_deref()) {
                Ok(k) => k,
                Err(russh::keys::Error::KeyIsEncrypted) => {
                    return Err(AppError::msg("PASSPHRASE_REQUIRED"))
                }
                Err(e) => return Err(e.into()),
            };
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            handle
                .authenticate_publickey(
                    &profile.username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await?
        }
    };

    if !auth.success() {
        let _ = handle.disconnect(Disconnect::ByApplication, "", "de").await;
        return Err(AppError::msg("AUTH_FAILED"));
    }

    Ok((handle, fingerprint, secret.password))
}

pub fn expand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        return format!("{home}/{rest}");
    }
    p.to_string()
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    host_id: String,
    password: Option<String>,
    passphrase: Option<String>,
) -> AppResult<ConnectInfo> {
    let (profile, mut secret, expected) = {
        let v = state.vault.lock().await;
        let p = v.host(&host_id)?;
        let key = format!("{}:{}", p.host, p.port);
        (p, v.secret(&host_id), v.data.known_hosts.get(&key).cloned())
    };
    if password.as_deref().is_some_and(|p| !p.is_empty()) {
        secret.password = password;
    }
    if passphrase.as_deref().is_some_and(|p| !p.is_empty()) {
        secret.passphrase = passphrase;
    }

    let new_host_key = expected.is_none();
    let (handle, fingerprint, login_password) = connect_profile(&profile, secret, expected).await?;

    {
        let mut v = state.vault.lock().await;
        if new_host_key && !fingerprint.is_empty() {
            v.data.known_hosts.insert(
                format!("{}:{}", profile.host, profile.port),
                fingerprint.clone(),
            );
        }
        v.touch(&host_id);
    }

    let id = uuid::Uuid::new_v4().to_string();
    let conn = Arc::new(Connection {
        username: profile.username.clone(),
        handle,
        login_password,
        sudo_nopass: OnceCell::new(),
        terminals: Mutex::new(HashMap::new()),
        sftp: Mutex::new(None),
        stats_prev: Mutex::new(None),
        cancels: std::sync::Mutex::new(HashMap::new()),
    });
    state.conns.write().await.insert(id.clone(), conn.clone());

    // Watchdog: meldet dem Frontend, wenn die Verbindung wegbricht.
    let weak = Arc::downgrade(&conn);
    let conn_id = id.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            match weak.upgrade() {
                Some(c) if c.handle.is_closed() => {
                    let _ = app.emit("conn-closed", &conn_id);
                    break;
                }
                Some(_) => continue,
                None => break,
            }
        }
    });

    Ok(ConnectInfo {
        id,
        host_id,
        label: profile.name,
        username: profile.username,
        fingerprint,
        new_host_key,
    })
}

#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    crate::tunnels::stop_for_connection(&state, &id).await;
    if let Some(conn) = state.conns.write().await.remove(&id) {
        let _ = conn
            .handle
            .disconnect(Disconnect::ByApplication, "Fernwerk getrennt", "de")
            .await;
    }
    Ok(())
}

/// Führt einen einzelnen Befehl aus (z.B. für Snippets im Hintergrund).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
}

#[tauri::command]
pub async fn ssh_exec(
    state: State<'_, AppState>,
    id: String,
    command: String,
) -> AppResult<ExecResult> {
    let conn = state.conn(&id).await?;
    let out = conn.exec(&command, None).await?;
    Ok(ExecResult {
        code: out.code,
        stdout: out.stdout,
        stderr: out.stderr,
    })
}
