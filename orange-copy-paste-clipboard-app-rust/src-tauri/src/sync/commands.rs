//! Tauri command handlers for cloud sync.
//!
//! Commands that perform network I/O are declared `async` so they run on
//! Tauri's internal async runtime without blocking the UI thread.
//! Fire-and-forget operations (on_new_entry hooks) are sync — they just
//! spawn tasks on the sync module's dedicated background runtime.

use std::sync::Arc;

use tauri::{Emitter, Manager, State};

use crate::state::AppState;
use crate::sync::client::{CreateSpaceRequest, JoinSpaceRequest};
use crate::sync::config::SyncConfig;
use crate::sync::crypto;
use crate::sync::types::{
    SendFilter, Space, SpaceComment, SpaceCommentCount, SyncDevice, SyncMode, SyncQuota,
    SyncStatusInfo, SyncUser,
};
use crate::sync::SyncClient;

// ── Helpers ──────────────────────────────────────────────────────────

fn sync_client(state: &State<'_, AppState>) -> Result<Arc<SyncClient>, String> {
    state
        .sync_client
        .lock()
        .clone()
        .ok_or_else(|| "sync not enabled".into())
}

/// Get the `SyncClient`, creating one if this is the first auth attempt (a
/// login can happen before sync was ever enabled in settings).
///
/// The lock is held across construction on purpose. Releasing it to build the
/// client leaves a window where two commands — startup session restore and a
/// sign-in click, say — each build one and the second replaces the first. That
/// discarded client is then dropped by whichever of its own worker threads holds
/// the last reference, which used to abort the process. `SyncClient::new` is
/// synchronous and only builds a runtime, so nothing can await while we hold it.
fn get_or_create_client(
    state: &State<'_, AppState>,
    app: &tauri::AppHandle,
) -> Result<Arc<SyncClient>, String> {
    let mut guard = state.sync_client.lock();
    if let Some(existing) = guard.clone() {
        return Ok(existing);
    }
    let client = Arc::new(SyncClient::new(app.clone(), SyncConfig::load(app))?);
    // Both loops need the Arc (they hold a Weak), so they start here rather
    // than inside `new`.
    client.spawn_passive_pull_loop();
    client.spawn_reminder_loop();
    *guard = Some(Arc::clone(&client));
    Ok(client)
}

/// Resolve both the SyncClient and its authenticated HTTP client, or fail
/// with the same errors the individual lookups produced.
fn sync_http(
    state: &State<'_, AppState>,
) -> Result<(Arc<SyncClient>, Arc<crate::sync::client::SyncHttpClient>), String> {
    let sync = sync_client(state)?;
    let http = sync.http().ok_or("not authenticated")?;
    Ok((sync, http))
}

/// Read-modify-write `settings.json` under app_data.
fn update_settings(
    app: &tauri::AppHandle,
    f: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>),
) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let path = dir.join("settings.json");
    // Read-modify-write, so a read that failed must not become an empty map:
    // writing that back erases every preference in the file, sync_enabled
    // included, which is a sign-out the user never asked for and cannot undo.
    // Only a genuinely absent file starts from empty.
    let mut map = match crate::settings_file::read_map(&path) {
        Ok(map) => map,
        Err(crate::settings_file::ReadError::Absent) => crate::settings_file::Map::new(),
        Err(crate::settings_file::ReadError::Unreadable(e))
        | Err(crate::settings_file::ReadError::Malformed(e)) => {
            crate::health::note(
                "settings write skipped: settings.json could not be read",
                &format!("{e} - refusing to overwrite it with a blank file"),
            );
            return;
        }
    };
    f(&mut map);
    if let Ok(json) = serde_json::to_string_pretty(&map) {
        // Read-modify-write of the whole settings file: a truncated write here
        // silently resets preferences, so replace it atomically.
        let _ = crate::health::write_atomic(&path, json.as_bytes());
    }
}

fn write_setting(app: &tauri::AppHandle, key: &str, value: serde_json::Value) {
    update_settings(app, |map| {
        map.insert(key.to_string(), value);
    });
}

// ── Auth commands ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn sync_login(
    email: String,
    password: String,
    device_name: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SyncUser, String> {
    // Ensure a SyncClient exists (create one on first login even if sync was
    // not yet enabled in settings).
    let sync = get_or_create_client(&state, &app)?;

    // Supabase login → bootstrap → device registration, all inside the client.
    let user = sync.perform_login(email, password, device_name).await?;
    // Catch up on entries created elsewhere, in the background.
    Arc::clone(&sync).trigger_initial_sync();
    Ok(user)
}

