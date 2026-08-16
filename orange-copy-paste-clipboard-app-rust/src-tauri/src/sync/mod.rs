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
pub mod oauth;
pub mod pending_queue;
pub(crate) mod persist;
pub mod supabase;
pub mod sync_state;
pub mod types;
pub mod ws_listener;

use std::collections::HashMap;
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
    BlobUploadRequest, DistributeKeysRequest, PushEntryRequest, RegisterDeviceRequest,
    SyncHttpClient, WrappedKeyringEntry,
};
use crate::sync::config::SyncConfig;
use crate::sync::id_map::IdMap;
use crate::sync::pending_queue::{PendingOp, PendingQueue};
use crate::sync::supabase::{SignUpOutcome, SupabaseAuth, SupabaseSession};
use crate::sync::sync_state::SyncStateStore;
use crate::sync::types::{
    EntryType, SendFilter, SkippedEntry, Space, SpaceMember, SyncMode, SyncStatusInfo, SyncUser,
};
use crate::sync::ws_listener::WsListener;

/// How long after the last `schedule_settings_push()` call before the push fires.
const SETTINGS_DEBOUNCE_SECS: f64 = 2.0;

/// How often the passive-mode pull loop wakes up.  Pushes are always immediate
/// (the backup must not lose data); passive only batches what gets *applied*.
const PASSIVE_PULL_INTERVAL_SECS: u64 = 300;

/// Settings key holding the per-space send filters (JSON map keyed by space
/// id).  Lives in settings.json and rides in the encrypted settings blob so
/// filters roam across devices without the server ever seeing them.
pub(crate) const SEND_FILTERS_KEY: &str = "space_send_filters";

/// Settings key for the cloud-sync mode ("realtime" | "passive").  Device-local
/// on purpose — it is a per-device ergonomic choice, like sync_enabled.
pub(crate) const SYNC_MODE_KEY: &str = "sync_mode";

/// Ordered keyring for one space: `[0]` is the current key, the rest are
/// previous keys kept so entries written before a rekey stay readable.
type SpaceKeyring = Vec<[u8; 32]>;

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
    /// Spaces this entry fans out to (may be empty = personal only).
    space_ids: Vec<String>,
    /// CEK envelope map (`"personal"` + one wrap per space id), JSON.
    wrapped_keys: String,
    /// Blob storage key + ciphertext size for image entries; `None` for text.
    blob_key: Option<String>,
    blob_size: Option<u64>,
}

/// Decode a base64 X25519 public key into a fixed 32-byte array.
fn decode_pubkey(b64: &str) -> Option<[u8; 32]> {
    B64.decode(b64).ok()?.try_into().ok()
}

/// Fields needed to materialize a downloaded image blob into the history store.
struct ImageMergeMeta {
    client_id: String,
    server_id: String,
    blob_key: String,
    mime: String,
    label: Option<String>,
    groups: Vec<String>,
    /// Spaces this entry was shared into, recorded alongside its server id so
    /// an image lands under the right space like every other entry.
    space_ids: Vec<String>,
    created_at: u64,
    pinned: bool,
    /// Write the materialized image to the clipboard once merged (auto-copy).
    autocopy: bool,
    /// Another member wrote this one (its key came from a space keyring).
    remote: bool,
}

/// Read the send-filter map and sync mode from `settings.json` (both default
/// to "off"/Realtime when absent or unreadable — the safe interpretations).
fn load_local_sync_prefs(app_data: &std::path::Path) -> (HashMap<String, SendFilter>, SyncMode) {
    let map = std::fs::read_to_string(app_data.join("settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&s).ok())
        .unwrap_or_default();
    let filters = map
        .get(SEND_FILTERS_KEY)
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let mode = map
        .get(SYNC_MODE_KEY)
        .and_then(|v| v.as_str())
        .and_then(SyncMode::parse)
        .unwrap_or_default();
    (filters, mode)
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
/// `space_ids` carries the spaces the entry was shared into so the tombstone
/// fans out to the same members; nobody decrypts a tombstone, so the envelope
/// stays empty.
fn tombstone_req(
    umk: &[u8; 32],
    client_id: &str,
    entry_type: &str,
    space_ids: Vec<String>,
) -> Option<PushEntryRequest> {
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
        space_ids,
        wrapped_keys: "{}".into(),
    })
}

// ── OAuth (Google, etc.) ─────────────────────────────────────────────

/// An OAuth login that has completed the provider handshake but still needs the
/// account password (the E2E secret) before the session can be finalized.
struct PendingOAuth {
    session: SupabaseSession,
    email: String,
    device_name: String,
    /// True when the account has no identity key yet — the user is setting a
    /// password for the first time rather than re-entering an existing one.
    is_new: bool,
}

/// Returned to the UI after the browser OAuth hop so it can prompt for the
/// account password (creating one on first sign-in, entering it thereafter).
#[derive(Debug, Clone, serde::Serialize)]
pub struct OAuthBegin {
    pub email: String,
    /// True → prompt to *create* a password; false → prompt to *enter* it.
    pub is_new: bool,
}

// ── SyncClient ───────────────────────────────────────────────────────

/// Request timeout for the session-restore chain, longer than the default.
/// Restore runs during startup — often right after an update, while the network
/// stack is still coming back — and a timeout there costs a manual login.
const RESTORE_TIMEOUT_SECS: u64 = 30;

/// Backoff schedule for the background restore retry, in seconds. Repeats the
/// last value forever: an app that was offline for an hour should still restore
/// itself the moment the network returns, and one poll a minute is cheap.
const RESTORE_RETRY_BACKOFF_SECS: [u64; 5] = [3, 10, 30, 60, 60];

/// Why a silent session restore did not produce a session.
///
/// Only [`RestoreError::Transient`] is worth retrying; the other two mean the
/// user genuinely has to sign in, and retrying would just burn requests.
#[derive(Debug)]
pub enum RestoreError {
    /// Nothing was stored to restore from (first run, or after a logout).
    NoSession(String),
    /// Stored credentials exist but are dead — refresh token revoked, device
    /// wrap gone, keychain unreadable. Only a fresh login fixes it.
    Terminal(String),
    /// The server or Supabase could not be reached, or answered 5xx. The stored
    /// credentials are still good; this should be retried.
    Transient(String),
}

impl RestoreError {
    fn from_auth(e: crate::sync::supabase::AuthError) -> Self {
        if e.is_transient() {
            Self::Transient(e.message)
        } else {
            Self::Terminal(e.message)
        }
    }

    fn from_api(e: crate::sync::client::ApiError) -> Self {
        if e.is_transient() {
            Self::Transient(e.message)
        } else {
            Self::Terminal(e.message)
        }
    }

    pub fn is_transient(&self) -> bool {
        matches!(self, Self::Transient(_))
    }

    pub fn message(&self) -> &str {
        match self {
            Self::NoSession(m) | Self::Terminal(m) | Self::Transient(m) => m,
        }
    }
}

impl std::fmt::Display for RestoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

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

    /// An OAuth session that has authenticated but is awaiting the account
    /// password (the E2E secret) from the user before it can be finalized.
    pending_oauth: Mutex<Option<PendingOAuth>>,

    /// Pending offline operation queue.
    pending_queue: Arc<Mutex<PendingQueue>>,
    /// Client-to-server ID mapping.
    id_map: Arc<Mutex<IdMap>>,
    /// Sync state (cursor, device_id, user_id).
    sync_state: Arc<Mutex<SyncStateStore>>,
    /// Aggregate sync status for UI display.
    status: Arc<Mutex<SyncStatusInfo>>,
    /// Cached space list (membership, members, presence) for the UI.
    spaces: Arc<Mutex<Vec<Space>>>,
    /// Space keyrings by space id, newest key first. In memory only, like the
    /// UMK — recovered from the server-side wrapped keyring on reconcile, and
    /// zeroized on logout.
    space_keys: Arc<Mutex<HashMap<String, SpaceKeyring>>>,
    /// Per-space send filters (what of mine auto-flows in), keyed by space id.
    /// Cache of the `space_send_filters` settings key; absent = explicit only.
    send_filters: Arc<Mutex<HashMap<String, SendFilter>>>,
    /// Cloud-sync mode for personal entries. Spaces are realtime regardless.
    sync_mode: Arc<Mutex<SyncMode>>,

    /// WebSocket listener — replaced on reconnect.
    ws_listener: Mutex<Option<Arc<WsListener>>>,

    /// True while a background session-restore retry loop is running, so a
    /// second one is never started alongside it.
    restore_retrying: Arc<std::sync::atomic::AtomicBool>,

    /// When set, a settings push is pending at this instant.
    settings_push_at: Arc<Mutex<Option<Instant>>>,
    /// Wakes the debounce task when a settings push is (re)scheduled.
    settings_notify: Arc<tokio::sync::Notify>,

    /// Handle to the dedicated background Tokio runtime.
    handle: tokio::runtime::Handle,
    /// Owned runtime — kept alive for the lifetime of SyncClient. `Option` only
    /// so [`Drop`] can move it out and shut it down without blocking.
    runtime: Option<tokio::runtime::Runtime>,
}

