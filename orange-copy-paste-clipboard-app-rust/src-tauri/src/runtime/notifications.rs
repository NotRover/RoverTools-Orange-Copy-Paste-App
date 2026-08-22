use std::sync::atomic::Ordering;

use tauri::{Emitter, Manager};

use crate::clipboard::history::ClipboardEntry;
use crate::runtime::platform::notification_position;
use crate::state::{AppState, NotificationPayload, NOTIF_H, NOTIF_W};

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
    let (px, py) = notification_position(NOTIF_W as i32, NOTIF_H as i32);

    if let Some(win) = app.get_webview_window("notification") {
        let payload = NotificationPayload {
            kind: kind.to_string(),
            action: action.to_string(),
            detail,
            note,
        };
        // Position first, then show, then set always-on-top to force Z-order.
        let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
        let _ = win.show();
        // Make the notification click-through. This MUST run after `show()`:
        // the window is created hidden/unrealized, and on GTK/Linux calling
        // `set_ignore_cursor_events` before the GDK window exists panics in tao.
        let _ = win.set_ignore_cursor_events(true);
        // Toggle always_on_top off then on to force the window manager to
        // re-stack this window above everything else.
        let _ = win.set_always_on_top(false);
        let _ = win.set_always_on_top(true);
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
        "Too large",
        Some(crate::sync::format_bytes(bytes as u64)),
        // The distinction the toast has to land in one read: the copy worked,
        // Windows has it, and pasting is unaffected. Only this app's history
        // declined to keep it.
        Some("Not added to history. Your system clipboard still has it, so paste works.".into()),
    );
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
