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
    SyncHttpClient, WrappedKeyEntry,
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
    created_at: u64,
    pinned: bool,
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
    /// Active Live Share sessions (includes cached group keys).
    sharing_sessions: Arc<Mutex<Vec<SharingSession>>>,
    /// Pool-group Group Keys by server group id. In memory only, like the UMK
    /// and session keys — recovered from `my_wrapped_group_key` on next sync.
    group_keys: Arc<Mutex<HashMap<String, [u8; 32]>>>,

    /// WebSocket listener — replaced on reconnect.
    ws_listener: Mutex<Option<Arc<WsListener>>>,

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
            pending_oauth: Mutex::new(None),
            pending_queue,
            id_map,
            sync_state,
            status,
            sharing_sessions: Arc::new(Mutex::new(Vec::new())),
            group_keys: Arc::new(Mutex::new(HashMap::new())),
            ws_listener: Mutex::new(None),
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
                Err("Account created — check your email to confirm it, then log in.".into())
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
        http.set_access_token(session.access_token.clone());
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
            .ok_or("no pending sign-in — start again")?;

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
        http.set_access_token(session.access_token);
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

        // 6. Register public keys for E2E group-key exchange.  The identity key
        //    is derived from the UMK (identical on every device).  Best-effort:
        //    a failure here only disables group sharing, not core sync.
        if let Err(e) = http
            .register_keys(client::RegisterKeysRequest {
                identity_pubkey: identity_pub_b64,
                device_pubkey: B64.encode(device_pub),
            })
            .await
        {
            eprintln!("[sync] register_keys failed (group sharing disabled): {e}");
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
        self.status.lock().connected = true;

        // 10. Start the realtime listener.
        self.start_ws_listener();

        Ok(user)
    }

    /// Restore the previous session without user interaction.
    ///
    /// Requires all of: stored `user_id`/`device_id` in sync_state.json, the
    /// refresh token and device private key in the OS keychain, and a
    /// device-wrapped UMK on the server (uploaded at login, cleared on device
    /// revocation — so a revoked device cannot restore even with an intact
    /// keychain). Any missing piece returns Err and the UI shows the login
    /// screen; nothing is mutated on failure.
    pub async fn try_restore_session(&self) -> Result<SyncUser, String> {
        if self.user.lock().is_some() {
            return self.current_user().ok_or_else(|| "no session".into());
        }

        let (stored_user, stored_device) = {
            let s = self.sync_state.lock();
            (s.data.user_id.clone(), s.data.device_id.clone())
        };
        if stored_user.is_empty() || stored_device.is_empty() {
            return Err("no previous session".into());
        }
        // Keep the underlying keychain error: "not found" and "found but
        // unreadable" are different problems, and collapsing both into one
        // message makes a failed restore impossible to diagnose from a log.
        let refresh = crypto::load_refresh_token(&stored_user)
            .map_err(|e| format!("no stored credentials for user {stored_user}: {e}"))?;
        let device_priv = crypto::load_device_private_key(&stored_user)
            .map_err(|e| format!("no stored device key for user {stored_user}: {e}"))?;

        // Fresh tokens from Supabase; the refresh token rotates, so persist it.
        let session = self.supabase.refresh(&refresh).await?;
        crypto::store_refresh_token(&stored_user, &session.refresh_token)?;

        let http = SyncHttpClient::new(self.server_url.clone(), Arc::clone(&self.supabase));
        http.set_access_token(session.access_token);
        http.set_refresh_token(session.refresh_token);
        http.set_user_id(stored_user.clone());
        http.set_device_id(stored_device.clone());

        let boot = http.bootstrap(None).await?;

        // Recover the UMK from the device wrap — no password involved.
        let wrapped = http
            .get_device_wrapped_umk()
            .await?
            .ok_or("no device key wrap (revoked or never stored) — log in again")?;
        let device_pub = crypto::device_public_key(&device_priv);
        let shared = crypto::x25519_shared_secret(&device_priv, &device_pub);
        let umk = crypto::unwrap_key(&shared, &wrapped)?;

        let user = SyncUser {
            user_id: stored_user,
            email: session.user.email.clone(),
            display_name: boot.display_name,
            avatar_url: boot.avatar_url,
        };
        *self.umk.lock() = Some(umk);
        *self.http.lock() = Some(Arc::clone(&http));
        *self.user.lock() = Some(user.clone());
        self.status.lock().connected = true;
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
        // Shared entries encrypt under the session Group Key (§15.2); personal
        // ones under the UMK.
        let (enc_key, group_ids) =
            self.share_target(umk, &entry.groups, |s| s.my_scope.includes_clipboard());

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

            // Image entries store their (encrypted) bytes in a blob and keep only
            // a small descriptor inline; text/html/file keep content inline.
            let (content, blob_key, blob_size) = if entry.kind == EntryKind::Image {
                let Some(http) = ctx.http.as_ref().filter(|h| h.is_authenticated()) else {
                    return; // image sync needs connectivity — nothing to queue
                };
                match upload_image_blob(http, &enc_key, &entry.id, &entry.content).await {
                    Ok((key, size, descriptor)) => (descriptor, Some(key), Some(size)),
                    Err(e) => {
                        eprintln!("[sync] image blob upload failed: {e}");
                        ctx.status.lock().skipped_count += 1;
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
                group_ids,
                blob_key,
                blob_size,
            };
            push_entry_task(ctx, enc_key, is_update, job).await;
        });
    }

    fn spawn_push_note(&self, note: Note, umk: Zeroizing<[u8; 32]>, is_update: bool) {
        let ctx = self.push_ctx();
        let (enc_key, group_ids) =
            self.share_target(umk, &note.groups, |s| s.my_scope.includes_notes());

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
                let label = meta.get("label").and_then(|l| l.as_str()).map(str::to_string);
                // Image bodies live in a blob: download + decrypt + materialize
                // asynchronously (this fn is sync).  `content` here is the small
                // descriptor `{"mime":...}` we stored inline at push time.
                if kind == EntryKind::Image {
                    if let Some(blob_key) = e.blob_key.clone() {
                        if let Some(http) = self.http.lock().clone() {
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
                                    created_at: e.created_at,
                                    pinned: e.pinned,
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
            // Recover pool-group and session keys *before* pulling: both are
            // memory-only, so without this the first pull after a restart would
            // fail to decrypt every shared entry and fall back to the UMK.
            self.reconcile_group_keys().await;
            self.refresh_sharing_sessions().await;
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

    /// The cached Group Key for a pool group, if we hold one.
    fn pool_group_key(&self, group_id: &str) -> Option<[u8; 32]> {
        self.group_keys.lock().get(group_id).copied()
    }

    fn set_pool_group_key(&self, group_id: &str, key: [u8; 32]) {
        self.group_keys.lock().insert(group_id.to_string(), key);
    }

    /// Resolve an entry's local group *names* to the server pool-group ids we
    /// hold a Group Key for. Names without a mapping, or groups we have no key
    /// for, are skipped — encrypting under a key no member holds would produce
    /// entries nobody (including us, on another device) could read.
    fn keyed_pool_groups(&self, group_names: &[String]) -> Vec<(String, [u8; 32])> {
        let id_map = self.id_map.lock();
        group_names
            .iter()
            .filter_map(|name| id_map.get_group_server_id(name).map(str::to_string))
            .filter_map(|gid| self.pool_group_key(&gid).map(|k| (gid, k)))
            .collect()
    }

    /// Pick the content-encryption key + fan-out target for an outgoing entry.
    ///
    /// Precedence: an entry explicitly tagged into a pool group we hold a key for
    /// is shared with that group — that's a deliberate user action, so it wins
    /// over an ambient Live Share session. Otherwise fall back to a matching
    /// Live Share session, and failing that it's personal (UMK, no group_ids).
    fn share_target(
        &self,
        umk: Zeroizing<[u8; 32]>,
        group_names: &[String],
        want: impl Fn(&SharingSession) -> bool,
    ) -> (Zeroizing<[u8; 32]>, Vec<String>) {
        let pools = self.keyed_pool_groups(group_names);
        if let Some((gid, key)) = pools.first() {
            // One key per entry: AES-GCM encrypts under a single key, so an entry
            // in several groups is shared into the first we hold a key for.
            return (Zeroizing::new(*key), vec![gid.clone()]);
        }

        let guard = self.sharing_sessions.lock();
        match guard.iter().find(|s| want(s) && s.group_key.is_some()) {
            Some(s) => (
                Zeroizing::new(s.group_key.expect("checked is_some")),
                vec![s.share_group_id.clone()],
            ),
            None => (umk, Vec::new()),
        }
    }

    /// The key to decrypt a pulled entry: a Live Share session key or a pool
    /// Group Key when the entry is tagged with one we hold, else the personal UMK.
    fn decryption_key_for(
        &self,
        umk: &Zeroizing<[u8; 32]>,
        group_ids: &[String],
    ) -> Zeroizing<[u8; 32]> {
        group_ids
            .iter()
            .find_map(|gid| {
                self.session_group_key(gid)
                    .or_else(|| self.pool_group_key(gid))
                    .map(Zeroizing::new)
            })
            .unwrap_or_else(|| umk.clone())
    }

    /// Reconcile pool-group Group Keys with the server.
    ///
    /// For each pool group we belong to: recover our key by unwrapping
    /// `my_wrapped_group_key` against the owner's identity key; and if we *are*
    /// the owner, mint a key when the group has none yet and (re)wrap it for every
    /// member who has published an identity key. Members without one are skipped
    /// and picked up the next time this runs.
    ///
    /// Idempotent, and safe to call on login, on `group:rekey`, and whenever
    /// membership changes.
    pub(crate) async fn reconcile_group_keys(self: &Arc<Self>) {
        let Some(http) = self.http.lock().clone() else {
            return;
        };
        let Some((id_priv, id_pub)) = self.identity_keypair() else {
            return;
        };
        let me = match self.current_user() {
            Some(u) => u.user_id,
            None => return,
        };

        let groups = match http.list_groups().await {
            Ok(g) => g,
            Err(e) => {
                eprintln!("[sync] reconcile group keys: {e}");
                return;
            }
        };

        for g in groups {
            let owner_pub = g
                .members
                .iter()
                .find(|m| m.user_id == g.owner_id)
                .and_then(|m| m.identity_pubkey.as_deref())
                .and_then(decode_pubkey);

            // ── Recover our own key ──────────────────────────────────────
            if self.pool_group_key(&g.id).is_none() {
                if let (Some(wrapped), Some(owner_pub)) = (&g.my_wrapped_group_key, owner_pub) {
                    let shared = crypto::x25519_shared_secret(&id_priv, &owner_pub);
                    match crypto::unwrap_key(&shared, wrapped) {
                        Ok(key) => self.set_pool_group_key(&g.id, *key),
                        Err(e) => eprintln!("[sync] unwrap group key {}: {e}", g.id),
                    }
                }
            }

            if g.owner_id != me {
                continue;
            }

            // ── Owner: mint on first use, then wrap for whoever needs it ──
            // `minted` matters: a fresh key invalidates every previously
            // distributed one, so it must go to all members. An existing key only
            // goes to members who don't have one yet — re-sending to everybody
            // would echo back as `group:rekey` and loop forever.
            let (group_key, minted) = match self.pool_group_key(&g.id) {
                Some(k) => (k, false),
                None => {
                    let fresh = *crypto::random_key();
                    self.set_pool_group_key(&g.id, fresh);
                    (fresh, true)
                }
            };

            let mut wrapped_keys = Vec::new();
            for m in &g.members {
                if m.has_group_key && !minted {
                    continue; // already holds the current key
                }
                let Some(member_pub) = m.identity_pubkey.as_deref().and_then(decode_pubkey) else {
                    continue; // hasn't registered keys yet — retried next run
                };
                // Wrapping for ourselves works too: X25519(priv, own_pub) is a
                // valid shared secret, so the owner can recover after a restart.
                let shared = crypto::x25519_shared_secret(&id_priv, &member_pub);
                match crypto::wrap_key(&shared, &group_key) {
                    Ok(w) => wrapped_keys.push(WrappedKeyEntry {
                        user_id: m.user_id.clone(),
                        wrapped_group_key: w,
                    }),
                    Err(e) => eprintln!("[sync] wrap group key for {}: {e}", m.user_id),
                }
            }
            let _ = id_pub; // own public half comes from the member list

            if wrapped_keys.is_empty() {
                continue;
            }
            if let Err(e) = http
                .distribute_group_keys(&g.id, DistributeKeysRequest { wrapped_keys })
                .await
            {
                eprintln!("[sync] distribute group keys for {}: {e}", g.id);
            }
        }
    }

    /// Fetch Live Share sessions from the server, recover or mint session keys,
    /// and refresh the in-memory session list.
    ///
    /// Sessions previously lived only in client memory, so an app restart lost
    /// them (and their keys) even though they persisted server-side. This is the
    /// session analogue of [`Self::reconcile_group_keys`]: members recover their
    /// key from `my_wrapped_group_key`; the owner mints one when none is held and
    /// (re)wraps it for every member who has published an identity key —
    /// including themselves, which is what makes the next restart recoverable.
    pub(crate) async fn refresh_sharing_sessions(self: &Arc<Self>) -> Vec<SharingSession> {
        let Some(http) = self.http.lock().clone() else {
            return self.sharing_sessions();
        };
        let Some((id_priv, _)) = self.identity_keypair() else {
            return self.sharing_sessions();
        };
        let me = match self.current_user() {
            Some(u) => u.user_id,
            None => return self.sharing_sessions(),
        };

        let sessions = match http.list_sharing_sessions().await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[sync] refresh sessions: {e}");
                return self.sharing_sessions();
            }
        };

        let server_ids: Vec<String> = sessions.iter().map(|s| s.share_group_id.clone()).collect();
        // Drop sessions that no longer exist server-side (dissolved elsewhere).
        self.sharing_sessions
            .lock()
            .retain(|s| server_ids.contains(&s.share_group_id));

        let mut out = Vec::new();
        for s in sessions {
            let owner_pub = s
                .members
                .iter()
                .find(|m| m.user_id == s.owner_id)
                .and_then(|m| m.identity_pubkey.as_deref())
                .and_then(decode_pubkey);

            // ── Recover our own key ──────────────────────────────────
            if self.session_group_key(&s.share_group_id).is_none() {
                if let (Some(wrapped), Some(owner_pub)) = (&s.my_wrapped_group_key, owner_pub) {
                    let shared = crypto::x25519_shared_secret(&id_priv, &owner_pub);
                    match crypto::unwrap_key(&shared, wrapped) {
                        Ok(key) => self.set_session_group_key(&s.share_group_id, *key),
                        Err(e) => eprintln!("[sync] unwrap session key {}: {e}", s.share_group_id),
                    }
                }
            }

            // ── Owner: mint on first use, wrap for whoever needs it ──
            if s.owner_id == me {
                let (group_key, minted) = match self.session_group_key(&s.share_group_id) {
                    Some(k) => (k, false),
                    None => {
                        let fresh = *crypto::random_key();
                        self.set_session_group_key(&s.share_group_id, fresh);
                        (fresh, true)
                    }
                };
                let mut wrapped_keys = Vec::new();
                for m in &s.members {
                    if m.has_group_key && !minted {
                        continue;
                    }
                    let Some(member_pub) = m.identity_pubkey.as_deref().and_then(decode_pubkey)
                    else {
                        continue;
                    };
                    let shared = crypto::x25519_shared_secret(&id_priv, &member_pub);
                    match crypto::wrap_key(&shared, &group_key) {
                        Ok(w) => wrapped_keys.push(WrappedKeyEntry {
                            user_id: m.user_id.clone(),
                            wrapped_group_key: w,
                        }),
                        Err(e) => eprintln!("[sync] wrap session key for {}: {e}", m.user_id),
                    }
                }
                if !wrapped_keys.is_empty() {
                    if let Err(e) = http
                        .distribute_group_keys(
                            &s.share_group_id,
                            DistributeKeysRequest { wrapped_keys },
                        )
                        .await
                    {
                        eprintln!("[sync] distribute session keys for {}: {e}", s.share_group_id);
                    }
                }
            }

            let session = SharingSession {
                share_group_id: s.share_group_id.clone(),
                name: "Live Share".into(),
                my_scope: ShareScope::parse(&s.my_scope).unwrap_or(ShareScope::Clipboard),
                members: s
                    .members
                    .into_iter()
                    .map(|m| crate::sync::types::SessionMember {
                        user_id: m.user_id,
                        display_name: m.display_name,
                        avatar_url: m.avatar_url,
                        email: String::new(),
                        scope: ShareScope::parse(&m.scope).unwrap_or(ShareScope::Clipboard),
                        online: false,
                    })
                    .collect(),
                group_key: self.session_group_key(&s.share_group_id),
            };
            self.id_map.lock().set_sharing_session(&s.share_group_id);
            self.set_sharing_session(session.clone());
            out.push(session);
        }
        out
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
    /// A rekey arrived but the payload carries no `sender_pubkey` — the pool-group
    /// path. Re-reading `GET /groups` fetches the same wrapped key from the server
    /// (it is persisted, not just broadcast) plus the owner's public key needed to
    /// unwrap it, so a plain reconcile covers it.
    pub(crate) fn handle_group_rekey_arc(self: &Arc<Self>, payload: &serde_json::Value) {
        if payload.get("sender_pubkey").and_then(|v| v.as_str()).is_some() {
            self.handle_group_rekey(payload);
            return;
        }
        // Distributing keys makes the server echo `group:rekey` back to every
        // recipient — including ourselves. Reconciling on an event for a group we
        // already hold a key for would re-distribute and loop indefinitely, so
        // only a group we have no key for is worth acting on.
        let group_id = payload
            .get("group_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        if group_id.is_empty() || self.pool_group_key(&group_id).is_some() {
            return;
        }
        let this = Arc::clone(self);
        self.handle.spawn(async move {
            this.reconcile_group_keys().await;
        });
    }

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
            state.history.lock().upsert_synced(ClipboardEntry {
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
            });
            state.history.lock().sort_recent();
            state.history_dirty.store(true, Ordering::Relaxed);
            id_map
                .lock()
                .set_entry(&format!("clipboard:{}", meta.client_id), &meta.server_id);
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
    http.upload_blob_bytes(&up.presigned_put_url, ciphertext).await?;
    http.confirm_blob_upload(&up.blob_key).await?;
    let descriptor = serde_json::json!({ "mime": mime }).to_string();
    Ok((up.blob_key, size, descriptor))
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