impl Drop for SyncClient {
    fn drop(&mut self) {
        // The last `Arc<SyncClient>` is frequently released *inside* a task
        // running on this very runtime — a spawned sync job that outlives
        // logout or a disabled-sync toggle. Dropping a Runtime from async
        // context panics ("Cannot drop a runtime in a context where blocking is
        // not allowed"), and because the release profile sets `panic = "abort"`
        // that panic takes the whole app down instead of just the worker.
        //
        // `shutdown_background` never blocks, so it is safe from any context:
        // in-flight tasks are abandoned rather than awaited, which is what we
        // want for a client that is already logged out.
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
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
                        let scheduled = *push_at.lock();
                        let deadline = match scheduled {
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

        // Seed the send-filter and sync-mode caches from settings.json so a
        // restart applies them without waiting for a settings pull.
        let (send_filters, sync_mode) = load_local_sync_prefs(&app_data);

        Ok(Self {
            server_url: config.server_url,
            app,
            app_data,
            supabase,
            umk: Mutex::new(None),
            user: Mutex::new(None),
            http: Mutex::new(None),
            pending_oauth: Mutex::new(None),
            pending_queue,
            id_map,
            sync_state,
            status,
            spaces: Arc::new(Mutex::new(Vec::new())),
            space_keys: Arc::new(Mutex::new(HashMap::new())),
            send_filters: Arc::new(Mutex::new(send_filters)),
            sync_mode: Arc::new(Mutex::new(sync_mode)),
            ws_listener: Mutex::new(None),
            restore_retrying: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            settings_push_at,
            settings_notify,
            handle,
            runtime: Some(runtime),
        })
    }

    // ── Auth lifecycle ────────────────────────────────────────────

    /// Full login flow against Supabase Auth + our backend:
    ///   1. Supabase password grant (access + refresh tokens, user id).
    ///   2. `POST /auth/bootstrap` → KDF salt + wrapped-UMK envelope.
    ///   3. Derive the wrapping key from password + salt, then unwrap the random
    ///      UMK (or generate + wrap one on a brand-new account).
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
                Err("Account created. Check your email to confirm it, then log in.".into())
            }
        }
    }

    /// Phase 1 of OAuth sign-in: run the provider handshake in the browser and
    /// determine whether the user needs to *create* or *enter* their account
    /// password.  The authenticated session is stashed until [`Self::complete_oauth`].
    ///
    /// Steps: PKCE pair → loopback redirect server → open browser → exchange the
    /// returned code for a session → bootstrap to learn if an identity key (and
    /// therefore a password) already exists for this account.
    pub async fn begin_oauth(
        self: &Arc<Self>,
        provider: String,
        device_name: String,
    ) -> Result<OAuthBegin, String> {
        let (verifier, challenge) = crypto::pkce_pair();

        // Bind the loopback redirect target *before* building the URL so the
        // exact redirect_uri is known.
        let loopback = oauth::bind()?;
        let auth_url = self
            .supabase
            .authorize_url(&provider, &loopback.redirect_uri, &challenge)?;
        oauth::open_browser(&auth_url)?;

        // The accept loop is blocking; run it off the async worker.
        let code = self
            .handle
            .spawn_blocking(move || loopback.wait_for_code())
            .await
            .map_err(|e| format!("oauth capture task: {e}"))??;

        let session = self.supabase.exchange_code_pkce(&code, &verifier).await?;
        let email = session.user.email.clone();

        // Probe the account: does it already have a registered identity key?
        let http = SyncHttpClient::new(self.server_url.clone(), Arc::clone(&self.supabase));
        http.set_access_token(session.access_token.clone(), session.expires_in);
        http.set_refresh_token(session.refresh_token.clone());
        http.set_user_id(session.user.id.clone());
        let boot = http.bootstrap(None).await?;
        let is_new = boot.wrapped_umk.is_none();

        *self.pending_oauth.lock() = Some(PendingOAuth {
            session,
            email: email.clone(),
            device_name,
            is_new,
        });

        Ok(OAuthBegin { email, is_new })
    }

    /// Phase 2 of OAuth sign-in: take the stashed session plus the account
    /// password and finalize.  On first sign-in the password is also written
    /// back to Supabase so the account gains a real credential usable for later
    /// email+password login; on return it is verified against the stored
    /// identity key inside [`Self::finalize_session`].
    pub async fn complete_oauth(&self, password: String) -> Result<SyncUser, String> {
        let pending = self
            .pending_oauth
            .lock()
            .take()
            .ok_or("no pending sign-in, start again")?;

        if pending.is_new {
            self.supabase
                .update_password(&pending.session.access_token, &password)
                .await?;
        }

        self.finalize_session(
            pending.session,
            &pending.email,
            &password,
            pending.device_name,
        )
        .await
    }

    /// Discard a stashed OAuth session (user cancelled the password step).
    pub fn cancel_oauth(&self) {
        *self.pending_oauth.lock() = None;
    }

    /// Send a Supabase password-reset email.  Restores account *access*; note
    /// that under the E2E envelope model a new password re-derives the KEK, so
    /// existing data only remains decryptable if the UMK is re-wrapped from a
    /// still-signed-in device (a future recovery path).
    pub async fn reset_password(&self, email: String) -> Result<(), String> {
        self.supabase.recover(&email).await
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
        http.set_access_token(session.access_token, session.expires_in);
        http.set_refresh_token(session.refresh_token.clone());
        http.set_user_id(user_id.clone());

        // 3. Bootstrap: fetch the KDF salt and (if the account is set up) the
        //    wrapped-UMK envelope.  The password derives only the wrapping key.
        let boot = http.bootstrap(None).await?;
        let kdf_salt = B64
            .decode(&boot.kdf_salt)
            .map_err(|e| format!("kdf_salt b64: {e}"))?;
        let kek = crypto::derive_kek(password, &kdf_salt);

        // 4. Establish the User Master Key (envelope model).
        //    - Returning account → unwrap the stored envelope.  A GCM auth
        //      failure here means the password is wrong; we abort before touching
        //      any device/key state.
        //    - Brand-new account → generate a fresh random UMK, wrap it under the
        //      KEK, and upload the envelope so every future login/device can
        //      unwrap the *same* key.
        let umk = match boot.wrapped_umk.as_deref() {
            Some(wrapped) => crypto::unwrap_umk(&kek, wrapped)?,
            None => {
                let fresh = crypto::random_key();
                let wrapped = crypto::wrap_umk(&kek, &fresh)?;
                http.set_wrapped_umk(wrapped).await?;
                fresh
            }
        };
        let (_identity_priv, identity_pub) = crypto::derive_identity_keypair(&umk);
        let identity_pub_b64 = B64.encode(identity_pub);

        // 5. Register this device — or reuse the identity from a previous login
        //    on this install, so re-logins stop minting a new device row every
        //    time. Reuse requires all three to line up: same user, a stored
        //    device id the server still lists (not revoked), and the device
        //    private key still in the keychain.
        let stored = {
            let s = self.sync_state.lock();
            (s.data.user_id.clone(), s.data.device_id.clone())
        };
        let mut reused: Option<(Zeroizing<[u8; 32]>, [u8; 32], String)> = None;
        if stored.0 == user_id && !stored.1.is_empty() {
            if let Ok(privk) = crypto::load_device_private_key(&user_id) {
                if let Ok(devices) = http.list_devices().await {
                    if devices.iter().any(|d| d.id == stored.1) {
                        let pubk = crypto::device_public_key(&privk);
                        reused = Some((privk, pubk, stored.1.clone()));
                    }
                }
            }
        }
        let (device_priv, device_pub, device_id) = match reused {
            Some(t) => t,
            None => {
                let (privk, pubk) = crypto::generate_device_keypair();
                let dev = http
                    .register_device(RegisterDeviceRequest {
                        device_name,
                        platform: std::env::consts::OS.to_string(),
                        app_version: env!("CARGO_PKG_VERSION").to_string(),
                        device_pubkey: Some(B64.encode(pubk)),
                    })
                    .await?;
                (privk, pubk, dev.device_id)
            }
        };
        http.set_device_id(device_id.clone());

        // 6. Register public keys for E2E space-key exchange.  The identity key
        //    is derived from the UMK (identical on every device).  Best-effort:
        //    a failure here only disables space sharing, not core sync.
        if let Err(e) = http
            .register_keys(client::RegisterKeysRequest {
                identity_pubkey: identity_pub_b64,
                device_pubkey: B64.encode(device_pub),
            })
            .await
        {
            eprintln!("[sync] register_keys failed (space sharing disabled): {e}");
        }

        // 7. Persist secrets to the OS keychain.
        crypto::store_device_private_key(&user_id, &device_priv)?;
        crypto::store_refresh_token(&user_id, &session.refresh_token)?;

        // 7b. Store the UMK wrapped for this device so future launches can
        //     restore the session without the password (see
        //     [`Self::try_restore_session`]). X25519 with our own public half
        //     is a valid self-shared secret, same pattern as group keys.
        //     Best-effort: failure only means the next launch asks to log in.
        {
            let shared = crypto::x25519_shared_secret(&device_priv, &device_pub);
            match crypto::wrap_key(&shared, &umk) {
                Ok(wrapped) => {
                    if let Err(e) = http.store_device_wrapped_umk(&device_id, wrapped).await {
                        eprintln!("[sync] store device umk failed (no silent restore): {e}");
                    }
                }
                Err(e) => eprintln!("[sync] wrap device umk failed: {e}"),
            }
        }

        // 8. Update persisted sync state.
        {
            let mut state = self.sync_state.lock();
            state.set_device_id(&device_id);
            state.set_user_id(&user_id);
        }

        // 9. Wire in-memory state.
        let user = SyncUser {
            user_id,
            email: user_email,
            display_name: boot.display_name,
            avatar_url: boot.avatar_url,
        };
        *self.umk.lock() = Some(umk);
        *self.http.lock() = Some(Arc::clone(&http));
        *self.user.lock() = Some(user.clone());

        // 10. Start the realtime listener.  It owns `connected` from here on —
        // setting it true at login made the status pill claim "Synced" for as
        // long as the app ran, even when the socket never came up.
        self.start_ws_listener();

        Ok(user)
    }

    /// Restore the previous session without user interaction.
    ///
    /// Requires all of: stored `user_id`/`device_id` in sync_state.json, the
    /// refresh token and device private key in the OS keychain, and a
    /// device-wrapped UMK on the server (uploaded at login, cleared on device
    /// revocation — so a revoked device cannot restore even with an intact
    /// keychain).
    ///
    /// The error tells the caller whether retrying is worth it: this runs while
    /// the app is still starting (often right after an update, before the
    /// network is back), and treating an unreachable server the same as a
    /// rejected credential is what makes a working login look like a logout.
    /// Nothing is mutated on failure either way.
    pub async fn try_restore_session(&self) -> Result<SyncUser, RestoreError> {
        if self.user.lock().is_some() {
            return self
                .current_user()
                .ok_or_else(|| RestoreError::NoSession("no session".into()));
        }

        let (stored_user, stored_device) = {
            let s = self.sync_state.lock();
            (s.data.user_id.clone(), s.data.device_id.clone())
        };
        if stored_user.is_empty() || stored_device.is_empty() {
            return Err(RestoreError::NoSession("no previous session".into()));
        }
        // Keep the underlying keychain error: "not found" and "found but
        // unreadable" are different problems, and collapsing both into one
        // message makes a failed restore impossible to diagnose from a log.
        // Either way the keychain is not going to start answering differently
        // on a retry, so these are terminal.
        let refresh = crypto::load_refresh_token(&stored_user).map_err(|e| {
            RestoreError::Terminal(format!("no stored credentials for user {stored_user}: {e}"))
        })?;
        let device_priv = crypto::load_device_private_key(&stored_user).map_err(|e| {
            RestoreError::Terminal(format!("no stored device key for user {stored_user}: {e}"))
        })?;

        // Fresh tokens from Supabase; the refresh token rotates, so persist it.
        let session = self
            .supabase
            .refresh(&refresh)
            .await
            .map_err(RestoreError::from_auth)?;
        crypto::store_refresh_token(&stored_user, &session.refresh_token)
            .map_err(RestoreError::Terminal)?;

        let http = SyncHttpClient::with_timeout(
            self.server_url.clone(),
            Arc::clone(&self.supabase),
            RESTORE_TIMEOUT_SECS,
        );
        http.set_access_token(session.access_token, session.expires_in);
        http.set_refresh_token(session.refresh_token);
        http.set_user_id(stored_user.clone());
        http.set_device_id(stored_device.clone());

        let boot = http.bootstrap(None).await.map_err(RestoreError::from_api)?;

        // Recover the UMK from the device wrap — no password involved.
        let wrapped = http
            .get_device_wrapped_umk()
            .await
            .map_err(RestoreError::from_api)?
            .ok_or_else(|| {
                RestoreError::Terminal(
                    "no device key wrap (revoked or never stored), log in again".into(),
                )
            })?;
        let device_pub = crypto::device_public_key(&device_priv);
        let shared = crypto::x25519_shared_secret(&device_priv, &device_pub);
        let umk = crypto::unwrap_key(&shared, &wrapped).map_err(RestoreError::Terminal)?;

        let user = SyncUser {
            user_id: stored_user,
            email: session.user.email.clone(),
            display_name: boot.display_name,
            avatar_url: boot.avatar_url,
        };
        *self.umk.lock() = Some(umk);
        *self.http.lock() = Some(Arc::clone(&http));
        *self.user.lock() = Some(user.clone());
        self.start_ws_listener();

        Ok(user)
    }

    /// Keep retrying a session restore that failed for a transient reason,
    /// backing off up to a minute between attempts and continuing for as long
    /// as the failures stay transient.
    ///
    /// This is what stops "the app was launched before the network came back"
    /// from reading as a logout: the stored credentials were fine all along, so
    /// the session comes back on its own instead of waiting for the user to
    /// retype a password. Emits `sync:session-restored` on success, the same
    /// event the immediate path uses, so the UI needs no special case.
    ///
    /// At most one loop runs at a time, and it stops as soon as a session
    /// exists — including one the user established by logging in manually.
    pub fn spawn_session_restore_retry(self: Arc<Self>) {
        use std::sync::atomic::Ordering;
        if self
            .restore_retrying
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return; // a loop is already running
        }

        let handle = self.handle.clone();
        handle.spawn(async move {
            let mut attempt = 0usize;
            loop {
                let delay = RESTORE_RETRY_BACKOFF_SECS
                    [attempt.min(RESTORE_RETRY_BACKOFF_SECS.len() - 1)];
                tokio::time::sleep(Duration::from_secs(delay)).await;
                attempt += 1;

                // The user may have signed in by hand while we were asleep.
                if self.user.lock().is_some() {
                    break;
                }

                match self.try_restore_session().await {
                    Ok(user) => {
                        eprintln!("[sync] session restored after {attempt} retries");
                        Arc::clone(&self).trigger_initial_sync();
                        let _ = self.app.emit("sync:session-restored", &user);
                        break;
                    }
                    Err(e) if e.is_transient() => {
                        eprintln!("[sync] session restore retry {attempt} failed: {e}");
                    }
                    Err(e) => {
                        // Credentials are genuinely dead — stop and leave the
                        // login screen up.
                        eprintln!("[sync] session restore gave up: {e}");
                        break;
                    }
                }
            }
            self.restore_retrying.store(false, Ordering::SeqCst);
        });
    }

    /// Clear all in-memory state and delete keychain entries.
    pub fn logout(&self) {
        // UMK is zeroed by Zeroizing::drop
        *self.umk.lock() = None;

        // Space keyrings are key material like the UMK — scrub, then drop.
        {
            use zeroize::Zeroize;
            let mut keyrings = self.space_keys.lock();
            for ring in keyrings.values_mut() {
                for key in ring.iter_mut() {
                    key.zeroize();
                }
            }
            keyrings.clear();
        }
        self.spaces.lock().clear();

        let user_id = self
            .user
            .lock()
            .as_ref()
            .map(|u| u.user_id.clone())
            .unwrap_or_default();
        if !user_id.is_empty() {
            crypto::delete_keychain_entries(&user_id);
        }

        let http = self.http.lock().take();
        if let Some(http) = http {
            http.logout();
        }

        *self.user.lock() = None;
        self.stop_ws_listener();
        self.status.lock().connected = false;
    }

    // ── WS management ─────────────────────────────────────────────

    /// Record whether the realtime socket is up.  Called by the WS listener on
    /// every connect and drop — it is the only writer, so the status pill and
    /// the actual connection can no longer disagree.
    pub(crate) fn set_connected(&self, connected: bool) {
        self.status.lock().connected = connected;
    }

    fn start_ws_listener(&self) {
        let current = self.http.lock().clone();
        let http = match current {
            Some(h) => h,
            None => return,
        };
        let listener = WsListener::new(self.app.clone(), http);
        listener.clone().connect(&self.handle);
        *self.ws_listener.lock() = Some(listener);
    }

    fn stop_ws_listener(&self) {
        let listener = self.ws_listener.lock().take();
        if let Some(listener) = listener {
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
        // Persist temporarily to disk so the push task can read it. Scratch data
        // read back moments later, so it needs the atomic swap but not the flush.
        let path = self.app_data.join("sync_settings_local.json");
        let _ = crate::health::replace_atomic(&path, json.as_bytes());
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
        // CEK envelope: content encrypts once under a per-entry key, which is
        // wrapped for "personal" (UMK) plus every target space.
        let targets = self.share_targets(
            "clipboard",
            &entry.id,
            &entry.groups,
            entry.kind.label(),
            |f| f.includes_clipboard(),
        );
        let (enc_key, wrapped_keys, space_ids) = match self.build_envelope(&umk, &targets) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[sync] clipboard envelope: {e}");
                return;
            }
        };

        self.handle.spawn(async move {
            let skip_label = skip_label_for(&entry);

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
                    record_skip(
                        &ctx,
                        &entry.id,
                        &skip_label,
                        format!(
                            "{} is over the 5 MB limit for synced files",
                            format_bytes(total_bytes)
                        ),
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

            // Image entries store their (encrypted) bytes in a blob and keep only
            // a small descriptor inline; text/html/file keep content inline.
            let (content, blob_key, blob_size) = if entry.kind == EntryKind::Image {
                let Some(http) = ctx.http.as_ref().filter(|h| h.is_authenticated()) else {
                    record_skip(
                        &ctx,
                        &entry.id,
                        &skip_label,
                        "Not signed in to sync when this image was copied".into(),
                    );
                    return; // image sync needs connectivity — nothing to queue
                };
                match upload_image_blob(http, &enc_key, &entry.id, &entry.content).await {
                    Ok((key, size, descriptor)) => (descriptor, Some(key), Some(size)),
                    Err(e) => {
                        eprintln!("[sync] image blob upload failed: {e}");
                        record_skip(&ctx, &entry.id, &skip_label, format!("Image upload failed: {e}"));
                        return;
                    }
                }
            } else {
                (entry.content, None, None)
            };

            let job = PushJob {
                client_id: entry.id.clone(),
                content,
                metadata_json,
                entry_type: "clipboard",
                kind: entry.kind.label().to_string(),
                // Clipboard content is immutable; use its capture time as
                // created_at and "now" as the last-write-wins clock so pin /
                // group edits (which fire on_update) always win server-side.
                created_at: entry.timestamp,
                updated_at: now_ms(),
                pinned: entry.pinned,
                space_ids,
                wrapped_keys,
                blob_key,
                blob_size,
            };
            push_entry_task(ctx, enc_key, is_update, job).await;
        });
    }

    fn spawn_push_note(&self, note: Note, umk: Zeroizing<[u8; 32]>, is_update: bool) {
        let ctx = self.push_ctx();
        let targets =
            self.share_targets("note", &note.id, &note.groups, "note", |f| f.includes_notes());
        let (enc_key, wrapped_keys, space_ids) = match self.build_envelope(&umk, &targets) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[sync] note envelope: {e}");
                return;
            }
        };

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
                space_ids,
                wrapped_keys,
                blob_key: None,
                blob_size: None,
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
        // The tombstone must reach the same spaces the entry did, so members
        // remove it too. Captured before the id_map row is dropped below.
        let space_ids = self
            .id_map
            .lock()
            .entry_shares()
            .remove(&map_key)
            .unwrap_or_default();

        self.handle.spawn(async move {
            // Always tombstone — even if offline (invariant #5).  A tombstone is
            // a push with deleted_at set, keyed by client_id (no server_id).
            if let (Some(http), Some(umk)) =
                (http.as_ref().filter(|h| h.is_authenticated()), umk.as_ref())
            {
                if let Some(req) = tombstone_req(umk, &client_id, &type_str, space_ids) {
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
    /// `client_id`).
    ///
    /// `live` marks WebSocket-delivered entries (vs. pull pages). It gates two
    /// behaviors: passive mode skips live *personal* entries (the cursor only
    /// advances on pull, so the next interval/manual pull picks them up), and
    /// auto-copy fires only for live space entries — never for backfill.
    pub(crate) fn merge_pulled(&self, entries: &[crate::sync::client::PulledEntry], live: bool) {
        use std::sync::atomic::Ordering;
        let Some(umk) = self.umk_clone() else {
            return;
        };
        let state = self.app.state::<crate::state::AppState>();
        let my_device = self.sync_state.lock().data.device_id.clone();
        let passive = *self.sync_mode.lock() == SyncMode::Passive;

        let mut clip_changed = false;
        let mut notes_changed = false;

        for e in entries {
            // Skip entries this device originated (echoed back over the user
            // channel); they are already present locally.
            if !my_device.is_empty() && e.device_id.as_deref() == Some(my_device.as_str()) {
                continue;
            }
            // Passive mode: personal entries are not applied live. Space
            // entries always are — spaces are realtime by definition.
            if live && passive && e.space_ids.is_empty() {
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

            // Unwrap the per-entry CEK: "personal" under the UMK for our own
            // entries, else through a carried space's keyring.
            let Some((content_key, from_space)) = self.unwrap_cek(&umk, e) else {
                eprintln!("[sync] merge: no usable key for {}", e.client_id);
                continue;
            };
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
                let label = meta.get("label").and_then(|l| l.as_str()).map(str::to_string);
                // Image bodies live in a blob: download + decrypt + materialize
                // asynchronously (this fn is sync).  `content` here is the small
                // descriptor `{"mime":...}` we stored inline at push time.
                if kind == EntryKind::Image {
                    if let Some(blob_key) = e.blob_key.clone() {
                        let http = self.http.lock().clone();
                        if let Some(http) = http {
                            let mime = serde_json::from_str::<serde_json::Value>(&content)
                                .ok()
                                .and_then(|v| v.get("mime").and_then(|m| m.as_str()).map(String::from))
                                .unwrap_or_else(|| "image/png".into());
                            self.spawn_blob_image_merge(
                                http,
                                content_key.clone(),
                                ImageMergeMeta {
                                    client_id: e.client_id.clone(),
                                    server_id: e.server_id.clone(),
                                    blob_key,
                                    mime,
                                    label,
                                    groups,
                                    space_ids: e.space_ids.clone(),
                                    created_at: e.created_at,
                                    pinned: e.pinned,
                                    autocopy: live && self.autocopy_enabled(&e.space_ids),
                                    remote: from_space,
                                },
                            );
                        }
                    }
                    continue;
                }
                // File-content sync is not wired (paths are machine-specific);
                // file entries remain local-only on the receiving device.
                if kind == EntryKind::File {
                    continue;
                }
                let merged = ClipboardEntry {
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
                };
                // Auto-copy: only live space entries, per the receiving
                // device's per-space toggle. Backfill never touches the
                // clipboard.
                let autocopy = live && self.autocopy_enabled(&e.space_ids);
                if autocopy {
                    crate::clipboard::commands::copy_entry_suppressed(&self.app, &merged);
                }
                state.history.lock().upsert_synced(merged);
                clip_changed = true;
            }

            let key = format!(
                "{}:{}",
                if is_note { "note" } else { "clipboard" },
                e.client_id
            );
            let mut id_map = self.id_map.lock();
            id_map.set_entry(&key, &e.server_id);
            // The sender's metadata carries *their* local group names, which say
            // nothing about the space the entry travelled through. Recording the
            // server ids is what lets the Spaces screen place a received entry
            // under the space it actually came from.
            id_map.set_entry_shares(&key, &e.space_ids);
            if from_space {
                id_map.mark_entry_remote(&key);
            }
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
                PendingOp::Push { entry_json, entry_type }
                | PendingOp::Update { entry_json, entry_type } => {
                    // Old-format queue entries (pre-CEK, no wrapped_keys) fail
                    // to parse and are dropped here — their ciphertext could
                    // not be decrypted under the new envelope anyway.
                    if let Ok(req) = serde_json::from_str::<PushEntryRequest>(&entry_json) {
                        let space_ids = req.space_ids.clone();
                        if let Ok(result) = http.push_entries(vec![req]).await {
                            for r in result.accepted {
                                // Key by the op's own type. Hardcoding
                                // "clipboard" filed every flushed note under a
                                // key nothing would ever look up or clean out.
                                let key = format!("{entry_type}:{}", r.client_id);
                                let mut id_map = self.id_map.lock();
                                id_map.set_entry(&key, &r.server_id);
                                id_map.set_entry_shares(&key, &space_ids);
                            }
                        }
                    }
                }
                PendingOp::Delete { client_id, entry_type } => {
                    if let Some(umk) = self.umk_clone() {
                        let map_key = format!("{entry_type}:{client_id}");
                        let space_ids = self
                            .id_map
                            .lock()
                            .entry_shares()
                            .remove(&map_key)
                            .unwrap_or_default();
                        if let Some(req) = tombstone_req(&umk, &client_id, &entry_type, space_ids)
                        {
                            let _ = http.push_entries(vec![req]).await;
                            self.id_map.lock().remove_entry(&map_key);
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
                    self.merge_pulled(&pull.entries, false);
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

    /// This install's server-assigned device id, if it has one.
    pub fn device_id(&self) -> Option<String> {
        let id = self.sync_state.lock().data.device_id.clone();
        if id.is_empty() { None } else { Some(id) }
    }

    pub fn status_info(&self) -> SyncStatusInfo {
        let mut info = self.status.lock().clone();
        // A worker that panicked leaves `connected` stuck true, so the pill would
        // claim everything is synced while nothing is running. Report the truth.
        if crate::health::is_degraded() {
            info.connected = false;
        }
        info
    }

    /// Per-entry sync state keyed `"clipboard:{id}"` / `"note:{id}"`, for the
    /// cloud badge on entry cards.  Queued work wins over an earlier ack: an
    /// entry that synced and then got edited offline is pending, not synced.
    pub fn entry_states(&self) -> HashMap<String, &'static str> {
        let mut states: HashMap<String, &'static str> = self
            .id_map
            .lock()
            .entry_keys()
            .into_iter()
            .map(|key| (key, "synced"))
            .collect();
        for key in self.pending_queue.lock().pending_keys() {
            states.insert(key, "pending");
        }
        states
    }

    /// Server group ids per entry, for the Sync screen's feed matching.
    pub fn entry_shares(&self) -> HashMap<String, Vec<String>> {
        self.id_map.lock().entry_shares()
    }

    /// Entry keys another member wrote, for the direction glyph on space rows.
    pub fn remote_entries(&self) -> Vec<String> {
        self.id_map.lock().remote_entries()
    }

    /// The recorded skips, for a retry pass that needs their client ids.
    pub fn skipped(&self) -> Vec<SkippedEntry> {
        self.status.lock().skipped.clone()
    }

    /// Drop the recorded skips (and their count) after the user has seen them.
    pub fn clear_skipped(&self) {
        let mut status = self.status.lock();
        status.skipped_count = 0;
        status.skipped.clear();
    }

    /// The cached space list (refreshed by [`Self::reconcile_spaces`]).
    pub fn spaces(&self) -> Vec<Space> {
        self.spaces.lock().clone()
    }

    /// Flip a member's presence across every cached space they appear in,
    /// then tell the UI.  Driven by the `user:presence` WS event.
    pub(crate) fn apply_member_presence(&self, user_id: &str, online: bool) {
        let mut changed = false;
        {
            let mut spaces = self.spaces.lock();
            for space in spaces.iter_mut() {
                for member in space.members.iter_mut() {
                    if member.user_id == user_id && member.online != online {
                        member.online = online;
                        changed = true;
                    }
                }
            }
        }
        if changed {
            let _ = self.app.emit(
                "space:presence-changed",
                serde_json::json!({ "user_id": user_id, "online": online }),
            );
        }
    }

    /// Spawn a background flush + delta pull on the sync runtime.  Called right
    /// after login so a freshly-signed-in device catches up without blocking
    /// the `sync_login` command's return.
    pub fn trigger_initial_sync(self: Arc<Self>) {
        let handle = self.handle.clone();
        handle.spawn(async move {
            // Recover space keyrings *before* pulling: they are memory-only, so
            // without this the first pull after a restart could not decrypt any
            // shared entry.
            self.reconcile_spaces().await;
            if let Err(e) = self.flush_and_pull().await {
                eprintln!("[sync] initial sync failed: {e}");
            }
        });
    }

    /// Start the passive-mode pull loop: every 5 minutes, if the mode is
    /// Passive and a session exists, run a flush + delta pull.  Holds only a
    /// `Weak` so the loop cannot keep a logged-out client (and its runtime)
    /// alive; it ends when the client is dropped.
    pub fn spawn_passive_pull_loop(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        self.handle.spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(PASSIVE_PULL_INTERVAL_SECS)).await;
                let Some(sync) = weak.upgrade() else { break };
                let due = *sync.sync_mode.lock() == SyncMode::Passive
                    && sync.user.lock().is_some();
                if due {
                    if let Err(e) = sync.flush_and_pull().await {
                        eprintln!("[sync] passive pull: {e}");
                    }
                }
            }
        });
    }

    // ── Sync mode & send filters ──────────────────────────────────

    pub fn sync_mode(&self) -> SyncMode {
        *self.sync_mode.lock()
    }

    /// Update the in-memory mode (the command persists it to settings.json).
    pub fn set_sync_mode(&self, mode: SyncMode) {
        *self.sync_mode.lock() = mode;
    }

    pub fn send_filters(&self) -> HashMap<String, SendFilter> {
        self.send_filters.lock().clone()
    }

    /// Update one space's send filter in memory (the command persists the map).
    pub fn set_send_filter(&self, space_id: &str, filter: SendFilter) {
        self.send_filters
            .lock()
            .insert(space_id.to_string(), filter);
    }

    /// Re-read the filter map and mode from settings.json — called after a
    /// settings pull lands roamed filter values on disk.
    pub fn reload_local_sync_prefs(&self) {
        let (filters, mode) = load_local_sync_prefs(&self.app_data);
        *self.send_filters.lock() = filters;
        *self.sync_mode.lock() = mode;
    }

    /// Whether any of `space_ids` has this device's auto-copy toggle on.
    /// Read from settings.json each time — merges are rare and the toggle can
    /// be flipped from the UI at any moment.
    fn autocopy_enabled(&self, space_ids: &[String]) -> bool {
        if space_ids.is_empty() {
            return false;
        }
        let Ok(data) = std::fs::read_to_string(self.app_data.join("settings.json")) else {
            return false;
        };
        let Ok(map) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&data)
        else {
            return false;
        };
        space_ids.iter().any(|sid| {
            map.get(&format!("space_autocopy:{sid}"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        })
    }

    // ── Space key exchange ────────────────────────────────────────

    /// Derive this user's identity keypair `(private, public)` from the
    /// in-memory UMK.  Identical on every device; `None` when logged out.
    pub fn identity_keypair(&self) -> Option<(Zeroizing<[u8; 32]>, [u8; 32])> {
        let umk = self.umk_clone()?;
        Some(crypto::derive_identity_keypair(&umk))
    }

    /// The current (newest) key for a space, if we hold its keyring.
    fn space_current_key(&self, space_id: &str) -> Option<[u8; 32]> {
        self.space_keys
            .lock()
            .get(space_id)
            .and_then(|ring| ring.first().copied())
    }

    /// The spaces an outgoing entry fans out to.
    ///
    /// An entry that has been pushed before keeps its recorded shares — edits
    /// (pin, label) never silently change where something already went, and an
    /// explicit share/un-share via `set_entry_shares` is authoritative.  A
    /// *new* entry flows into every space whose send filter matches (default:
    /// none — explicit only).  Spaces we hold no key for are skipped:
    /// encrypting under a key nobody holds would produce entries nobody could
    /// read.
    fn share_targets(
        &self,
        entry_type: &str,
        client_id: &str,
        group_names: &[String],
        kind: &str,
        want: impl Fn(&SendFilter) -> bool,
    ) -> Vec<String> {
        let entry_key = format!("{entry_type}:{client_id}");
        let recorded = self.id_map.lock().entry_shares().remove(&entry_key);
        let targets = match recorded {
            Some(ids) => ids,
            None => self
                .send_filters
                .lock()
                .iter()
                .filter(|(_, f)| {
                    f.enabled
                        && want(f)
                        && (f.kinds.is_empty() || f.kinds.iter().any(|k| k == kind))
                        && (f.groups.is_empty()
                            || f.groups.iter().any(|g| group_names.contains(g)))
                })
                .map(|(sid, _)| sid.clone())
                .collect(),
        };
        targets
            .into_iter()
            .filter(|sid| {
                let keyed = self.space_current_key(sid).is_some();
                if !keyed {
                    eprintln!("[sync] no key for space {sid}; entry {client_id} not shared there");
                }
                keyed
            })
            .collect()
    }

    /// Mint the per-entry content key (CEK) and its wrapped-copies envelope:
    /// one wrap under the UMK (`"personal"`) and one per target space's current
    /// key.  Returns `(cek, wrapped_keys_json, space_ids)` — the content is
    /// then encrypted exactly once under the CEK, which is what lets a single
    /// ciphertext fan out to several spaces.
    fn build_envelope(
        &self,
        umk: &Zeroizing<[u8; 32]>,
        targets: &[String],
    ) -> Result<(Zeroizing<[u8; 32]>, String, Vec<String>), String> {
        let cek = crypto::random_key();
        let mut wraps = serde_json::Map::new();
        wraps.insert("personal".into(), crypto::wrap_key(umk, &cek)?.into());
        let mut space_ids = Vec::new();
        for sid in targets {
            let Some(space_key) = self.space_current_key(sid) else {
                continue; // filtered upstream; belt and suspenders
            };
            wraps.insert(sid.clone(), crypto::wrap_key(&space_key, &cek)?.into());
            space_ids.push(sid.clone());
        }
        let json = serde_json::to_string(&serde_json::Value::Object(wraps))
            .map_err(|e| format!("envelope json: {e}"))?;
        Ok((cek, json, space_ids))
    }

    /// Unwrap a pulled entry's CEK.  Our own entries carry a `"personal"` wrap
    /// under the UMK; space entries are tried against each carried space's
    /// keyring, newest key first (an AES-GCM auth failure just means "wrong
    /// key", so trial decryption is safe and epoch-free).
    /// Returns the entry's content key and whether it had to come from a space
    /// keyring. Our own entries always carry a "personal" wrap, so the space
    /// path means another member wrote this one — that flag is the direction
    /// the Spaces rows show.
    fn unwrap_cek(
        &self,
        umk: &Zeroizing<[u8; 32]>,
        e: &crate::sync::client::PulledEntry,
    ) -> Option<(Zeroizing<[u8; 32]>, bool)> {
        let wraps: HashMap<String, String> = serde_json::from_str(&e.wrapped_keys).ok()?;
        if let Some(w) = wraps.get("personal") {
            if let Ok(cek) = crypto::unwrap_key(umk, w) {
                return Some((cek, false));
            }
        }
        let keyrings = self.space_keys.lock();
        for sid in &e.space_ids {
            let (Some(w), Some(ring)) = (wraps.get(sid), keyrings.get(sid)) else {
                continue;
            };
            for key in ring {
                if let Ok(cek) = crypto::unwrap_key(key, w) {
                    return Some((cek, true));
                }
            }
        }
        None
    }

    /// Reconcile space keyrings with the server; refreshes the cached space
    /// list and returns it.
    ///
    /// For every space we belong to: recover our keyring by unwrapping the
    /// server-side `my_wrapped_space_keys` against the owner's identity key.
    /// If we *are* the owner: mint a key when the space has none yet, mint a
    /// **new** key on top of the ring when the server cleared the wrapped
    /// keyrings (that is the rekey signal after a member was removed), and
    /// (re)wrap the full keyring for every member who needs it.  Members
    /// without a registered identity key are skipped and picked up next run.
    ///
    /// Idempotent, and safe to call on login, on `space:rekey`, and whenever
    /// membership changes: distribution only happens while someone lacks keys,
    /// so the rekey events it echoes back cannot loop.
    pub(crate) async fn reconcile_spaces(self: &Arc<Self>) -> Vec<Space> {
        let Some(http) = self.http.lock().clone() else {
            return self.spaces();
        };
        let Some((id_priv, _id_pub)) = self.identity_keypair() else {
            return self.spaces();
        };
        let me = match self.current_user() {
            Some(u) => u.user_id,
            None => return self.spaces(),
        };

        let server_spaces = match http.list_spaces().await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[sync] reconcile spaces: {e}");
                return self.spaces();
            }
        };

        // Prune keyrings of spaces that no longer exist (deleted / we left),
        // scrubbing the key bytes on the way out.
        {
            use zeroize::Zeroize;
            let server_ids: Vec<&str> = server_spaces.iter().map(|s| s.id.as_str()).collect();
            self.space_keys.lock().retain(|id, ring| {
                let keep = server_ids.contains(&id.as_str());
                if !keep {
                    for key in ring.iter_mut() {
                        key.zeroize();
                    }
                }
                keep
            });
        }

        let mut out = Vec::new();
        for s in server_spaces {
            let owner_pub = s
                .members
                .iter()
                .find(|m| m.user_id == s.owner_id)
                .and_then(|m| m.identity_pubkey.as_deref())
                .and_then(decode_pubkey);

            // ── Recover our keyring from the server-side wrapped copy ────
            // An empty wrap does NOT clear in-memory keys: the server clears
            // keyrings to signal a pending rekey, and the owner needs the old
            // ring to keep history readable under the new distribution.
            let server_keyring: Vec<String> = s
                .my_wrapped_space_keys
                .as_deref()
                .and_then(|j| serde_json::from_str(j).ok())
                .unwrap_or_default();
            if !server_keyring.is_empty() {
                if let Some(owner_pub) = owner_pub {
                    let shared = crypto::x25519_shared_secret(&id_priv, &owner_pub);
                    let mut ring: SpaceKeyring = Vec::with_capacity(server_keyring.len());
                    for wrapped in &server_keyring {
                        match crypto::unwrap_key(&shared, wrapped) {
                            Ok(key) => ring.push(*key),
                            Err(e) => eprintln!("[sync] unwrap space key {}: {e}", s.id),
                        }
                    }
                    if !ring.is_empty() {
                        let mut guard = self.space_keys.lock();
                        let had = guard.get(&s.id).is_some_and(|r| !r.is_empty());
                        let changed = guard.get(&s.id) != Some(&ring);
                        if changed {
                            guard.insert(s.id.clone(), ring);
                        }
                        drop(guard);
                        if changed && !had {
                            // Newly able to read this space — tell the UI so
                            // the feed refreshes without a manual reload.
                            let _ = self.app.emit(
                                "space:key-received",
                                serde_json::json!({ "space_id": s.id }),
                            );
                        }
                    }
                }
            }

            // ── Owner: mint / rekey, then wrap for whoever needs it ──────
            if s.owner_id == me {
                // The server clearing every wrapped keyring (ours included) is
                // the rekey signal left behind by a member removal.
                let needs_rekey = server_keyring.is_empty();
                let mut ring = self
                    .space_keys
                    .lock()
                    .get(&s.id)
                    .cloned()
                    .unwrap_or_default();
                let mut redistribute_all = false;
                if ring.is_empty() {
                    // Brand-new space — or a rekey after a restart, where the
                    // previous keys are unrecoverable (they lived only in
                    // memory once the server cleared the wraps).
                    ring.push(*crypto::random_key());
                    redistribute_all = true;
                } else if needs_rekey {
                    // New key on top; older keys stay so history remains
                    // readable. The removed member never sees the new one.
                    ring.insert(0, *crypto::random_key());
                    redistribute_all = true;
                }
                self.space_keys.lock().insert(s.id.clone(), ring.clone());

                let mut wrapped_keyrings = Vec::new();
                for m in &s.members {
                    if m.has_space_key && !redistribute_all {
                        continue; // already holds the current ring
                    }
                    let Some(member_pub) = m.identity_pubkey.as_deref().and_then(decode_pubkey)
                    else {
                        continue; // hasn't registered keys yet — retried next run
                    };
                    // Wrapping for ourselves works too: X25519(priv, own_pub)
                    // is a valid shared secret, which is how the owner recovers
                    // after a restart.
                    let shared = crypto::x25519_shared_secret(&id_priv, &member_pub);
                    let mut wrapped: Vec<String> = Vec::with_capacity(ring.len());
                    let mut failed = false;
                    for key in &ring {
                        match crypto::wrap_key(&shared, key) {
                            Ok(w) => wrapped.push(w),
                            Err(e) => {
                                eprintln!("[sync] wrap space key for {}: {e}", m.user_id);
                                failed = true;
                                break;
                            }
                        }
                    }
                    if failed {
                        continue;
                    }
                    match serde_json::to_string(&wrapped) {
                        Ok(json) => wrapped_keyrings.push(WrappedKeyringEntry {
                            user_id: m.user_id.clone(),
                            wrapped_space_keys: json,
                        }),
                        Err(e) => eprintln!("[sync] keyring json for {}: {e}", m.user_id),
                    }
                }

                if !wrapped_keyrings.is_empty() {
                    if let Err(e) = http
                        .distribute_space_keys(&s.id, DistributeKeysRequest { wrapped_keyrings })
                        .await
                    {
                        eprintln!("[sync] distribute space keys for {}: {e}", s.id);
                    }
                }
            }

            out.push(Space {
                is_owner: s.owner_id == me,
                member_count: s.members.len() as u32,
                members: s
                    .members
                    .into_iter()
                    .map(|m| SpaceMember {
                        user_id: m.user_id,
                        display_name: m.display_name,
                        avatar_url: m.avatar_url,
                        role: m.role,
                        has_space_key: m.has_space_key,
                        online: m.online,
                    })
                    .collect(),
                id: s.id,
                name: s.name,
                owner_id: s.owner_id,
                share_history: s.share_history,
                invite_code: s.invite_code,
                invite_expires_at: s.invite_expires_at,
            });
        }

        *self.spaces.lock() = out.clone();
        out
    }

    /// `space:rekey` arrived: the server persisted a fresh wrapped keyring for
    /// us (or someone else, echoed back).  A plain reconcile recovers whatever
    /// changed; it cannot loop because reconcile only distributes while a
    /// member still lacks keys.
    pub(crate) fn handle_space_rekey(self: &Arc<Self>) {
        let this = Arc::clone(self);
        self.handle.spawn(async move {
            this.reconcile_spaces().await;
        });
    }

    /// Download, decrypt, and materialize an image blob to the images dir, then
    /// upsert the entry into history.  Runs on the background runtime because
    /// `merge_pulled` (its caller) is synchronous.  A download failure (e.g. a
    /// blob owned by another Live Share member — download URLs are owner-only)
    /// is logged and skipped, not fatal.
    fn spawn_blob_image_merge(
        &self,
        http: Arc<SyncHttpClient>,
        key: Zeroizing<[u8; 32]>,
        meta: ImageMergeMeta,
    ) {
        use std::sync::atomic::Ordering;
        let app = self.app.clone();
        let images_dir = self
            .app
            .path()
            .app_data_dir()
            .ok()
            .map(|d| d.join("images"));
        let id_map = Arc::clone(&self.id_map);

        self.handle.spawn(async move {
            let Ok(dl) = http.blob_download_url(&meta.blob_key).await else {
                eprintln!("[sync] image blob {} download-url failed (skipped)", meta.blob_key);
                return;
            };
            let Ok(cipher) = http.download_blob_bytes(&dl.presigned_get_url).await else {
                return;
            };
            let Ok(bytes) = crypto::decrypt_bytes(&key, &cipher, &meta.client_id) else {
                eprintln!("[sync] image blob {} decrypt failed", meta.client_id);
                return;
            };
            let Some(dir) = images_dir else { return };
            let path = dir.join(format!("{}.{}", meta.client_id, ext_for_mime(&meta.mime)));
            // Atomic, because the entry upserted below points at this file — a
            // torn write would leave history referencing a truncated image.
            if crate::health::replace_atomic(&path, &bytes).is_err() {
                return;
            }

            let state = app.state::<crate::state::AppState>();
            let merged = ClipboardEntry {
                id: meta.client_id.clone(),
                kind: EntryKind::Image,
                content: path.to_string_lossy().to_string(),
                timestamp: meta.created_at,
                pinned: meta.pinned,
                groups: meta.groups,
                label: meta.label,
                content_hash: None,
                server_id: Some(meta.server_id.clone()),
                sync_status: crate::sync::types::SyncStatus::Synced,
            };
            if meta.autocopy {
                crate::clipboard::commands::copy_entry_suppressed(&app, &merged);
            }
            state.history.lock().upsert_synced(merged);
            state.history.lock().sort_recent();
            state.history_dirty.store(true, Ordering::Relaxed);
            let key = format!("clipboard:{}", meta.client_id);
            let mut id_map = id_map.lock();
            id_map.set_entry(&key, &meta.server_id);
            id_map.set_entry_shares(&key, &meta.space_ids);
            if meta.remote {
                id_map.mark_entry_remote(&key);
            }
            drop(id_map);
            let _ = app.emit("sync:history-merged", serde_json::Value::Null);
        });
    }

    pub fn http(&self) -> Option<Arc<SyncHttpClient>> {
        self.http.lock().clone()
    }

    pub fn umk_clone(&self) -> Option<Zeroizing<[u8; 32]>> {
        self.umk.lock().clone()
    }
}

/// Resolve an image entry's raw bytes + MIME type.  `content` is either a
/// `data:<mime>;base64,…` URL (fresh capture) or an on-disk path (externalized).
fn read_image_bytes(content: &str) -> Result<(Vec<u8>, String), String> {
    if let Some(pos) = content.find(";base64,") {
        let mime = content.get(5..pos).unwrap_or("image/png").to_string();
        let raw = B64
            .decode(&content[pos + 8..])
            .map_err(|e| format!("image b64: {e}"))?;
        Ok((raw, mime))
    } else {
        let bytes = std::fs::read(content).map_err(|e| format!("read image file: {e}"))?;
        Ok((bytes, mime_from_path(content)))
    }
}

/// Guess an image MIME type from a file path extension.
fn mime_from_path(path: &str) -> String {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
    .to_string()
}

/// File extension for an image MIME type (for the materialized filename).
fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        _ => "png",
    }
}

