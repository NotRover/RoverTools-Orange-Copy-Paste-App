//! Smart Clipboard – Tauri/Rust backend.

pub mod clipboard;
pub mod runtime;
pub mod state;

pub use state::AppState;

use crate::clipboard::history::ClipboardHistory;
use parking_lot::Mutex;
use std::sync::Arc;

type SharedHistory = Arc<Mutex<ClipboardHistory>>;

fn create_shared_history() -> SharedHistory {
    Arc::new(Mutex::new(ClipboardHistory::new()))
}

fn app_state_from_history(history: &SharedHistory) -> AppState {
    AppState {
        history: Arc::clone(history),
    }
}

fn setup_runtime(
    app: &mut tauri::App,
    history: &SharedHistory,
) -> Result<(), Box<dyn std::error::Error>> {
    crate::runtime::popup_windows::setup_popup_windows(app)?;
    crate::runtime::hotkeys::register_global_shortcuts(app, Arc::clone(history))?;
    crate::runtime::popup_windows::setup_main_window_focus_handler(app);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let history = create_shared_history();

    tauri::Builder::default()
        .manage(app_state_from_history(&history))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            crate::clipboard::commands::get_history,
            crate::clipboard::commands::delete_entry,
            crate::clipboard::commands::clear_history,
            crate::clipboard::commands::copy_entry,
            crate::clipboard::commands::paste_entry,
            crate::runtime::commands::close_cursor_popup,
            crate::runtime::commands::close_paste_popup,
        ])
        .setup(move |app| setup_runtime(app, &history))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
