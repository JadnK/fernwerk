//! Server-Monitoring (Linux): CPU, RAM, Disks, Netz, Prozesse, systemd-Dienste.
//! Alles läuft über einen einzigen Exec-Aufruf pro Abfrage – kein Agent auf dem Server nötig.

use std::time::Instant;

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::ssh::sh_quote;
use crate::state::AppState;

const SEP: &str = "@@FW@@";

const SCRIPT: &str = r#"LC_ALL=C; export LC_ALL
head -n1 /proc/stat; echo @@FW@@
cat /proc/meminfo; echo @@FW@@
cat /proc/loadavg; echo @@FW@@
cat /proc/uptime; echo @@FW@@
df -PB1 -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null; echo @@FW@@
cat /proc/net/dev; echo @@FW@@
nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo; echo @@FW@@
hostname; uname -r; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -s; echo @@FW@@
ps -eo pid=,user=,pcpu=,pmem=,rss=,comm= --sort=-pcpu 2>/dev/null | head -n 25; echo @@FW@@
who 2>/dev/null | wc -l"#;

#[derive(Debug, Clone)]
pub struct Sample {
    at: Instant,
    cpu_total: u64,
    cpu_idle: u64,
    rx: u64,
    tx: u64,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Mem {
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub cached: u64,
    pub swap_total: u64,
    pub swap_used: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub fs: String,
    pub mount: String,
    pub size: u64,
    pub used: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Proc {
    pub pid: u32,
    pub user: String,
    pub cpu: f32,
    pub mem: f32,
    pub rss: u64,
    pub command: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub hostname: String,
    pub kernel: String,
    pub os: String,
    pub cores: u32,
    /// CPU-Auslastung in Prozent seit der letzten Abfrage (None bei erster Abfrage)
    pub cpu: Option<f64>,
    pub load: [f64; 3],
    pub uptime: u64,
    pub mem: Mem,
    pub disks: Vec<Disk>,
    pub rx_rate: Option<f64>,
    pub tx_rate: Option<f64>,
    pub rx_total: u64,
    pub tx_total: u64,
    pub procs: Vec<Proc>,
    pub sessions: u32,
}

fn parse_cpu(line: &str) -> (u64, u64) {
    let v: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|x| x.parse().ok())
        .collect();
    let total = v.iter().sum();
    // idle + iowait
    let idle = v.get(3).copied().unwrap_or(0) + v.get(4).copied().unwrap_or(0);
    (total, idle)
}

fn parse_meminfo(s: &str) -> Mem {
    let get = |k: &str| -> u64 {
        s.lines()
            .find(|l| l.starts_with(k) && l[k.len()..].starts_with(':'))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|x| x.parse::<u64>().ok())
            .unwrap_or(0)
            * 1024
    };
    let total = get("MemTotal");
    let available = get("MemAvailable");
    let swap_total = get("SwapTotal");
    Mem {
        total,
        available,
        used: total.saturating_sub(available),
        cached: get("Cached") + get("Buffers"),
        swap_total,
        swap_used: swap_total.saturating_sub(get("SwapFree")),
    }
}

fn parse_df(s: &str) -> Vec<Disk> {
    s.lines()
        .skip(1)
        .filter_map(|l| {
            let p: Vec<&str> = l.split_whitespace().collect();
            if p.len() < 6 {
                return None;
            }
            Some(Disk {
                fs: p[0].to_string(),
                size: p[1].parse().ok()?,
                used: p[2].parse().ok()?,
                mount: p[5..].join(" "),
            })
        })
        .filter(|d| d.size > 0)
        .collect()
}

fn parse_net(s: &str) -> (u64, u64) {
    let mut rx = 0;
    let mut tx = 0;
    for l in s.lines().skip(2) {
        let Some((iface, rest)) = l.split_once(':') else {
            continue;
        };
        let iface = iface.trim();
        if iface == "lo"
            || iface.starts_with("veth")
            || iface.starts_with("docker")
            || iface.starts_with("br-")
        {
            continue;
        }
        let v: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|x| x.parse().ok())
            .collect();
        rx += v.first().copied().unwrap_or(0);
        tx += v.get(8).copied().unwrap_or(0);
    }
    (rx, tx)
}

