//! Desktop notifications - the Windows/Linux toast, not the app's own popup.
//!
//! Two different things wear the word "notification" in this app. The popup in
//! `runtime::notifications` is ours: a small window we draw, for copy and paste.
//! This is the operating system's, and it is only ever used for something that
//! already earned a row in the notification centre.
//!
//! **Only when the app is not focused.** A toast for something the user is
//! looking at is the same sentence twice, and that is what makes a notification
//! feel like spam rather than help. Hidden to the tray, behind another window,
//! on another workspace - those are the cases worth interrupting for.

use std::sync::atomic::Ordering;

use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

/// Show `title` / `body` as a desktop notification, if this is a moment for one.
///
/// Silent about failure on purpose: the row is already in the feed, so a toast
/// that could not be shown has cost the user nothing.
pub fn show(app: &tauri::AppHandle, title: &str, body: &str) {
    if !app
        .state::<crate::state::AppState>()
        .os_notifications
        .load(Ordering::Relaxed)
    {
        return;
    }
    if main_window_has_focus(app) {
        return;
    }
    let mut builder = app.notification().builder().title(title);
    if !body.is_empty() {
        builder = builder.body(body);
    }
    if let Err(e) = builder.show() {
        eprintln!("[os-notify] {e}");
    }
}

/// Whether the user is currently looking at us.
///
/// A window that is hidden reports no focus, which is the answer we want, so the
/// two checks collapse into one. An error from either question is read as "not
/// focused": the cost of a toast the user did not need is lower than silently
/// dropping the only sign that something happened.
fn main_window_has_focus(app: &tauri::AppHandle) -> bool {
    let Some(win) = app.get_webview_window("main") else {
        return false;
    };
    win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false)
}
