//! Async HTTP client for the cloud sync API (our FastAPI backend).
//!
//! Wraps `reqwest::Client` with:
//!   - Base URL injection
//!   - `Authorization: Bearer <supabase jwt>` from the in-memory access token
//!   - `X-Device-Id` header on device-scoped routes
//!   - Automatic 401 → Supabase token refresh → retry (once), plus a proactive
//!     refresh once the JWT is close to expiry
//!   - 10-second request timeout
//!
//! Identity itself (login / signup / refresh) is Supabase's; see
//! [`crate::sync::supabase`].  This client only carries the resulting JWT and
//! refreshes it through Supabase when the backend rejects it with a 401.
//!
//! All methods are `async`.  They run on whichever Tokio runtime the caller is
//! using (Tauri's runtime for commands, or the sync module's dedicated runtime
//! for background tasks).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::sync::supabase::SupabaseAuth;

const REQUEST_TIMEOUT_SECS: u64 = 10;

/// Blob transfers move up to 5 MB over a presigned S3/R2 URL, which the
/// 10-second default cuts off on a slow link.
const BLOB_TRANSFER_TIMEOUT_SECS: u64 = 90;

/// How long to wait before the single retry of a request that never reached
/// the backend.  Long enough for a host that spun down while idle to finish
/// waking, short enough that a genuinely offline machine fails quickly.
const TRANSPORT_RETRY_DELAY_SECS: u64 = 3;

/// How many times to retry a request the server itself failed (502/503/504 from
/// an overloaded or restarting backend, 429 from the rate limiter).  Without
/// this a momentary backend hiccup permanently skips the entry, because a skip
/// is never queued.
const SERVER_RETRY_ATTEMPTS: u32 = 3;

/// Refresh the access token this many seconds before it actually expires, so a
/// request (or a WebSocket handshake) never goes out holding a JWT that dies
/// mid-flight.
const TOKEN_REFRESH_SKEW_SECS: u64 = 120;

/// A failed backend call, keeping the HTTP status alongside the message.
///
/// Same reason as [`crate::sync::supabase::AuthError`]: session restore must
/// distinguish "the backend is unreachable" from "the backend rejected us".
#[derive(Debug, Clone)]
pub struct ApiError {
    /// Status the backend replied with, or `None` when no response arrived.
    pub status: Option<u16>,
    pub message: String,
}

