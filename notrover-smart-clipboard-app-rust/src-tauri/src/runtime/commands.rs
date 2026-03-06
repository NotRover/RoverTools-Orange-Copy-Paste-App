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
