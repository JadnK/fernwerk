//! SSH-Tunnel: Local Forward (-L) und dynamischer SOCKS5-Proxy (-D).

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

use crate::error::{AppError, AppResult};
use crate::ssh::Connection;
use crate::state::AppState;
use crate::vault::{now, TunnelDef};

#[derive(Default)]
pub struct TunnelStats {
    active: AtomicU32,
    total: AtomicU64,
    up: AtomicU64,
    down: AtomicU64,
}

pub struct RunningTunnel {
    pub def: TunnelDef,
    pub conn_id: String,
    pub started: i64,
    stats: Arc<TunnelStats>,
    task: JoinHandle<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub id: String,
    pub conn_id: String,
    pub name: String,
    pub kind: String,
    pub bind_host: String,
    pub bind_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub active: u32,
    pub total_conns: u64,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub started: i64,
}

/// Kopiert in beide Richtungen und zählt die Bytes live mit.
async fn relay<A, B>(a: A, b: B, stats: &TunnelStats)
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    let (mut ar, mut aw) = tokio::io::split(a);
    let (mut br, mut bw) = tokio::io::split(b);

    let up = async {
        let mut buf = vec![0u8; 32 * 1024];
        while let Ok(n) = ar.read(&mut buf).await {
            if n == 0 || bw.write_all(&buf[..n]).await.is_err() {
                break;
            }
            stats.up.fetch_add(n as u64, Ordering::Relaxed);
        }
        let _ = bw.shutdown().await;
    };
    let down = async {
        let mut buf = vec![0u8; 32 * 1024];
        while let Ok(n) = br.read(&mut buf).await {
            if n == 0 || aw.write_all(&buf[..n]).await.is_err() {
                break;
            }
            stats.down.fetch_add(n as u64, Ordering::Relaxed);
        }
        let _ = aw.shutdown().await;
    };
    tokio::join!(up, down);
}

async fn pipe(
    conn: Arc<Connection>,
    tcp: TcpStream,
    host: String,
    port: u16,
    stats: Arc<TunnelStats>,
) {
    let (peer_ip, peer_port) = tcp
        .peer_addr()
        .map(|a| (a.ip().to_string(), a.port() as u32))
        .unwrap_or_else(|_| ("127.0.0.1".into(), 0));
    let ch = match conn
        .handle
        .channel_open_direct_tcpip(host, port as u32, peer_ip, peer_port)
        .await
    {
        Ok(c) => c,
        Err(_) => return,
    };
    stats.active.fetch_add(1, Ordering::Relaxed);
    stats.total.fetch_add(1, Ordering::Relaxed);
    relay(tcp, ch.into_stream(), &stats).await;
    stats.active.fetch_sub(1, Ordering::Relaxed);
}

/// Minimaler SOCKS5-Handshake (nur CONNECT, keine Auth). Liefert Zielhost/-port.
async fn socks5_handshake(tcp: &mut TcpStream) -> std::io::Result<(String, u16)> {
    let mut head = [0u8; 2];
    tcp.read_exact(&mut head).await?;
    if head[0] != 5 {
        return Err(std::io::Error::other("kein SOCKS5"));
    }
    let mut methods = vec![0u8; head[1] as usize];
    tcp.read_exact(&mut methods).await?;
    tcp.write_all(&[5, 0]).await?;

    let mut req = [0u8; 4];
    tcp.read_exact(&mut req).await?;
    if req[1] != 1 {
        tcp.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Err(std::io::Error::other("nur CONNECT unterstützt"));
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            tcp.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            tcp.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            tcp.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).into_owned()
        }
        4 => {
            let mut a = [0u8; 16];
            tcp.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => return Err(std::io::Error::other("unbekannter Adresstyp")),
    };
    let mut port = [0u8; 2];
    tcp.read_exact(&mut port).await?;
    Ok((host, u16::from_be_bytes(port)))
}

async fn socks_client(conn: Arc<Connection>, mut tcp: TcpStream, stats: Arc<TunnelStats>) {
    let Ok((host, port)) = socks5_handshake(&mut tcp).await else {
        return;
    };
    let ch = match conn
        .handle
        .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
        .await
    {
        Ok(c) => c,
        Err(_) => {
            let _ = tcp.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            return;
        }
    };
    if tcp
        .write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
        .await
        .is_err()
    {
        return;
    }
    stats.active.fetch_add(1, Ordering::Relaxed);
    stats.total.fetch_add(1, Ordering::Relaxed);
    relay(tcp, ch.into_stream(), &stats).await;
    stats.active.fetch_sub(1, Ordering::Relaxed);
}

