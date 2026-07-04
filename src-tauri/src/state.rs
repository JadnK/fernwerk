use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use tokio::sync::{Mutex, RwLock};

use crate::error::{AppError, AppResult};
use crate::ssh::Connection;
use crate::tunnels::RunningTunnel;
use crate::vault::Vault;

pub struct AppState {
    pub vault: Mutex<Vault>,
    pub conns: RwLock<HashMap<String, Arc<Connection>>>,
    pub tunnels: Mutex<HashMap<String, RunningTunnel>>,
}

impl AppState {
    pub fn new(data_dir: &Path) -> AppResult<Self> {
        Ok(Self {
            vault: Mutex::new(Vault::open(data_dir)?),
            conns: RwLock::new(HashMap::new()),
            tunnels: Mutex::new(HashMap::new()),
        })
    }

    pub async fn conn(&self, id: &str) -> AppResult<Arc<Connection>> {
        self.conns
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or(AppError::NoConnection)
    }
}
