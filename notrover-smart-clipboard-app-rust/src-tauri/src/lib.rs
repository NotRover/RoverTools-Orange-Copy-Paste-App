//! Smart Clipboard – Tauri/Rust backend.

pub mod clipboard;
pub mod runtime;
pub mod state;

pub use state::AppState;

use crate::clipboard::history::ClipboardHistory;
use parking_lot::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

type SharedHistory = Arc<Mutex<ClipboardHistory>>;
type SuppressFlag = Arc<AtomicBool>;

fn create_shared_history() -> SharedHistory {
    Arc::new(Mutex::new(ClipboardHistory::new()))
}

fn app_state_from_history(history: &SharedHistory, suppress: &SuppressFlag) -> AppState {
    AppState {
        history: Arc::clone(history),
        suppress_next_capture: Arc::clone(suppress),
    }
}

fn setup_runtime(
    app: &mut tauri::App,
    history: &SharedHistory,
    suppress: &SuppressFlag,
) -> Result<(), Box<dyn std::error::Error>> {
    crate::runtime::popup_windows::setup_popup_windows(app)?;
    crate::runtime::hotkeys::register_global_shortcuts(app, Arc::clone(history))?;
    crate::runtime::clipboard_watcher::start_clipboard_watcher(
        &app.handle().clone(),
        Arc::clone(history),
        Arc::clone(suppress),
    );
    crate::runtime::popup_windows::setup_main_window_focus_handler(app);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let history = create_shared_history();
    let suppress: SuppressFlag = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        .manage(app_state_from_history(&history, &suppress))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            crate::clipboard::commands::get_history,
            crate::clipboard::commands::delete_entry,
            crate::clipboard::commands::clear_history,
            crate::clipboard::commands::copy_entry,
            crate::clipboard::commands::paste_entry,
            crate::clipboard::commands::get_image_file_preview,
            crate::clipboard::commands::get_video_file_preview,
            crate::runtime::commands::close_cursor_popup,
            crate::runtime::commands::close_paste_popup,
        ])
        .setup(move |app| setup_runtime(app, &history, &suppress))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
