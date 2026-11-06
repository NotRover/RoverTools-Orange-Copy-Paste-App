use std::sync::atomic::Ordering;

use tauri::Manager;
#[cfg(not(target_os = "linux"))]
use tauri::Emitter;
#[cfg(target_os = "linux")]
use tauri_plugin_notification::NotificationExt;

use crate::clipboard::history::ClipboardEntry;
#[cfg(not(target_os = "linux"))]
use crate::runtime::platform::notification_position;
use crate::state::AppState;
#[cfg(not(target_os = "linux"))]
use crate::state::{NotificationPayload, NOTIF_H, NOTIF_W};

fn show_notification(app: &tauri::AppHandle, entry: &ClipboardEntry, action: &str) {
    show_toast(app, entry.kind.label(), action, None, None);
}

/// Show the app's own small toast. The one place that positions and reveals
/// that window, so every caller gets the same Z-order and click-through dance.
fn show_toast(
    app: &tauri::AppHandle,
    kind: &str,
    action: &str,
    detail: Option<String>,
    note: Option<String>,
) {
    // No toast window on Linux (see `popup_windows.rs`). Only the alerts that
    // bypass the preferences reach here there, and they go to the desktop's
    // own notifications, which every Linux desktop shows reliably.
    #[cfg(target_os = "linux")]
    {
        let _ = (kind, detail);
        let mut builder = app.notification().builder().title(action);
        if let Some(note) = note.as_deref() {
            builder = builder.body(note);
        }
        if let Err(e) = builder.show() {
            log::warn!(target: "os-notify", "{e}");
        }
        return;
    }
    #[cfg(not(target_os = "linux"))]
    show_window_toast(app, kind, action, detail, note);
}

#[cfg(not(target_os = "linux"))]
fn show_window_toast(
    app: &tauri::AppHandle,
    kind: &str,
    action: &str,
    detail: Option<String>,
    note: Option<String>,
) {
    let (px, py) = notification_position(NOTIF_W as i32, NOTIF_H as i32);

    if let Some(win) = app.get_webview_window("notification") {
        let payload = NotificationPayload {
            kind: kind.to_string(),
            action: action.to_string(),
            detail,
            note,
        };
        // The toast must never take focus: a paste sends its Ctrl+V right
        // after this, and it has to reach the app the user is in. Every tao
        // call that touches a visible window's flags re-shows it with
        // SW_SHOW, which activates, so on Windows the click-through flag is
        // set first (a no-op once it is set) and the show, position and
        // Z-order are one non-activating call. See `platform/windows.rs`.
        #[cfg(windows)]
        {
            let _ = win.set_ignore_cursor_events(true);
            if let Ok(hwnd) = win.hwnd() {
                crate::runtime::platform::show_without_focus(hwnd.0 as isize, px, py);
            }
        }
        #[cfg(not(windows))]
        {
            // After a popup handed focus back (`hide_popup` on macOS) the app is
            // hidden, and a hidden app's windows do not appear. Unhide it without
            // taking focus, or this toast is queued until the user next opens us.
            #[cfg(target_os = "macos")]
            crate::runtime::platform::macos::unhide_quietly(app);
            // Position first, then show, then set always-on-top to force Z-order.
            let _ = win.set_position(crate::runtime::platform::position_at(px, py));
            let _ = win.show();
            // Make the notification click-through. This must run after `show()`
            // where the window is only realized on first show.
            let _ = win.set_ignore_cursor_events(true);
            // Toggle always_on_top off then on to force the window manager to
            // re-stack this window above everything else.
            let _ = win.set_always_on_top(false);
            let _ = win.set_always_on_top(true);
        }
        let _ = win.emit("notification:show", &payload);
    }
}

/// Tell the user a copy was refused for its size - always, whatever the
/// notification preferences say.
///
/// The copy and paste toasts are opt-in because they confirm something that
/// worked, which the user already knows about. This one reports something that
/// did *not* happen: an item they copied is not in their history, and the only
/// other sign of it is the absence. A preference must not be able to hide that,
/// so this deliberately reads neither `notification_enabled` nor `notif_copy`.
pub(crate) fn notify_capture_skipped(app: &tauri::AppHandle, bytes: usize) {
    show_toast(
        app,
        "text",
        "Too large for history",
        Some(crate::sync::format_bytes(bytes as u64)),
        // The distinction the toast has to land in one read: the copy worked,
        // Windows has it, and pasting is unaffected. Only this app's history
        // declined to keep it.
        Some("Not added to history. Your system clipboard still has it, so paste works.".into()),
    );
}

/// Tell the user the app is waiting for sync work before it closes or
/// restarts - always, whatever the notification preferences say.
///
/// The window is already hidden by then, so without this the app has simply
/// not closed yet, and the obvious next move is to end it from Task Manager:
/// the one thing that loses the upload the wait is for.
pub(crate) fn notify_finishing_sync(app: &tauri::AppHandle, restarting: bool) {
    let then = if restarting { "restart" } else { "close" };
    show_toast(
        app,
        "closing",
        "Finishing sync",
        Some("Cloud sync".into()),
        Some(format!("Orange Copy Paste will {then} in a few seconds.")),
    );
}

/// Show a copy notification if the user has the feature enabled
/// and copy operations are not muted.
pub(crate) fn notify_if_enabled(app: &tauri::AppHandle, entry: &ClipboardEntry) {
    // The confirmations are the in-app popup's job, and Linux has none.
    if cfg!(target_os = "linux") {
        return;
    }
    let state = app.state::<AppState>();
    if !state.notification_enabled.load(Ordering::Relaxed) {
        return;
    }
    if state.notif_copy.load(Ordering::Relaxed) {
        show_notification(app, entry, "Copied");
    }
}

/// Show a paste notification if the user has the feature enabled
/// and paste operations are not muted.
pub(crate) fn notify_paste_if_enabled(app: &tauri::AppHandle, entry: &ClipboardEntry) {
    if cfg!(target_os = "linux") {
        return;
    }
    let state = app.state::<AppState>();
    if !state.notification_enabled.load(Ordering::Relaxed) {
        return;
    }
    if state.notif_paste.load(Ordering::Relaxed) {
        show_notification(app, entry, "Pasted");
    }
}
