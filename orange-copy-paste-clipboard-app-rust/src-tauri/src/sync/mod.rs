//! Cloud sync orchestrator.
//!
//! `SyncClient` lives in `AppState` and is the single point of contact for all
//! sync operations.  It owns a dedicated Tokio runtime (2 worker threads, named
//! "sync-worker") so that background tasks — the WebSocket listener, debounce
//! timer, pending-queue flusher — never block clipboard capture or the UI.
//!
//! # Invariants (see ARCHITECTURE.md §Cross-System Invariants)
//! - UMK is in-memory only; never written to any file or log.
//! - Sync runtime never calls `block_on` on Tauri's runtime.
//! - Capture pipeline is untouched; hooks fire only after a confirmed push.
//! - Tombstones always propagate; `on_delete_entry` queues even while offline.

pub mod client;
pub mod commands;
pub mod config;
pub mod crypto;
pub mod id_map;
pub mod pending_queue;
pub(crate) mod persist;
pub mod supabase;
pub mod sync_state;
pub mod types;
pub mod ws_listener;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{Emitter, Manager};
use zeroize::Zeroizing;

use base64::{engine::general_purpose::STANDARD as B64, Engine};

use crate::clipboard::history::{ClipboardEntry, EntryKind};
use crate::notes::Note;
use crate::sync::client::{
    DistributeKeysRequest, PushEntryRequest, RegisterDeviceRequest, SyncHttpClient, WrappedKeyEntry,
};
use crate::sync::config::SyncConfig;
use crate::sync::id_map::IdMap;
use crate::sync::pending_queue::{PendingOp, PendingQueue};
use crate::sync::supabase::{SignUpOutcome, SupabaseAuth, SupabaseSession};
use crate::sync::sync_state::SyncStateStore;
use crate::sync::types::{EntryType, ShareScope, SharingSession, SyncStatusInfo, SyncUser};
use crate::sync::ws_listener::WsListener;

/// How long after the last `schedule_settings_push()` call before the push fires.
const SETTINGS_DEBOUNCE_SECS: f64 = 2.0;

/// Shared handles cloned out of `SyncClient` for a spawned push/delete task.
struct PushCtx {
    http: Option<Arc<SyncHttpClient>>,
    queue: Arc<Mutex<PendingQueue>>,
    id_map: Arc<Mutex<IdMap>>,
    status: Arc<Mutex<SyncStatusInfo>>,
    app: tauri::AppHandle,
}

/// Everything that differs between a clipboard push and a note push.
struct PushJob {
    client_id: String,
    content: String,
    metadata_json: String,
    /// Backend wire discriminator: "clipboard" | "note".
    entry_type: &'static str,
    kind: String,
    created_at: u64,
    updated_at: u64,
    pinned: bool,
    group_ids: Vec<String>,
}

/// Decode a base64 X25519 public key into a fixed 32-byte array.
fn decode_pubkey(b64: &str) -> Option<[u8; 32]> {
    B64.decode(b64).ok()?.try_into().ok()
}

/// Current Unix time in milliseconds.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Build a tombstone push for `client_id`.  Deletions have no dedicated route:
/// the server keys entries by `(client_id, entry_type)`, so a push with
/// `deleted_at` set marks the row deleted and always wins LWW.  The content is
/// an encrypted empty string because the server requires a non-null ciphertext.
fn tombstone_req(umk: &[u8; 32], client_id: &str, entry_type: &str) -> Option<PushEntryRequest> {
    let ts = now_ms();
    Some(PushEntryRequest {
        client_id: client_id.to_string(),
        entry_type: entry_type.to_string(),
        kind: String::new(),
        encrypted_content: crypto::encrypt(umk, "", client_id).ok()?,
        encrypted_metadata: crypto::encrypt(umk, "{}", client_id).ok()?,
        created_at: ts,
        updated_at: ts,
        pinned: false,
        deleted_at: Some(ts),
        blob_key: None,
        blob_size: None,
        group_ids: Vec::new(),
    })
}

// ── SyncClient ───────────────────────────────────────────────────────

pub struct SyncClient {
    pub server_url: String,
    app: tauri::AppHandle,
    app_data: PathBuf,

    /// Supabase Auth (GoTrue) handle — owns identity/login/refresh.
    supabase: Arc<SupabaseAuth>,

    /// User Master Key — in memory only, zeroed on logout or drop.
    umk: Mutex<Option<Zeroizing<[u8; 32]>>>,
    /// Logged-in user info.
    user: Mutex<Option<SyncUser>>,
    /// Authenticated HTTP client (None when logged out).
    http: Mutex<Option<Arc<SyncHttpClient>>>,

