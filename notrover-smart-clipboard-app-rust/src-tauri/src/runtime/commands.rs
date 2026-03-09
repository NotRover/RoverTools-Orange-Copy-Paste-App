//! Tauri command handlers for runtime window controls.

use crate::runtime::popup_windows::hide_popup;
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;

// Safety guard: never let debug/dev binaries register autostart by default.
// This prevents Windows startup entries from pointing to `target/debug` builds
// that depend on `devUrl` (localhost) and fail on boot.
const ALLOW_AUTOSTART_IN_DEBUG_BUILD: bool = false;

#[tauri::command]
pub fn close_copy_popup(app: tauri::AppHandle) {
    hide_popup(&app, "copy-popup");
}

#[tauri::command]
pub fn close_paste_popup(app: tauri::AppHandle) {
    hide_popup(&app, "paste-popup");
}

#[tauri::command]
pub fn close_copy_notification(app: tauri::AppHandle) {
    hide_popup(&app, "copy-notification");
}

fn resize_popup(app: &tauri::AppHandle, label: &str, width: f64, height: f64) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.set_size(tauri::LogicalSize::new(width, height));
    }
}

#[tauri::command]
pub fn resize_paste_popup(app: tauri::AppHandle, height: f64) {
    resize_popup(&app, "paste-popup", crate::state::PASTE_POPUP_W, height);
}

#[tauri::command]
pub fn resize_copy_popup(app: tauri::AppHandle, height: f64) {
    resize_popup(&app, "copy-popup", crate::state::COPY_POPUP_W, height);
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

#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> bool {
    if enabled && cfg!(debug_assertions) && !ALLOW_AUTOSTART_IN_DEBUG_BUILD {
        eprintln!(
            "Refusing to enable autostart from a debug build (ALLOW_AUTOSTART_IN_DEBUG_BUILD=false)."
        );
        return false;
    }

    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().is_ok()
    } else {
        mgr.disable().is_ok()
    }
}
