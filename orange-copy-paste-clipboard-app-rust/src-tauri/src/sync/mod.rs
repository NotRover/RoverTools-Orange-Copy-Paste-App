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

use std::collections::{HashMap, HashSet};
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
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
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
    /// Caps how many pushes are in flight at once. See [`PUSH_CONCURRENCY`].
    gate: Arc<Semaphore>,
    /// Remaining blob storage, shared so one 402 stops the whole batch.
    budget: BlobBudget,
    /// Pushes running right now, so the UI can show them as pending.
    in_flight: Arc<Mutex<HashSet<String>>>,
}

/// Bytes of blob storage left on the account, as last known.
///
/// Without this, an account that is out of space asks the server for an upload
/// slot once per image and is refused every time - 219 identical round trips
/// and 219 identical rows in the skipped list. A successful upload subtracts
/// its own size; a 402 sets it to zero, and every image after that is refused
/// locally until the next quota check refills it.
type BlobBudget = Arc<Mutex<Option<u64>>>;

/// How many pushes may talk to the server at the same time.
///
/// Every entry gets its own task, so a bulk upload of a few thousand items
/// used to open a few thousand requests at once: the backend answered 502 and
/// the blob presign timed out, and each failure became a skip the user had to
/// heal by hand. A small window is both faster and far more reliable here -
/// nothing is queued behind a stalled connection pool, and the server is never
/// the thing that breaks.
const PUSH_CONCURRENCY: usize = 6;

/// Largest blob the server accepts, matched here so an oversized image is
/// caught before it is uploaded rather than rejected after.
const BLOB_SIZE_LIMIT: u64 = 5 * 1024 * 1024;

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
    /// Which account wrote it, when `remote`. Names the sender on a space row.
    owner_id: Option<String>,
}

/// Read the send-filter map and sync mode from `settings.json` (both default
/// to "off"/Realtime when absent or unreadable — the safe interpretations).
fn load_local_sync_prefs(app_data: &std::path::Path) -> (HashMap<String, SendFilter>, SyncMode) {
    let map = crate::settings_file::read_map(&app_data.join("settings.json")).unwrap_or_default();
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

/// How many passes an unreadable OS credential store gets before the restore
/// loop stops and leaves the login screen up.
///
/// With the backoff above that is a little over three minutes - long enough to
/// cover a launch that outran the credential store after an update or a reboot,
/// short enough that a store which is simply broken does not get polled forever.
const UNAVAILABLE_RETRY_LIMIT: usize = 6;

/// Backoff schedule for re-uploading this device's wrapped UMK, in seconds.
///
/// That wrap is what lets a launch restore the session without a password. If it
/// never reaches the server, every launch from then on lands on the login
/// screen, so a failure here is worth chasing for a few minutes rather than
/// waiting for the user to sign in again.
const DEVICE_WRAP_RETRY_BACKOFF_SECS: [u64; 5] = [2, 5, 15, 30, 60];

/// Backoff schedule for the space-key distribution retry, in seconds.
///
/// Handing a new member their copy of the Space Key is the owner's job, and it
/// used to happen only on an event: a membership change over the socket, or the
/// owner opening the Spaces screen. Every way that can be missed - the owner's
/// app closed, the socket down, the member not having registered an identity
/// key yet - left them on "waiting for key" until the owner happened to come
/// back. This retries on its own instead, and stops as soon as nobody is
/// waiting.
const KEY_RETRY_BACKOFF_SECS: [u64; 6] = [5, 10, 20, 40, 60, 60];

/// How many times that retry runs before giving up (~4 minutes). A member who
/// has never registered an identity key cannot be wrapped for at all, so the
/// loop has to end rather than poll for the life of the session.
const KEY_RETRY_MAX_ATTEMPTS: usize = 8;

/// Why a silent session restore did not produce a session.
///
/// Each variant carries its own retry budget - see [`RestoreError::retry`].
/// Getting that classification wrong in either direction is what users feel:
/// retrying a dead credential burns requests forever, and giving up on a
/// reachable one signs them out for no reason.
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
    /// A local facility the restore needs - the OS credential store - would not
    /// answer. Also retryable, but unlike a network outage it will not fix
    /// itself given long enough, so the retry loop caps this class rather than
    /// polling a broken keychain for the life of the process.
    Unavailable(String),
}

/// How hard to keep trying a failed restore.
pub enum Retry {
    /// Never; the user has to sign in.
    No,
    /// For as long as it takes. An outage ends on its own, and the app is
    /// already running - one poll a minute costs nothing.
    Unbounded,
    /// This many passes, then give up. For a local facility that is not going
    /// to start working on its own, where polling forever would only hide the
    /// problem.
    Capped(usize),
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

    pub fn retry(&self) -> Retry {
        match self {
            Self::NoSession(_) | Self::Terminal(_) => Retry::No,
            Self::Transient(_) => Retry::Unbounded,
            Self::Unavailable(_) => Retry::Capped(UNAVAILABLE_RETRY_LIMIT),
        }
    }

    pub fn is_transient(&self) -> bool {
        !matches!(self.retry(), Retry::No)
    }

