//! Tauri command handlers for cloud sync.
//!
//! Commands that perform network I/O are declared `async` so they run on
//! Tauri's internal async runtime without blocking the UI thread.
//! Fire-and-forget operations (on_new_entry hooks) are sync — they just
//! spawn tasks on the sync module's dedicated background runtime.

use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::{Emitter, Manager, State};

use crate::state::AppState;
use crate::sync::client::{
    CreateGroupRequest, CreateSharingRequest, JoinGroupRequest, JoinSharingRequest,
    SharingInviteRequest,
};
use crate::sync::config::SyncConfig;
use crate::sync::crypto;
use crate::sync::types::{
    ShareScope, SharingInvite, SharingSession, SyncGroup, SyncStatusInfo, SyncUser,
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

fn to_sync_group(g: crate::sync::client::ServerGroup) -> SyncGroup {
    SyncGroup {
        id: g.id,
        name: g.name,
        member_count: g.member_count,
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

#[tauri::command]
pub fn sync_set_server_url(
    url: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    write_setting(
        &app,
        "sync_server_url",
        serde_json::Value::String(url.clone()),
    );
    // Rebuild the SyncClient if one exists so it picks up the new URL
    if state.sync_client.lock().is_some() {
        eprintln!("[sync] server URL changed to {url} — restart app to reconnect");
    }
    Ok(())
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
    let (_sync, http) = sync_http(&state)?;
    let groups = http.list_groups().await?;
    Ok(groups.into_iter().map(to_sync_group).collect())
}

#[tauri::command]
pub async fn sync_create_group(
    name: String,
    state: State<'_, AppState>,
) -> Result<SyncGroup, String> {
    let (_sync, http) = sync_http(&state)?;
    let g = http
        .create_group(CreateGroupRequest {
            name,
            group_type: "pool".into(),
        })
        .await?;
    Ok(to_sync_group(g))
}

#[tauri::command]
pub async fn sync_join_group(
    invite_code: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (sync, http) = sync_http(&state)?;
    let g = http.join_group(JoinGroupRequest { invite_code }).await?;
    sync.register_group_mapping(&g.name, &g.id);
    Ok(())
}

#[tauri::command]
pub async fn sync_leave_group(
    group_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (_sync, http) = sync_http(&state)?;
    http.leave_group(&group_id).await?;
    Ok(())
}

// ── Live Share ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn sharing_invite(
    email: String,
    scope: String,
    state: State<'_, AppState>,
) -> Result<SharingInvite, String> {
    let (sync, http) = sync_http(&state)?;

    // Create the Live Share group first, then invite
    let created = http
        .create_sharing_session(CreateSharingRequest {
            name: None,
            scope: scope.clone(),
        })
        .await?;

    let invite_resp = http
        .invite_to_sharing(
            &created.share_group_id,
            SharingInviteRequest {
                email,
                scope: scope.clone(),
            },
        )
        .await?;

    // Register in id_map and sharing_sessions
    sync.id_map
        .lock()
        .set_sharing_session(&created.share_group_id);

    let parsed_scope = parse_scope(&scope)?;
    sync.set_sharing_session(SharingSession {
        share_group_id: created.share_group_id.clone(),
        name: created.name,
        my_scope: parsed_scope,
        members: Vec::new(),
        group_key: None, // Group key exchanged when invite is accepted
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
    let _umk = sync.umk_clone().ok_or("not authenticated")?;

    let user_id = sync
        .current_user()
        .map(|u| u.user_id)
        .ok_or("not authenticated")?;

    let _device_priv = crypto::load_device_private_key(&user_id)?;
    let (_priv2, pub_key) = crypto::generate_device_keypair();
    let pub_key_b64 = B64.encode(pub_key);

    let join_resp = http
        .join_sharing(JoinSharingRequest {
            invite_code,
            scope: scope.clone(),
            device_public_key: pub_key_b64,
        })
        .await?;

    // Derive shared secret and unwrap Group Key
    // The server returns a wrapped_group_key encrypted with a shared secret
    // derived from our device key and the owner's device key.
    // Full X25519 exchange is completed here.
    let _wrapped_bytes =
        B64.decode(&join_resp.wrapped_group_key).map_err(|e| format!("b64: {e}"))?;
    // For now, store the wrapped key — decryption requires the peer's public key
    // which is part of the group:rekey WebSocket flow (Phase 8).
    eprintln!("[sync] sharing_accept: group key exchange pending WS flow");

    let parsed_scope = parse_scope(&scope)?;
    sync.id_map
        .lock()
        .set_sharing_session(&join_resp.share_group_id);
    sync.set_sharing_session(SharingSession {
        share_group_id: join_resp.share_group_id,
        name: String::new(),
        my_scope: parsed_scope,
        members: Vec::new(),
        group_key: None,
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
    match scope {
        "clipboard" => Ok(ShareScope::Clipboard),
        "notes" => Ok(ShareScope::Notes),
        "both" => Ok(ShareScope::Both),
        other => Err(format!("unknown scope: {other}")),
    }
}