/// How many skips the status snapshot keeps.  Enough to explain a bad run
/// without letting a broken blob store grow the list without bound.
const SKIPPED_HISTORY_LIMIT: usize = 20;

fn format_bytes(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.0} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

/// A short human label for an entry, used when telling the user which item
/// sync refused to send.
fn skip_label_for(entry: &ClipboardEntry) -> String {
    if let Some(label) = entry.label.as_ref().filter(|l| !l.trim().is_empty()) {
        return label.clone();
    }
    match entry.kind {
        EntryKind::Image => "Image".into(),
        EntryKind::File => entry
            .content
            .lines()
            .next()
            .and_then(|p| std::path::Path::new(p).file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "File".into()),
        _ => {
            let text: String = entry.content.trim().chars().take(40).collect();
            if text.is_empty() { "Clipboard item".into() } else { text }
        }
    }
}

/// Record an entry sync refused to send: bump the count, keep the reason for
/// the Account screen, and tell the UI so it can surface it immediately.
fn record_skip(ctx: &PushCtx, client_id: &str, label: &str, reason: String) {
    {
        let mut status = ctx.status.lock();
        status.skipped_count += 1;
        status.skipped.insert(
            0,
            SkippedEntry {
                client_id: client_id.to_string(),
                label: label.to_string(),
                reason: reason.clone(),
                at: now_ms(),
            },
        );
        status.skipped.truncate(SKIPPED_HISTORY_LIMIT);
    }
    let _ = ctx.app.emit(
        "sync:entry-skipped",
        serde_json::json!({ "client_id": client_id, "label": label, "reason": reason }),
    );
}

