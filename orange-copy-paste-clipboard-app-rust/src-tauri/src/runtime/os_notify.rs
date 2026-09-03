//! Desktop notifications - the Windows/Linux toast, not the app's own popup.
//!
//! Two different things wear the word "notification" in this app. The popup in
//! `runtime::notifications` is ours: a small window we draw, for copy and paste.
//! This is the operating system's, and it is only ever used for something that
//! already earned a row in the notification centre.
//!
//! **When the user is not already looking at it.** A toast for something on the
//! screen in front of you is the same sentence twice, and that is what makes a
//! notification feel like spam. For most rows "looking at it" just means the app
//! has focus. Space activity is the exception: a comment or invite is about one
//! space, and a user typing in a different space - or on the clipboard screen -
//! is not looking at it, so those toast even with the app focused, and fall
//! silent only while that exact space is open.

use std::sync::atomic::Ordering;

use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

use crate::notifications::NotificationKind;

/// Show `title` / `body` as a desktop notification, if this is a moment for one.
///
/// `kind` and `space_id` decide what "the user is already looking at this" means
/// for this row - see the module docs. Silent about failure on purpose: the row
/// is already in the feed, so a toast that could not be shown has cost nothing.
pub fn show(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
    kind: NotificationKind,
    space_id: Option<&str>,
) {
    if !app
        .state::<crate::state::AppState>()
        .os_notifications
        .load(Ordering::Relaxed)
    {
        return;
    }
    if already_seeing_it(app, kind, space_id) {
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

/// Whether a toast for this row would only repeat what the user is already
/// looking at.
///
/// Space activity (a comment, an invite, a join request) is about one space, so
/// it is "already seen" only while that exact space is open and focused - not
/// merely because the app has focus. Every other row falls back to plain focus:
/// an announcement or a sync warning is not tied to a screen.
fn already_seeing_it(app: &tauri::AppHandle, kind: NotificationKind, space_id: Option<&str>) -> bool {
    let focused = main_window_has_focus(app);
    let about_a_space = matches!(
        kind,
        NotificationKind::SpaceInvite | NotificationKind::SpaceActivity
    );
    if !about_a_space {
        return focused;
    }
    // Unfocused: not looking at anything, so never suppressed. Focused: suppress
    // only when the open space is the one this row is about.
    if !focused {
        return false;
    }
    let state = app.state::<crate::state::AppState>();
    let view = state.ui_view.lock();
    view.screen == "spaces" && view.space_id.as_deref() == space_id && space_id.is_some()
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
