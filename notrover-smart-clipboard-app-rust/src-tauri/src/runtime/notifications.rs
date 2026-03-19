use std::sync::atomic::Ordering;

use tauri::{Emitter, Manager};

use crate::clipboard::history::ClipboardEntry;
use crate::runtime::platform::notification_position;
use crate::state::{AppState, CopyNotificationPayload, COPY_NOTIF_H, COPY_NOTIF_W};

fn show_copy_notification(app: &tauri::AppHandle, entry: &ClipboardEntry) {
    let (px, py) = notification_position(COPY_NOTIF_W as i32, COPY_NOTIF_H as i32);

    if let Some(win) = app.get_webview_window("copy-notification") {
        let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
        let payload = CopyNotificationPayload {
            kind: entry.kind.label().to_string(),
        };
        let _ = win.emit("copy-notification:show", &payload);
        let _ = win.set_always_on_top(true);
        let _ = win.show();
    }
}

/// Show a copy notification if the user has the feature enabled
/// and copy operations are not muted.
pub(crate) fn notify_if_enabled(app: &tauri::AppHandle, entry: &ClipboardEntry) {
    let state = app.state::<AppState>();
    if !state.copy_notification.load(Ordering::Relaxed) {
        return;
    }
    if state.notif_copy.load(Ordering::Relaxed) {
        show_copy_notification(app, entry);
    }
}