/// Encrypt an image entry's bytes and upload them as a blob.  Returns
/// `(blob_key, ciphertext_size, descriptor_json)` — the descriptor (`{"mime":…}`)
/// is what gets stored inline as the entry's `encrypted_content`.
async fn upload_image_blob(
    http: &SyncHttpClient,
    enc_key: &[u8; 32],
    client_id: &str,
    content: &str,
) -> Result<(String, u64, String), String> {
    let (bytes, mime) = read_image_bytes(content)?;
    let ciphertext = crypto::encrypt_bytes(enc_key, &bytes, client_id)?;
    let size = ciphertext.len() as u64;
    let checksum = crypto::sha256_hex(&ciphertext);
    let up = http
        .request_blob_upload(BlobUploadRequest {
            mime_type: mime.clone(),
            size_bytes: size,
            checksum,
        })
        .await?;
    http.upload_blob_bytes(&up.presigned_put_url, ciphertext, &mime)
        .await?;
    http.confirm_blob_upload(&up.blob_key).await?;
    let descriptor = serde_json::json!({ "mime": mime }).to_string();
    Ok((up.blob_key, size, descriptor))
}

/// Encrypt and push one entry (clipboard or note); queue it when offline.
/// Shared body of `spawn_push_clipboard_entry` / `spawn_push_note`.  `enc_key`
/// is the entry's freshly minted CEK; `job.wrapped_keys` carries its envelope.
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
        space_ids,
        wrapped_keys,
        blob_key,
        blob_size,
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

    // Record the spaces this entry went into before the push is attempted, so
    // the sender's own Spaces screen shows their contribution whether or not
    // the request succeeds (a queued push carries the same space_ids).
    let entry_key = format!("{entry_type}:{client_id}");
    ctx.id_map.lock().set_entry_shares(&entry_key, &space_ids);

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
        blob_key,
        blob_size,
        space_ids,
        wrapped_keys,
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
    // Nothing else fires when a push falls back to the queue, so without this
    // the card's "waiting to upload" badge would not appear until some
    // unrelated sync event happened to refresh it.
    let _ = ctx.app.emit(
        "sync:entry-queued",
        serde_json::json!({ "client_id": client_id, "entry_type": entry_type }),
    );
}
