//! Notification centre - the one place the app tells the user something
//! happened, whoever raised it.
//!
//! The store is a durable record of *what the user was told*, not a second copy
//! of the thing itself. An invite lives on the server and can be answered from
//! another device; the notification only remembers that this device surfaced
//! it, and is reconciled against the server's list (see
//! [`commands::notifications_refresh`]) rather than trusted on its own.

pub mod commands;
pub mod store;

pub use store::{Notification, NotificationKind, NotificationStore};

use tauri::Manager;

/// Raise a notification from anywhere in the app.
///
/// Idempotent on the notification's id, so a source that can fire the same
/// event twice - a reconnect replaying it, a retry - does not stack rows.
pub fn raise(app: &tauri::AppHandle, notification: Notification) {
    let changed = app
        .state::<crate::state::AppState>()
        .notifications
        .lock()
        .upsert(notification);
    commands::commit(app, changed);
}

/// Raise a rolling summary, where new text means a new event. See
/// [`NotificationStore::announce`].
pub fn raise_rolling(app: &tauri::AppHandle, notification: Notification) {
    let changed = app
        .state::<crate::state::AppState>()
        .notifications
        .lock()
        .announce(notification);
    commands::commit(app, changed);
}