    /// Pending offline operation queue.
    pending_queue: Arc<Mutex<PendingQueue>>,
    /// Client-to-server ID mapping.
    id_map: Arc<Mutex<IdMap>>,
    /// Sync state (cursor, device_id, user_id).
    sync_state: Arc<Mutex<SyncStateStore>>,
    /// Aggregate sync status for UI display.
    status: Arc<Mutex<SyncStatusInfo>>,
    /// Active Live Share sessions (includes cached group keys).
    sharing_sessions: Arc<Mutex<Vec<SharingSession>>>,

    /// WebSocket listener — replaced on reconnect.
    ws_listener: Mutex<Option<Arc<WsListener>>>,

    /// When set, a settings push is pending at this instant.
    settings_push_at: Arc<Mutex<Option<Instant>>>,
    /// Wakes the debounce task when a settings push is (re)scheduled.
    settings_notify: Arc<tokio::sync::Notify>,

    /// Handle to the dedicated background Tokio runtime.
    handle: tokio::runtime::Handle,
    /// Owned runtime — kept alive for the lifetime of SyncClient.
    _runtime: tokio::runtime::Runtime,
}

impl SyncClient {
    /// Create a new `SyncClient`.  Does not authenticate — call
    /// [`Self::perform_login`] from the `sync_login` command to sign in.
    pub fn new(app: tauri::AppHandle, config: SyncConfig) -> Result<Self, String> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("sync-worker")
            .build()
            .map_err(|e| format!("sync runtime: {e}"))?;
        let handle = runtime.handle().clone();

        let app_data = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data: {e}"))?;

        let pending_queue = Arc::new(Mutex::new(PendingQueue::load(
            pending_queue::pending_queue_path(&app_data),
        )));
        let id_map = Arc::new(Mutex::new(IdMap::load(id_map::id_map_path(&app_data))));
        let sync_state = Arc::new(Mutex::new(SyncStateStore::load(
            sync_state::state_path(&app_data),
        )));
        let status = Arc::new(Mutex::new(SyncStatusInfo {
            pending_count: pending_queue.lock().len(),
            ..Default::default()
        }));
        let settings_push_at: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        let settings_notify = Arc::new(tokio::sync::Notify::new());

        // Debounce task: sleeps until 2s after the most recent schedule call,
        // then signals React to collect localStorage values.  Idle (no polling)
        // until `schedule_settings_push()` wakes it.
        {
            let push_at = Arc::clone(&settings_push_at);
            let notify = Arc::clone(&settings_notify);
            let app2 = app.clone();
            handle.spawn(async move {
                loop {
                    notify.notified().await;
                    loop {
                        let deadline = match *push_at.lock() {
                            Some(at) => at + Duration::from_secs_f64(SETTINGS_DEBOUNCE_SECS),
                            None => break,
                        };
                        let now = Instant::now();
                        if now >= deadline {
                            *push_at.lock() = None;
                            let _ = app2.emit("sync:collect-settings", serde_json::Value::Null);
                            break;
                        }
                        tokio::time::sleep(deadline - now).await;
                    }
                }
            });
        }

        let supabase = Arc::new(SupabaseAuth::new(
            &config.supabase_url,
            &config.supabase_anon_key,
        ));