fn parse_procs(s: &str) -> Vec<Proc> {
    s.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            Some(Proc {
                pid: it.next()?.parse().ok()?,
                user: it.next()?.to_string(),
                cpu: it.next()?.parse().ok()?,
                mem: it.next()?.parse().ok()?,
                rss: it.next()?.parse::<u64>().ok()? * 1024,
                command: it.collect::<Vec<_>>().join(" "),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn stats_fetch(state: State<'_, AppState>, conn_id: String) -> AppResult<Stats> {
    let conn = state.conn(&conn_id).await?;
    let out = conn
        .exec(&format!("sh -c {}", sh_quote(SCRIPT)), None)
        .await?;
    let parts: Vec<&str> = out.stdout.split(SEP).map(|p| p.trim()).collect();
    if parts.len() < 10 || !parts[0].starts_with("cpu") {
        return Err(AppError::msg(
            "Monitoring wird nur auf Linux-Servern unterstützt",
        ));
    }

    let (cpu_total, cpu_idle) = parse_cpu(parts[0]);
    let (rx, tx) = parse_net(parts[5]);
    let now = Sample {
        at: Instant::now(),
        cpu_total,
        cpu_idle,
        rx,
        tx,
    };

    let mut prev = conn.stats_prev.lock().await;
    let (cpu, rx_rate, tx_rate) = match prev.as_ref() {
        Some(p) => {
            let dt = now.at.duration_since(p.at).as_secs_f64().max(0.001);
            let dtotal = now.cpu_total.saturating_sub(p.cpu_total) as f64;
            let didle = now.cpu_idle.saturating_sub(p.cpu_idle) as f64;
            let cpu = if dtotal > 0.0 {
                Some(((dtotal - didle) / dtotal * 100.0).clamp(0.0, 100.0))
            } else {
                None
            };
            (
                cpu,
                Some(now.rx.saturating_sub(p.rx) as f64 / dt),
                Some(now.tx.saturating_sub(p.tx) as f64 / dt),
            )
        }
        None => (None, None, None),
    };
    *prev = Some(now);

    let load: Vec<f64> = parts[2]
        .split_whitespace()
        .take(3)
        .filter_map(|x| x.parse().ok())
        .collect();
    let uptime = parts[3]
        .split_whitespace()
        .next()
        .and_then(|x| x.parse::<f64>().ok())
        .unwrap_or(0.0) as u64;
    let mut info = parts[7].lines();

    Ok(Stats {
        hostname: info.next().unwrap_or_default().to_string(),
        kernel: info.next().unwrap_or_default().to_string(),
        os: info.next().unwrap_or_default().to_string(),
        cores: parts[6].parse().unwrap_or(1),
        cpu,
        load: [
            load.first().copied().unwrap_or(0.0),
            load.get(1).copied().unwrap_or(0.0),
            load.get(2).copied().unwrap_or(0.0),
        ],
        uptime,
        mem: parse_meminfo(parts[1]),
        disks: parse_df(parts[4]),
        rx_rate,
        tx_rate,
        rx_total: rx,
        tx_total: tx,
        procs: parse_procs(parts[8]),
        sessions: parts[9].parse().unwrap_or(0),
    })
}

#[tauri::command]
pub async fn process_kill(
    state: State<'_, AppState>,
    conn_id: String,
    pid: u32,
    signal: String,
    sudo_password: Option<String>,
) -> AppResult<()> {
    let sig = match signal.as_str() {
        "TERM" | "KILL" | "HUP" | "INT" => signal,
        _ => return Err(AppError::msg("Ungültiges Signal")),
    };
    let conn = state.conn(&conn_id).await?;
    let cmd = format!("kill -{sig} {pid}");
    let out = conn.exec(&cmd, None).await?;
    if out.ok() {
        return Ok(());
    }
    conn.exec_root(&cmd, sudo_password, None).await?.check()?;
    Ok(())
}
