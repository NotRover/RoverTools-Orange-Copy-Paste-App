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
pub mod sync_state;
pub mod types;
pub mod ws_listener;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::{Emitter, Manager};
use zeroize::Zeroizing;

use crate::clipboard::history::{ClipboardEntry, EntryKind};
use crate::notes::Note;
use crate::sync::client::{PushEntryRequest, SyncHttpClient};
use crate::sync::config::SyncConfig;
use crate::sync::id_map::IdMap;
use crate::sync::pending_queue::{PendingOp, PendingQueue};
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
    /// "clipboard" | "notes"
    entry_type: &'static str,
    kind: String,
    group_ids: Vec<String>,
}

// ── SyncClient ───────────────────────────────────────────────────────

pub struct SyncClient {
    pub server_url: String,
    app: tauri::AppHandle,
    app_data: PathBuf,

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
    /// [`initialize_after_login`] after a successful `sync_login` command.
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

        Ok(Self {
            server_url: config.server_url,
            app,
            app_data,
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

    /// Wire up state after a successful login response from the server.
    pub fn initialize_after_login(
        &self,
        user: SyncUser,
        access_token: String,
        refresh_token: &str,
        kdf_salt_b64: &str,
        password: &str,
        device_id: &str,
    ) -> Result<(), String> {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        let kdf_salt = B64.decode(kdf_salt_b64).map_err(|e| format!("kdf_salt b64: {e}"))?;
        let umk = crypto::derive_umk(password, &kdf_salt);

        // Generate and store device keypair
        let (priv_key, _pub_key) = crypto::generate_device_keypair();
        crypto::store_device_private_key(&user.user_id, &priv_key)?;
        crypto::store_refresh_token(&user.user_id, refresh_token)?;

        // Update sync state
        {
            let mut state = self.sync_state.lock();
            state.set_device_id(device_id);
            state.set_user_id(&user.user_id);
        }

        // Set in-memory state
        *self.umk.lock() = Some(umk);

        let http = SyncHttpClient::new(self.server_url.clone());
        http.set_access_token(access_token);
        http.set_user_id(user.user_id.clone());
        *self.http.lock() = Some(Arc::clone(&http));

        *self.user.lock() = Some(user);
        self.status.lock().connected = true;

        // Start WebSocket listener
        self.start_ws_listener();

        Ok(())
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
            let http2 = Arc::clone(&http);
            self.handle.spawn(async move {
                let _ = http2.logout().await;
            });
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

    /// Live Share group IDs whose scope matches `scope_matches`.
    fn session_group_ids(&self, scope_matches: impl Fn(&SharingSession) -> bool) -> Vec<String> {
        self.sharing_sessions
            .lock()
            .iter()
            .filter(|s| scope_matches(s))
            .map(|s| s.share_group_id.clone())
            .collect()
    }

    fn spawn_push_clipboard_entry(
        &self,
        entry: ClipboardEntry,
        umk: Zeroizing<[u8; 32]>,
        is_update: bool,
    ) {
        let ctx = self.push_ctx();
        let group_ids = self.session_group_ids(|s| s.my_scope.includes_clipboard());

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
                group_ids,
            };
            push_entry_task(ctx, umk, is_update, job).await;
        });
    }

    fn spawn_push_note(&self, note: Note, umk: Zeroizing<[u8; 32]>, is_update: bool) {
        let ctx = self.push_ctx();
        let group_ids = self.session_group_ids(|s| s.my_scope.includes_notes());

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
                entry_type: "notes",
                kind: "note".into(),
                group_ids,
            };
            push_entry_task(ctx, umk, is_update, job).await;
        });
    }

    fn spawn_delete_entry(&self, client_id: String, entry_type: EntryType) {
        let http = self.http.lock().clone();
        let queue = Arc::clone(&self.pending_queue);
        let id_map = Arc::clone(&self.id_map);
        let status = Arc::clone(&self.status);
        let type_str = entry_type.as_str().to_string();
        let map_key = format!("{type_str}:{client_id}");

        self.handle.spawn(async move {
            // Always tombstone — even if offline (invariant #5)
            if let Some(http) = http.as_ref().filter(|h| h.is_authenticated()) {
                let server_id = {
                    let map = id_map.lock();
                    map.get_server_id(&map_key).map(|s| s.to_string())
                };
                if let Some(server_id) = server_id {
                    match http.delete_entry(&server_id).await {
                        Ok(()) => {
                            id_map.lock().remove_entry(&map_key);
                            status.lock().pending_count = queue.lock().len();
                            return;
                        }
                        Err(e) => eprintln!("[sync] delete failed: {e}"),
                    }
                }
            }
            // Queue tombstone for later
            queue.lock().push(PendingOp::Delete {
                client_id,
                entry_type: type_str,
            });
            status.lock().pending_count = queue.lock().len();
        });
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
                    if let Ok(req) =
                        serde_json::from_str::<PushEntryRequest>(&entry_json)
                    {
                        if let Ok(responses) = http.push_entries(vec![req]).await {
                            for r in responses {
                                let key = format!("clipboard:{}", r.client_id);
                                self.id_map.lock().set_entry(&key, &r.server_id);
                            }
                        }
                    }
                }
                PendingOp::Delete { client_id, entry_type } => {
                    let key = format!("{entry_type}:{client_id}");
                    let server_id = {
                        let map = self.id_map.lock();
                        map.get_server_id(&key).map(|s| s.to_string())
                    };
                    if let Some(sid) = server_id {
                        let _ = http.delete_entry(&sid).await;
                        self.id_map.lock().remove_entry(&key);
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
                    // TODO: decrypt entries, merge into local store, emit events
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

    pub fn http(&self) -> Option<Arc<SyncHttpClient>> {
        self.http.lock().clone()
    }

    pub fn umk_clone(&self) -> Option<Zeroizing<[u8; 32]>> {
        self.umk.lock().clone()
    }
}

/// Encrypt and push one entry (clipboard or note); queue it when offline.
/// Shared body of `spawn_push_clipboard_entry` / `spawn_push_note`.
async fn push_entry_task(ctx: PushCtx, umk: Zeroizing<[u8; 32]>, is_update: bool, job: PushJob) {
    let PushJob {
        client_id,
        content,
        metadata_json,
        entry_type,
        kind,
        group_ids,
    } = job;

    let encrypted_content = match crypto::encrypt(&umk, &content, &client_id) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[sync] {entry_type} encrypt content: {e}");
            return;
        }
    };
    let encrypted_metadata = match crypto::encrypt(&umk, &metadata_json, &client_id) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[sync] {entry_type} encrypt metadata: {e}");
            return;
        }
    };

    let push_req = PushEntryRequest {
        client_id: client_id.clone(),
        encrypted_content,
        encrypted_metadata,
        entry_type: entry_type.into(),
        kind,
        blob_key: None,
        group_ids,
    };

    if let Some(http) = ctx.http.as_ref().filter(|h| h.is_authenticated()) {
        match http.push_entries(vec![push_req.clone()]).await {
            Ok(responses) => {
                if let Some(r) = responses.into_iter().find(|r| r.client_id == client_id) {
                    if entry_type == "notes" {
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
