use std::sync::atomic::Ordering;

use tauri::{Emitter, Manager};

use crate::clipboard::history::ClipboardEntry;
use crate::runtime::platform::notification_position;
use crate::state::{AppState, NotificationPayload, NOTIF_H, NOTIF_W};

fn show_notification(app: &tauri::AppHandle, entry: &ClipboardEntry, action: &str) {
    let (px, py) = notification_position(NOTIF_W as i32, NOTIF_H as i32);

    if let Some(win) = app.get_webview_window("notification") {
        let payload = NotificationPayload {
            kind: entry.kind.label().to_string(),
            action: action.to_string(),
        };
        // Position first, then show, then set always-on-top to force Z-order.
        let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
        let _ = win.show();
        // Toggle always_on_top off then on to force the window manager to
        // re-stack this window above everything else.
        let _ = win.set_always_on_top(false);
        let _ = win.set_always_on_top(true);
        let _ = win.emit("notification:show", &payload);
    }
}

/// Show a copy notification if the user has the feature enabled
/// and copy operations are not muted.
pub(crate) fn notify_if_enabled(app: &tauri::AppHandle, entry: &ClipboardEntry) {
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
    let state = app.state::<AppState>();
    if !state.notification_enabled.load(Ordering::Relaxed) {
        return;
    }
    if state.notif_paste.load(Ordering::Relaxed) {
        show_notification(app, entry, "Pasted");
    }
}
