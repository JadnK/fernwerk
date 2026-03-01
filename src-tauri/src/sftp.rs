//! SFTP: Verzeichnisse, Dateioperationen, rekursive Up-/Downloads mit Fortschritt.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, AppResult};
use crate::ssh::Connection;
use crate::state::AppState;

const CHUNK: usize = 256 * 1024;
const MAX_EDIT_SIZE: u64 = 5 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    /// "dir" | "file" | "link"
    pub kind: String,
    pub link_to_dir: bool,
    pub size: u64,
    pub mtime: Option<u32>,
    pub mode: u32,
    pub perms: String,
    pub owner: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub transfer_id: String,
    pub file: String,
    pub done: u64,
    pub total: u64,
    pub finished: bool,
    pub error: Option<String>,
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

pub fn perm_string(mode: u32, is_dir: bool, is_link: bool) -> String {
    let t = if is_link {
        'l'
    } else if is_dir {
        'd'
    } else {
        '-'
    };
    let bits = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    std::iter::once(t)
        .chain(
            bits.iter()
                .map(|(b, c)| if mode & b != 0 { *c } else { '-' }),
        )
        .collect()
}

async fn sftp_of(
    state: &State<'_, AppState>,
    conn_id: &str,
) -> AppResult<(Arc<Connection>, Arc<SftpSession>)> {
    let conn = state.conn(conn_id).await?;
    let s = conn.sftp().await?;
    Ok((conn, s))
}