impl ApiError {
    /// True when retrying later could plausibly succeed.
    pub fn is_transient(&self) -> bool {
        match self.status {
            None => true,
            Some(status) => status == 408 || status == 429 || status >= 500,
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<ApiError> for String {
    fn from(e: ApiError) -> Self {
        e.message
    }
}

/// Seconds since the Unix epoch, or 0 if the clock is before it.
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── API request / response types ─────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct BootstrapRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BootstrapResponse {
    pub user_id: String,
    /// base64-encoded salt used for Argon2id key derivation (the wrapping key).
    pub kdf_salt: String,
    pub display_name: String,
    /// Identity-provider avatar URL (Google, mirrored at bootstrap); `None` for
    /// accounts without one.
    #[serde(default)]
    pub avatar_url: Option<String>,
    /// base64 envelope holding the random UMK wrapped under the password-derived
    /// KEK.  `None` on a brand-new account (no UMK established yet); its presence
    /// is how the client distinguishes first-setup from a returning login, and
    /// its GCM tag doubles as the password verifier on unwrap.
    #[serde(default)]
    pub wrapped_umk: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SetWrappedUmkRequest {
    pub wrapped_umk: String,
}

#[derive(Debug, Serialize)]
pub struct RegisterDeviceRequest {
    pub device_name: String,
    pub platform: String,
    pub app_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_pubkey: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RegisterDeviceResponse {
    pub device_id: String,
}

/// A registered device (`GET /auth/devices`), for the presence UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceOut {
    pub id: String,
    pub device_name: String,
    pub platform: String,
    pub app_version: String,
    pub last_seen_at: u64,
    /// Presence snapshot at list time; live updates arrive over WS.
    #[serde(default)]
    pub online: bool,
}

#[derive(Debug, Serialize)]
pub struct RegisterKeysRequest {
    pub identity_pubkey: String,
    pub device_pubkey: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushEntryRequest {
    pub client_id: String,
    /// Backend discriminator: `"clipboard"` | `"note"` (singular).
    pub entry_type: String,
    /// `"text" | "image" | "html" | "file"` for clipboard; `"note"` for notes.
    pub kind: String,
    pub encrypted_content: String,
    pub encrypted_metadata: String,
    /// Unix ms — set once on insert.
    pub created_at: u64,
    /// Unix ms — the last-write-wins clock; a push wins only when strictly newer.
    pub updated_at: u64,
    #[serde(default)]
    pub pinned: bool,
    /// Unix ms when this entry was deleted (tombstone); `None` for live entries.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<u64>,
    /// For file/image entries: the blob's storage key; otherwise None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_size: Option<u64>,
    /// Space UUIDs this entry fans out to.  `default` matters: queued pushes
    /// round-trip through sync_pending.json, and a personal entry serializes
    /// without this field.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub space_ids: Vec<String>,
    /// CEK envelope: JSON map of wrapped content-key copies — `"personal"`
    /// (under the UMK) plus one per space id. Opaque to the server.  No serde
    /// default on purpose: pre-CEK queue files fail to parse and are dropped
    /// instead of pushing ciphertext nobody could unwrap.
    pub wrapped_keys: String,
}

/// Request body for `POST /sync/push` — the backend expects `{ "entries": [...] }`.
#[derive(Debug, Serialize)]
struct PushBody<'a> {
    entries: &'a [PushEntryRequest],
}

#[derive(Debug, Deserialize)]
pub struct AcceptedEntry {
    pub client_id: String,
    pub server_id: String,
    pub server_ts: u64,
}

#[derive(Debug, Deserialize)]
pub struct ConflictEntry {
    pub client_id: String,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct PushResult {
    pub accepted: Vec<AcceptedEntry>,
    pub conflicts: Vec<ConflictEntry>,
}

#[derive(Debug, Deserialize)]
pub struct PulledEntry {
    #[serde(rename = "id")]
    pub server_id: String,
    pub client_id: String,
    /// Originating device — used to skip our own entries echoed back over WS.
    #[serde(default)]
    pub device_id: Option<String>,
    pub entry_type: String,
    #[serde(default)]
    pub kind: Option<String>,
    pub encrypted_content: String,
    #[serde(default)]
    pub encrypted_metadata: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub server_ts: u64,
    #[serde(default)]
    pub deleted_at: Option<u64>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub space_ids: Vec<String>,
    /// CEK envelope map (see `PushEntryRequest::wrapped_keys`).
    #[serde(default)]
    pub wrapped_keys: String,
    #[serde(default)]
    pub blob_key: Option<String>,
    #[serde(default)]
    pub blob_size: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct PullResponse {
    pub entries: Vec<PulledEntry>,
    pub next_cursor: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct CursorRequest {
    pub last_server_ts: u64,
}

#[derive(Debug, Serialize)]
pub struct SettingsPushRequest {
    pub encrypted_blob: String,
    pub updated_at: u64,
}

#[derive(Debug, Deserialize)]
pub struct SettingsPushResponse {
    pub winner: String, // "client" | "server"
    pub encrypted_blob: Option<String>,
    pub updated_at: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct SettingsPullResponse {
    pub encrypted_blob: String,
    pub updated_at: u64,
}

// ── Spaces ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct CreateSpaceRequest {
    pub name: String,
    /// Owner's choice: may members who join later read entries pushed before
    /// they joined? Resolved server-side into each member's history floor.
    pub share_history: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateSpaceResponse {
    pub space_id: String,
    pub invite_code: String,
}

/// One member of a space; `identity_pubkey` is null until they register keys.
#[derive(Debug, Deserialize)]
pub struct SpaceMemberOut {
    pub user_id: String,
    #[serde(default)]
    pub display_name: String,
    /// Identity-provider avatar URL; `None` for accounts without one.
    #[serde(default)]
    pub avatar_url: Option<String>,
    pub role: String,
    pub joined_at: u64,
    #[serde(default)]
    pub identity_pubkey: Option<String>,
    /// Whether this member already holds a wrapped keyring.
    #[serde(default)]
    pub has_space_key: bool,
    /// Presence snapshot from the server: true when any of this member's
    /// devices is connected.
    #[serde(default)]
    pub online: bool,
}

/// Full space record (`GET /spaces` / `GET /spaces/{id}`).
#[derive(Debug, Deserialize)]
pub struct SpaceOut {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    #[serde(default)]
    pub invite_code: Option<String>,
    #[serde(default)]
    pub invite_expires_at: Option<u64>,
    #[serde(default)]
    pub members: Vec<SpaceMemberOut>,
    /// Our *own* wrapped keyring (JSON array of wrapped Space Keys, newest
    /// first) against our identity key. Space Keys are held in memory only,
    /// so this is how a client recovers them after restart.
    #[serde(default)]
    pub my_wrapped_space_keys: Option<String>,
    #[serde(default = "default_true")]
    pub share_history: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
pub struct JoinSpaceRequest {
    pub invite_code: String,
}

#[derive(Debug, Deserialize)]
pub struct JoinSpaceResponse {
    pub space_id: String,
    pub name: String,
}

// ── Space key distribution ──────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct WrappedKeyringEntry {
    pub user_id: String,
    /// JSON array of wrapped Space Keys, newest first — opaque to the server.
    pub wrapped_space_keys: String,
}

#[derive(Debug, Serialize)]
pub struct DistributeKeysRequest {
    pub wrapped_keyrings: Vec<WrappedKeyringEntry>,
}

// ── Addressed invites ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InviteOut {
    pub id: String,
    pub space_id: String,
    pub space_name: String,
    pub inviter_id: String,
    pub inviter_name: String,
    pub invitee_email: String,
    pub status: String,
    pub created_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InviteListResponse {
    pub sent: Vec<InviteOut>,
    pub received: Vec<InviteOut>,
}

#[derive(Debug, Serialize)]
pub struct SendInviteRequest {
    pub email: String,
}

#[derive(Debug, Serialize)]
pub struct BlobUploadRequest {
    pub mime_type: String,
    pub size_bytes: u64,
    /// SHA-256 hex of the (encrypted) bytes being uploaded.
    pub checksum: String,
}

#[derive(Debug, Deserialize)]
pub struct BlobUploadResponse {
    pub blob_key: String,
    pub presigned_put_url: String,
    pub expires_in_seconds: u64,
}

#[derive(Debug, Serialize)]
pub struct BlobConfirmRequest {
    pub blob_key: String,
}

#[derive(Debug, Deserialize)]
pub struct BlobDownloadResponse {
    pub presigned_get_url: String,
    pub expires_in_seconds: u64,
}

#[derive(Debug, Deserialize)]
pub struct QuotaResponse {
    pub used_bytes: u64,
    pub quota_bytes: u64,
}

// ── Client ───────────────────────────────────────────────────────────

pub struct SyncHttpClient {
    inner: reqwest::Client,
    pub base_url: String,
    /// Supabase Auth handle, used to refresh the access token on 401.
    supabase: Arc<SupabaseAuth>,
    /// Short-lived Supabase JWT.  Replaced on the 401 → refresh flow.
    access_token: Mutex<Option<String>>,
    /// Long-lived Supabase refresh token.  Rotated on each refresh.
    refresh_token: Mutex<Option<String>>,
    /// This device's server-assigned UUID (sent as `X-Device-Id`).
    device_id: Mutex<Option<String>>,
    user_id: Mutex<Option<String>>,
    /// Serialises token refresh.
    ///
    /// GoTrue rotates the refresh token on every use and revokes the whole
    /// token family when a spent one is presented outside its reuse window.
    /// Startup fires the WebSocket listener and the initial sync at the same
    /// time, so without this two concurrent 401s would each spend the same
    /// stored token and log the user out permanently.
    refresh_lock: tokio::sync::Mutex<()>,
    /// Bumped on every access-token replacement.  A caller that entered
    /// [`Self::refresh_access_token`] at generation N and finds a higher one
    /// after taking `refresh_lock` knows a concurrent refresh already produced
    /// the fresh token it wanted, and must not spend the rotated token again.
    token_generation: AtomicU64,
    /// Unix seconds at which the current access token expires; 0 when unknown.
    access_token_expires_at: AtomicU64,
}

/// Seconds the server asked us to wait, from a `Retry-After` header.  Only the
/// delta-seconds form is honoured; the HTTP-date form is rare and not worth a
/// date parser here.
fn retry_after_secs(resp: &reqwest::Response) -> Option<u64> {
    resp.headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(|s| s.min(30))
}

/// Flatten a reqwest transport failure into something a user can act on.
///
/// `reqwest::Error`'s own `Display` stops at "error sending request for url
/// (...)" and hides the cause in `source()`, so every network problem - DNS,
/// TLS, refused connection, timeout - reaches the UI looking identical.
fn transport_detail(e: &reqwest::Error) -> String {
    let head = if e.is_timeout() {
        "timed out"
    } else if e.is_connect() {
        "could not reach the server"
    } else if e.is_body() || e.is_decode() {
        "the response was cut short"
    } else {
        "request failed"
    };
    let mut cause: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(e);
    let mut deepest = String::new();
    while let Some(c) = cause {
        deepest = c.to_string();
        cause = c.source();
    }
    if deepest.is_empty() {
        head.to_string()
    } else {
        format!("{head} ({deepest})")
    }
}

impl SyncHttpClient {
    pub fn new(base_url: String, supabase: Arc<SupabaseAuth>) -> Arc<Self> {
        Self::with_timeout(base_url, supabase, REQUEST_TIMEOUT_SECS)
    }

    /// Same client with a custom request timeout.  Session restore uses a
    /// longer one: it runs while the app is still starting up (often right
    /// after an update, before the network is fully back), and a timeout there
    /// costs the user a manual login.
    pub fn with_timeout(
        base_url: String,
        supabase: Arc<SupabaseAuth>,
        timeout_secs: u64,
    ) -> Arc<Self> {
        let inner = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout_secs))
            .build()
            .expect("reqwest client");
        Arc::new(Self {
            inner,
            base_url,
            supabase,
            access_token: Mutex::new(None),
            refresh_token: Mutex::new(None),
            device_id: Mutex::new(None),
            user_id: Mutex::new(None),
            refresh_lock: tokio::sync::Mutex::new(()),
            token_generation: AtomicU64::new(0),
            access_token_expires_at: AtomicU64::new(0),
        })
    }

    /// Store a freshly issued access token.  `expires_in` is the lifetime
    /// GoTrue reported in seconds; 0 means "unknown", which disables the
    /// proactive refresh and falls back to the reactive 401 path.
    pub fn set_access_token(&self, token: String, expires_in: u64) {
        *self.access_token.lock() = Some(token);
        self.access_token_expires_at.store(
            if expires_in == 0 {
                0
            } else {
                now_secs().saturating_add(expires_in)
            },
            Ordering::SeqCst,
        );
        self.token_generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn set_refresh_token(&self, token: String) {
        *self.refresh_token.lock() = Some(token);
    }

    pub fn set_device_id(&self, device_id: String) {
        *self.device_id.lock() = Some(device_id);
    }

    pub fn set_user_id(&self, user_id: String) {
        *self.user_id.lock() = Some(user_id);
    }

    pub fn device_id(&self) -> Option<String> {
        self.device_id.lock().clone()
    }

    pub fn clear_auth(&self) {
        *self.access_token.lock() = None;
        *self.refresh_token.lock() = None;
        *self.device_id.lock() = None;
        *self.user_id.lock() = None;
        self.access_token_expires_at.store(0, Ordering::SeqCst);
        self.token_generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn is_authenticated(&self) -> bool {
        self.access_token.lock().is_some()
    }

    /// Current access token for use in the WebSocket URL query param.
    pub fn current_access_token(&self) -> Option<String> {
        self.access_token.lock().clone()
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path)
    }

    fn auth_header(&self) -> Option<String> {
        self.access_token
            .lock()
            .as_ref()
            .map(|t| format!("Bearer {t}"))
    }

    /// Build an authenticated request for `path`, attaching `Authorization`
    /// and — when known — the `X-Device-Id` header.
    fn authed(&self, method: Method, path: &str) -> Result<reqwest::RequestBuilder, String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let mut rb = self
            .inner
            .request(method, self.url(path))
            .header("Authorization", auth);
        let device_id = self.device_id.lock().clone();
        if let Some(device_id) = device_id {
            rb = rb.header("X-Device-Id", device_id);
        }
        Ok(rb)
    }

    /// Exchange the stored refresh token for a fresh access token via Supabase.
    /// Rotates and persists the refresh token on success.
    ///
    /// Single-flight: concurrent callers queue on `refresh_lock`, and whoever
    /// gets in after the token has already moved on returns straight away
    /// instead of spending the rotated token a second time.
    pub(crate) async fn refresh_access_token(&self) -> Result<(), String> {
        // Read the generation *before* queueing, so it reflects the token the
        // caller found stale rather than one a winner installed while we waited.
        let seen = self.token_generation.load(Ordering::SeqCst);
        let _guard = self.refresh_lock.lock().await;
        if self.token_generation.load(Ordering::SeqCst) != seen {
            // Someone refreshed while we were queued; their token is ours too.
            return Ok(());
        }

        let refresh = self
            .refresh_token
            .lock()
            .clone()
            .ok_or("session expired, log in again")?;
        let session = self.supabase.refresh(&refresh).await?;
        // Rotate the stored token before publishing the access token: the
        // generation bump in set_access_token is what releases queued callers,
        // and they must never observe the spent refresh token.
        *self.refresh_token.lock() = Some(session.refresh_token.clone());
        let user_id = self.user_id.lock().clone();
        if let Some(user_id) = user_id {
            let _ = crate::sync::crypto::store_refresh_token(&user_id, &session.refresh_token);
        }
        self.set_access_token(session.access_token, session.expires_in);
        Ok(())
    }

    /// Refresh ahead of expiry so a request never leaves with a JWT that dies
    /// in flight, and so the WebSocket reconnect loop stops handshaking with a
    /// token that expired while the app sat idle.
    ///
    /// Best-effort: on failure the caller proceeds and the reactive 401 path in
    /// [`Self::run`] gets its turn.
    pub async fn ensure_fresh_access_token(&self) {
        let expires_at = self.access_token_expires_at.load(Ordering::SeqCst);
        if expires_at == 0 || self.access_token.lock().is_none() {
            return;
        }
        if now_secs().saturating_add(TOKEN_REFRESH_SKEW_SECS) < expires_at {
            return;
        }
        if let Err(e) = self.refresh_access_token().await {
            eprintln!("[sync] proactive token refresh failed: {e}");
        }
    }

    /// Run a request built by `factory`, retrying once after a Supabase token
    /// refresh if the backend responds 401.  `factory` is re-invoked on retry
    /// so the rebuilt request picks up the refreshed `Authorization` header.
    ///
    /// With `allow_404`, a 404 yields `Ok(None)` instead of an error.
    async fn run<F>(
        &self,
        tag: &str,
        allow_404: bool,
        factory: F,
    ) -> Result<Option<reqwest::Response>, ApiError>
    where
        F: Fn() -> Result<reqwest::RequestBuilder, String>,
    {
        self.ensure_fresh_access_token().await;
        let mut refreshed = false;
        let mut retried = false;
        let mut attempt: u32 = 0;
        loop {
            let sent = factory()
                .map_err(|message| ApiError {
                    // A request we could not even build is a local problem
                    // (no token yet), not something a retry fixes.
                    status: Some(0),
                    message,
                })?
                .send()
                .await;
            let resp = match sent {
                Ok(resp) => resp,
                // Nothing came back at all.  A host that spins down when idle
                // drops the first request that wakes it and answers the next
                // one, so give it exactly one more try before giving up - the
                // alternative is a skipped entry the user has to heal by hand.
                Err(e) if !retried && (e.is_timeout() || e.is_connect()) => {
                    retried = true;
                    tokio::time::sleep(std::time::Duration::from_secs(
                        TRANSPORT_RETRY_DELAY_SECS,
                    ))
                    .await;
                    continue;
                }
                Err(e) => {
                    return Err(ApiError {
                        status: None,
                        message: format!("{tag}: {}", transport_detail(&e)),
                    })
                }
            };
            let code = resp.status().as_u16();
            if code == 401 && !refreshed {
                self.refresh_access_token().await.map_err(|message| ApiError {
                    status: Some(401),
                    message,
                })?;
                refreshed = true;
                continue;
            }
            if allow_404 && code == 404 {
                return Ok(None);
            }
            // The server is up but could not serve this request right now.
            // Back off and try again: the alternative is a skipped entry that
            // never heals on its own.
            if matches!(code, 429 | 502 | 503 | 504) && attempt < SERVER_RETRY_ATTEMPTS {
                let wait = retry_after_secs(&resp).unwrap_or(1u64 << attempt);
                attempt += 1;
                tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                continue;
            }
            if !resp.status().is_success() {
                let body = resp.text().await.unwrap_or_default();
                let body = body.trim();
                let detail = if body.is_empty() {
                    // A bare 502 from a proxy has no body, and "blob
                    // request-upload 502:" told the user nothing at all.
                    "the server did not respond in time; try again"
                } else {
                    body
                };
                return Err(ApiError {
                    status: Some(code),
                    message: format!("{tag} {code}: {detail}"),
                });
            }
            return Ok(Some(resp));
        }
    }

    /// Run and parse the JSON body as `T`, flattening the error to a string.
    /// Most callers only ever surface the message; the handful that need the
    /// status use [`Self::get_json_classified`] directly.
    async fn get_json<T, F>(&self, tag: &str, factory: F) -> Result<T, String>
    where
        T: serde::de::DeserializeOwned,
        F: Fn() -> Result<reqwest::RequestBuilder, String>,
    {
        self.get_json_classified(tag, factory)
            .await
            .map_err(String::from)
    }

    /// Run and parse the JSON body as `T`, keeping the HTTP status.
    async fn get_json_classified<T, F>(&self, tag: &str, factory: F) -> Result<T, ApiError>
    where
        T: serde::de::DeserializeOwned,
        F: Fn() -> Result<reqwest::RequestBuilder, String>,
    {
        let resp = self
            .run(tag, false, factory)
            .await?
            .expect("404 not allowed here");
        // The call succeeded; only the body was unreadable, so leave the status
        // off rather than let it read as a verdict on our credentials.
        resp.json::<T>().await.map_err(|e| ApiError {
            status: None,
            message: format!("{tag} parse: {e}"),
        })
    }

    /// Run and discard the response body.
    async fn get_ok<F>(&self, tag: &str, allow_404: bool, factory: F) -> Result<(), String>
    where
        F: Fn() -> Result<reqwest::RequestBuilder, String>,
    {
        self.run(tag, allow_404, factory)
            .await
            .map(|_| ())
            .map_err(String::from)
    }

    // ── Auth (profile / devices / keys) ───────────────────────────

    /// Idempotently ensure a profile exists; returns the KDF salt for UMK
    /// derivation.  Called right after a successful Supabase login.
    ///
    /// Returns [`ApiError`] so session restore can retry an unreachable backend
    /// instead of dropping the user at the login screen.
    pub async fn bootstrap(
        &self,
        display_name: Option<String>,
    ) -> Result<BootstrapResponse, ApiError> {
        let body = BootstrapRequest { display_name };
        self.get_json_classified("bootstrap", || {
            Ok(self.authed(Method::POST, "/api/v1/auth/bootstrap")?.json(&body))
        })
        .await
    }

    /// Store the password-wrapped UMK envelope for this account.  Called once on
    /// first setup, and again if the account password changes (re-wrap).
    pub async fn set_wrapped_umk(&self, wrapped_umk: String) -> Result<(), String> {
        let body = SetWrappedUmkRequest { wrapped_umk };
        self.get_ok("set wrapped umk", false, || {
            Ok(self.authed(Method::PUT, "/api/v1/auth/umk")?.json(&body))
        })
        .await
    }

    /// Register this device; returns the server-assigned device_id.
    pub async fn register_device(
        &self,
        req: RegisterDeviceRequest,
    ) -> Result<RegisterDeviceResponse, String> {
        self.get_json("register device", || {
            Ok(self.authed(Method::POST, "/api/v1/auth/devices")?.json(&req))
        })
        .await
    }

    /// Store the user's identity + this device's public keys for E2E setup.
    pub async fn register_keys(&self, req: RegisterKeysRequest) -> Result<(), String> {
        self.get_ok("register keys", false, || {
            Ok(self
                .authed(Method::POST, "/api/v1/auth/keys/register")?
                .json(&req))
        })
        .await
    }

    /// Local sign-out.  Supabase refresh tokens are cleared client-side; there
    /// is no server session to invalidate on our backend.
    pub fn logout(&self) {
        self.clear_auth();
    }

    // ── Sync push / pull ──────────────────────────────────────────

    pub async fn push_entries(
        &self,
        entries: Vec<PushEntryRequest>,
    ) -> Result<PushResult, String> {
        let body = PushBody { entries: &entries };
        self.get_json("push", || {
            Ok(self
                .authed(Method::POST, "/api/v1/sync/push")?
                .json(&body))
        })
        .await
    }

    pub async fn pull_entries(
        &self,
        after_ts: Option<u64>,
        limit: u32,
    ) -> Result<PullResponse, String> {
        let mut path = format!("/api/v1/sync/pull?limit={limit}");
        if let Some(ts) = after_ts {
            path.push_str(&format!("&after_ts={ts}"));
        }
        self.get_json("pull", || self.authed(Method::GET, &path)).await
    }

    pub async fn advance_cursor(&self, last_server_ts: u64) -> Result<(), String> {
        let body = CursorRequest { last_server_ts };
        self.get_ok("cursor", false, || {
            Ok(self.authed(Method::POST, "/api/v1/sync/cursor")?.json(&body))
        })
        .await
    }

    // Note: there is no dedicated delete route. Deletions are propagated as
    // tombstones — a normal `push` with `deleted_at` set (keyed by client_id +
    // entry_type). See `SyncClient::spawn_delete_entry`.

    // ── Settings ──────────────────────────────────────────────────

    pub async fn push_settings(
        &self,
        req: SettingsPushRequest,
    ) -> Result<SettingsPushResponse, String> {
        self.get_json("settings push", || {
            Ok(self.authed(Method::PUT, "/api/v1/settings")?.json(&req))
        })
        .await
    }

    pub async fn pull_settings(&self) -> Result<Option<SettingsPullResponse>, String> {
        match self
            .run("settings pull", true, || {
                self.authed(Method::GET, "/api/v1/settings")
            })
            .await?
        {
            None => Ok(None),
            Some(resp) => resp
                .json::<SettingsPullResponse>()
                .await
                .map(Some)
                .map_err(|e| format!("settings pull parse: {e}")),
        }
    }

    // ── Spaces ────────────────────────────────────────────────────

    pub async fn list_spaces(&self) -> Result<Vec<SpaceOut>, String> {
        self.get_json("list spaces", || self.authed(Method::GET, "/api/v1/spaces"))
            .await
    }

    pub async fn get_space(&self, space_id: &str) -> Result<SpaceOut, String> {
        self.get_json("get space", || {
            self.authed(Method::GET, &format!("/api/v1/spaces/{space_id}"))
        })
        .await
    }

    pub async fn create_space(
        &self,
        req: CreateSpaceRequest,
    ) -> Result<CreateSpaceResponse, String> {
        self.get_json("create space", || {
            Ok(self.authed(Method::POST, "/api/v1/spaces")?.json(&req))
        })
        .await
    }

    pub async fn join_space(&self, req: JoinSpaceRequest) -> Result<JoinSpaceResponse, String> {
        self.get_json("join space", || {
            Ok(self.authed(Method::POST, "/api/v1/spaces/join")?.json(&req))
        })
        .await
    }

    /// Distribute per-member wrapped Space keyrings (owner action).
    pub async fn distribute_space_keys(
        &self,
        space_id: &str,
        req: DistributeKeysRequest,
    ) -> Result<(), String> {
        self.get_ok("distribute keys", false, || {
            Ok(self
                .authed(Method::POST, &format!("/api/v1/spaces/{space_id}/keys"))?
                .json(&req))
        })
        .await
    }

    /// Delete a space the caller owns.
    pub async fn delete_space(&self, space_id: &str) -> Result<(), String> {
        self.get_ok("delete space", true, || {
            self.authed(Method::DELETE, &format!("/api/v1/spaces/{space_id}"))
        })
        .await
    }

    /// Leave a space (self-removal) — the owner may also remove others.
    pub async fn remove_space_member(
        &self,
        space_id: &str,
        member_user_id: &str,
    ) -> Result<(), String> {
        self.get_ok("remove member", true, || {
            self.authed(
                Method::DELETE,
                &format!("/api/v1/spaces/{space_id}/members/{member_user_id}"),
            )
        })
        .await
    }

    // ── Blob storage ──────────────────────────────────────────────

    pub async fn request_blob_upload(
        &self,
        req: BlobUploadRequest,
    ) -> Result<BlobUploadResponse, String> {
        self.get_json("blob request-upload", || {
            Ok(self
                .authed(Method::POST, "/api/v1/blobs/request-upload")?
                .json(&req))
        })
        .await
    }

    /// `mime` must be the same value the upload was requested with: the
    /// backend signs `ContentType` into the presigned PUT, so S3 recomputes
    /// the signature over a `content-type` header we have to send back
    /// verbatim. Omitting it is a signature mismatch, which S3 answers 403.
    pub async fn upload_blob_bytes(
        &self,
        upload_url: &str,
        data: Vec<u8>,
        mime: &str,
    ) -> Result<(), String> {
        // Presigned URL upload — no auth header, no retry (not our origin).
        let resp = self
            .inner
            .put(upload_url)
            .header(reqwest::header::CONTENT_TYPE, mime)
            .timeout(std::time::Duration::from_secs(BLOB_TRANSFER_TIMEOUT_SECS))
            .body(data)
            .send()
            .await
            .map_err(|e| format!("blob upload: {}", transport_detail(&e)))?;
        if !resp.status().is_success() {
            return Err(format!("blob upload {}", resp.status().as_u16()));
        }
        Ok(())
    }

    pub async fn confirm_blob_upload(&self, blob_key: &str) -> Result<(), String> {
        let body = BlobConfirmRequest {
            blob_key: blob_key.to_string(),
        };
        self.get_ok("blob confirm", false, || {
            Ok(self
                .authed(Method::POST, "/api/v1/blobs/confirm-upload")?
                .json(&body))
        })
        .await
    }

    /// Fetch a presigned GET URL for a blob (owner-only server-side).
    pub async fn blob_download_url(
        &self,
        blob_key: &str,
    ) -> Result<BlobDownloadResponse, String> {
        self.get_json("blob download-url", || {
            self.authed(
                Method::GET,
                &format!("/api/v1/blobs/{blob_key}/download-url"),
            )
        })
        .await
    }

    /// Download raw blob bytes from a presigned GET URL (no auth, no retry).
    pub async fn download_blob_bytes(&self, get_url: &str) -> Result<Vec<u8>, String> {
        let resp = self
            .inner
            .get(get_url)
            .timeout(std::time::Duration::from_secs(BLOB_TRANSFER_TIMEOUT_SECS))
            .send()
            .await
            .map_err(|e| format!("blob download: {}", transport_detail(&e)))?;
        if !resp.status().is_success() {
            return Err(format!("blob download {}", resp.status().as_u16()));
        }
        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| format!("blob download body: {}", transport_detail(&e)))
    }

    pub async fn blob_quota(&self) -> Result<QuotaResponse, String> {
        self.get_json("blob quota", || self.authed(Method::GET, "/api/v1/blobs/quota"))
            .await
    }

    // ── Devices ───────────────────────────────────────────────────

    /// List the current user's registered devices (for the presence UI).
    pub async fn list_devices(&self) -> Result<Vec<DeviceOut>, String> {
        self.get_json("list devices", || self.authed(Method::GET, "/api/v1/auth/devices"))
            .await
    }

    /// The UMK wrapped for this device (silent restore path); `None` when no
    /// wrap is stored or the device was revoked.
    pub async fn get_device_wrapped_umk(&self) -> Result<Option<String>, ApiError> {
        match self
            .run("device umk", true, || {
                self.authed(Method::GET, "/api/v1/auth/umk/device")
            })
            .await?
        {
            None => Ok(None),
            Some(resp) => resp
                .json::<serde_json::Value>()
                .await
                .map_err(|e| ApiError {
                    status: None,
                    message: format!("device umk parse: {e}"),
                })
                .map(|v| v.get("wrapped_umk").and_then(|w| w.as_str()).map(String::from)),
        }
    }

    /// Store the UMK wrapped for a device (enables its silent restore).
    pub async fn store_device_wrapped_umk(
        &self,
        device_id: &str,
        wrapped_umk: String,
    ) -> Result<(), String> {
        let body = serde_json::json!({ "wrapped_umk": wrapped_umk });
        self.get_ok("store device umk", false, || {
            Ok(self
                .authed(Method::POST, &format!("/api/v1/auth/devices/{device_id}/key-wrap"))?
                .json(&body))
        })
        .await
    }

    /// Revoke one of the user's devices (soft delete server-side).
    pub async fn revoke_device(&self, device_id: &str) -> Result<(), String> {
        self.get_ok("revoke device", true, || {
            self.authed(Method::DELETE, &format!("/api/v1/auth/devices/{device_id}"))
        })
        .await
    }

    // ── Addressed invites ─────────────────────────────────────────

    /// Pending invites addressed to us + the status of invites we sent.
    pub async fn list_invites(&self) -> Result<InviteListResponse, String> {
        self.get_json("list invites", || self.authed(Method::GET, "/api/v1/invites"))
            .await
    }

    /// Send an addressed invite for a space we own (also emails the code).
    pub async fn send_space_invite(&self, space_id: &str, email: &str) -> Result<InviteOut, String> {
        let body = SendInviteRequest { email: email.to_string() };
        self.get_json("send invite", || {
            Ok(self
                .authed(Method::POST, &format!("/api/v1/spaces/{space_id}/invites"))?
                .json(&body))
        })
        .await
    }

    /// Accept an invite addressed to us; joins its space server-side.
    pub async fn accept_invite(&self, invite_id: &str) -> Result<JoinSpaceResponse, String> {
        self.get_json("accept invite", || {
            Ok(self
                .authed(Method::POST, &format!("/api/v1/invites/{invite_id}/accept"))?
                .json(&serde_json::json!({})))
        })
        .await
    }

    pub async fn decline_invite(&self, invite_id: &str) -> Result<(), String> {
        self.get_ok("decline invite", true, || {
            Ok(self
                .authed(Method::POST, &format!("/api/v1/invites/{invite_id}/decline"))?
                .json(&serde_json::json!({})))
        })
        .await
    }

    pub async fn revoke_invite(&self, invite_id: &str) -> Result<(), String> {
        self.get_ok("revoke invite", true, || {
            self.authed(Method::DELETE, &format!("/api/v1/invites/{invite_id}"))
        })
        .await
    }
}
