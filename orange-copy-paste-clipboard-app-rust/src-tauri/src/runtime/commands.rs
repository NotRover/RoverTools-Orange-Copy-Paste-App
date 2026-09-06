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

/// Reveal the copy popup. Split from the capture path so the window stays hidden
/// until the webview has rendered the entry and sized itself, then shows already
/// populated — no visible chip pop-in or resize after it is on screen.
///
/// On the reveal, the caller passes the measured `height` so sizing and showing
/// happen in a single IPC round-trip instead of a resize call followed by a
/// present call — the window appears one hop sooner. `None` just shows at the
/// current size (the fallback path, when a resize already ran).
#[tauri::command]
pub fn present_copy_popup(app: tauri::AppHandle, height: Option<f64>) {
    if let Some(win) = app.get_webview_window("copy-popup") {
        if let Some(h) = height {
            let _ = win.set_size(tauri::LogicalSize::new(crate::state::COPY_POPUP_W, h));
            crate::runtime::popup_windows::clamp_popup_into_monitor(&app, "copy-popup");
        }
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
pub fn close_paste_popup(app: tauri::AppHandle) {
    hide_popup(&app, "paste-popup");
}

#[tauri::command]
pub fn close_notification(app: tauri::AppHandle) {
    hide_popup(&app, "notification");
}

/// The frontend reporting which screen is now showing. Split from the space
/// report below so the two writers - the app shell (screen) and the Spaces
/// screen (selected space) - never overwrite each other's field, whatever order
/// their effects run in. Cheap and frequent; nothing reads it until a space
/// notification asks whether the user is already looking at what it is about.
#[tauri::command]
pub fn ui_screen_changed(screen: String, state: tauri::State<'_, crate::state::AppState>) {
    state.ui_view.lock().screen = screen;
}

/// The frontend reporting which space is selected on the Spaces screen (or
/// `None` when it unmounts). Meaningful only while the screen is "spaces"; the
/// reader gates on that.
#[tauri::command]
pub fn ui_space_changed(space_id: Option<String>, state: tauri::State<'_, crate::state::AppState>) {
    state.ui_view.lock().space_id = space_id;
}

fn resize_popup(app: &tauri::AppHandle, label: &str, width: f64, height: f64) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.set_size(tauri::LogicalSize::new(width, height));
    }
}

#[tauri::command]
pub fn resize_paste_popup(app: tauri::AppHandle, width: f64, height: f64) {
    resize_popup(&app, "paste-popup", width, height);
    crate::runtime::popup_windows::clamp_popup_into_monitor(&app, "paste-popup");
}

#[tauri::command]
pub fn resize_copy_popup(app: tauri::AppHandle, height: f64) {
    resize_popup(&app, "copy-popup", crate::state::COPY_POPUP_W, height);
    crate::runtime::popup_windows::clamp_popup_into_monitor(&app, "copy-popup");
}

/// Nudge a popup back onto its monitor after the user has dragged it by the
/// header. The drag itself is an OS move loop we do not control; the frontend
/// calls this once the moves settle, so a popup pulled past an edge snaps back
/// while one left on-screen stays exactly where it was placed. Restricted to the
/// two draggable popups so it can never be pointed at another window.
#[tauri::command]
pub fn clamp_popup(app: tauri::AppHandle, label: String) {
    if label == "copy-popup" || label == "paste-popup" {
        crate::runtime::popup_windows::clamp_popup_into_monitor(&app, &label);
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

#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Re-point the OS startup entry at this build's executable.
///
/// An update reinstalls the app rather than patching it, so the path recorded
/// when the user first switched "Run on startup" on can end up naming an
/// executable the installer replaced. `enable()` overwrites the existing entry in
/// place, so this is an idempotent refresh — and unlike disable-then-enable it
/// leaves no window where a failure loses the setting.
///
/// A no-op when startup is off, and in debug builds for the same reason
/// [`set_autostart`] refuses there.
pub fn reconcile_autostart(app: &tauri::AppHandle) {
    if cfg!(debug_assertions) && !ALLOW_AUTOSTART_IN_DEBUG_BUILD {
        return;
    }
    let mgr = app.autolaunch();
    if mgr.is_enabled().unwrap_or(false) {
        let _ = mgr.enable();
    }
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

