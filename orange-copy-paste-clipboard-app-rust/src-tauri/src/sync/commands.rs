//! Tauri command handlers for cloud sync.
//!
//! Commands that perform network I/O are declared `async` so they run on
//! Tauri's internal async runtime without blocking the UI thread.
//! Fire-and-forget operations (on_new_entry hooks) are sync — they just
//! spawn tasks on the sync module's dedicated background runtime.

use std::sync::Arc;

use tauri::{Emitter, Manager, State};

use crate::state::AppState;
use crate::sync::client::{CreateGroupRequest, GroupOut, JoinGroupRequest, SharingInviteRequest};
use crate::sync::config::SyncConfig;
use crate::sync::crypto;
use crate::sync::types::{
    ShareScope, SharingInvite, SharingSession, SyncDevice, SyncGroup, SyncQuota, SyncStatusInfo,
    SyncUser,
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
    let mut map: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    f(&mut map);
    if let Ok(json) = serde_json::to_string_pretty(&map) {
        let _ = std::fs::write(&path, json);
    }
}

fn write_setting(app: &tauri::AppHandle, key: &str, value: serde_json::Value) {
    update_settings(app, |map| {
        map.insert(key.to_string(), value);
    });
}

fn to_sync_group(g: GroupOut, me: &str) -> SyncGroup {
    SyncGroup {
        member_count: g.members.len() as u32,
        is_owner: g.owner_id == me,
        members: g
            .members
            .into_iter()
            .map(|m| crate::sync::types::SyncGroupMember {
                user_id: m.user_id,
                display_name: m.display_name,
                role: m.role,
                has_group_key: m.has_group_key,
            })
            .collect(),
        id: g.id,
        name: g.name,
        owner_id: g.owner_id,
        share_history: g.share_history,
        invite_code: g.invite_code,
        invite_expires_at: g.invite_expires_at,
    }
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
    let sync = {
        let guard = state.sync_client.lock();
        match guard.clone() {
            Some(s) => s,
            None => {
                drop(guard);
                let config = SyncConfig::load(&app);
                let client = SyncClient::new(app.clone(), config)?;
                let arc = Arc::new(client);
                *state.sync_client.lock() = Some(Arc::clone(&arc));
                arc
            }
        }
    };

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
    let sync = {
        let guard = state.sync_client.lock();
        match guard.clone() {
            Some(s) => s,
            None => {
                drop(guard);
                let config = SyncConfig::load(&app);
                let client = SyncClient::new(app.clone(), config)?;
                let arc = Arc::new(client);
                *state.sync_client.lock() = Some(Arc::clone(&arc));
                arc
            }
        }
    };

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
    let sync = {
        let guard = state.sync_client.lock();
        match guard.clone() {
            Some(s) => s,
            None => {
                drop(guard);
                let config = SyncConfig::load(&app);
                let client = SyncClient::new(app.clone(), config)?;
                let arc = Arc::new(client);
                *state.sync_client.lock() = Some(Arc::clone(&arc));
                arc
            }
        }
    };
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

/// Discard a stashed OAuth session when the user backs out of the password step.
#[tauri::command]
pub fn sync_oauth_cancel(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(sync) = state.sync_client.lock().clone() {
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
    let sync = {
        let guard = state.sync_client.lock();
        match guard.clone() {
            Some(s) => s,
            None => {
                drop(guard);
                let config = SyncConfig::load(&app);
                let client = SyncClient::new(app.clone(), config)?;
                let arc = Arc::new(client);
                *state.sync_client.lock() = Some(Arc::clone(&arc));
                arc
            }
        }
    };
    sync.reset_password(email).await
}

#[tauri::command]
pub async fn sync_logout(
    state: State<'_, AppState>,
) -> Result<(), String> {
    if let Some(sync) = state.sync_client.lock().clone() {
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
        let guard = state.sync_client.lock();
        if guard.is_none() {
            drop(guard);
            let config = SyncConfig::load(&app);
            let client = SyncClient::new(app, config)?;
            *state.sync_client.lock() = Some(Arc::new(client));
        }
    } else if let Some(sync) = state.sync_client.lock().take() {
        sync.logout();
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

#[tauri::command]
pub fn sync_get_connection(app: tauri::AppHandle) -> SyncConnection {
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

// ── Pool groups ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn sync_get_groups(state: State<'_, AppState>) -> Result<Vec<SyncGroup>, String> {
    let (sync, http) = sync_http(&state)?;
    let me = sync.current_user().map(|u| u.user_id).unwrap_or_default();
    let groups = http.list_groups().await?;
    Ok(groups.into_iter().map(|g| to_sync_group(g, &me)).collect())
}

#[tauri::command]
pub async fn sync_create_group(
    name: String,
    share_history: Option<bool>,
    state: State<'_, AppState>,
) -> Result<SyncGroup, String> {
    let (sync, http) = sync_http(&state)?;
    let created = http
        .create_group(CreateGroupRequest {
            name: name.clone(),
            group_type: "pool".into(),
            // Default to sharing history — matches the server default and the
            // previous behaviour for callers that don't pass a choice.
            share_history: share_history.unwrap_or(true),
        })
        .await?;
    sync.register_group_mapping(&name, &created.group_id);
    // Mint and upload the Group Key now, so the first entry tagged into this
    // group can be encrypted for the group rather than silently falling back to
    // the personal UMK (which no other member could ever read).
    sync.reconcile_group_keys().await;
    // Creator is the sole member at this point; surface the invite code so the
    // UI can share it.
    let me = sync.current_user().map(|u| u.user_id).unwrap_or_default();
    Ok(SyncGroup {
        id: created.group_id,
        name,
        owner_id: me.clone(),
        is_owner: true,
        share_history: share_history.unwrap_or(true),
        member_count: 1,
        members: Vec::new(),
        invite_code: Some(created.invite_code),
        invite_expires_at: None,
    })
}

#[tauri::command]
pub async fn sync_join_group(
    invite_code: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    let g = http
        .join_group(JoinGroupRequest {
            // Tolerate pasted links and sloppy casing: the server normalizes
            // short codes, but strip an obvious `?code=`/path prefix here.
            invite_code: extract_invite_code(&invite_code),
            wrapped_group_key: None,
        })
        .await?;
    sync.register_group_mapping(&g.name, &g.group_id);
    // Catch up on the group's shared history in the background.
    let sync2 = Arc::clone(&sync);
    tauri::async_runtime::spawn(async move {
        sync2.reconcile_group_keys().await;
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
pub async fn sync_leave_group(
    group_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    let user_id = sync
        .current_user()
        .map(|u| u.user_id)
        .ok_or("not authenticated")?;
    // Self-removal (the owner may dissolve the group with delete instead).
    http.remove_group_member(&group_id, &user_id).await?;
    Ok(())
}

// ── Blobs & devices ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn sync_get_quota(state: State<'_, AppState>) -> Result<SyncQuota, String> {
    let (_sync, http) = sync_http(&state)?;
    let q = http.blob_quota().await?;
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

/// Remove a member from a group we own (self-removal uses sync_leave_group).
#[tauri::command]
pub async fn sync_remove_member(
    group_id: String,
    member_user_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (_sync, http) = sync_http(&state)?;
    http.remove_group_member(&group_id, &member_user_id).await
}

/// Delete a group we own (dissolves it for every member).
#[tauri::command]
pub async fn sync_delete_group(
    group_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (_sync, http) = sync_http(&state)?;
    http.delete_group(&group_id).await
}

#[tauri::command]
pub async fn sync_revoke_device(
    device_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    // Refuse to revoke the device we're running on — sign out is the way.
    if sync.device_id().as_deref() == Some(device_id.as_str()) {
        return Err("can't remove this device while signed in on it — sign out instead".into());
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
    group_id: String,
    email: String,
    state: State<'_, AppState>,
) -> Result<crate::sync::client::InviteOut, String> {
    let (_sync, http) = sync_http(&state)?;
    http.send_group_invite(&group_id, &email).await
}

#[tauri::command]
pub async fn sync_accept_invite(
    invite_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    let g = http.accept_invite(&invite_id).await?;
    sync.register_group_mapping(&g.name, &g.group_id);
    // Catch up in the background: recover/receive keys, then pull the group's
    // history (subject to its share_history policy).
    let sync2 = Arc::clone(&sync);
    tauri::async_runtime::spawn(async move {
        sync2.reconcile_group_keys().await;
        sync2.refresh_sharing_sessions().await;
        let _ = sync2.flush_and_pull().await;
    });
    Ok(())
}

#[tauri::command]
pub async fn sync_decline_invite(
    invite_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (_sync, http) = sync_http(&state)?;
    http.decline_invite(&invite_id).await
}

#[tauri::command]
pub async fn sync_revoke_invite(
    invite_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (_sync, http) = sync_http(&state)?;
    http.revoke_invite(&invite_id).await
}

// ── Live Share ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn sharing_invite(
    email: String,
    scope: String,
    state: State<'_, AppState>,
) -> Result<SharingInvite, String> {
    let (sync, http) = sync_http(&state)?;
    let parsed_scope = parse_scope(&scope)?;

    // Owner generates the Group Key up front and caches it; it is wrapped for
    // each member as they accept (see `handle_sharing_accepted`).
    let group_key = crypto::random_key();

    // One call creates the live_share group and emails the invite.
    let invite_resp = http
        .create_sharing_invite(SharingInviteRequest {
            email,
            share_scope: scope.clone(),
        })
        .await?;

    sync.id_map
        .lock()
        .set_sharing_session(&invite_resp.share_group_id);
    sync.set_sharing_session(SharingSession {
        share_group_id: invite_resp.share_group_id.clone(),
        name: "Live Share".into(),
        my_scope: parsed_scope,
        members: Vec::new(),
        group_key: Some(*group_key),
    });

    Ok(SharingInvite {
        invite_code: invite_resp.invite_code,
        share_group_id: invite_resp.share_group_id,
        expires_at: invite_resp.expires_at,
    })
}

#[tauri::command]
pub async fn sharing_accept(
    invite_code: String,
    scope: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    let parsed_scope = parse_scope(&scope)?;

    // Live Share sessions are joined via the shared group-join route.  The
    // Group Key is delivered afterwards over WS (`group:rekey`) once the owner
    // wraps it against our identity key — so no key material is exchanged here.
    let join_resp = http
        .join_group(JoinGroupRequest {
            invite_code: extract_invite_code(&invite_code),
            wrapped_group_key: None,
        })
        .await?;

    sync.id_map
        .lock()
        .set_sharing_session(&join_resp.group_id);
    sync.set_sharing_session(SharingSession {
        share_group_id: join_resp.group_id,
        name: join_resp.name,
        my_scope: parsed_scope,
        members: Vec::new(),
        group_key: None, // arrives via `group:rekey`
    });

    Ok(())
}

#[tauri::command]
pub fn sharing_get_sessions(state: State<'_, AppState>) -> Vec<SharingSession> {
    state
        .sync_client
        .lock()
        .as_ref()
        .map(|s| s.sharing_sessions())
        .unwrap_or_default()
}

/// Fetch sessions from the server (recovering keys as needed) and return the
/// refreshed list. Use this on screen mount; `sharing_get_sessions` only reads
/// the in-memory cache, which is empty right after an app restart.
#[tauri::command]
pub async fn sharing_refresh_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<SharingSession>, String> {
    let sync = sync_client(&state)?;
    Ok(sync.refresh_sharing_sessions().await)
}

#[tauri::command]
pub async fn sharing_update_scope(
    share_group_id: String,
    scope: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    http.update_sharing_scope(&share_group_id, &scope).await?;

    // Update local session
    let parsed_scope = parse_scope(&scope)?;
    sync.update_session_scope(&share_group_id, parsed_scope);
    Ok(())
}

#[tauri::command]
pub async fn sharing_end_session(
    share_group_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    http.end_sharing_session(&share_group_id).await?;
    sync.remove_sharing_session(&share_group_id);
    Ok(())
}

#[tauri::command]
pub async fn sharing_leave_session(
    share_group_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    http.leave_sharing_session(&share_group_id).await?;
    sync.remove_sharing_session(&share_group_id);
    Ok(())
}

// ── Settings sync commands ────────────────────────────────────────────

/// Settings keys sourced from settings.json that participate in cloud sync.
const SYNCED_JSON_KEYS: &[&str] = &[
    "keep_history",
    "close_to_tray",
    "start_minimized",
    "notification",
    "notif_copy",
    "notif_paste",
    "autosave",
    "sharing_notify",
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
    }

    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────

fn parse_scope(scope: &str) -> Result<ShareScope, String> {
    ShareScope::parse(scope).ok_or_else(|| format!("unknown scope: {scope}"))
}
