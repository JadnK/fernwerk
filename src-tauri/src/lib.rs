mod error;
mod state;
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
        ])
        .run(tauri::generate_context!())
        .expect("Fernwerk konnte nicht gestartet werden");
}
