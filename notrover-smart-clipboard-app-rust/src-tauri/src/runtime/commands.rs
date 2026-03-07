//! Tauri command handlers for runtime window controls.

use crate::runtime::popup_windows::hide_popup;
use tauri::Manager;

#[tauri::command]
pub fn close_copy_popup(app: tauri::AppHandle) {
    hide_popup(&app, "copy-popup");
}

#[tauri::command]
pub fn close_paste_popup(app: tauri::AppHandle) {
    hide_popup(&app, "paste-popup");
}

#[tauri::command]
pub fn resize_paste_popup(app: tauri::AppHandle, height: f64) {
    if let Some(win) = app.get_webview_window("paste-popup") {
        let w = crate::state::PASTE_POPUP_W;
        let _ = win.set_size(tauri::LogicalSize::new(w, height));
    }
}

#[tauri::command]
pub fn resize_copy_popup(app: tauri::AppHandle, height: f64) {
    if let Some(win) = app.get_webview_window("copy-popup") {
        let w = crate::state::COPY_POPUP_W;
        let _ = win.set_size(tauri::LogicalSize::new(w, height));
    }
}

#[tauri::command]
pub fn open_data_folder(app: tauri::AppHandle) -> bool {
    let Some(dir) = app.path().app_data_dir().ok() else {
        return false;
    };
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .is_ok()
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .is_ok()
    }
}