        Ok(Self {
            server_url: config.server_url,
            app,
            app_data,
            supabase,
            umk: Mutex::new(None),
            user: Mutex::new(None),
            http: Mutex::new(None),
            pending_queue,
            id_map,
            sync_state,
            status,
            sharing_sessions: Arc::new(Mutex::new(Vec::new())),
            ws_listener: Mutex::new(None),
            settings_push_at,
            settings_notify,
            handle,
            _runtime: runtime,
        })
    }

    // ── Auth lifecycle ────────────────────────────────────────────

    /// Full login flow against Supabase Auth + our backend:
    ///   1. Supabase password grant (access + refresh tokens, user id).
    ///   2. `POST /auth/bootstrap` → KDF salt + display name.
    ///   3. Derive the UMK from password + salt (deterministic per account).
    ///   4. Generate a device keypair and register the device → device_id.
    ///   5. Persist secrets (device key + refresh token) to the OS keychain.
    ///   6. Wire in-memory state and start the WebSocket listener.
    pub async fn perform_login(
        &self,
        email: String,
        password: String,
        device_name: String,
    ) -> Result<SyncUser, String> {
        let session = self.supabase.sign_in_password(&email, &password).await?;
        self.finalize_session(session, &email, &password, device_name)
            .await
    }

    /// Register a new account with Supabase, then finalize the session.  When
    /// the project requires email confirmation, no session is issued yet and an
    /// explanatory error is returned so the UI can prompt the user to confirm.
    pub async fn perform_signup(
        &self,
        email: String,
        password: String,
        device_name: String,
    ) -> Result<SyncUser, String> {
        match self.supabase.sign_up(&email, &password).await? {
            SignUpOutcome::Session(session) => {
                self.finalize_session(*session, &email, &password, device_name)
                    .await
            }
            SignUpOutcome::ConfirmationRequired => {
                Err("Account created — check your email to confirm it, then log in.".into())
            }
        }
    }

    /// Shared post-authentication flow for both login and signup.
    async fn finalize_session(
        &self,
        session: SupabaseSession,
        email: &str,
        password: &str,
        device_name: String,
    ) -> Result<SyncUser, String> {
        let user_id = session.user.id.clone();
        let user_email = if session.user.email.is_empty() {
            email.to_string()
        } else {
            session.user.email.clone()
        };

        // 2. Build the authenticated backend client.
        let http = SyncHttpClient::new(self.server_url.clone(), Arc::clone(&self.supabase));
        http.set_access_token(session.access_token);
        http.set_refresh_token(session.refresh_token.clone());
        http.set_user_id(user_id.clone());

        // 3. Ensure a profile exists and fetch the KDF salt; derive the UMK.
        let boot = http.bootstrap(None).await?;
        let kdf_salt = B64
            .decode(&boot.kdf_salt)
            .map_err(|e| format!("kdf_salt b64: {e}"))?;
        let umk = crypto::derive_umk(password, &kdf_salt);

        // 4. Register this device (fresh X25519 keypair for group key exchange).
        let (device_priv, device_pub) = crypto::generate_device_keypair();
        let dev = http
            .register_device(RegisterDeviceRequest {
                device_name,
                platform: std::env::consts::OS.to_string(),
                app_version: env!("CARGO_PKG_VERSION").to_string(),
                device_pubkey: Some(B64.encode(device_pub)),
            })
            .await?;
        http.set_device_id(dev.device_id.clone());

        // 5. Register public keys for E2E group-key exchange.  The identity key
        //    is derived from the UMK (identical on every device), so we register
        //    its public half alongside this device's public key.  Best-effort:
        //    a failure here only disables group sharing, not core sync.
        let (_identity_priv, identity_pub) = crypto::derive_identity_keypair(&umk);
        if let Err(e) = http
            .register_keys(client::RegisterKeysRequest {
                identity_pubkey: B64.encode(identity_pub),
                device_pubkey: B64.encode(device_pub),
            })
            .await
        {
            eprintln!("[sync] register_keys failed (group sharing disabled): {e}");
        }

        // 6. Persist secrets to the OS keychain.
        crypto::store_device_private_key(&user_id, &device_priv)?;
        crypto::store_refresh_token(&user_id, &session.refresh_token)?;

        // 7. Update persisted sync state.
        {
            let mut state = self.sync_state.lock();
            state.set_device_id(&dev.device_id);
            state.set_user_id(&user_id);
        }

        // 8. Wire in-memory state.
        let user = SyncUser {
            user_id,
            email: user_email,
            display_name: boot.display_name,
        };
        *self.umk.lock() = Some(umk);
        *self.http.lock() = Some(Arc::clone(&http));
        *self.user.lock() = Some(user.clone());
        self.status.lock().connected = true;

        // 9. Start the realtime listener.
        self.start_ws_listener();

        Ok(user)
    }

    /// Clear all in-memory state and delete keychain entries.
    pub fn logout(&self) {
        // UMK is zeroed by Zeroizing::drop
        *self.umk.lock() = None;

        let user_id = self
            .user
            .lock()
            .as_ref()
            .map(|u| u.user_id.clone())
            .unwrap_or_default();
        if !user_id.is_empty() {
            crypto::delete_keychain_entries(&user_id);
        }

        if let Some(http) = self.http.lock().take() {
            http.logout();
        }

        *self.user.lock() = None;
        self.stop_ws_listener();
        self.status.lock().connected = false;
    }

    // ── WS management ─────────────────────────────────────────────

    fn start_ws_listener(&self) {
        let http = match self.http.lock().clone() {
            Some(h) => h,
            None => return,
        };
        let listener = WsListener::new(self.app.clone(), http);
        listener.clone().connect(&self.handle);
        *self.ws_listener.lock() = Some(listener);
    }

    fn stop_ws_listener(&self) {
        if let Some(listener) = self.ws_listener.lock().take() {
            listener.disconnect();
        }
        let _ = self
            .app
            .emit("sync:status-changed", serde_json::json!({ "connected": false }));
    }

    // ── Settings sync debounce ────────────────────────────────────

    /// Schedule a settings push 2 seconds from now.  Repeated calls within
    /// the 2-second window reset the timer.  Thread-safe — can be called from
    /// any sync command handler.
    pub fn schedule_settings_push(&self) {
        *self.settings_push_at.lock() = Some(Instant::now());
        self.settings_notify.notify_one();
    }

    /// Store the localStorage values received from React via the
    /// `sync_receive_local_settings` command.  They will be merged with
    /// `settings.json` values on the next debounced push.
    pub fn store_local_settings_payload(&self, json: String) {
        // Persist temporarily to disk so the push task can read it
        let path = self.app_data.join("sync_settings_local.json");
        let _ = std::fs::write(&path, json);
    }

    // ── Entry sync hooks ──────────────────────────────────────────
    //
    // These are called from sync clipboard / notes command handlers.
    // They are synchronous from the caller's perspective; the actual
    // HTTP work is spawned onto the background runtime.

    pub fn on_new_clipboard_entry(&self, entry: ClipboardEntry) {
        let Some(umk) = self.umk.lock().clone() else {
            return; // Not logged in
        };
        self.spawn_push_clipboard_entry(entry, umk, false);
    }

    pub fn on_update_clipboard_entry(&self, entry: ClipboardEntry) {
        let Some(umk) = self.umk.lock().clone() else {
            return;
        };
        self.spawn_push_clipboard_entry(entry, umk, true);
    }

    pub fn on_delete_clipboard_entry(&self, client_id: String) {
        self.spawn_delete_entry(client_id, EntryType::Clipboard);
    }

    pub fn on_new_note(&self, note: Note) {
        let Some(umk) = self.umk.lock().clone() else {
            return;
        };
        self.spawn_push_note(note, umk, false);
    }

    pub fn on_update_note(&self, note: Note) {
        let Some(umk) = self.umk.lock().clone() else {
            return;
        };
        self.spawn_push_note(note, umk, true);
    }

    pub fn on_delete_note(&self, note_id: String) {
        self.spawn_delete_entry(note_id, EntryType::Notes);
    }

    // ── Internal spawn helpers ────────────────────────────────────

    /// Clone the shared handles a spawned task needs.
    fn push_ctx(&self) -> PushCtx {
        PushCtx {
            http: self.http.lock().clone(),
            queue: Arc::clone(&self.pending_queue),
            id_map: Arc::clone(&self.id_map),
            status: Arc::clone(&self.status),
            app: self.app.clone(),
        }
    }

    fn spawn_push_clipboard_entry(
        &self,
        entry: ClipboardEntry,
        umk: Zeroizing<[u8; 32]>,
        is_update: bool,
    ) {
        let ctx = self.push_ctx();
        // Shared entries encrypt under the session Group Key (§15.2); personal
        // ones under the UMK.
        let (enc_key, group_ids) = self.share_target(umk, |s| s.my_scope.includes_clipboard());

        self.handle.spawn(async move {
            // Skip file entries larger than 5 MB (Phase 7 enforcement)
            if entry.kind == EntryKind::File {
                let total_bytes: u64 = entry
                    .content
                    .lines()
                    .filter_map(|path| std::fs::metadata(path).ok())
                    .map(|m| m.len())
                    .sum();
                const FILE_SIZE_LIMIT: u64 = 5 * 1024 * 1024;
                if total_bytes > FILE_SIZE_LIMIT {
                    ctx.status.lock().skipped_count += 1;
                    let _ = ctx.app.emit(
                        "sync:file-skipped",
                        serde_json::json!({ "client_id": entry.id, "size_bytes": total_bytes }),
                    );
                    return;
                }
            }

            let metadata_json = serde_json::json!({
                "groups": entry.groups,
                "pinned": entry.pinned,
                "label": entry.label,
            })
            .to_string();
            let job = PushJob {
                client_id: entry.id.clone(),
                content: entry.content,
                metadata_json,
                entry_type: "clipboard",
                kind: entry.kind.label().to_string(),
                // Clipboard content is immutable; use its capture time as
                // created_at and "now" as the last-write-wins clock so pin /
                // group edits (which fire on_update) always win server-side.
                created_at: entry.timestamp,
                updated_at: now_ms(),
                pinned: entry.pinned,
                group_ids,
            };
            push_entry_task(ctx, enc_key, is_update, job).await;
        });
    }

    fn spawn_push_note(&self, note: Note, umk: Zeroizing<[u8; 32]>, is_update: bool) {
        let ctx = self.push_ctx();
        let (enc_key, group_ids) = self.share_target(umk, |s| s.my_scope.includes_notes());

        self.handle.spawn(async move {
            let metadata_json = serde_json::json!({
                "title": note.title,
                "groups": note.groups,
                "pinned": note.pinned,
            })
            .to_string();
            let job = PushJob {
                client_id: note.id.clone(),
                content: note.content,
                metadata_json,
                entry_type: "note",
                kind: "note".into(),
                created_at: note.created_at,
                updated_at: note.updated_at,
                pinned: note.pinned,
                group_ids,
            };
            push_entry_task(ctx, enc_key, is_update, job).await;
        });
    }

    fn spawn_delete_entry(&self, client_id: String, entry_type: EntryType) {
        let http = self.http.lock().clone();
        let umk = self.umk.lock().clone();
        let queue = Arc::clone(&self.pending_queue);
        let id_map = Arc::clone(&self.id_map);
        let status = Arc::clone(&self.status);
        let type_str = entry_type.as_str().to_string();
        let map_key = format!("{type_str}:{client_id}");

        self.handle.spawn(async move {
            // Always tombstone — even if offline (invariant #5).  A tombstone is
            // a push with deleted_at set, keyed by client_id (no server_id).
            if let (Some(http), Some(umk)) =
                (http.as_ref().filter(|h| h.is_authenticated()), umk.as_ref())
            {
                if let Some(req) = tombstone_req(umk, &client_id, &type_str) {
                    match http.push_entries(vec![req]).await {
                        Ok(_) => {
                            id_map.lock().remove_entry(&map_key);
                            status.lock().pending_count = queue.lock().len();
                            return;
                        }
                        Err(e) => eprintln!("[sync] tombstone push failed: {e}"),
                    }
                }
            }
            // Offline / not logged in — queue the tombstone for the next flush.
            queue.lock().push(PendingOp::Delete {
                client_id,
                entry_type: type_str,
            });
            status.lock().pending_count = queue.lock().len();
        });
    }

    // ── Pull merge ────────────────────────────────────────────────

    /// Decrypt a batch of pulled entries and merge them into the local stores.
    ///
    /// Writes **directly** to the history / notes stores (never through the
    /// command hooks) so a merge never echoes back as a new push.  Tombstones
    /// remove the local entry; live entries upsert by id (which is the shared
    /// `client_id`).  Image/file clipboard bodies live in blobs and are skipped
    /// until blob download is wired (Phase 5).
    pub(crate) fn merge_pulled(&self, entries: &[crate::sync::client::PulledEntry]) {
        use std::sync::atomic::Ordering;
        let Some(umk) = self.umk_clone() else {
            return;
        };
        let state = self.app.state::<crate::state::AppState>();
        let my_device = self.sync_state.lock().data.device_id.clone();

        let mut clip_changed = false;
        let mut notes_changed = false;

        for e in entries {
            // Skip entries this device originated (echoed back over the user
            // channel); they are already present locally.
            if !my_device.is_empty() && e.device_id.as_deref() == Some(my_device.as_str()) {
                continue;
            }
            let is_note = e.entry_type == "note";

            // Tombstone → remove locally.
            if e.deleted_at.is_some() {
                if is_note {
                    notes_changed |= state.notes.lock().delete(&e.client_id);
                } else {
                    clip_changed |= state.history.lock().remove(&e.client_id);
                }
                self.id_map.lock().remove_entry(&format!(
                    "{}:{}",
                    if is_note { "note" } else { "clipboard" },
                    e.client_id
                ));
                continue;
            }

            // Shared entries are encrypted under the session Group Key; personal
            // ones under the UMK.  Choose per entry by its group tags.
            let content_key = self.decryption_key_for(&umk, &e.group_ids);
            let Ok(content) = crypto::decrypt(&content_key, &e.encrypted_content, &e.client_id)
            else {
                eprintln!("[sync] merge: decrypt content failed for {}", e.client_id);
                continue;
            };
            let meta: serde_json::Value = e
                .encrypted_metadata
                .as_ref()
                .and_then(|m| crypto::decrypt(&content_key, m, &e.client_id).ok())
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or(serde_json::Value::Null);
            let groups: Vec<String> = meta
                .get("groups")
                .and_then(|g| serde_json::from_value(g.clone()).ok())
                .unwrap_or_default();

            if is_note {
                let title = meta
                    .get("title")
                    .and_then(|t| t.as_str())
                    .unwrap_or_default()
                    .to_string();
                state.notes.lock().upsert_synced(Note {
                    id: e.client_id.clone(),
                    title,
                    content,
                    created_at: e.created_at,
                    updated_at: e.updated_at,
                    pinned: e.pinned,
                    groups,
                    server_id: Some(e.server_id.clone()),
                    sync_status: crate::sync::types::SyncStatus::Synced,
                });
                notes_changed = true;
            } else {
                let kind = EntryKind::from_label(e.kind.as_deref().unwrap_or("text"));
                // Image/file bodies are blob-backed; skip until Phase 5.
                if matches!(kind, EntryKind::Image | EntryKind::File) {
                    continue;
                }
                let label = meta.get("label").and_then(|l| l.as_str()).map(str::to_string);
                state.history.lock().upsert_synced(ClipboardEntry {
                    id: e.client_id.clone(),
                    kind,
                    content,
                    timestamp: e.created_at,
                    pinned: e.pinned,
                    groups,
                    label,
                    content_hash: None,
                    server_id: Some(e.server_id.clone()),
                    sync_status: crate::sync::types::SyncStatus::Synced,
                });
                clip_changed = true;
            }

            let key = format!(
                "{}:{}",
                if is_note { "note" } else { "clipboard" },
                e.client_id
            );
            self.id_map.lock().set_entry(&key, &e.server_id);
        }

        if clip_changed {
            state.history.lock().sort_recent();
            state.history_dirty.store(true, Ordering::Relaxed);
            let _ = self.app.emit("sync:history-merged", serde_json::Value::Null);
        }
        if notes_changed {
            state.notes.lock().sort_recent();
            state.notes_dirty.store(true, Ordering::Relaxed);
            let _ = self.app.emit("sync:notes-merged", serde_json::Value::Null);
        }
    }

    /// Apply a `sync:delete` event (keyed only by `server_id`) by removing the
    /// matching local entry from whichever store holds it.  Best-effort — the
    /// primary delete path is a tombstone `sync:entry` (keyed by client_id).
    pub(crate) fn apply_remote_delete(&self, server_id: &str) {
        use std::sync::atomic::Ordering;
        let state = self.app.state::<crate::state::AppState>();

        let clip_id = state
            .history
            .lock()
            .all()
            .iter()
            .find(|e| e.server_id.as_deref() == Some(server_id))
            .map(|e| e.id.clone());
        if let Some(id) = clip_id {
            if state.history.lock().remove(&id) {
                state.history_dirty.store(true, Ordering::Relaxed);
                let _ = self.app.emit("sync:history-merged", serde_json::Value::Null);
            }
        }

        let note_id = state
            .notes
            .lock()
            .all()
            .iter()
            .find(|n| n.server_id.as_deref() == Some(server_id))
            .map(|n| n.id.clone());
        if let Some(id) = note_id {
            if state.notes.lock().delete(&id) {
                state.notes_dirty.store(true, Ordering::Relaxed);
                let _ = self.app.emit("sync:notes-merged", serde_json::Value::Null);
            }
        }
    }

    // ── Manual sync trigger ───────────────────────────────────────

    /// Flush the pending queue and do a delta pull.  Called by `sync_now`.
    pub async fn flush_and_pull(&self) -> Result<(), String> {
        let http = self.http.lock().clone().ok_or("not authenticated")?;
        if !http.is_authenticated() {
            return Err("not authenticated".into());
        }

        // Flush pending queue in order
        let ops = self.pending_queue.lock().drain();
        for op in ops {
            match op {
                PendingOp::Push { entry_json, .. } | PendingOp::Update { entry_json, .. } => {
                    if let Ok(req) = serde_json::from_str::<PushEntryRequest>(&entry_json) {
                        if let Ok(result) = http.push_entries(vec![req]).await {
                            for r in result.accepted {
                                // client_id is unique across types; the row is
                                // keyed by (client_id, entry_type) server-side.
                                let key = format!("clipboard:{}", r.client_id);
                                self.id_map.lock().set_entry(&key, &r.server_id);
                            }
                        }
                    }
                }
                PendingOp::Delete { client_id, entry_type } => {
                    if let Some(umk) = self.umk_clone() {
                        if let Some(req) = tombstone_req(&umk, &client_id, &entry_type) {
                            let _ = http.push_entries(vec![req]).await;
                            self.id_map
                                .lock()
                                .remove_entry(&format!("{entry_type}:{client_id}"));
                        }
                    }
                }
            }
        }

        // Delta pull
        let after_ts = self.sync_state.lock().data.last_server_ts;
        let mut cursor = after_ts;
        loop {
            match http.pull_entries(cursor, 200).await {
                Ok(pull) => {
                    self.merge_pulled(&pull.entries);
                    if let Some(last) = pull.entries.last() {
                        let ts = last.server_ts;
                        self.sync_state.lock().set_last_server_ts(ts);
                        let _ = http.advance_cursor(ts).await;
                    }
                    if pull.next_cursor.is_none() {
                        break;
                    }
                    cursor = pull.next_cursor;
                }
                Err(e) => {
                    eprintln!("[sync] pull failed: {e}");
                    break;
                }
            }
        }

        self.status.lock().pending_count = self.pending_queue.lock().len();
        Ok(())
    }

    // ── Status / accessors ────────────────────────────────────────

    pub fn current_user(&self) -> Option<SyncUser> {
        self.user.lock().clone()
    }

    pub fn status_info(&self) -> SyncStatusInfo {
        self.status.lock().clone()
    }

    pub fn sharing_sessions(&self) -> Vec<SharingSession> {
        self.sharing_sessions.lock().clone()
    }

    pub fn set_sharing_session(&self, session: SharingSession) {
        let mut guard = self.sharing_sessions.lock();
        if let Some(existing) = guard
            .iter_mut()
            .find(|s| s.share_group_id == session.share_group_id)
        {
            *existing = session;
        } else {
            guard.push(session);
        }
    }

    pub fn remove_sharing_session(&self, share_group_id: &str) {
        self.sharing_sessions
            .lock()
            .retain(|s| s.share_group_id != share_group_id);
        self.id_map.lock().remove_sharing_session(share_group_id);
    }

    pub fn update_session_scope(&self, share_group_id: &str, scope: ShareScope) {
        if let Some(session) = self
            .sharing_sessions
            .lock()
            .iter_mut()
            .find(|s| s.share_group_id == share_group_id)
        {
            session.my_scope = scope;
        }
    }

    pub fn register_group_mapping(&self, name: &str, server_id: &str) {
        self.id_map.lock().set_group(name, server_id);
    }

    /// Spawn a background flush + delta pull on the sync runtime.  Called right
    /// after login so a freshly-signed-in device catches up without blocking
    /// the `sync_login` command's return.
    pub fn trigger_initial_sync(self: Arc<Self>) {
        let handle = self.handle.clone();
        handle.spawn(async move {
            if let Err(e) = self.flush_and_pull().await {
                eprintln!("[sync] initial sync failed: {e}");
            }
        });
    }

    // ── Group key exchange (§7.4) ─────────────────────────────────

    /// Derive this user's identity keypair `(private, public)` from the
    /// in-memory UMK.  Identical on every device; `None` when logged out.
    pub fn identity_keypair(&self) -> Option<(Zeroizing<[u8; 32]>, [u8; 32])> {
        let umk = self.umk_clone()?;
        Some(crypto::derive_identity_keypair(&umk))
    }

    /// The cached Group Key for a session, if we currently hold one.
    fn session_group_key(&self, share_group_id: &str) -> Option<[u8; 32]> {
        self.sharing_sessions
            .lock()
            .iter()
            .find(|s| s.share_group_id == share_group_id)
            .and_then(|s| s.group_key)
    }

    /// Store the Group Key for a session, preserving an existing session's
    /// scope/members or creating a placeholder if we don't know it yet.  Kept
    /// in memory only (never persisted); Live Share keys are ephemeral.
    pub(crate) fn set_session_group_key(&self, share_group_id: &str, key: [u8; 32]) {
        let mut guard = self.sharing_sessions.lock();
        if let Some(s) = guard.iter_mut().find(|s| s.share_group_id == share_group_id) {
            s.group_key = Some(key);
        } else {
            guard.push(SharingSession {
                share_group_id: share_group_id.to_string(),
                name: String::new(),
                my_scope: ShareScope::Both,
                members: Vec::new(),
                group_key: Some(key),
            });
        }
    }

    /// Pick the content-encryption key + fan-out target for an outgoing entry.
    /// If the user is in a Live Share session (matching `want`) whose Group Key
    /// we hold, encrypt under that key and tag the entry with that group;
    /// otherwise it's a personal entry encrypted under the UMK (no group_ids).
    fn share_target(
        &self,
        umk: Zeroizing<[u8; 32]>,
        want: impl Fn(&SharingSession) -> bool,
    ) -> (Zeroizing<[u8; 32]>, Vec<String>) {
        let guard = self.sharing_sessions.lock();
        match guard.iter().find(|s| want(s) && s.group_key.is_some()) {
            Some(s) => (
                Zeroizing::new(s.group_key.expect("checked is_some")),
                vec![s.share_group_id.clone()],
            ),
            None => (umk, Vec::new()),
        }
    }

    /// The key to decrypt a pulled entry: a session Group Key when the entry is
    /// tagged with a session we hold a key for, else the personal UMK.
    fn decryption_key_for(
        &self,
        umk: &Zeroizing<[u8; 32]>,
        group_ids: &[String],
    ) -> Zeroizing<[u8; 32]> {
        group_ids
            .iter()
            .find_map(|gid| self.session_group_key(gid).map(Zeroizing::new))
            .unwrap_or_else(|| umk.clone())
    }

    /// Owner side (`sharing:accepted`): a member joined our Live Share.  Wrap
    /// our cached Group Key against their identity key and distribute it via
    /// `POST /groups/{id}/keys` (fans back out to them as `group:rekey`).
    pub(crate) fn handle_sharing_accepted(self: &Arc<Self>, payload: &serde_json::Value) {
        let share_group_id = payload
            .get("share_group_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let member = payload.get("new_member");
        let member_id = member
            .and_then(|m| m.get("id"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let member_pub_b64 = member
            .and_then(|m| m.get("identity_pubkey"))
            .and_then(|v| v.as_str())
            .map(str::to_string);

        let Some(group_key) = self.session_group_key(&share_group_id) else {
            eprintln!("[sync] sharing:accepted for unknown/keyless session {share_group_id}");
            return;
        };
        let (Some((id_priv, _)), Some(member_pub_b64)) =
            (self.identity_keypair(), member_pub_b64)
        else {
            eprintln!("[sync] sharing:accepted: member {member_id} has no identity key yet");
            return;
        };
        let Some(http) = self.http.lock().clone() else {
            return;
        };

        let this = Arc::clone(self);
        self.handle.spawn(async move {
            let Some(member_pub) = decode_pubkey(&member_pub_b64) else {
                return;
            };
            let shared = crypto::x25519_shared_secret(&id_priv, &member_pub);
            let wrapped = match crypto::wrap_key(&shared, &group_key) {
                Ok(w) => w,
                Err(e) => {
                    eprintln!("[sync] wrap group key: {e}");
                    return;
                }
            };
            let req = DistributeKeysRequest {
                wrapped_keys: vec![WrappedKeyEntry {
                    user_id: member_id.clone(),
                    wrapped_group_key: wrapped,
                }],
            };
            match http.distribute_group_keys(&share_group_id, req).await {
                Ok(()) => {
                    let _ = this.app.emit(
                        "sharing:member-joined",
                        serde_json::json!({ "share_group_id": share_group_id, "user_id": member_id }),
                    );
                }
                Err(e) => eprintln!("[sync] distribute group key failed: {e}"),
            }
        });
    }

    /// Member side (`group:rekey`): the owner sent us a Group Key wrapped
    /// against our identity key.  Unwrap with `X25519(my_priv, sender_pubkey)`
    /// and cache it so matching entries encrypt/decrypt under it.
    pub(crate) fn handle_group_rekey(&self, payload: &serde_json::Value) {
        let group_id = payload
            .get("group_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let wrapped = payload
            .get("wrapped_group_key")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let sender_pub_b64 = payload
            .get("sender_pubkey")
            .and_then(|v| v.as_str())
            .map(str::to_string);

        let (Some((id_priv, _)), Some(sender_pub_b64)) =
            (self.identity_keypair(), sender_pub_b64)
        else {
            eprintln!("[sync] group:rekey for {group_id} missing keys");
            return;
        };
        let Some(sender_pub) = decode_pubkey(&sender_pub_b64) else {
            return;
        };
        let shared = crypto::x25519_shared_secret(&id_priv, &sender_pub);
        match crypto::unwrap_key(&shared, &wrapped) {
            Ok(key) => {
                self.set_session_group_key(&group_id, *key);
                let _ = self.app.emit(
                    "sharing:key-received",
                    serde_json::json!({ "share_group_id": group_id }),
                );
            }
            Err(e) => eprintln!("[sync] unwrap group key for {group_id} failed: {e}"),
        }
    }

    pub fn http(&self) -> Option<Arc<SyncHttpClient>> {
        self.http.lock().clone()
    }

    pub fn umk_clone(&self) -> Option<Zeroizing<[u8; 32]>> {
        self.umk.lock().clone()
    }
}

/// Encrypt and push one entry (clipboard or note); queue it when offline.
/// Shared body of `spawn_push_clipboard_entry` / `spawn_push_note`.  `enc_key`
/// is the session Group Key for shared entries or the UMK for personal ones.
async fn push_entry_task(ctx: PushCtx, enc_key: Zeroizing<[u8; 32]>, is_update: bool, job: PushJob) {
    let PushJob {
        client_id,
        content,
        metadata_json,
        entry_type,
        kind,
        created_at,
        updated_at,
        pinned,
        group_ids,
    } = job;

    let encrypted_content = match crypto::encrypt(&enc_key, &content, &client_id) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[sync] {entry_type} encrypt content: {e}");
            return;
        }
    };
    let encrypted_metadata = match crypto::encrypt(&enc_key, &metadata_json, &client_id) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[sync] {entry_type} encrypt metadata: {e}");
            return;
        }
    };

    let push_req = PushEntryRequest {
        client_id: client_id.clone(),
        entry_type: entry_type.into(),
        kind,
        encrypted_content,
        encrypted_metadata,
        created_at,
        updated_at,
        pinned,
        deleted_at: None,
        blob_key: None,
        blob_size: None,
        group_ids,
    };

    if let Some(http) = ctx.http.as_ref().filter(|h| h.is_authenticated()) {
        match http.push_entries(vec![push_req.clone()]).await {
            Ok(result) => {
                if let Some(r) = result.accepted.into_iter().find(|r| r.client_id == client_id) {
                    if entry_type == "note" {
                        ctx.id_map
                            .lock()
                            .set_entry(&format!("note:{client_id}"), &r.server_id);
                        let _ = ctx.app.emit(
                            "sync:note-synced",
                            serde_json::json!({ "client_id": client_id }),
                        );
                    } else {
                        ctx.id_map
                            .lock()
                            .set_entry(&format!("clipboard:{client_id}"), &r.server_id);
                        let _ = ctx.app.emit(
                            "sync:entry-synced",
                            serde_json::json!({
                                "client_id": client_id,
                                "server_id": r.server_id,
                            }),
                        );
                    }
                }
                ctx.status.lock().pending_count = ctx.queue.lock().len();
                return;
            }
            Err(e) => eprintln!("[sync] {entry_type} push failed: {e}"),
        }
    }

    // Offline / unauthenticated — queue
    let entry_json = match serde_json::to_string(&push_req) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("[sync] serialize {entry_type} push: {e}");
            return;
        }
    };
    let op = if is_update {
        PendingOp::Update {
            entry_json,
            entry_type: entry_type.into(),
        }
    } else {
        PendingOp::Push {
            entry_json,
            entry_type: entry_type.into(),
        }
    };
    ctx.queue.lock().push(op);
    ctx.status.lock().pending_count = ctx.queue.lock().len();
}