#[tauri::command]
pub async fn tunnel_start(
    state: State<'_, AppState>,
    conn_id: String,
    def: TunnelDef,
) -> AppResult<()> {
    let conn = state.conn(&conn_id).await?;
    let mut tunnels = state.tunnels.lock().await;
    if tunnels.contains_key(&def.id) {
        return Ok(());
    }
    if def.kind == "local" && (def.remote_host.is_empty() || def.remote_port == 0) {
        return Err(AppError::msg("Zielhost und -port angeben"));
    }

    let bind = format!("{}:{}", def.bind_host, def.bind_port);
    let listener = TcpListener::bind(&bind)
        .await
        .map_err(|e| AppError::msg(format!("{bind} kann nicht gebunden werden: {e}")))?;

    let stats = Arc::new(TunnelStats::default());
    let (kind, rh, rp) = (def.kind.clone(), def.remote_host.clone(), def.remote_port);
    let st = stats.clone();
    let task = tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let c = conn.clone();
            let s = st.clone();
            if kind == "dynamic" {
                tokio::spawn(socks_client(c, tcp, s));
            } else {
                tokio::spawn(pipe(c, tcp, rh.clone(), rp, s));
            }
        }
    });

    tunnels.insert(
        def.id.clone(),
        RunningTunnel {
            def,
            conn_id,
            started: now(),
            stats,
            task,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn tunnel_stop(state: State<'_, AppState>, id: String) -> AppResult<()> {
    if let Some(t) = state.tunnels.lock().await.remove(&id) {
        t.task.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn tunnel_list(state: State<'_, AppState>) -> AppResult<Vec<TunnelStatus>> {
    let tunnels = state.tunnels.lock().await;
    Ok(tunnels
        .values()
        .map(|t| TunnelStatus {
            id: t.def.id.clone(),
            conn_id: t.conn_id.clone(),
            name: t.def.name.clone(),
            kind: t.def.kind.clone(),
            bind_host: t.def.bind_host.clone(),
            bind_port: t.def.bind_port,
            remote_host: t.def.remote_host.clone(),
            remote_port: t.def.remote_port,
            active: t.stats.active.load(Ordering::Relaxed),
            total_conns: t.stats.total.load(Ordering::Relaxed),
            bytes_up: t.stats.up.load(Ordering::Relaxed),
            bytes_down: t.stats.down.load(Ordering::Relaxed),
            started: t.started,
        })
        .collect())
}

pub async fn stop_for_connection(state: &AppState, conn_id: &str) {
    let mut tunnels = state.tunnels.lock().await;
    tunnels.retain(|_, t| {
        if t.conn_id == conn_id {
            t.task.abort();
            false
        } else {
            true
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
    pub address: String,
    pub port: u16,
    pub process: String,
}

/// Lauschende TCP-Ports auf dem Server – für "Ein-Klick-Weiterleitung".
#[tauri::command]
pub async fn remote_ports(
    state: State<'_, AppState>,
    conn_id: String,
) -> AppResult<Vec<ListeningPort>> {
    let conn = state.conn(&conn_id).await?;
    let out = conn
        .exec(
            "ss -Htlnp 2>/dev/null || netstat -tln 2>/dev/null | tail -n +3",
            None,
        )
        .await?;
    let mut ports: Vec<ListeningPort> = out
        .stdout
        .lines()
        .filter_map(|l| {
            let cols: Vec<&str> = l.split_whitespace().collect();
            // ss: State Recv-Q Send-Q Local Peer [Process]; netstat: Proto Recv Send Local Foreign State
            let local = if cols.first() == Some(&"LISTEN") {
                cols.get(3)?
            } else {
                cols.get(3)?
            };
            let (addr, port) = local.rsplit_once(':')?;
            let process = cols
                .iter()
                .find(|c| c.starts_with("users:"))
                .and_then(|c| c.split('"').nth(1))
                .unwrap_or("")
                .to_string();
            Some(ListeningPort {
                address: addr.trim_matches(|c| c == '[' || c == ']').to_string(),
                port: port.parse().ok()?,
                process,
            })
        })
        .collect();
    ports.sort_by_key(|p| p.port);
    ports.dedup_by_key(|p| p.port);
    Ok(ports)
}
