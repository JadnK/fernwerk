mod error;
mod keys;
mod sftp;
mod ssh;
mod state;
mod stats;
mod terminal;
mod tunnels;
mod users;
mod vault;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let state = state::AppState::new(&dir).map_err(|e| e.to_string())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Vault
            vault::vault_load,
            vault::host_save,
            vault::host_delete,
            vault::host_forget_key,
            vault::snippet_save,
            vault::snippet_delete,
            vault::settings_save,
            vault::vault_export,
            vault::vault_import,
            // SSH
            ssh::ssh_connect,
            ssh::ssh_disconnect,
            ssh::ssh_exec,
            // Terminal
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
            // SFTP
            sftp::sftp_home,
            sftp::sftp_list,
            sftp::sftp_mkdir,
            sftp::sftp_touch,
            sftp::sftp_rename,
            sftp::sftp_chmod,
            sftp::sftp_remove,
            sftp::sftp_read_text,
            sftp::sftp_write_text,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_cancel,
            // Monitoring
            stats::stats_fetch,
            stats::process_kill,
            stats::services_list,
            stats::service_action,
            stats::service_logs,
            // Tunnel
            tunnels::tunnel_start,
            tunnels::tunnel_stop,
            tunnels::tunnel_list,
            tunnels::remote_ports,
            // Benutzer
            users::users_list,
            users::user_create,
            users::user_delete,
            users::user_password,
            users::user_lock,
            users::user_update,
            users::group_create,
            // Schlüssel
            keys::keys_generate,
            keys::keys_import,
            keys::keys_delete,
            keys::key_deploy,
            keys::authorized_keys_list,
            keys::authorized_keys_remove,
        ])
        .run(tauri::generate_context!())
        .expect("Fernwerk konnte nicht gestartet werden");
}