#[tauri::command]
pub async fn sync_signup(
    email: String,
    password: String,
    device_name: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SyncUser, String> {
    let sync = get_or_create_client(&state, &app)?;

    // Supabase signup → (if confirmed) bootstrap → device registration.
    let user = sync.perform_signup(email, password, device_name).await?;
    Arc::clone(&sync).trigger_initial_sync();
    Ok(user)
}

/// Phase 1 of OAuth sign-in (e.g. Google): runs the browser handshake and
/// returns whether the user must create or enter their account password.
#[tauri::command]
pub async fn sync_oauth_begin(
    provider: String,
    device_name: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<crate::sync::OAuthBegin, String> {
    let sync = get_or_create_client(&state, &app)?;
    sync.begin_oauth(provider, device_name).await
}

/// Phase 2 of OAuth sign-in: finalize the stashed session with the account
/// password (the E2E secret).
#[tauri::command]
pub async fn sync_oauth_complete(
    password: String,
    state: State<'_, AppState>,
) -> Result<SyncUser, String> {
    let sync = sync_client(&state)?;
    let user = sync.complete_oauth(password).await?;
    Arc::clone(&sync).trigger_initial_sync();
    Ok(user)
}

/// The OAuth attempt already waiting on a password, if the browser handshake
/// landed while the sign-in screen was not mounted.
#[tauri::command]
pub fn sync_oauth_pending(
    state: State<'_, AppState>,
) -> Result<Option<crate::sync::OAuthBegin>, String> {
    let sync = state.sync_client.lock().clone();
    Ok(sync.and_then(|s| s.pending_oauth()))
}

/// Discard a stashed OAuth session when the user backs out of the password step.
#[tauri::command]
pub fn sync_oauth_cancel(state: State<'_, AppState>) -> Result<(), String> {
    let sync = state.sync_client.lock().clone();
    if let Some(sync) = sync {
        sync.cancel_oauth();
    }
    Ok(())
}

/// Send a password-reset email via Supabase.
#[tauri::command]
pub async fn sync_reset_password(
    email: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let sync = get_or_create_client(&state, &app)?;
    sync.reset_password(email).await
}

/// Silently restore the previous session (refresh token + device-wrapped UMK).
/// Called once on app startup; returns null when there's nothing to restore so
/// the UI can show the login screen without an error.
#[tauri::command]
pub async fn sync_restore_session(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Option<SyncUser>, String> {
    let config = SyncConfig::load(&app);
    if !config.enabled || !config.is_configured() {
        return Ok(None);
    }
    let sync = get_or_create_client(&state, &app)?;
    match sync.try_restore_session().await {
        Ok(user) => {
            Arc::clone(&sync).trigger_initial_sync();
            let _ = app.emit("sync:session-restored", &user);
            Ok(Some(user))
        }
        Err(e) if e.is_transient() => {
            // The stored credentials are still good, we just could not reach
            // the server yet — very common right after an update, when the app
            // autostarts before the network is back. Keep trying in the
            // background instead of making the user log in again; the UI shows
            // the login screen meanwhile and swaps over on
            // `sync:session-restored`.
            eprintln!("[sync] session restore deferred, will retry: {e}");
            Arc::clone(&sync).spawn_session_restore_retry();
            Ok(None)
        }
        Err(e) => {
            // Expected on first run / after logout, and the UI just shows the
            // login screen. A `Terminal` failure is different: the app had a
            // session and decided it was dead, which is the sign-out the user
            // sees. Record that one durably - a release build prints nowhere, so
            // this is the only way to tell a revoked device from an empty
            // keychain after the fact.
            eprintln!("[sync] session restore skipped: {e}");
            if let crate::sync::RestoreError::Terminal(reason) = &e {
                crate::health::note("sync restore: credentials rejected", reason);
            }
            Ok(None)
        }
    }
}

#[tauri::command]
pub async fn sync_logout(
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sync = state.sync_client.lock().clone();
    if let Some(sync) = sync {
        sync.logout();
    }
    Ok(())
}

#[tauri::command]
pub fn sync_get_user(state: State<'_, AppState>) -> Option<SyncUser> {
    state
        .sync_client
        .lock()
        .as_ref()
        .and_then(|s| s.current_user())
}

// ── Status & control ─────────────────────────────────────────────────

#[tauri::command]
pub fn sync_get_status(state: State<'_, AppState>) -> SyncStatusInfo {
    state
        .sync_client
        .lock()
        .as_ref()
        .map(|s| s.status_info())
        .unwrap_or_default()
}

/// Per-entry sync state (`"synced"` | `"pending"`), keyed `"clipboard:{id}"` /
/// `"note:{id}"`.  Entry cards read the cloud badge from this: the state is
/// sync bookkeeping and is deliberately not persisted in the entry itself.
#[tauri::command]
pub fn sync_get_entry_states(
    state: State<'_, AppState>,
) -> std::collections::HashMap<String, String> {
    state
        .sync_client
        .lock()
        .as_ref()
        .map(|s| {
            s.entry_states()
                .into_iter()
                .map(|(k, v)| (k, v.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Which shared spaces each entry belongs to, keyed `"clipboard:{id}"` /
/// `"note:{id}"` with server group ids as values.  The Sync screen joins this
/// against its feed; entries themselves only carry user-chosen group names.
#[tauri::command]
pub fn sync_get_entry_shares(
    state: State<'_, AppState>,
) -> std::collections::HashMap<String, Vec<String>> {
    state
        .sync_client
        .lock()
        .as_ref()
        .map(|s| s.entry_shares())
        .unwrap_or_default()
}

/// Which account wrote each entry, keyed like `sync_get_entry_shares`.  Only
/// entries received from another member appear; the Spaces feed resolves the
/// id against the space's member list to name and picture the sender.
#[tauri::command]
pub fn sync_get_entry_owners(
    state: State<'_, AppState>,
) -> std::collections::HashMap<String, String> {
    state
        .sync_client
        .lock()
        .as_ref()
        .map(|s| s.entry_owners())
        .unwrap_or_default()
}

/// Items removed from a space, keyed like `sync_get_entry_shares`.  The Spaces
/// feed renders these as placeholders so a removal is visible rather than a row
/// quietly disappearing.
#[tauri::command]
pub fn sync_get_deleted_markers(
    state: State<'_, AppState>,
) -> std::collections::HashMap<String, crate::sync::id_map::DeletedMarker> {
    state
        .sync_client
        .lock()
        .as_ref()
        .map(|s| s.deleted_markers())
        .unwrap_or_default()
}

/// Drop the placeholders for one space.  They are a record of what went, not a
/// queue, so clearing them loses nothing — but the items stay gone, because the
/// markers also stop a pull re-merging what this device removed.
#[tauri::command]
pub fn space_clear_removed(space_id: String, state: State<'_, AppState>) -> usize {
    state
        .sync_client
        .lock()
        .as_ref()
        .map(|s| s.clear_removed_in_space(&space_id))
        .unwrap_or(0)
}

/// Entry keys (`"clipboard:{id}"` / `"note:{id}"`) another member wrote.  The
/// Spaces screen marks these as coming in and everything else as going out.
#[tauri::command]
pub fn sync_get_remote_entries(state: State<'_, AppState>) -> Vec<String> {
    state
        .sync_client
        .lock()
        .as_ref()
        .map(|s| s.remote_entries())
        .unwrap_or_default()
}

/// Dismiss the list of skipped entries once the user has read it.  Skips are a
/// report on past pushes, not a queue — nothing is retried or lost by clearing.
#[tauri::command]
pub fn sync_clear_skipped(state: State<'_, AppState>) {
    if let Some(sync) = state.sync_client.lock().as_ref() {
        sync.clear_skipped();
    }
}

/// Push the skipped entries again. A skip is a dead end - nothing queues it -
/// so an entry that failed for a reason since fixed (an expired session, a
/// rejected blob upload) needs this to ever reach the server. Returns how many
/// entries were found and re-pushed; the ones that fail again record a fresh
/// skip, which is why the old list is dropped first.
#[tauri::command]
pub fn sync_retry_skipped(state: State<'_, AppState>) -> Result<usize, String> {
    let sync = sync_client(&state)?;
    let skipped = sync.skipped();
    sync.clear_skipped();
    // The user may have freed space since these were refused.
    sync.invalidate_blob_budget();

    let mut retried = 0;
    for skip in skipped {
        let entry = state
            .history
            .lock()
            .all()
            .iter()
            .find(|e| e.id == skip.client_id)
            .cloned();
        if let Some(entry) = entry {
            sync.on_manual_push_clipboard_entry(entry);
            retried += 1;
            continue;
        }
        let note = state
            .notes
            .lock()
            .all()
            .iter()
            .find(|n| n.id == skip.client_id)
            .cloned();
        if let Some(note) = note {
            sync.on_manual_push_note(note);
            retried += 1;
        }
        // Neither: the entry was deleted after it was skipped. Nothing to do.
    }
    Ok(retried)
}

/// Push every local item the server has never seen. Sync only ever picks up
/// items as they are created, so anything captured before signing in (or while
/// sync was off) stays local forever without this. Already-synced items are
/// left alone.
///
/// Returns the id_map keys it started a push for, not a count: each push is an
/// independent background task, so the only way the UI can show progress is to
/// watch these keys land in [`sync_settled_count`].
#[tauri::command]
pub fn sync_push_unsynced(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let sync = sync_client(&state)?;
    sync.invalidate_blob_budget();
    let known = sync.entry_states();

    let entries: Vec<_> = state
        .history
        .lock()
        .all()
        .iter()
        .filter(|e| !known.contains_key(&format!("clipboard:{}", e.id)))
        .cloned()
        .collect();
    let notes: Vec<_> = state
        .notes
        .lock()
        .all()
        .iter()
        .filter(|n| !known.contains_key(&format!("note:{}", n.id)))
        .cloned()
        .collect();

    let mut keys = Vec::with_capacity(entries.len() + notes.len());
    for entry in entries {
        keys.push(format!("clipboard:{}", entry.id));
        sync.on_manual_push_clipboard_entry(entry);
    }
    for note in notes {
        keys.push(format!("note:{}", note.id));
        sync.on_manual_push_note(note);
    }
    Ok(keys)
}

/// What a bulk upload would cost, checked before anything is sent.
#[derive(serde::Serialize)]
pub struct UnsyncedPreview {
    /// Items the server has never seen.
    pub total: usize,
    /// How many of those are images, i.e. need blob storage.
    pub images: usize,
    /// What those images will occupy once encrypted.
    pub image_bytes: u64,
    /// Storage still available, from a fresh quota check.
    pub free_bytes: u64,
    /// How many images fit in what is free, filled in push order.
    pub images_that_fit: usize,
}

/// Cloud storage one image will occupy: the file on disk (or the decoded
/// length of an inline data URL) plus AES-GCM's nonce and tag.
fn image_upload_size(content: &str) -> u64 {
    const GCM_OVERHEAD: u64 = 12 + 16;
    let raw = if let Some(pos) = content.find(";base64,") {
        // 4 base64 chars carry 3 bytes; padding makes this a slight over-count,
        // which is the right direction for a budget check.
        (content.len() - pos - 8) as u64 * 3 / 4
    } else {
        std::fs::metadata(content).map(|m| m.len()).unwrap_or(0)
    };
    raw + GCM_OVERHEAD
}

/// Measure a bulk upload before starting it.
///
/// Images are externalized to disk, so this is one `stat` each - no reading and
/// no encrypting. Worth doing: without it an account that is out of room finds
/// out one refusal at a time, and the user reads a list of failures instead of
/// a sentence they could have acted on.
#[tauri::command]
pub async fn sync_preview_unsynced(state: State<'_, AppState>) -> Result<UnsyncedPreview, String> {
    let (sync, http) = sync_http(&state)?;
    let known = sync.entry_states();

    // Sizes first, so no store lock is held across the quota request.
    let image_sizes: Vec<u64> = {
        let history = state.history.lock();
        history
            .all()
            .iter()
            .filter(|e| !known.contains_key(&format!("clipboard:{}", e.id)))
            .filter(|e| e.kind == crate::clipboard::history::EntryKind::Image)
            .map(|e| image_upload_size(&e.content))
            .collect()
    };
    let clipboard_total = state
        .history
        .lock()
        .all()
        .iter()
        .filter(|e| !known.contains_key(&format!("clipboard:{}", e.id)))
        .count();
    let notes_total = state
        .notes
        .lock()
        .all()
        .iter()
        .filter(|n| !known.contains_key(&format!("note:{}", n.id)))
        .count();

    let quota = http.blob_quota().await?;
    sync.set_blob_budget(quota.used_bytes, quota.quota_bytes);
    let free_bytes = quota.quota_bytes.saturating_sub(quota.used_bytes);

    let mut spent = 0u64;
    let mut images_that_fit = 0usize;
    for size in &image_sizes {
        if spent + size > free_bytes {
            break;
        }
        spent += size;
        images_that_fit += 1;
    }

    Ok(UnsyncedPreview {
        total: clipboard_total + notes_total,
        images: image_sizes.len(),
        image_bytes: image_sizes.iter().sum(),
        free_bytes,
        images_that_fit,
    })
}

/// Push the named local items, whether or not they have been pushed before.
/// The bulk bar's "Upload" action - `sync_push_unsynced` for a chosen set.
#[tauri::command]
pub fn sync_push_entries(
    client_ids: Vec<String>,
    entry_type: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let sync = sync_client(&state)?;
    let mut pushed = 0;
    for id in client_ids {
        // Not ours to publish; the push would be dropped anyway.
        if sync.is_remote_entry(&entry_type, &id) {
            continue;
        }
        if entry_type == "note" {
            let note = state.notes.lock().all().iter().find(|n| n.id == id).cloned();
            if let Some(note) = note {
                sync.on_manual_push_note(note);
                pushed += 1;
            }
        } else {
            let entry = state
                .history
                .lock()
                .all()
                .iter()
                .find(|e| e.id == id)
                .cloned();
            if let Some(entry) = entry {
                sync.on_manual_push_clipboard_entry(entry);
                pushed += 1;
            }
        }
    }
    Ok(pushed)
}

/// Take the named items off the server, keeping the local copies. This is the
/// delete path, so it is a tombstone: the items also disappear from your other
/// devices and from any space they were shared into. Only this device keeps
/// them, which is the whole point of the action.
#[tauri::command]
pub fn sync_unpush_entries(
    client_ids: Vec<String>,
    entry_type: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let sync = sync_client(&state)?;
    // Entries another member wrote have no server copy of ours to take down,
    // so they are skipped rather than counted - the caller reports this number
    // back to the user, and counting the whole request claimed removals that
    // never happened.
    let mut count = 0usize;
    for id in client_ids {
        if sync.is_remote_entry(&entry_type, &id) {
            continue;
        }
        count += 1;
        if entry_type == "note" {
            sync.on_delete_note(id);
        } else {
            sync.on_delete_clipboard_entry(id);
        }
    }
    Ok(count)
}

/// Take everything this account has off the server, keeping the local copies.
/// Same tombstone semantics as [`sync_unpush_entries`].
///
/// The list comes from the server, not from this device's records, so rows
/// another device pushed are removed too — otherwise they sat there unreachable
/// and, for images, went on using storage after the account looked empty. If
/// the server cannot be reached the local records are used instead, which is
/// still better than doing nothing.
///
/// Returns the keys it tombstoned, so the UI can follow them out of
/// [`sync_settled_count`] the same way an upload follows keys in.
#[tauri::command]
pub async fn sync_unpush_all(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let sync = sync_client(&state)?;
    let mut keys: Vec<String> = sync.entry_states().into_keys().collect();
    if let Ok(remote) = sync.server_entry_keys().await {
        for key in remote {
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    for key in &keys {
        let Some((kind, id)) = key.split_once(':') else {
            continue;
        };
        if kind == "note" {
            sync.on_delete_note(id.to_string());
        } else {
            sync.on_delete_clipboard_entry(id.to_string());
        }
    }
    Ok(keys)
}

/// How many entries this account still has on the server.
///
/// Checked after a bulk removal rather than trusted: the removal used to work
/// off this device's own records, so rows another device pushed were left
/// behind while the UI reported everything gone - an image row went on using
/// storage with nothing to show for it. Asking the server closes that gap for
/// good, whatever the local records happen to say.
#[tauri::command]
pub async fn sync_server_entry_count(state: State<'_, AppState>) -> Result<usize, String> {
    let sync = sync_client(&state)?;
    Ok(sync.server_entry_keys().await?.len())
}

/// The same account-wide sweep, split by what the entries are.
#[derive(serde::Serialize)]
pub struct ServerBreakdown {
    pub clipboard: usize,
    pub notes: usize,
    pub total: usize,
}

/// What this account holds on the server, by kind.
///
/// Built on `server_entry_keys` rather than a second sweep: those keys already
/// carry the kind (`"clipboard:{id}"` / `"note:{id}"`), so the split costs one
/// pass over a list that had to be fetched anyway. The account screen shows
/// clipboard and notes on their own rows, and a single total could not say
/// which of the two an unexpected number came from.
#[tauri::command]
pub async fn sync_server_breakdown(
    state: State<'_, AppState>,
) -> Result<ServerBreakdown, String> {
    let sync = sync_client(&state)?;
    let keys = sync.server_entry_keys().await?;
    let notes = keys.iter().filter(|k| k.starts_with("note:")).count();
    Ok(ServerBreakdown {
        clipboard: keys.len() - notes,
        notes,
        total: keys.len(),
    })
}

/// Where a bulk upload or removal has got to.
#[derive(serde::Serialize)]
pub struct BulkProgressOut {
    /// How many of the asked-about keys the server has acknowledged.
    pub settled: usize,
    /// How many are still known to sync at all - acknowledged, queued, or being
    /// pushed right now. This, not `settled`, is what a removal counts down:
    /// "not acknowledged" also describes a tombstone that has not gone out yet,
    /// and a row this device has no local record of would otherwise read as
    /// already removed on the first poll.
    pub present: usize,
    /// How many were refused and will never arrive without a manual retry.
    pub failed: usize,
    /// Pushes talking to the server right now, across the whole app.
    pub in_flight: usize,
}

/// Progress of a bulk upload or removal. Both are fan-outs of independent
/// background tasks with no completion signal of their own, so the UI polls
/// this: an upload watches `settled` rise to the total, a removal watches
/// `present` fall to zero.
///
/// `in_flight` is what keeps the UI honest. A batch of large images can go a
/// long time without a single one finishing, which looks identical to a stall
/// from the outside - and calling that a failure while the upload is still
/// running is worse than saying nothing.
#[tauri::command]
pub fn sync_bulk_progress(keys: Vec<String>, state: State<'_, AppState>) -> BulkProgressOut {
    let guard = state.sync_client.lock();
    let Some(sync) = guard.as_ref() else {
        return BulkProgressOut { settled: 0, present: 0, failed: 0, in_flight: 0 };
    };
    let states = sync.entry_states();
    let refused: std::collections::HashSet<String> =
        sync.skipped().into_iter().map(|s| s.client_id).collect();
    let settled = keys
        .iter()
        .filter(|k| states.get(*k).is_some_and(|s| *s == "synced"))
        .count();
    let present = keys.iter().filter(|k| states.contains_key(*k)).count();
    let failed = keys
        .iter()
        .filter(|k| {
            k.split_once(':')
                .is_some_and(|(_, id)| refused.contains(id))
        })
        .count();
    BulkProgressOut {
        settled,
        present,
        failed,
        in_flight: sync.pushes_in_flight(),
    }
}

#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>) -> Result<(), String> {
    let sync = sync_client(&state)?;
    sync.flush_and_pull().await
}

#[tauri::command]
pub fn sync_set_enabled(
    enabled: bool,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    write_setting(&app, "sync_enabled", serde_json::Value::Bool(enabled));

    if enabled {
        get_or_create_client(&state, &app)?;
    } else {
        // Log out while still holding our own reference, then release it. The
        // client's runtime is shut down without blocking by its Drop impl, so it
        // no longer matters which thread happens to release the last Arc.
        let previous = state.sync_client.lock().take();
        if let Some(sync) = previous {
            sync.logout();
        }
    }

    Ok(())
}

// ── Connection configuration ──────────────────────────────────────────

/// Whether this build knows which deployment to talk to.
///
/// Endpoints are compiled in (see the `DEFAULT_*` constants in `sync/config.rs`)
/// so a shipped app needs no setup. This exists purely so the sign-in screen can
/// say "not configured" instead of failing silently on a build without them.
/// The endpoint values themselves are deliberately not exposed to the UI.
#[derive(serde::Serialize)]
pub struct SyncConnection {
    pub configured: bool,
}

// Async so the settings read lands on a worker: this is called from the Account
// screen's mount effect, and a non-async command runs on the UI thread.
#[tauri::command]
pub async fn sync_get_connection(app: tauri::AppHandle) -> SyncConnection {
    SyncConnection {
        configured: SyncConfig::load(&app).is_configured(),
    }
}

// ── Settings sync ─────────────────────────────────────────────────────

/// Called by React in response to the `sync:collect-settings` event.
/// Stores the localStorage values for inclusion in the next settings push.
#[tauri::command]
pub fn sync_receive_local_settings(
    json: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sync = sync_client(&state)?;
    sync.store_local_settings_payload(json);
    Ok(())
}

// ── Spaces ────────────────────────────────────────────────────────────

/// Fetch the user's spaces from the server, recovering (or, for owners,
/// minting and distributing) space keyrings on the way.  Use on screen mount;
/// this is the source of truth the cached list mirrors.
#[tauri::command]
pub async fn spaces_list(state: State<'_, AppState>) -> Result<Vec<Space>, String> {
    let sync = sync_client(&state)?;
    Ok(sync.reconcile_spaces().await)
}

/// The cached space list — no network, no key work.  Presence events only move
/// a dot, so the UI re-reads this instead of paying for a reconcile.
#[tauri::command]
pub fn spaces_cached(state: State<'_, AppState>) -> Vec<Space> {
    state
        .sync_client
        .lock()
        .as_ref()
        .map(|s| s.spaces())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn space_create(
    name: String,
    share_history: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Space, String> {
    let (sync, http) = sync_http(&state)?;
    let share_history = share_history.unwrap_or(true);
    let created = http
        .create_space(CreateSpaceRequest {
            name: name.clone(),
            share_history,
        })
        .await?;
    // Mint and distribute the Space Key now, so the first entry shared into
    // this space encrypts under it instead of silently staying personal.
    sync.reconcile_spaces().await;
    // Creator is the sole member at this point; surface the invite code so the
    // UI can share it.
    let me = sync.current_user().map(|u| u.user_id).unwrap_or_default();
    Ok(Space {
        id: created.space_id,
        name,
        owner_id: me,
        is_owner: true,
        share_history,
        member_count: 1,
        members: Vec::new(),
        invite_code: Some(created.invite_code),
        invite_expires_at: None,
    })
}

#[tauri::command]
pub async fn space_join(invite_code: String, state: State<'_, AppState>) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    http.join_space(JoinSpaceRequest {
        // Tolerate pasted links and sloppy casing: the server normalizes
        // short codes, but strip an obvious `?code=`/path prefix here.
        invite_code: extract_invite_code(&invite_code),
    })
    .await?;
    // Catch up on the space's shared history in the background (the keyring
    // arrives once the owner's reconcile wraps it for us).
    let sync2 = Arc::clone(&sync);
    tauri::async_runtime::spawn(async move {
        sync2.reconcile_spaces().await;
        let _ = sync2.flush_and_pull().await;
    });
    Ok(())
}

/// Pull the code out of a pasted invite link (`…?code=KX7Q-2M4X` or a bare
/// code, dashed or not). Server-side normalization handles case/dashes.
fn extract_invite_code(input: &str) -> String {
    let trimmed = input.trim();
    if let Some(pos) = trimmed.find("code=") {
        let rest = &trimmed[pos + 5..];
        return rest.split(&['&', '#'][..]).next().unwrap_or(rest).to_string();
    }
    trimmed.rsplit('/').next().unwrap_or(trimmed).to_string()
}

#[tauri::command]
pub async fn space_leave(space_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    let user_id = sync
        .current_user()
        .map(|u| u.user_id)
        .ok_or("not authenticated")?;
    // Self-removal (the owner dissolves the space with space_delete instead).
    http.remove_space_member(&space_id, &user_id).await?;
    Ok(())
}

/// Set which spaces an entry is shared into — the explicit share gesture.
/// The recorded list is authoritative from here on (filters no longer apply
/// to this entry), and the entry is re-pushed so the new envelope reaches the
/// server: added spaces gain a wrapped key, removed ones lose theirs.
/// Un-sharing is best-effort like all revocation — members who already pulled
/// the entry keep what they saw.
#[tauri::command]
pub fn space_set_entry_shares(
    entry_id: String,
    entry_type: String,
    space_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if entry_type != "clipboard" && entry_type != "note" {
        return Err(format!("unknown entry type: {entry_type}"));
    }
    let sync = sync_client(&state)?;
    let key = format!("{entry_type}:{entry_id}");
    // Spaces this gesture takes the entry out of. Each one keeps a placeholder,
    // so the feed there says the item was pulled back rather than losing the
    // row without a word.
    let dropped: Vec<String> = {
        let mut id_map = sync.id_map.lock();
        let dropped: Vec<String> = id_map
            .shares_for(&key)
            .into_iter()
            .filter(|s| !space_ids.contains(s))
            .collect();
        id_map.set_entry_shares(&key, &space_ids);
        dropped
    };
    if !dropped.is_empty() {
        sync.mark_unshared(&key, dropped);
    }

    // Re-push with the new share set (the push path reads the record above).
    if entry_type == "note" {
        let note = state
            .notes
            .lock()
            .all()
            .iter()
            .find(|n| n.id == entry_id)
            .cloned()
            .ok_or("note not found")?;
        sync.on_update_note(note);
    } else {
        let entry = state
            .history
            .lock()
            .all()
            .iter()
            .find(|e| e.id == entry_id)
            .cloned()
            .ok_or("entry not found")?;
        sync.on_update_clipboard_entry(entry);
    }
    Ok(())
}

/// Per-device toggle: write incoming entries from this space straight to the
/// clipboard.  Stored in settings.json (device-local by design).
#[tauri::command]
pub fn space_set_autocopy(
    space_id: String,
    enabled: bool,
    app: tauri::AppHandle,
) -> Result<(), String> {
    write_setting(
        &app,
        &format!("space_autocopy:{space_id}"),
        serde_json::Value::Bool(enabled),
    );
    Ok(())
}

/// Update one space's send filter.  Persisted under `space_send_filters` in
/// settings.json and scheduled into the encrypted settings blob so it roams.
#[tauri::command]
pub fn space_set_send_filter(
    space_id: String,
    filter: SendFilter,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let sync = sync_client(&state)?;
    sync.set_send_filter(&space_id, filter);
    let filters = sync.send_filters();
    let value = serde_json::to_value(&filters).map_err(|e| format!("filters json: {e}"))?;
    write_setting(&app, crate::sync::SEND_FILTERS_KEY, value);
    sync.schedule_settings_push();
    Ok(())
}

/// The full send-filter map, keyed by space id (absent = explicit only).
#[tauri::command]
pub fn space_get_send_filters(
    state: State<'_, AppState>,
) -> std::collections::HashMap<String, SendFilter> {
    state
        .sync_client
        .lock()
        .as_ref()
        .map(|s| s.send_filters())
        .unwrap_or_default()
}

/// Cloud-sync mode for personal entries ("realtime" | "passive").
/// Device-local; spaces stay realtime regardless.
#[tauri::command]
pub fn sync_set_mode(
    mode: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let parsed = SyncMode::parse(&mode).ok_or_else(|| format!("unknown sync mode: {mode}"))?;
    write_setting(
        &app,
        crate::sync::SYNC_MODE_KEY,
        serde_json::Value::String(parsed.as_str().into()),
    );
    if let Some(sync) = state.sync_client.lock().as_ref() {
        sync.set_sync_mode(parsed);
    }
    Ok(())
}

#[tauri::command]
pub fn sync_get_mode(state: State<'_, AppState>) -> String {
    state
        .sync_client
        .lock()
        .as_ref()
        .map(|s| s.sync_mode())
        .unwrap_or_default()
        .as_str()
        .to_string()
}

// ── Blobs & devices ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn sync_get_quota(state: State<'_, AppState>) -> Result<SyncQuota, String> {
    let (sync, http) = sync_http(&state)?;
    let q = http.blob_quota().await?;
    // Every quota read doubles as the refill for the image-upload precheck.
    sync.set_blob_budget(q.used_bytes, q.quota_bytes);
    Ok(SyncQuota {
        used_bytes: q.used_bytes,
        quota_bytes: q.quota_bytes,
    })
}

#[tauri::command]
pub async fn sync_list_devices(state: State<'_, AppState>) -> Result<Vec<SyncDevice>, String> {
    let (sync, http) = sync_http(&state)?;
    let my_device = sync.device_id();
    let devices = http.list_devices().await?;
    Ok(devices
        .into_iter()
        .map(|d| SyncDevice {
            is_current: my_device.as_deref() == Some(d.id.as_str()),
            id: d.id,
            device_name: d.device_name,
            platform: d.platform,
            app_version: d.app_version,
            last_seen_at: d.last_seen_at,
            online: d.online,
        })
        .collect())
}

/// Remove a member from a space we own (self-removal uses space_leave).
/// The server clears every remaining member's wrapped keyring; our next
/// reconcile mints a new key the removed member never receives.
#[tauri::command]
pub async fn space_remove_member(
    space_id: String,
    member_user_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (_sync, http) = sync_http(&state)?;
    http.remove_space_member(&space_id, &member_user_id).await
}

/// Take a shared entry down from a space. The space owner can do this to any
/// entry, and anyone can do it to their own. The author keeps their personal
/// copy; every member is told to drop theirs over the space channel, and we
/// drop ours here so the action lands without a round trip.
#[tauri::command]
pub async fn space_remove_entry(
    space_id: String,
    client_id: String,
    entry_type: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    // Both paths run through here, so "did the author do this" is whether the
    // entry is ours - not simply true because we are the one clicking.
    let by_author = !sync.is_remote_entry(&entry_type, &client_id);
    http.remove_space_entry(&space_id, &client_id, &entry_type)
        .await?;
    sync.drop_space_entry(&space_id, &client_id, &entry_type, by_author);
    Ok(())
}

// ── Space comments ───────────────────────────────────────────────────

/// Post a comment on an entry shared into a space. Any member may.
///
/// `body` may carry `@[Name](user-id)` spans; they are encrypted with the rest
/// of the text, so the server never learns who was tagged.
#[tauri::command]
pub async fn space_comment_add(
    space_id: String,
    client_id: String,
    entry_type: String,
    body: String,
    state: State<'_, AppState>,
) -> Result<SpaceComment, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("Write something first".into());
    }
    let sync = sync_client(&state)?;
    sync.add_space_comment(&space_id, &client_id, &entry_type, body)
        .await
}

/// One entry's thread, oldest first.
#[tauri::command]
pub async fn space_comments_list(
    space_id: String,
    client_id: String,
    entry_type: String,
    state: State<'_, AppState>,
) -> Result<Vec<SpaceComment>, String> {
    let sync = sync_client(&state)?;
    sync.list_space_comments(&space_id, &client_id, &entry_type)
        .await
}

/// Comment tallies for every commented-on entry in a space, so the feed can
/// draw its chips in one request instead of one per card.
#[tauri::command]
pub async fn space_comment_counts(
    space_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<SpaceCommentCount>, String> {
    let sync = sync_client(&state)?;
    sync.space_comment_counts(&space_id).await
}

/// Delete a comment: its author, or the space owner as moderator. The server
/// is what enforces that; this only asks.
#[tauri::command]
pub async fn space_comment_delete(
    space_id: String,
    comment_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let sync = sync_client(&state)?;
    sync.delete_space_comment(&space_id, &comment_id).await
}

/// Delete a space we own (dissolves it for every member).
#[tauri::command]
pub async fn space_delete(space_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let (_sync, http) = sync_http(&state)?;
    http.delete_space(&space_id).await
}

/// Owner action: let (or stop letting) members read what was shared before they
/// joined. Turning it on applies to the members already here, not just the next
/// one - the server clears their history floor and tells them to go back for the
/// entries they were never served. Returns the refreshed space list.
#[tauri::command]
pub async fn space_set_share_history(
    space_id: String,
    share_history: bool,
    state: State<'_, AppState>,
) -> Result<Vec<Space>, String> {
    let (sync, http) = sync_http(&state)?;
    http.set_share_history(&space_id, share_history).await?;
    Ok(sync.reconcile_spaces().await)
}

#[tauri::command]
pub async fn sync_revoke_device(
    device_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    // Refuse to revoke the device we're running on — sign out is the way.
    if sync.device_id().as_deref() == Some(device_id.as_str()) {
        return Err("can't remove this device while signed in on it. Sign out instead".into());
    }
    http.revoke_device(&device_id).await
}

// ── Addressed invites ─────────────────────────────────────────────────

#[tauri::command]
pub async fn sync_list_invites(
    state: State<'_, AppState>,
) -> Result<crate::sync::client::InviteListResponse, String> {
    let (_sync, http) = sync_http(&state)?;
    http.list_invites().await
}

#[tauri::command]
pub async fn sync_send_invite(
    space_id: String,
    email: String,
    state: State<'_, AppState>,
) -> Result<crate::sync::client::InviteOut, String> {
    let (_sync, http) = sync_http(&state)?;
    http.send_space_invite(&space_id, &email).await
}

/// One answer, told to every surface that is showing the invite.
///
/// The invite lists on the Spaces screen and the row in the notification centre
/// used to find out separately, and only by asking the server again - so an
/// invite accepted in one of them still offered Join and Decline in the other,
/// and pressing Decline there is what produced "Invite already accepted".
/// Answering it is now what settles it, wherever the answer came from.
/// Swallow a 409 on an invite answer.
///
/// The server says 409 when the invite has already been answered - from
/// another device, or from the app's other surface a moment earlier. The user
/// asked for it to be gone and it is gone, so this is the outcome they wanted,
/// not a failure to put in front of them. The caller still settles the row, so
/// the stale buttons it was pressed on go away.
fn already_answered<T>(result: Result<T, crate::sync::client::ApiError>) -> Result<(), String> {
    match result {
        Ok(_) => Ok(()),
        Err(e) if e.status == Some(409) => Ok(()),
        Err(e) => Err(String::from(e)),
    }
}

fn settle_invite(app: &tauri::AppHandle, invite_id: &str, status: &str, outcome: &str) {
    crate::notifications::resolve(app, &format!("invite:{invite_id}"), outcome);
    let _ = app.emit(
        "sync:invite-answered",
        serde_json::json!({ "invite_id": invite_id, "status": status }),
    );
}

#[tauri::command]
pub async fn sync_accept_invite(
    invite_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    already_answered(http.accept_invite(&invite_id).await)?;
    settle_invite(&app, &invite_id, "accepted", "Joined");
    // Catch up in the background: receive the keyring once the owner wraps it,
    // then pull the space's history (subject to its share_history policy).
    let sync2 = Arc::clone(&sync);
    tauri::async_runtime::spawn(async move {
        sync2.reconcile_spaces().await;
        let _ = sync2.flush_and_pull().await;
    });
    Ok(())
}

#[tauri::command]
pub async fn sync_decline_invite(
    invite_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (_sync, http) = sync_http(&state)?;
    already_answered(http.decline_invite(&invite_id).await)?;
    settle_invite(&app, &invite_id, "declined", "Declined");
    Ok(())
}

#[tauri::command]
pub async fn sync_revoke_invite(
    invite_id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (_sync, http) = sync_http(&state)?;
    already_answered(http.revoke_invite(&invite_id).await)?;
    settle_invite(&app, &invite_id, "revoked", "Withdrawn");
    Ok(())
}

// ── Settings sync commands ────────────────────────────────────────────

/// Settings keys sourced from settings.json that participate in cloud sync.
/// `space_send_filters` rides here so filters roam across a user's devices
/// inside the encrypted blob — the server never sees the plaintext group names
/// they reference.  The auto-copy toggles and `sync_mode` are deliberately
/// absent: those are per-device choices.
const SYNCED_JSON_KEYS: &[&str] = &[
    "keep_history",
    "close_to_tray",
    "start_minimized",
    "notification",
    "notif_copy",
    "notif_paste",
    "autosave",
    crate::sync::SEND_FILTERS_KEY,
];

/// Encrypt and push merged settings (settings.json + localStorage) to the server.
/// If the server wins (its settings are newer), decrypts and emits `sync:settings`.
#[tauri::command]
pub async fn sync_push_settings(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    let umk = sync.umk_clone().ok_or("not authenticated")?;

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data: {e}"))?;

    // Build blob from settings.json
    let settings_path = app_data.join("settings.json");
    let mut blob: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    if let Ok(data) = std::fs::read_to_string(&settings_path) {
        if let Ok(map) = serde_json::from_str::<serde_json::Map<_, _>>(&data) {
            for key in SYNCED_JSON_KEYS {
                if let Some(v) = map.get(*key) {
                    blob.insert(key.to_string(), v.clone());
                }
            }
        }
    }

    // Merge localStorage values collected via sync_receive_local_settings
    let local_path = app_data.join("sync_settings_local.json");
    if let Ok(data) = std::fs::read_to_string(&local_path) {
        if let Ok(map) = serde_json::from_str::<serde_json::Map<_, _>>(&data) {
            for (k, v) in map {
                blob.insert(k, v);
            }
        }
    }

    let blob_str = serde_json::to_string(&serde_json::Value::Object(blob))
        .map_err(|e| format!("serialize: {e}"))?;
    let encrypted = crypto::encrypt(&umk, &blob_str, "settings")
        .map_err(|e| format!("encrypt settings: {e}"))?;
    let updated_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let resp = http
        .push_settings(crate::sync::client::SettingsPushRequest {
            encrypted_blob: encrypted,
            updated_at,
        })
        .await?;

    // Server wins: apply its blob
    if resp.winner == "server" {
        if let Some(server_blob) = resp.encrypted_blob {
            if let Ok(decrypted) = crypto::decrypt(&umk, &server_blob, "settings") {
                let _ = app.emit("sync:settings", &decrypted);
            }
        }
    }

    Ok(())
}

/// Pull settings from the server, decrypt, and apply.
/// Emits `sync:settings` to React with the decrypted JSON blob.
#[tauri::command]
pub async fn sync_pull_settings(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    let umk = sync.umk_clone().ok_or("not authenticated")?;

    let result = http.pull_settings().await?;
    let Some(pull) = result else {
        return Ok(()); // No settings on server yet
    };

    let decrypted = crypto::decrypt(&umk, &pull.encrypted_blob, "settings")
        .map_err(|e| format!("decrypt settings: {e}"))?;

    // Emit localStorage keys to React for application
    let _ = app.emit("sync:settings", &decrypted);

    // Write settings.json keys directly
    if let Ok(blob) = serde_json::from_str::<serde_json::Map<_, _>>(&decrypted) {
        update_settings(&app, |existing| {
            for key in SYNCED_JSON_KEYS {
                if let Some(v) = blob.get(*key) {
                    existing.insert(key.to_string(), v.clone());
                }
            }
        });
        // Roamed send filters just landed on disk — refresh the push-path cache.
        sync.reload_local_sync_prefs();
    }

    Ok(())
}
