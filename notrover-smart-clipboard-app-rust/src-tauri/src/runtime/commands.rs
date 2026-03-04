//! Tauri command handlers for runtime window controls.

use crate::runtime::popup_windows::hide_popup;

#[tauri::command]
pub fn close_cursor_popup(app: tauri::AppHandle) {
    hide_popup(&app, "cursor-popup");
}

#[tauri::command]
pub fn close_paste_popup(app: tauri::AppHandle) {
    hide_popup(&app, "paste-popup");
}
