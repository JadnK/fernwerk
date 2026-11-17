//! Interaktive Shells (PTY) über SSH. Daten werden per Tauri-Channel gestreamt.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use russh::ChannelMsg;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::ssh::SUDO_MARKER;
use crate::state::AppState;

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TermEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

#[tauri::command]
pub async fn term_open(
    state: State<'_, AppState>,
    conn_id: String,
    cols: u32,
    rows: u32,
    on_event: Channel<TermEvent>,
) -> AppResult<String> {
    let conn = state.conn(&conn_id).await?;
    let ch = conn.handle.channel_open_session().await?;
    ch.set_env(false, "COLORTERM", "truecolor").await.ok();
    ch.request_pty(
        false,
        "xterm-256color",
        cols.max(10),
        rows.max(4),
        0,
        0,
        &[],
    )
    .await?;
    // root-Modus: neue Shells starten als root (sudo -i), das Passwort tippt Fernwerk selbst ein
    let mut sudo_pw = None;
    if conn.is_root_mode() && conn.username != "root" {
        let (cmd, pw) = conn.root_shell().await;
        sudo_pw = pw;
        ch.exec(false, cmd).await?;
    } else {
        ch.request_shell(false).await?;
    }

    let (mut read, write) = ch.split();
    let term_id = uuid::Uuid::new_v4().to_string();
    conn.terminals.lock().await.insert(term_id.clone(), write);

    let conn2 = conn.clone();
    let tid = term_id.clone();
    tokio::spawn(async move {
        let mut code = None;
        let mut prompts = 0;
        while let Some(msg) = read.wait().await {
            match msg {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    let mut data = data.to_vec();
                    if let Some(pos) = find(&data, SUDO_MARKER.as_bytes()) {
                        prompts += 1;
                        // Erster Prompt: Passwort automatisch senden. Weitere (z.B. falsches Passwort):
                        // normalen Prompt zeigen, damit man selbst tippen kann.
                        let shown: &[u8] = match (prompts, sudo_pw.take()) {
                            (1, Some(pw)) => {
                                if let Some(w) = conn2.terminals.lock().await.get(&tid) {
                                    let _ = w.data(format!("{pw}\n").as_bytes()).await;
                                }
                                b""
                            }
                            _ => b"[sudo] Passwort: ",
                        };
                        data.splice(pos..pos + SUDO_MARKER.len(), shown.iter().copied());
                    }
                    if on_event
                        .send(TermEvent::Data {
                            data: B64.encode(&data),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        conn2.terminals.lock().await.remove(&tid);
        let _ = on_event.send(TermEvent::Exit { code });
    });

    Ok(term_id)
}

#[tauri::command]
pub async fn term_write(
    state: State<'_, AppState>,
    conn_id: String,
    term_id: String,
    data: String,
) -> AppResult<()> {
    let conn = state.conn(&conn_id).await?;
    let terms = conn.terminals.lock().await;
    let w = terms
        .get(&term_id)
        .ok_or_else(|| AppError::msg("Terminal geschlossen"))?;
    w.data(data.as_bytes()).await?;
    Ok(())
}

#[tauri::command]
pub async fn term_resize(
    state: State<'_, AppState>,
    conn_id: String,
    term_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    let conn = state.conn(&conn_id).await?;
    let terms = conn.terminals.lock().await;
    if let Some(w) = terms.get(&term_id) {
        w.window_change(cols.max(10), rows.max(4), 0, 0).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn term_close(
    state: State<'_, AppState>,
    conn_id: String,
    term_id: String,
) -> AppResult<()> {
    if let Ok(conn) = state.conn(&conn_id).await {
        if let Some(w) = conn.terminals.lock().await.remove(&term_id) {
            let _ = w.close().await;
        }
    }
    Ok(())
}