    pub fn message(&self) -> &str {
        match self {
            Self::NoSession(m) | Self::Terminal(m) | Self::Transient(m) | Self::Unavailable(m) => m,
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
    /// Cancel flag for the loopback capture of the in-flight OAuth attempt.
    /// Tripping it lets the blocking accept loop drop its listener early, so a
    /// retry can bind the same port instead of waiting out the capture deadline.
    oauth_cancel: Mutex<Option<Arc<std::sync::atomic::AtomicBool>>>,

    /// Pending offline operation queue.
    pending_queue: Arc<Mutex<PendingQueue>>,
    /// Shared permit pool bounding concurrent pushes to [`PUSH_CONCURRENCY`].
    push_gate: Arc<Semaphore>,
    /// Blob storage still available, as last known.  `None` until a quota
    /// check has run.  See [`BlobBudget`].
    blob_budget: BlobBudget,
    /// Entry keys with a push running right now. Reported as "pending" so the
    /// card badge moves the moment the user asks for an upload, instead of
    /// staying blank until the server answers - a wait long enough to read as
    /// "nothing happened".
    in_flight: Arc<Mutex<HashSet<String>>>,
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

    /// True while the space-key distribution retry loop is running. Reconcile
    /// runs from several triggers at once (screen mount, socket event, join),
    /// and without this each one would start its own loop.
    key_retrying: Arc<std::sync::atomic::AtomicBool>,

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

/// Upload this device's wrapped UMK, retrying on the schedule above.
///
/// Free-standing and holding only what it needs, so a retry that outlives the
/// login cannot pin the whole `SyncClient` (and its runtime) alive.
async fn store_device_wrap(http: Arc<SyncHttpClient>, device_id: String, wrapped: String) {
    // A leading zero so the first attempt runs immediately and the schedule
    // below describes only the waits after it.
    for delay in std::iter::once(0).chain(DEVICE_WRAP_RETRY_BACKOFF_SECS) {
        if delay > 0 {
            tokio::time::sleep(Duration::from_secs(delay)).await;
        }
        match http.store_device_wrapped_umk(&device_id, wrapped.clone()).await {
            Ok(()) => return,
            Err(e) => eprintln!("[sync] store device umk failed: {e}"),
        }
    }
    crate::health::note(
        "sync: device key wrap never stored",
        "silent restore is off for this device until the next sign-in",
    );
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
            oauth_cancel: Mutex::new(None),
            pending_queue,
            push_gate: Arc::new(Semaphore::new(PUSH_CONCURRENCY)),
            blob_budget: Arc::new(Mutex::new(None)),
            in_flight: Arc::new(Mutex::new(HashSet::new())),
            id_map,
            sync_state,
            status,
            spaces: Arc::new(Mutex::new(Vec::new())),
            space_keys: Arc::new(Mutex::new(HashMap::new())),
            send_filters: Arc::new(Mutex::new(send_filters)),
            sync_mode: Arc::new(Mutex::new(sync_mode)),
            ws_listener: Mutex::new(None),
            restore_retrying: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            key_retrying: Arc::new(std::sync::atomic::AtomicBool::new(false)),
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
        // Abandon whatever a previous attempt left listening, so this one can
        // take the port back.
        self.trip_oauth_cancel();
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        *self.oauth_cancel.lock() = Some(Arc::clone(&cancel));

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
            .spawn_blocking(move || loopback.wait_for_code(cancel))
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

        let begin = OAuthBegin { email, is_new };
        // Also announce it: the command's reply can be missed if the window was
        // hidden or reloaded during the browser handshake, and the event lets
        // the UI move on to the password step anyway.
        let _ = self.app.emit("sync:oauth-ready", &begin);
        Ok(begin)
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

    /// The stashed OAuth attempt, if the browser handshake already landed.
    /// Lets a freshly mounted UI pick up a step it may have missed.
    pub fn pending_oauth(&self) -> Option<OAuthBegin> {
        self.pending_oauth.lock().as_ref().map(|p| OAuthBegin {
            email: p.email.clone(),
            is_new: p.is_new,
        })
    }

    /// Discard a stashed OAuth session (user cancelled the password step) and
    /// stop any loopback capture still waiting on the browser.
    pub fn cancel_oauth(&self) {
        *self.pending_oauth.lock() = None;
        self.trip_oauth_cancel();
    }

    /// Signal the in-flight loopback capture, if any, to give up.
    fn trip_oauth_cancel(&self) {
        let flag = self.oauth_cancel.lock().take();
        if let Some(flag) = flag {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
        }
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
            if let Ok(Some(privk)) = crypto::load_device_private_key(&user_id) {
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
        crypto::store_device_private_key(&user_id, &device_priv).await?;
        crypto::store_refresh_token(&user_id, &session.refresh_token).await?;

        // 7b. Store the UMK wrapped for this device so future launches can
        //     restore the session without the password (see
        //     [`Self::try_restore_session`]). X25519 with our own public half
        //     is a valid self-shared secret, same pattern as group keys.
        //     Best-effort: failure only means the next launch asks to log in.
        //     Not best-effort in practice: until this lands, every later launch
        //     finds no wrap and has to ask for a password again, which is the
        //     sign-out users see repeat. A network blip in the seconds after a
        //     login is enough to cause it, so retry in the background rather
        //     than leaving it to the next login to fix.
        {
            let shared = crypto::x25519_shared_secret(&device_priv, &device_pub);
            match crypto::wrap_key(&shared, &umk) {
                Ok(wrapped) => {
                    self.handle.spawn(store_device_wrap(
                        Arc::clone(&http),
                        device_id.clone(),
                        wrapped,
                    ));
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
        // An absent entry and an unreachable store are different problems and
        // must not be collapsed. Nothing stored means the user really does have
        // to sign in. A store that would not answer usually means this launch
        // raced the OS - an in-app update relaunches the app immediately, and an
        // autostart entry runs while the user profile is still coming up - so it
        // is transient, and the retry loop gets the session back on its own.
        // Treating that as a dead credential is what made a working login look
        // like a logout, permanently, until the user retyped a password.
        let unreachable =
            |e: String| RestoreError::Unavailable(format!("keychain unavailable: {e}"));
        let refresh = crypto::load_refresh_token(&stored_user)
            .map_err(unreachable)?
            .ok_or_else(|| {
                RestoreError::Terminal(format!("no stored credentials for user {stored_user}"))
            })?;
        let device_priv = crypto::load_device_private_key(&stored_user)
            .map_err(unreachable)?
            .ok_or_else(|| {
                RestoreError::Terminal(format!("no stored device key for user {stored_user}"))
            })?;

        // Fresh tokens from Supabase; the refresh token rotates, so persist it.
        let session = self
            .supabase
            .refresh(&refresh)
            .await
            .map_err(RestoreError::from_auth)?;
        // The refresh token has now been spent and rotated. Aborting here would
        // be the worst of both outcomes: no session now, and a stored token that
        // is already dead for the next launch. So carry on with the session we
        // just earned and record that the next launch may have to ask for a
        // password.
        if let Err(e) =
            crypto::store_refresh_token(&stored_user, &session.refresh_token).await
        {
            crate::health::note(
                "sync restore: rotated refresh token not stored",
                &format!("{e} - the next launch may have to sign in again"),
            );
        }

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
            // Counted apart from `attempt`, so a long network outage does not
            // spend a capped class's budget. Reset when an unbounded class
            // answers instead, since that is evidence the earlier fault cleared.
            let mut capped = 0usize;
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
                    Err(e) => {
                        // A capped class is one that will not fix itself: a
                        // launch can outrun the credential store, but a store
                        // that is simply broken would otherwise be polled for the
                        // life of the process, never telling the user, and
                        // pinning the client (and its runtime) alive through the
                        // `Arc` this task holds.
                        let budget = e.retry();
                        capped = match budget {
                            Retry::Capped(_) => capped + 1,
                            Retry::Unbounded => 0,
                            Retry::No => capped,
                        };
                        let done = match budget {
                            Retry::No => true,
                            Retry::Capped(limit) => capped >= limit,
                            Retry::Unbounded => false,
                        };
                        if !done {
                            eprintln!("[sync] session restore retry {attempt} failed: {e}");
                            continue;
                        }
                        // Recorded durably: a release build is a Windows GUI
                        // binary, so nothing printed here reaches a user machine,
                        // and this is the one line that says why they were
                        // signed out.
                        eprintln!("[sync] session restore gave up: {e}");
                        crate::health::note(
                            "sync restore: gave up",
                            &format!("after {attempt} retries: {e}"),
                        );
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
        // Distinct from `status-changed { connected: false }`, which means "signed
        // in but the socket is down". Without it the sidebar kept whatever the
        // connection last was and read "Connected" while signed out.
        let _ = self.app.emit("sync:signed-out", serde_json::Value::Null);
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
        self.spawn_push_note(note, umk, false, None);
    }

    pub fn on_update_note(&self, note: Note) {
        let Some(umk) = self.umk.lock().clone() else {
            return;
        };
        self.spawn_push_note(note, umk, true, None);
    }

    /// "Upload to cloud" on a note the user picked, as opposed to a note that
    /// has just been written.
    ///
    /// The push carries `now` as its `updated_at` instead of the note's own.
    /// A note that has sat untouched for weeks is older than whatever the
    /// server holds for it - in particular the tombstone that "Remove from
    /// cloud" left behind, which is stamped at the moment of removal - and the
    /// server drops any push that is not newer as a stale update.  That
    /// rejection is silent, so the note simply never came back.
    ///
    /// Only the wire copy is stamped: the note keeps its own `updated_at`, so
    /// nothing reorders, and the merge skips entries this device sent, so the
    /// newer timestamp never lands back here.
    pub fn on_manual_push_note(&self, note: Note) {
        let Some(umk) = self.umk.lock().clone() else {
            return;
        };
        let at = note.updated_at.max(now_ms());
        self.spawn_push_note(note, umk, true, Some(at));
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
            gate: Arc::clone(&self.push_gate),
            budget: Arc::clone(&self.blob_budget),
            in_flight: Arc::clone(&self.in_flight),
        }
    }

    fn spawn_push_clipboard_entry(
        &self,
        entry: ClipboardEntry,
        umk: Zeroizing<[u8; 32]>,
        is_update: bool,
    ) {
        // Not ours to publish - see the note push for why a second row is worse
        // than no push at all.
        if self.is_remote_entry("clipboard", &entry.id) {
            return;
        }

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
            // Taken before anything touches the network, so a bulk upload of
            // images opens PUSH_CONCURRENCY connections rather than one per
            // entry.
            let permit = ctx.gate.clone().acquire_owned().await.ok();
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
                match upload_image_blob(http, &enc_key, &entry.id, &entry.content, &ctx.budget)
                    .await
                {
                    Ok((key, size, descriptor)) => (descriptor, Some(key), Some(size)),
                    Err(e) => {
                        eprintln!("[sync] image blob upload failed: {e}");
                        record_skip(&ctx, &entry.id, &skip_label, e);
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
            push_entry_task(ctx, enc_key, is_update, job, permit).await;
        });
    }

    /// `wire_updated_at` overrides the timestamp the push carries, for an
    /// upload the user asked for. `None` sends the note's own.
    fn spawn_push_note(
        &self,
        note: Note,
        umk: Zeroizing<[u8; 32]>,
        is_update: bool,
        wire_updated_at: Option<u64>,
    ) {
        // Someone else wrote it, so it is not ours to publish. Rows are keyed by
        // owner, so this would not update theirs - it would insert a second row
        // under the same client_id and hand every member a rival copy.
        if self.is_remote_entry("note", &note.id) {
            return;
        }

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
            let permit = ctx.gate.clone().acquire_owned().await.ok();
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
                updated_at: wire_updated_at.unwrap_or(note.updated_at),
                pinned: note.pinned,
                space_ids,
                wrapped_keys,
                blob_key: None,
                blob_size: None,
            };
            push_entry_task(ctx, enc_key, is_update, job, permit).await;
        });
    }

    fn spawn_delete_entry(&self, client_id: String, entry_type: EntryType) {
        let http = self.http.lock().clone();
        let umk = self.umk.lock().clone();
        let queue = Arc::clone(&self.pending_queue);
        let id_map = Arc::clone(&self.id_map);
        let status = Arc::clone(&self.status);
        let gate = Arc::clone(&self.push_gate);
        let type_str = entry_type.as_str().to_string();
        let map_key = format!("{type_str}:{client_id}");
        // The tombstone must reach the same spaces the entry did, so members
        // remove it too. Captured before the id_map row is dropped below.
        let (space_ids, is_remote, owner_id) = {
            let map = self.id_map.lock();
            (
                map.shares_for(&map_key),
                map.is_remote(&map_key),
                map.owner_of(&map_key),
            )
        };

        // A removal in a space leaves a placeholder, so the item does not just
        // disappear from under the other members.
        if !space_ids.is_empty() {
            self.id_map.lock().mark_deleted(
                &map_key,
                crate::sync::id_map::DeletedMarker {
                    space_ids: space_ids.clone(),
                    owner_id,
                    deleted_at: now_ms(),
                    by_author: !is_remote,
                    content_gone: true,
                    local_only: is_remote,
                },
            );
        }

        // Someone else wrote this one, so removing it here is a local decision
        // and must stay local. Pushing a tombstone would not update their row
        // (rows are keyed by owner) — it would insert one of ours carrying the
        // same space ids, and take the item down for every member. The marker
        // above is what stops the next pull handing it straight back.
        if is_remote {
            self.id_map.lock().remove_entry(&map_key);
            return;
        }

        // Claimed here, before the task starts, so a removal is visible for its
        // whole life. Without it a tombstone for a row this device has no local
        // record of - one another device pushed - would be indistinguishable
        // from a finished removal from the very first poll, and the bulk bar
        // would report a clean sweep while the pushes were still going out.
        self.in_flight.lock().insert(map_key.clone());
        let in_flight = Arc::clone(&self.in_flight);
        let flight_key = map_key.clone();
        let flight_type = entry_type.as_str();
        let app = self.app.clone();

        self.handle.spawn(async move {
            // Every exit path below releases the claim.
            let _flight = InFlightGuard {
                set: in_flight,
                key: flight_key,
                app,
                entry_type: flight_type,
            };
            // "Remove from cloud" fans out one of these per entry, so they
            // share the push window rather than flooding the server.
            let _permit = gate.acquire_owned().await;
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

            let key = format!(
                "{}:{}",
                if is_note { "note" } else { "clipboard" },
                e.client_id
            );

            // Tombstone → remove locally.
            if e.deleted_at.is_some() {
                let had_local = if is_note {
                    let gone = state.notes.lock().delete(&e.client_id);
                    notes_changed |= gone;
                    gone
                } else {
                    let gone = state.history.lock().remove(&e.client_id);
                    clip_changed |= gone;
                    gone
                };
                let mut id_map = self.id_map.lock();
                // Spaces come off the id_map row rather than the tombstone: the
                // payload carries them too, but the local record is what this
                // device actually saw the item in.
                let local_spaces = id_map.shares_for(&key);
                // A placeholder explains a row that disappeared from *this*
                // device's feed. Someone who joins a space still gets served the
                // tombstones of everything deleted before they arrived, and
                // falling back to the payload's space list turned every one of
                // those into a placeholder for an item they never saw - a new
                // member's whole feed reading "Removed this item". No local trace
                // of the item means there is nothing to explain.
                let knew_it = had_local
                    || !local_spaces.is_empty()
                    || id_map.get_server_id(&key).is_some();
                let space_ids = if local_spaces.is_empty() {
                    e.space_ids.clone()
                } else {
                    local_spaces
                };
                if knew_it && !space_ids.is_empty() {
                    let owner_id = id_map.owner_of(&key);
                    id_map.mark_deleted(
                        &key,
                        crate::sync::id_map::DeletedMarker {
                            space_ids,
                            owner_id,
                            deleted_at: e.deleted_at.unwrap_or_else(now_ms),
                            by_author: true,
                            content_gone: true,
                            local_only: false,
                        },
                    );
                }
                id_map.remove_entry(&key);
                continue;
            }

            // Already removed here. Re-merging would resurrect an item the user
            // took out, which is exactly what a member's local removal must not
            // do — the server still holds it, so every pull would offer it.
            //
            // Unless it was put back. A space removal strips the space id from
            // the row, and pull only matches rows that still carry one of our
            // spaces — so a row arriving with a space we removed it from is the
            // author sharing it again, not the old copy coming round. Dropping
            // a record only this device made (`local_only`) says nothing about
            // the space, so those keep blocking.
            {
                let mut id_map = self.id_map.lock();
                match id_map.deleted_marker(&key) {
                    Some(m) if m.content_gone => {
                        let reshared = !m.local_only
                            && e.space_ids.iter().any(|s| m.space_ids.contains(s));
                        if !reshared {
                            continue;
                        }
                        id_map.clear_deleted(&key);
                    }
                    _ => {}
                }
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
                                    owner_id: e.user_id.clone(),
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

            let mut id_map = self.id_map.lock();
            id_map.set_entry(&key, &e.server_id);
            // The sender's metadata carries *their* local group names, which say
            // nothing about the space the entry travelled through. Recording the
            // server ids is what lets the Spaces screen place a received entry
            // under the space it actually came from.
            // Not while we are pushing this entry: a share we just made is
            // newer than anything this response can carry, and a pull that
            // overlapped the push would write the pre-share list back - the
            // checkmark switching off and on again as the push lands.
            if !self.in_flight.lock().contains(&key) {
                id_map.set_entry_shares(&key, &e.space_ids);
            }
            if from_space {
                id_map.mark_entry_remote(&key);
                // Only for entries that came through a space: a space row has to
                // say who sent it, and our own entries are the ones without an
                // owner recorded.
                if let Some(owner) = e.user_id.as_deref() {
                    id_map.set_entry_owner(&key, owner);
                }
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

    /// Re-pull from the beginning of the account's history, merging only what is
    /// new to this device.
    ///
    /// A normal pull asks for `server_ts > cursor`, so entries that were on the
    /// server before this device caught up are permanently behind it. That is
    /// exactly the situation when an owner opens a space's back catalogue: rows
    /// that were filtered out at the time are now visible, but no delta pull
    /// would ever ask for them again.
    ///
    /// The cursor is left where it was. Entries already held are dropped before
    /// the merge rather than re-applied, which is what keeps this from
    /// re-downloading every image blob the device already has.
    pub async fn backfill_pull(&self) -> Result<(), String> {
        let http = self.http.lock().clone().ok_or("not authenticated")?;
        if !http.is_authenticated() {
            return Err("not authenticated".into());
        }
        let state = self.app.state::<crate::state::AppState>();

        let mut cursor = None;
        let mut merged = 0usize;
        loop {
            let pull = match http.pull_entries(cursor, 200).await {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[sync] backfill pull failed: {e}");
                    break;
                }
            };
            let next_cursor = pull.next_cursor;
            let fresh: Vec<_> = pull
                .entries
                .into_iter()
                .filter(|e| {
                    // A tombstone always applies: the local copy is exactly what
                    // it is there to remove.
                    if e.deleted_at.is_some() {
                        return true;
                    }
                    if e.entry_type == "note" {
                        // Notes are edited, so an older copy still has to merge.
                        !state
                            .notes
                            .lock()
                            .find(&e.client_id)
                            .is_some_and(|n| n.updated_at >= e.updated_at)
                    } else {
                        // Clipboard entries are immutable once captured, so
                        // holding one at all is enough - and re-merging an image
                        // would download and rewrite its blob for nothing.
                        state.history.lock().find(&e.client_id).is_none()
                    }
                })
                .collect();
            if !fresh.is_empty() {
                merged += fresh.len();
                self.merge_pulled(&fresh, false);
            }
            match next_cursor {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        if merged > 0 {
            eprintln!("[sync] backfill merged {merged} entries");
        }
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

    /// Everything this account still has on the server, as entry keys.
    ///
    /// "Remove from cloud" worked off this device's id_map, which only knows
    /// what this device pushed or pulled. A row another device wrote, or one
    /// this device has since forgotten, stayed on the server with nothing in
    /// the UI able to reach it — and an image row kept holding its storage,
    /// which is what made a cleared account still report bytes in use.
    ///
    /// Rows belonging to other members are skipped: entries are keyed by owner,
    /// so a tombstone of ours would not remove theirs, it would insert one
    /// carrying the same spaces and take the item down for everybody.
    pub async fn server_entry_keys(&self) -> Result<Vec<String>, String> {
        let http = self
            .http
            .lock()
            .clone()
            .filter(|h| h.is_authenticated())
            .ok_or("not signed in")?;
        let me = self.current_user().map(|u| u.user_id);
        let mut after: Option<u64> = None;
        let mut keys: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        // Rows pushed in the same millisecond share a server_ts, and the cursor
        // is exclusive, so a page that cannot advance it would loop forever.
        for _ in 0..200 {
            let page = http.pull_entries(after, 500).await?;
            let next = page.next_cursor;
            for e in page.entries {
                if e.deleted_at.is_some() {
                    continue;
                }
                if let (Some(me), Some(owner)) = (me.as_deref(), e.user_id.as_deref()) {
                    if owner != me {
                        continue;
                    }
                }
                let kind = if e.entry_type == "note" {
                    "note"
                } else {
                    "clipboard"
                };
                let key = format!("{kind}:{}", e.client_id);
                if seen.insert(key.clone()) {
                    keys.push(key);
                }
            }
            match next {
                Some(c) if Some(c) != after => after = Some(c),
                _ => break,
            }
        }
        Ok(keys)
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
        // A push that is running has no id_map row and no queue entry yet, so
        // without this the item reads as "not in the cloud" for the whole
        // round trip.
        for key in self.in_flight.lock().iter() {
            states.entry(key.clone()).or_insert("pending");
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

    /// Which account wrote each received entry, for the sender badge on space
    /// rows.
    pub fn entry_owners(&self) -> HashMap<String, String> {
        self.id_map.lock().entry_owners()
    }

    /// Whether another member wrote this entry. Anything that edits content has
    /// to ask first: a copy shared into a space is theirs, not ours to rewrite.
    pub fn is_remote_entry(&self, entry_type: &str, client_id: &str) -> bool {
        self.id_map.lock().is_remote(&format!("{entry_type}:{client_id}"))
    }

    /// Record that our own entry was pulled back out of these spaces, so each
    /// one keeps a placeholder where the item used to be. The entry itself is
    /// untouched: it is still ours, and still in whatever spaces remain.
    pub fn mark_unshared(&self, key: &str, spaces: Vec<String>) {
        self.id_map.lock().mark_deleted(
            key,
            crate::sync::id_map::DeletedMarker {
                space_ids: spaces,
                owner_id: None,
                deleted_at: now_ms(),
                by_author: true,
                content_gone: false,
                local_only: false,
            },
        );
    }

    /// Items removed from a space, for the feed's placeholders.
    pub fn deleted_markers(&self) -> HashMap<String, crate::sync::id_map::DeletedMarker> {
        self.id_map.lock().deleted_markers()
    }

    /// An entry left a space — taken down by the space owner, or un-shared by
    /// whoever posted it. Either way the space stops carrying it.
    ///
    /// What that means depends on whose entry it is. Ours: it only leaves the
    /// space and the copy in our own history is untouched. Someone else's: the
    /// local copy goes too.
    ///
    /// Either way the space feed keeps a placeholder. Our own item leaving used
    /// to disappear without trace, so a space could not answer "what happened
    /// to the thing I posted here" — the row simply was not there any more.
    ///
    /// `by_author` says whether the person who wrote the entry is also the one
    /// who removed it — the only thing this side cannot infer. It travels on the
    /// entry-removed event as `removed_by`; the local command passes true,
    /// since the reader can only unshare what they posted.
    pub fn drop_space_entry(&self, space_id: &str, client_id: &str, entry_type: &str, by_author: bool) {
        use crate::state::app_state::AppState;
        use std::sync::atomic::Ordering;

        let key = format!("{entry_type}:{client_id}");
        let is_remote = self.id_map.lock().is_remote(&key);

        if !is_remote {
            let mut id_map = self.id_map.lock();
            let kept: Vec<String> = id_map
                .shares_for(&key)
                .into_iter()
                .filter(|s| s != space_id)
                .collect();
            id_map.set_entry_shares(&key, &kept);
            // Ours, so no owner id: the badge reads "You", the same as it does
            // on a live card we posted. Only this space is named - the item is
            // still in every other space it was shared into.
            id_map.mark_deleted(
                &key,
                crate::sync::id_map::DeletedMarker {
                    space_ids: vec![space_id.to_string()],
                    owner_id: None,
                    deleted_at: now_ms(),
                    by_author,
                    content_gone: false,
                    local_only: false,
                },
            );
            drop(id_map);
            let _ = self.app.emit(
                if entry_type == "note" {
                    "sync:notes-merged"
                } else {
                    "sync:history-merged"
                },
                serde_json::Value::Null,
            );
            return;
        }

        let state = self.app.state::<AppState>();
        let changed = if entry_type == "note" {
            state.notes.lock().delete(client_id)
        } else {
            state.history.lock().remove(client_id)
        };

        {
            let mut id_map = self.id_map.lock();
            let mut space_ids = id_map.shares_for(&key);
            if !space_ids.iter().any(|s| s == space_id) {
                space_ids.push(space_id.to_string());
            }
            let owner_id = id_map.owner_of(&key);
            id_map.mark_deleted(
                &key,
                crate::sync::id_map::DeletedMarker {
                    space_ids,
                    owner_id,
                    deleted_at: now_ms(),
                    by_author,
                    content_gone: true,
                    local_only: false,
                },
            );
            id_map.remove_entry(&key);
        }

        // Emitted even when nothing local changed: the Spaces feed still gains
        // a placeholder row, and it refreshes off these two events.
        if entry_type == "note" {
            if changed {
                state.notes_dirty.store(true, Ordering::Relaxed);
            }
            let _ = self.app.emit("sync:notes-merged", serde_json::Value::Null);
        } else {
            if changed {
                state.history_dirty.store(true, Ordering::Relaxed);
            }
            let _ = self.app.emit("sync:history-merged", serde_json::Value::Null);
        }
    }

    /// Forget the placeholders for one space. Returns how many went.
    pub fn clear_removed_in_space(&self, space_id: &str) -> usize {
        self.id_map.lock().clear_deleted_in_space(space_id)
    }

    /// Record the storage the account has left, from a fresh quota check.
    /// Clears the "full" latch when space has been freed.
    pub fn set_blob_budget(&self, used_bytes: u64, quota_bytes: u64) {
        *self.blob_budget.lock() = Some(quota_bytes.saturating_sub(used_bytes));
    }

    /// Forget the remaining-storage figure, so the next image asks the server
    /// again.  Called when the user retries by hand: they may have just freed
    /// space, and a stale zero would refuse every image without trying.
    pub fn invalidate_blob_budget(&self) {
        *self.blob_budget.lock() = None;
    }

    /// How many pushes are talking to the server right now.  A bulk upload
    /// looks stalled from the outside during a long image transfer, so the UI
    /// asks this before deciding nothing is happening.
    pub fn pushes_in_flight(&self) -> usize {
        PUSH_CONCURRENCY.saturating_sub(self.push_gate.available_permits())
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

    /// Mirror our own socket state onto our row in every cached space.
    ///
    /// Our presence reaches other members as a `user:presence` event, but our
    /// own copy of the member list came from a REST snapshot taken around the
    /// same moment the socket came up — so whichever landed last won, and it
    /// was routinely the snapshot saying we were offline while we sat there
    /// connected. This is the one presence fact this device knows for certain,
    /// so it stops asking the server for it.
    pub(crate) fn apply_self_presence(&self, online: bool) {
        let user_id = self.current_user().map(|u| u.user_id);
        if let Some(user_id) = user_id {
            self.apply_member_presence(&user_id, online);
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
        let Ok(map) = crate::settings_file::read_map(&self.app_data.join("settings.json")) else {
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
        if self.keys_pending(&out) {
            Arc::clone(self).spawn_key_retry();
        }
        // A space that shares its earlier items but has never been swept here
        // owes this device a backfill: the `space:history_opened` event only
        // reaches members who were running when the owner flipped it.
        let owed: Vec<String> = {
            let state = self.sync_state.lock();
            out.iter()
                .filter(|s| {
                    !s.is_owner && s.share_history && !state.has_history_backfilled(&s.id)
                })
                .map(|s| s.id.clone())
                .collect()
        };
        if !owed.is_empty() {
            let this = Arc::clone(self);
            self.handle.spawn(async move {
                if this.backfill_pull().await.is_ok() {
                    let mut state = this.sync_state.lock();
                    for id in owed {
                        state.mark_history_backfilled(&id);
                    }
                }
            });
        }
        out
    }

    /// Whether anyone is still waiting on a Space Key we could hand out or
    /// receive: a member of a space we own without their wrapped copy, or a
    /// space of someone else's that we cannot read yet.
    fn keys_pending(&self, spaces: &[Space]) -> bool {
        let rings = self.space_keys.lock();
        spaces.iter().any(|s| {
            if s.is_owner {
                s.members.iter().any(|m| !m.has_space_key)
            } else {
                !matches!(rings.get(&s.id), Some(ring) if !ring.is_empty())
            }
        })
    }

    /// Re-run reconcile on a backoff until nobody is waiting on a key.
    ///
    /// Reconcile is the whole fix here - it wraps the keyring for every member
    /// who lacks one, and recovers ours if the owner has since published it.
    /// What was missing was anything to run it again after the one attempt an
    /// event triggers. At most one loop runs at a time; the loop calls
    /// reconcile, which calls this, and the flag is what stops that recursing.
    fn spawn_key_retry(self: Arc<Self>) {
        use std::sync::atomic::Ordering;
        if self
            .key_retrying
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return; // a loop is already running
        }

        let handle = self.handle.clone();
        handle.spawn(async move {
            for attempt in 0..KEY_RETRY_MAX_ATTEMPTS {
                let delay =
                    KEY_RETRY_BACKOFF_SECS[attempt.min(KEY_RETRY_BACKOFF_SECS.len() - 1)];
                tokio::time::sleep(Duration::from_secs(delay)).await;

                // Logged out while we slept - there is nothing to distribute.
                if self.http.lock().is_none() {
                    break;
                }
                let spaces = self.reconcile_spaces().await;
                if !self.keys_pending(&spaces) {
                    break;
                }
            }
            self.key_retrying.store(false, Ordering::SeqCst);
        });
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
        let in_flight = Arc::clone(&self.in_flight);

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
            if !in_flight.lock().contains(&key) {
                id_map.set_entry_shares(&key, &meta.space_ids);
            }
            if meta.remote {
                id_map.mark_entry_remote(&key);
                if let Some(owner) = meta.owner_id.as_deref() {
                    id_map.set_entry_owner(&key, owner);
                }
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
        // Externalized images keep their file name in `content`; only an
        // inline data URL has nothing to name it by. "Image" on its own left
        // the user with no way to tell which one was skipped.
        EntryKind::Image if !entry.content.starts_with("data:") => {
            std::path::Path::new(&entry.content)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Image".into())
        }
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
    budget: &BlobBudget,
) -> Result<(String, u64, String), String> {
    let (bytes, mime) = read_image_bytes(content)?;
    let ciphertext = crypto::encrypt_bytes(enc_key, &bytes, client_id)?;
    let size = ciphertext.len() as u64;
    // The server enforces this too, but finding out from a 413 means the user
    // reads a raw error for something we could have measured before sending.
    if size > BLOB_SIZE_LIMIT {
        return Err(format!(
            "{} is over the 5 MB limit for synced images",
            format_bytes(size)
        ));
    }
    // Refuse locally when the account is known to be out of room, so a bulk
    // upload asks the server once rather than once per image.
    if let Some(remaining) = *budget.lock() {
        if size > remaining {
            return Err(format!(
                "Cloud storage is full - {} free, this image needs {}",
                format_bytes(remaining),
                format_bytes(size)
            ));
        }
    }
    let checksum = crypto::sha256_hex(&ciphertext);
    let up = http
        .request_blob_upload(BlobUploadRequest {
            mime_type: mime.clone(),
            size_bytes: size,
            checksum,
        })
        .await
        .map_err(|e| {
            if e.status == Some(402) {
                // The server is the authority; latch it so the rest of the
                // batch stops asking.
                *budget.lock() = Some(0);
                "Cloud storage is full - remove some synced images to make room".to_string()
            } else {
                format!("Image upload failed: {e}")
            }
        })?;
    http.upload_blob_bytes(&up.presigned_put_url, ciphertext, &mime)
        .await
        .map_err(|e| format!("Image upload failed: {e}"))?;
    http.confirm_blob_upload(&up.blob_key)
        .await
        .map_err(|e| format!("Image upload failed: {e}"))?;
    if let Some(remaining) = budget.lock().as_mut() {
        *remaining = remaining.saturating_sub(size);
    }
    let descriptor = serde_json::json!({ "mime": mime }).to_string();
    Ok((up.blob_key, size, descriptor))
}

/// Encrypt and push one entry (clipboard or note); queue it when offline.
/// Shared body of `spawn_push_clipboard_entry` / `spawn_push_note`.  `enc_key`
/// is the entry's freshly minted CEK; `job.wrapped_keys` carries its envelope.
/// Drops an entry out of the in-flight set however `push_entry_task` ends -
/// success, an early `return` on an encryption error, or a panic. Tracking it
/// by hand left items stuck on "pending" forever down the error paths.
struct InFlightGuard {
    set: Arc<Mutex<HashSet<String>>>,
    key: String,
    app: tauri::AppHandle,
    entry_type: &'static str,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.set.lock().remove(&self.key);
        // The success path emits its own event; this covers the failure paths,
        // which would otherwise leave the amber badge until something else
        // refreshed it.
        let _ = self.app.emit(
            "sync:entry-queued",
            serde_json::json!({ "key": self.key, "entry_type": self.entry_type }),
        );
    }
}

async fn push_entry_task(
    ctx: PushCtx,
    enc_key: Zeroizing<[u8; 32]>,
    is_update: bool,
    job: PushJob,
    // Taken by the caller before it uploads any blob, and held here until the
    // push finishes. Acquiring it inside this function instead would leave the
    // image upload - the slow half - outside the window entirely.
    _permit: Option<OwnedSemaphorePermit>,
) {
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

    // Claimed before any encryption or network work, so the badge turns amber
    // on the click rather than on the response.
    let entry_key_flight = format!("{entry_type}:{client_id}");
    ctx.in_flight.lock().insert(entry_key_flight.clone());
    let _ = ctx.app.emit(
        "sync:entry-queued",
        serde_json::json!({ "client_id": client_id, "entry_type": entry_type }),
    );
    let _flight = InFlightGuard {
        set: Arc::clone(&ctx.in_flight),
        key: entry_key_flight,
        app: ctx.app.clone(),
        entry_type,
    };

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
                // A rejected push used to look exactly like an accepted one
                // from here: no row, no event, no word anywhere. Say so.
                if let Some(c) = result.conflicts.iter().find(|c| c.client_id == client_id) {
                    eprintln!(
                        "[sync] {entry_type} {client_id} rejected by the server: {}",
                        c.reason
                    );
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