#[tauri::command]
pub async fn sftp_home(state: State<'_, AppState>, conn_id: String) -> AppResult<String> {
    let (conn, s) = sftp_of(&state, &conn_id).await?;
    match s.canonicalize(".").await {
        Ok(p) => Ok(p),
        Err(e) => {
            conn.reset_sftp().await;
            Err(e.into())
        }
    }
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> AppResult<Vec<FileEntry>> {
    let (conn, s) = sftp_of(&state, &conn_id).await?;
    let dir = match s.read_dir(path.clone()).await {
        Ok(d) => d,
        Err(e) => {
            if matches!(e, russh_sftp::client::error::Error::UnexpectedBehavior(_)) {
                conn.reset_sftp().await;
            }
            return Err(e.into());
        }
    };

    let mut out = Vec::new();
    for entry in dir {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata();
        let full = join(&path, &name);
        let ft = entry.file_type();
        let is_link = matches!(ft, FileType::Symlink);
        let is_dir = matches!(ft, FileType::Dir);
        let link_to_dir = if is_link {
            s.metadata(full.clone())
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false)
        } else {
            false
        };
        let mode = meta.permissions.unwrap_or(0) & 0o7777;
        out.push(FileEntry {
            name,
            path: full,
            kind: if is_dir {
                "dir"
            } else if is_link {
                "link"
            } else {
                "file"
            }
            .into(),
            link_to_dir,
            size: meta.size.unwrap_or(0),
            mtime: meta.mtime,
            mode,
            perms: perm_string(mode, is_dir, is_link),
            owner: meta
                .user
                .clone()
                .unwrap_or_else(|| meta.uid.map(|u| u.to_string()).unwrap_or_default()),
        });
    }
    out.sort_by(|a, b| {
        let ad = a.kind == "dir" || a.link_to_dir;
        let bd = b.kind == "dir" || b.link_to_dir;
        bd.cmp(&ad)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> AppResult<()> {
    let (_, s) = sftp_of(&state, &conn_id).await?;
    s.create_dir(path).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_touch(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> AppResult<()> {
    let (_, s) = sftp_of(&state, &conn_id).await?;
    if s.try_exists(path.clone()).await? {
        return Err(AppError::msg("Datei existiert bereits"));
    }
    let mut f = s.create(path).await?;
    f.shutdown().await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    conn_id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    let (_, s) = sftp_of(&state, &conn_id).await?;
    s.rename(from, to).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
    mode: u32,
) -> AppResult<()> {
    let (_, s) = sftp_of(&state, &conn_id).await?;
    let mut attrs = FileAttributes::empty();
    attrs.permissions = Some(mode & 0o7777);
    s.set_metadata(path, attrs).await?;
    Ok(())
}

fn remove_recursive<'a>(
    s: &'a SftpSession,
    path: String,
) -> Pin<Box<dyn Future<Output = AppResult<()>> + Send + 'a>> {
    Box::pin(async move {
        for entry in s.read_dir(path.clone()).await? {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let full = join(&path, &name);
            if matches!(entry.file_type(), FileType::Dir) {
                remove_recursive(s, full).await?;
            } else {
                s.remove_file(full).await?;
            }
        }
        s.remove_dir(path).await?;
        Ok(())
    })
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    conn_id: String,
    paths: Vec<String>,
) -> AppResult<()> {
    let (_, s) = sftp_of(&state, &conn_id).await?;
    for p in paths {
        let meta = s.symlink_metadata(p.clone()).await?;
        if meta.is_dir() {
            remove_recursive(&s, p).await?;
        } else {
            s.remove_file(p).await?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_read_text(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
) -> AppResult<String> {
    let (_, s) = sftp_of(&state, &conn_id).await?;
    let meta = s.metadata(path.clone()).await?;
    if meta.size.unwrap_or(0) > MAX_EDIT_SIZE {
        return Err(AppError::msg(
            "Datei ist zu groß für den Editor (max. 5 MB)",
        ));
    }
    let bytes = s.read(path).await?;
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return Err(AppError::msg("Binärdatei – Bearbeiten nicht möglich"));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[tauri::command]
pub async fn sftp_write_text(
    state: State<'_, AppState>,
    conn_id: String,
    path: String,
    content: String,
) -> AppResult<()> {
    let (_, s) = sftp_of(&state, &conn_id).await?;
    let mut f = s.create(path).await?;
    f.write_all(content.as_bytes()).await?;
    f.shutdown().await?;
    Ok(())
}

// ---------------------------------------------------------------- Transfers

struct Job<'a> {
    id: String,
    cancel: Arc<AtomicBool>,
    chan: &'a Channel<Progress>,
    done: u64,
    total: u64,
}

impl Job<'_> {
    fn report(&self, file: &str) {
        let _ = self.chan.send(Progress {
            transfer_id: self.id.clone(),
            file: file.to_string(),
            done: self.done,
            total: self.total,
            finished: false,
            error: None,
        });
    }

    fn check_cancel(&self) -> AppResult<()> {
        if self.cancel.load(Ordering::Relaxed) {
            Err(AppError::msg("Abgebrochen"))
        } else {
            Ok(())
        }
    }
}

fn register_cancel(conn: &Connection, id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    conn.cancels
        .lock()
        .unwrap()
        .insert(id.to_string(), flag.clone());
    flag
}

fn finish(conn: &Connection, chan: &Channel<Progress>, id: &str, total: u64, res: &AppResult<()>) {
    conn.cancels.lock().unwrap().remove(id);
    let _ = chan.send(Progress {
        transfer_id: id.to_string(),
        file: String::new(),
        done: if res.is_ok() { total } else { 0 },
        total,
        finished: true,
        error: res.as_ref().err().map(|e| e.to_string()),
    });
}

#[tauri::command]
pub async fn sftp_cancel(
    state: State<'_, AppState>,
    conn_id: String,
    transfer_id: String,
) -> AppResult<()> {
    let conn = state.conn(&conn_id).await?;
    if let Some(flag) = conn.cancels.lock().unwrap().get(&transfer_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

// ---- Download

fn remote_size<'a>(
    s: &'a SftpSession,
    path: String,
) -> Pin<Box<dyn Future<Output = AppResult<u64>> + Send + 'a>> {
    Box::pin(async move {
        let meta = s.metadata(path.clone()).await?;
        if !meta.is_dir() {
            return Ok(meta.size.unwrap_or(0));
        }
        let mut sum = 0;
        for e in s.read_dir(path.clone()).await? {
            let n = e.file_name();
            if n == "." || n == ".." || matches!(e.file_type(), FileType::Symlink) {
                continue;
            }
            sum += remote_size(s, join(&path, &n)).await?;
        }
        Ok(sum)
    })
}

fn download_rec<'a>(
    s: &'a SftpSession,
    job: &'a mut Job<'_>,
    remote: String,
    local: PathBuf,
) -> Pin<Box<dyn Future<Output = AppResult<()>> + Send + 'a>> {
    Box::pin(async move {
        job.check_cancel()?;
        let meta = s.metadata(remote.clone()).await?;
        if meta.is_dir() {
            tokio::fs::create_dir_all(&local).await?;
            for e in s.read_dir(remote.clone()).await? {
                let n = e.file_name();
                if n == "." || n == ".." || matches!(e.file_type(), FileType::Symlink) {
                    continue;
                }
                download_rec(s, job, join(&remote, &n), local.join(&n)).await?;
            }
            return Ok(());
        }

        let mut src = s.open(remote.clone()).await?;
        let mut dst = tokio::fs::File::create(&local).await?;
        let mut buf = vec![0u8; CHUNK];
        let mut last = std::time::Instant::now();
        loop {
            job.check_cancel()?;
            let n = src.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await?;
            job.done += n as u64;
            if last.elapsed().as_millis() > 120 {
                job.report(&remote);
                last = std::time::Instant::now();
            }
        }
        dst.flush().await?;
        job.report(&remote);
        Ok(())
    })
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    conn_id: String,
    remote_paths: Vec<String>,
    local_dir: String,
    transfer_id: String,
    on_progress: Channel<Progress>,
) -> AppResult<()> {
    let (conn, s) = sftp_of(&state, &conn_id).await?;
    let cancel = register_cancel(&conn, &transfer_id);
    let mut total = 0;
    for p in &remote_paths {
        total += remote_size(&s, p.clone()).await.unwrap_or(0);
    }
    let mut job = Job {
        id: transfer_id.clone(),
        cancel,
        chan: &on_progress,
        done: 0,
        total,
    };

    let res: AppResult<()> = async {
        for p in remote_paths {
            let name = p.rsplit('/').next().unwrap_or("download").to_string();
            download_rec(&s, &mut job, p, Path::new(&local_dir).join(name)).await?;
        }
        Ok(())
    }
    .await;
    finish(&conn, &on_progress, &transfer_id, total, &res);
    res
}

// ---- Upload

fn local_size(path: &Path) -> u64 {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => std::fs::read_dir(path)
            .map(|rd| rd.flatten().map(|e| local_size(&e.path())).sum())
            .unwrap_or(0),
        Ok(m) if m.is_file() => m.len(),
        _ => 0,
    }
}

fn upload_rec<'a>(
    s: &'a SftpSession,
    job: &'a mut Job<'_>,
    local: PathBuf,
    remote: String,
) -> Pin<Box<dyn Future<Output = AppResult<()>> + Send + 'a>> {
    Box::pin(async move {
        job.check_cancel()?;
        let meta = tokio::fs::symlink_metadata(&local).await?;
        if meta.is_dir() {
            if !s.try_exists(remote.clone()).await.unwrap_or(false) {
                s.create_dir(remote.clone()).await?;
            }
            let mut rd = tokio::fs::read_dir(&local).await?;
            while let Some(e) = rd.next_entry().await? {
                let name = e.file_name().to_string_lossy().into_owned();
                upload_rec(s, job, e.path(), join(&remote, &name)).await?;
            }
            return Ok(());
        }
        if !meta.is_file() {
            return Ok(());
        }

        let mut src = tokio::fs::File::open(&local).await?;
        let mut dst = s.create(remote.clone()).await?;
        let mut buf = vec![0u8; CHUNK];
        let mut last = std::time::Instant::now();
        loop {
            job.check_cancel()?;
            let n = src.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).await?;
            job.done += n as u64;
            if last.elapsed().as_millis() > 120 {
                job.report(&remote);
                last = std::time::Instant::now();
            }
        }
        dst.shutdown().await?;
        job.report(&remote);
        Ok(())
    })
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    conn_id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    transfer_id: String,
    on_progress: Channel<Progress>,
) -> AppResult<()> {
    let (conn, s) = sftp_of(&state, &conn_id).await?;
    let cancel = register_cancel(&conn, &transfer_id);
    let total = local_paths.iter().map(|p| local_size(Path::new(p))).sum();
    let mut job = Job {
        id: transfer_id.clone(),
        cancel,
        chan: &on_progress,
        done: 0,
        total,
    };

    let res: AppResult<()> = async {
        for p in local_paths {
            let path = PathBuf::from(&p);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .ok_or_else(|| AppError::msg("Ungültiger Pfad"))?;
            upload_rec(&s, &mut job, path, join(&remote_dir, &name)).await?;
        }
        Ok(())
    }
    .await;
    finish(&conn, &on_progress, &transfer_id, total, &res);
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn perms() {
        assert_eq!(perm_string(0o755, true, false), "drwxr-xr-x");
        assert_eq!(perm_string(0o644, false, false), "-rw-r--r--");
        assert_eq!(perm_string(0o777, false, true), "lrwxrwxrwx");
    }

    #[test]
    fn joins() {
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join("/var/www", "html"), "/var/www/html");
    }
}
