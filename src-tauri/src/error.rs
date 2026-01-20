use serde::{Serialize, Serializer};

/// Einheitlicher Fehlertyp für alle Tauri-Commands.
/// Kommt im Frontend als String an.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Msg(String),
    #[error("Verbindung nicht gefunden")]
    NoConnection,
    #[error("SSH: {0}")]
    Ssh(#[from] russh::Error),
    #[error("SFTP: {0}")]
    Sftp(#[from] russh_sftp::client::error::Error),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Schlüssel: {0}")]
    Key(#[from] russh::keys::Error),
}

impl AppError {
    pub fn msg(s: impl Into<String>) -> Self {
        AppError::Msg(s.into())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Msg(e.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
