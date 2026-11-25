//! Interaktive Shells (PTY) über SSH. Daten werden per Tauri-Channel gestreamt.
//! Jede Shell merkt sich die letzte Ausgabe, damit sie in ein anderes Fenster
//! umgehängt werden kann (`term_attach`) und dort mit Verlauf weiterläuft.

use std::collections::VecDeque;

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

/// So viel Ausgabe wird beim Umhängen in ein neues Fenster wieder abgespielt.
const BACKLOG: usize = 512 * 1024;

pub struct TermOut {
    channel: Channel<TermEvent>,
    backlog: VecDeque<u8>,
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
    if conn.is_root_mode() && !conn.is_root() {
        let (cmd, pw) = conn.root_shell().await;
        sudo_pw = pw;
        ch.exec(false, cmd).await?;
    } else {
        ch.request_shell(false).await?;
    }

    let (mut read, write) = ch.split();
    let term_id = uuid::Uuid::new_v4().to_string();
    conn.terminals.lock().await.insert(term_id.clone(), write);
    conn.term_out.lock().unwrap().insert(
        term_id.clone(),
        TermOut {
            channel: on_event,
            backlog: VecDeque::new(),
        },
    );

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
                    // Kein await, solange der (synchrone) Lock gehalten wird
                    let alive = {
                        let mut outs = conn2.term_out.lock().unwrap();
                        match outs.get_mut(&tid) {
                            Some(out) => {
                                out.backlog.extend(data.iter().copied());
                                let excess = out.backlog.len().saturating_sub(BACKLOG);
                                if excess > 0 {
                                    out.backlog.drain(..excess);
                                }
                                // Fehler ignorieren: das Fenster kann gerade gewechselt werden
                                let _ = out.channel.send(TermEvent::Data {
                                    data: B64.encode(&data),
                                });
                                true
                            }
                            None => false, // per term_close geschlossen
                        }
                    };
                    if !alive {
                        break;
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        conn2.terminals.lock().await.remove(&tid);
        let out = conn2.term_out.lock().unwrap().remove(&tid);
        if let Some(out) = out {
            let _ = out.channel.send(TermEvent::Exit { code });
        }
    });

    Ok(term_id)
}

/// Hängt eine laufende Shell an einen neuen Channel (z.B. in einem eigenen Fenster).
/// Der bisherige Verlauf wird zuerst abgespielt.
#[tauri::command]
pub async fn term_attach(
    state: State<'_, AppState>,
    conn_id: String,
    term_id: String,
    on_event: Channel<TermEvent>,
) -> AppResult<()> {
    let conn = state.conn(&conn_id).await?;
    let mut outs = conn.term_out.lock().unwrap();
    let out = outs
        .get_mut(&term_id)
        .ok_or_else(|| AppError::msg("Terminal geschlossen"))?;
    let (a, b) = out.backlog.as_slices();
    if !a.is_empty() || !b.is_empty() {
        let mut buf = Vec::with_capacity(a.len() + b.len());
        buf.extend_from_slice(a);
        buf.extend_from_slice(b);
        let _ = on_event.send(TermEvent::Data {
            data: B64.encode(&buf),
        });
    }
    out.channel = on_event;
    Ok(())
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
        conn.term_out.lock().unwrap().remove(&term_id);
        if let Some(w) = conn.terminals.lock().await.remove(&term_id) {
            let _ = w.close().await;
        }
    }
    Ok(())
}
