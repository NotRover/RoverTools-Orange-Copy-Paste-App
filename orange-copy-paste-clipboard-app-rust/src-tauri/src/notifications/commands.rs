//! Tauri commands for the notification centre.
//!
//! Everything that mutates the store goes through [`commit`], which persists,
//! emits `notifications:changed`, and lets the caller stay a one-liner. The
//! frontend never writes to the feed directly - it asks for the list, acts on a
//! row, and re-reads.

use std::sync::atomic::Ordering;

use tauri::{Emitter, Manager, State};

use crate::notifications::{Notification, NotificationKind};
use crate::state::AppState;

/// Emitted whenever the feed changes, so the sidebar badge and an open popout
/// re-read together rather than drifting apart.
const CHANGED_EVENT: &str = "notifications:changed";

/// Mark the store dirty and tell the UI, but only when something really moved.
///
/// `changed` comes from the store methods, which return false for a no-op.
/// Reconcile runs on every reconnect, so without that guard a user sitting on
/// an unchanged feed would get a write and a re-render every time the socket
/// came back.
fn commit(app: &tauri::AppHandle, changed: bool) {
    if !changed {
        return;
    }
    let state = app.state::<AppState>();
    state.notifications_dirty.store(true, Ordering::Relaxed);
    let _ = app.emit(CHANGED_EVENT, ());
}

/// The whole feed, newest first.
#[tauri::command]
pub fn notifications_list(state: State<'_, AppState>) -> Vec<Notification> {
    state.notifications.lock().all().to_vec()
}

#[tauri::command]
pub fn notifications_unread_count(state: State<'_, AppState>) -> usize {
    state.notifications.lock().unread_count()
}

#[tauri::command]
pub fn notifications_mark_read(app: tauri::AppHandle, ids: Vec<String>) {
    let changed = app.state::<AppState>().notifications.lock().mark_read(&ids);
    commit(&app, changed);
}

#[tauri::command]
pub fn notifications_mark_all_read(app: tauri::AppHandle) {
    let changed = app.state::<AppState>().notifications.lock().mark_all_read();
    commit(&app, changed);
}

#[tauri::command]
pub fn notifications_dismiss(app: tauri::AppHandle, id: String) {
    let changed = app.state::<AppState>().notifications.lock().dismiss(&id);
    commit(&app, changed);
}

/// Clear everything already read, leaving unread items in place.
#[tauri::command]
pub fn notifications_clear_read(app: tauri::AppHandle) {
    let changed = app.state::<AppState>().notifications.lock().clear_read();
    commit(&app, changed);
}

/// Bring the feed in line with the server.
///
/// Invites are the server's record, not ours: one can be accepted on a phone,
/// revoked by the sender, or expire while this device was closed. So rather
/// than trusting what was stored, every refresh re-reads the list and retires
/// the rows that are no longer pending. Signed out, this is a no-op - the feed
/// stays as the last sign-in left it instead of being emptied by a network
/// state.
#[tauri::command]
pub async fn notifications_refresh(app: tauri::AppHandle) -> Result<(), String> {
    let http = {
        let state = app.state::<AppState>();
        let client = state.sync_client.lock().clone();
        match client.and_then(|c| c.http()) {
            Some(http) => http,
            None => return Ok(()),
        }
    };
    let invites = http.list_invites().await?;
    let mut changed = false;
    {
        let state = app.state::<AppState>();
        let mut store = state.notifications.lock();
        for invite in &invites.received {
            let id = format!("invite:{}", invite.id);
            match invite.status.as_str() {
                "pending" => {
                    let mut n = Notification::new(
                        id,
                        NotificationKind::SpaceInvite,
                        format!("{} invited you to {}", invite.inviter_name, invite.space_name),
                    )
                    .with_data("invite_id", invite.id.clone())
                    .with_data("space_id", invite.space_id.clone())
                    .with_data("space_name", invite.space_name.clone());
                    // Invites arrive with the server's own timestamp, so a
                    // catch-up after days offline files them under the day they
                    // were sent rather than bunching them all under "Today".
                    n.created_at = invite.created_at;
                    changed |= store.upsert(n);
                }
                // Answered or withdrawn: keep the row as history if we already
                // showed it, and never introduce one for an invite the user was
                // never told about.
                other => {
                    let outcome = match other {
                        "accepted" => "Joined",
                        "declined" => "Declined",
                        _ => "No longer available",
                    };
                    changed |= store.resolve(&id, outcome);
                }
            }
        }
    }
    commit(&app, changed);
    Ok(())
}
