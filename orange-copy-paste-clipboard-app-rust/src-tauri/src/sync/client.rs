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

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::sync::supabase::{AuthError, SupabaseAuth};

const REQUEST_TIMEOUT_SECS: u64 = 10;

/// Blob transfers move up to 5 MB over a presigned S3/R2 URL, which the
/// 10-second default cuts off on a slow link.
const BLOB_TRANSFER_TIMEOUT_SECS: u64 = 90;

/// How long to wait before each retry of a request that never reached the
/// backend, in seconds.  The first is long enough for a host that spun down
/// while idle to finish waking; the list ends so a genuinely offline machine
/// still fails quickly.
const TRANSPORT_RETRY_DELAYS: [u64; 2] = [3, 8];

/// How many times to retry a request the server itself failed (502/503/504 from
/// an overloaded or restarting backend, 429 from the rate limiter).  Without
/// this a momentary backend hiccup permanently skips the entry, because a skip
/// is never queued.
const SERVER_RETRY_ATTEMPTS: u32 = 3;

/// Refresh the access token this many seconds before it actually expires, so a
/// request (or a WebSocket handshake) never goes out holding a JWT that dies
/// mid-flight.
const TOKEN_REFRESH_SKEW_SECS: u64 = 120;

// ── An in-flight refresh-token rotation ─────────────────────────────

/// Rotations currently between "GoTrue has been asked" and "the replacement is
/// durable".
///
/// GoTrue revokes a refresh token the moment it is spent, so a process that
/// dies inside that window leaves the keychain holding a token the server has
/// already thrown away - and the next launch cannot tell that from a session
/// that was genuinely revoked. This count is what lets the exit paths wait for
/// the window to close, and what lets a relaunch wait before killing the
/// instance it is replacing.
static ROTATIONS_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// Held for the width of one rotation.
///
/// A guard with a `Drop` rather than a pair of calls, because the count has to
/// come back down through paths that never return normally: a cancelled task,
/// an early `?`, or the runtime being torn down mid-await. A leaked count would
/// make every later exit wait out the whole drain budget for nothing.
pub(crate) struct RotationGuard;

impl RotationGuard {
    pub(crate) fn enter() -> Self {
        if ROTATIONS_IN_FLIGHT.fetch_add(1, Ordering::SeqCst) == 0 {
            write_rotation_marker();
        }
        Self
    }
}

impl Drop for RotationGuard {
    fn drop(&mut self) {
        if ROTATIONS_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst) == 1 {
            let _ = std::fs::remove_file(rotation_marker_path());
        }
    }
}

/// Whether this process is mid-rotation.
///
/// Reads an atomic and touches no runtime, so an exit path may call it from the
/// main thread without violating the one-way dependency in [`crate::sync`].
pub(crate) fn rotation_in_flight() -> bool {
    ROTATIONS_IN_FLIGHT.load(Ordering::SeqCst) != 0
}

/// Where the cross-process marker lives.
///
/// Deliberately not the app data directory. The process that reads this marker
/// runs before Tauri is built, so it has no `AppHandle` to resolve that path
/// from, and a hand-rolled copy of Tauri's convention would turn into a silent
/// no-op the day the convention drifted. The temp directory is the one location
/// both processes agree on with no help from either.
fn rotation_marker_path() -> std::path::PathBuf {
    // `%TEMP%` is already per-user; `/tmp` is not.
    #[cfg(windows)]
    let scope = String::new();
    #[cfg(not(windows))]
    let scope = std::env::var("USER")
        .map(|u| format!("-{u}"))
        .unwrap_or_default();
    std::env::temp_dir().join(format!("orange-copy-paste-rotating{scope}.lock"))
}

/// Tell any process that might kill us that now is the wrong moment.
///
/// Best-effort on purpose: if the write fails, the only thing lost is a wait a
/// relaunch would have done, which leaves exactly today's behaviour.
fn write_rotation_marker() {
    let _ = std::fs::write(rotation_marker_path(), std::process::id().to_string());
}

/// The pid recorded in the marker, when some process is mid-rotation.
///
/// `None` for a missing, empty or unparseable marker. The pid is the whole point
/// of writing one: a marker left behind by a crash must not make every later
/// launch wait, and the only way to tell a live rotation from a dead one is to
/// check whether the process that claimed it is still running.
pub(crate) fn rotation_marker_pid() -> Option<u32> {
    std::fs::read_to_string(rotation_marker_path())
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// What the server said about this device's copy of the master key.
///
/// The two answers have to stay apart: [`Self::Present`] restores a session
/// silently, [`Self::Absent`] ends one. Anything else - including a 404 that did
/// not come from the key-wrap route - is an error, not an answer.
#[derive(Debug, Clone)]
pub enum DeviceWrap {
    /// The UMK, wrapped for this device's public key.
    Present(String),
    /// This device has no wrap: never stored, or revoked. Only a fresh sign-in
    /// recovers from it.
    Absent,
}

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

    /// True when the server understood the request and will refuse this exact
    /// body however many times it is sent.
    ///
    /// A short explicit list rather than "not transient", because a 401 or a
    /// 403 is also not transient and means the *session* is wrong, not the
    /// payload - dropping a queued entry for one of those would be data loss
    /// the user never asked for. Only a body the server has judged malformed or
    /// oversized is safe to stop retrying.
    pub fn is_permanent_rejection(&self) -> bool {
        matches!(self.status, Some(400) | Some(413) | Some(422))
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
    /// base64 envelope holding the same UMK wrapped under the recovery-code key.
    /// `None` means no recovery code has been saved for this account, which is
    /// what makes the account screen ask for one.
    #[serde(default)]
    pub recovery_wrapped_umk: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SetWrappedUmkRequest {
    pub wrapped_umk: String,
}

#[derive(Debug, Serialize)]
pub struct SetRecoveryUmkRequest {
    pub recovery_wrapped_umk: String,
}

#[derive(Debug, Serialize)]
pub struct RegisterDeviceRequest {
    pub device_name: String,
    pub platform: String,
    pub app_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_pubkey: Option<String>,
    /// Salted hash of this machine's id (see `sync::device_id`). A grouping
    /// hint for the device list, never proof - the server matches on
    /// `device_pubkey`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
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
    /// This row's machine fingerprint, or `None` for rows registered before
    /// fingerprints existed. Lets the UI group one machine's registrations.
    #[serde(default)]
    pub fingerprint: Option<String>,
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
    /// Account that wrote the entry. Names the sender on a space row; our own
    /// entries carry our id, so the Spaces feed compares before showing it.
    #[serde(default)]
    pub user_id: Option<String>,
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

/// One entry that left one space, as reported by a pull.
///
/// The durable counterpart to the `space:entry_removed` event. The event only
/// reaches a device that is connected when it fires, and pub/sub keeps nothing
/// for anyone who is not — so a device that was closed used to come back, pull,
/// match nothing, and keep its copy of withdrawn content indefinitely. Pull
/// cannot infer it either: a removal strips the space id from the entry's
/// `space_ids`, and the entries query matches on exactly that array, so the row
/// is absent rather than changed.
#[derive(Debug, Deserialize)]
pub struct RemovedEntry {
    pub space_id: String,
    pub client_id: String,
    pub entry_type: String,
    /// Who shared it, and who took it down. Equal when the author withdrew their
    /// own post, different when a space owner moderated it — which is the only
    /// way to tell the two apart, and decides what the placeholder says.
    pub author_id: String,
    pub removed_by: String,
    pub server_ts: u64,
}

#[derive(Debug, Deserialize)]
pub struct PullResponse {
    pub entries: Vec<PulledEntry>,
    /// `default` so a client that ships ahead of the backend still parses a
    /// response without the field, rather than failing every sync.
    #[serde(default)]
    pub removals: Vec<RemovedEntry>,
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
    /// Which account wrapped `my_wrapped_space_keys`, and therefore whose public
    /// key opens it. `None` means the owner did - the only possibility before any
    /// member could hand a key over, so old rows keep working.
    #[serde(default)]
    pub my_wrapped_by: Option<String>,
    /// Fingerprint of the space's newest key, written by the owner alone. What a
    /// received keyring is checked against; `None` when the owner has not
    /// published one yet, and then nothing can be verified.
    #[serde(default)]
    pub key_fingerprint: Option<String>,
    /// Set when a departure means the owner owes the space a new key. This is the
    /// rekey signal; it used to be "the server cleared every wrap", which also
    /// destroyed the owner's own recovery copy.
    #[serde(default)]
    pub rekey_requested_at: Option<u64>,
    #[serde(default = "default_true")]
    pub share_history: bool,
    /// The owner's approval policy: may any member let somebody in, or only the
    /// owner? Shown to the owner as the one control on the space.
    #[serde(default)]
    pub members_can_approve: bool,
    /// Whether *we* may approve, resolved by the server from the policy above and
    /// our role. Derived server-side on purpose, so no client re-implements the
    /// rule and none of them can disagree with it.
    #[serde(default)]
    pub i_can_approve: bool,
    /// Pending join requests on this space. Zero unless we may act on them.
    #[serde(default)]
    pub pending_join_requests: u32,
}

/// A comment as it goes to the server: ciphertext plus the wrapped key that
/// opens it. Mirrors `CreateCommentRequest` in the backend.
#[derive(Debug, Serialize)]
pub struct CreateCommentRequest {
    pub client_id: String,
    pub entry_type: String,
    pub encrypted_body: String,
    pub wrapped_key: String,
}

/// A stored comment. The body stays sealed until the space keyring opens it,
/// so nothing here is readable without a Space Key.
#[derive(Debug, Clone, Deserialize)]
pub struct CommentOut {
    pub id: String,
    pub space_id: String,
    pub client_id: String,
    pub entry_type: String,
    pub author_id: String,
    pub encrypted_body: String,
    pub wrapped_key: String,
    pub created_at: i64,
}

/// One entry's tally, for the chips on the feed.
#[derive(Debug, Clone, Deserialize)]
pub struct CommentCountOut {
    pub client_id: String,
    pub entry_type: String,
    pub count: i64,
    pub latest_at: i64,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
pub struct JoinSpaceRequest {
    pub invite_code: String,
}

/// The answer to redeeming an invite code. There is no space in it, because a
/// code no longer grants one: `status` is `"pending"` while somebody inside
/// decides, or `"declined"` when a previous knock was already turned down.
#[derive(Debug, Deserialize)]
pub struct JoinSpaceResponse {
    pub status: String,
    pub space_name: String,
}

// ── Join requests ───────────────────────────────────────────────────────

/// Somebody who pasted this space's code and is waiting to be let in.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct JoinRequestOut {
    pub id: String,
    pub space_id: String,
    pub space_name: String,
    pub user_id: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    pub status: String,
    pub created_at: u64,
    /// The requester's X25519 identity key, so we can wrap the Space Key for them
    /// in the same action as the approval. `None` means they have not registered
    /// keys yet; approving still works and they pick one up on the next
    /// distribution, like any other keyless member.
    #[serde(default)]
    pub identity_pubkey: Option<String>,
}

/// One of our own outstanding knocks. A pending request is not a membership, so
/// none of these spaces come back from `GET /spaces` - this is the only thing
/// that stops the wait being a blank screen.
#[derive(Debug, Clone, Deserialize)]
pub struct MyJoinRequestOut {
    pub space_id: String,
    pub space_name: String,
    pub created_at: u64,
}

#[derive(Debug, Serialize)]
pub struct ApproveJoinRequest {
    /// Our keyring wrapped for the requester. `None` when we cannot wrap yet -
    /// the approval still stands and they wait for a key the way a member does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrapped_space_keys: Option<String>,
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
    /// Fingerprint of the newest key in the rings being sent. The server accepts
    /// it from the space owner only, since only the owner mints.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_fingerprint: Option<String>,
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
    /// The invitee's identity key, returned to the inviter only so it can wrap
    /// the keyring for them up front. Not passed on to the frontend: nothing on
    /// screen needs it, and key material stays in Rust.
    #[serde(default, skip_serializing)]
    pub invitee_identity_pubkey: Option<String>,
    /// Whether a wrapped keyring is already attached to this invite.
    #[serde(default, skip_serializing)]
    pub has_space_key: bool,
}

/// The keyring wrapped for an invitee, attached to their pending invite so the
/// key is there the moment they accept - with nobody else online.
#[derive(Debug, Serialize)]
pub struct AttachInviteKeyRequest {
    pub wrapped_space_keys: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InviteListResponse {
    pub sent: Vec<InviteOut>,
    pub received: Vec<InviteOut>,
}

/// A message written by the server rather than by a user.
///
/// The one payload in the sync contract that arrives as plaintext, because it
/// is the service's own words - a maintenance window, a note to one account -
/// and never quotes content the server would have had to decrypt to know.
#[derive(Debug, Clone, Deserialize)]
pub struct AnnouncementOut {
    pub id: String,
    /// Names a client notification kind. Free-form on the wire so the server can
    /// start using a new one before every build knows it; unknown values fall
    /// back rather than dropping the message.
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub data: std::collections::BTreeMap<String, String>,
    pub created_at: u64,
}

#[derive(Debug, Deserialize)]
pub struct AnnouncementListResponse {
    pub announcements: Vec<AnnouncementOut>,
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
    /// Live rows on the account, and the ceiling they run into. Defaulted so a
    /// build talking to a server from before these existed still parses.
    #[serde(default)]
    pub entry_count: u64,
    #[serde(default)]
    pub entry_limit: u64,
    #[serde(default)]
    pub max_entry_bytes: u64,
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

/// The readable half of an error response.
///
/// FastAPI answers with `{"detail": "..."}`, which used to reach the user as
/// raw JSON; a proxy 502 answers with nothing at all, which reached them as a
/// bare colon.  Both are the same problem: the message is the body's, not the
/// wire format's.
fn error_detail(code: u16, body: &str) -> String {
    let body = body.trim();
    if let Some(detail) = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("detail").and_then(|d| d.as_str()).map(str::to_string))
    {
        return detail;
    }
    if !body.is_empty() && !body.starts_with('{') && !body.starts_with('<') {
        return body.to_string();
    }
    match code {
        502 | 503 | 504 => "the server is busy, try again in a moment".to_string(),
        _ => format!("the server rejected the request ({code})"),
    }
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

    /// The newest refresh token this client holds.
    ///
    /// Not the one its caller started with: [`Self::refresh_access_token`]
    /// rotates it mid-flight, so anything persisting the token has to ask for
    /// the current value rather than reuse the one it was handed at sign-in.
    pub fn refresh_token(&self) -> Option<String> {
        self.refresh_token.lock().clone()
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
    /// Returns [`AuthError`] rather than a string so the caller keeps the status.
    /// Flattening it lost the one thing that separates "GoTrue was unreachable"
    /// or "GoTrue rate-limited us" from "this token is dead" - and the caller
    /// then stamped its own 401 on all three, which is a permanent sign-out for
    /// two failures that would have cleared on their own.
    pub(crate) async fn refresh_access_token(&self) -> Result<(), AuthError> {
        // Read the generation *before* queueing, so it reflects the token the
        // caller found stale rather than one a winner installed while we waited.
        let seen = self.token_generation.load(Ordering::SeqCst);
        let _guard = self.refresh_lock.lock().await;
        if self.token_generation.load(Ordering::SeqCst) != seen {
            // Someone refreshed while we were queued; their token is ours too.
            return Ok(());
        }

        let refresh = self.refresh_token.lock().clone().ok_or_else(|| AuthError {
            // Not transient: no amount of retrying invents a token we never had.
            status: Some(0),
            message: "session expired, log in again".into(),
        })?;
        // Everything from here to the keychain write is the window GoTrue opens
        // when it spends this token. Announce it, so an exit or a relaunch waits
        // for the replacement to be durable instead of destroying it.
        let _rotating = RotationGuard::enter();
        let session = self.supabase.refresh(&refresh).await?;
        // Rotate the stored token before publishing the access token: the
        // generation bump in set_access_token is what releases queued callers,
        // and they must never observe the spent refresh token.
        *self.refresh_token.lock() = Some(session.refresh_token.clone());
        // This write is not best-effort, whatever its return type suggests: the
        // token just handed back replaces one that is now spent, so a dropped
        // write leaves the keychain holding a dead token and signs the user out
        // on the next launch. It cannot be undone from here - the old token is
        // already gone - so record it instead of discarding it silently.
        let user_id = self.user_id.lock().clone();
        if let Some(user_id) = user_id {
            if let Err(e) =
                crate::sync::crypto::store_refresh_token(&user_id, &session.refresh_token)
                    .await
            {
                eprintln!("[sync] rotated refresh token not stored: {e}");
                let detail = format!("{e} - the next launch may have to sign in again");
                // Off the worker too: this runs with the refresh lock held, and
                // appending to the log is disk I/O like any other.
                tokio::task::spawn_blocking(move || {
                    crate::health::note("sync: rotated refresh token not stored", &detail)
                });
            }
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
    /// With `allow_404`, a 404 is returned as a response rather than an error,
    /// and the caller reads the status. It used to collapse to `Ok(None)`, which
    /// threw away the one thing that tells a deliberate 404 apart from any other
    /// - see `get_device_wrapped_umk`, where the difference decides whether a
    /// user keeps their session.
    async fn run<F>(
        &self,
        tag: &str,
        allow_404: bool,
        factory: F,
    ) -> Result<reqwest::Response, ApiError>
    where
        F: Fn() -> Result<reqwest::RequestBuilder, String>,
    {
        self.ensure_fresh_access_token().await;
        let mut refreshed = false;
        let mut transport_tries = 0usize;
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
                Err(e)
                    if transport_tries < TRANSPORT_RETRY_DELAYS.len()
                        && (e.is_timeout() || e.is_connect()) =>
                {
                    let wait = TRANSPORT_RETRY_DELAYS[transport_tries];
                    transport_tries += 1;
                    tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
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
                // Carry GoTrue's own verdict, not a 401 of our own invention.
                // A timeout, a 429 or a 5xx from the refresh grant says nothing
                // about the credential, and stamping 401 on them made the
                // restore path call the session dead and stop retrying.
                self.refresh_access_token().await.map_err(|e| ApiError {
                    status: e.status,
                    message: e.message,
                })?;
                refreshed = true;
                continue;
            }
            if allow_404 && code == 404 {
                return Ok(resp);
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
                return Err(ApiError {
                    status: Some(code),
                    message: format!("{tag} {code}: {}", error_detail(code, &body)),
                });
            }
            return Ok(resp);
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
        let resp = self.run(tag, false, factory).await?;
        // The call succeeded; only the body was unreadable, so leave the status
        // off rather than let it read as a verdict on our credentials.
        // A 2xx whose body we cannot read is almost always a proxy that
        // truncated the reply under load, so say that rather than quoting a
        // decoder error at the user.
        resp.json::<T>().await.map_err(|e| {
            eprintln!("[sync] {tag} parse: {e}");
            ApiError {
                status: None,
                message: format!("{tag}: the server's reply was incomplete, try again"),
            }
        })
    }

    /// Run and discard the response body.
    async fn get_ok<F>(&self, tag: &str, allow_404: bool, factory: F) -> Result<(), String>
    where
        F: Fn() -> Result<reqwest::RequestBuilder, String>,
    {
        self.get_ok_classified(tag, allow_404, factory)
            .await
            .map_err(String::from)
    }

    /// Same, keeping the HTTP status for a caller that acts on it.
    async fn get_ok_classified<F>(
        &self,
        tag: &str,
        allow_404: bool,
        factory: F,
    ) -> Result<(), ApiError>
    where
        F: Fn() -> Result<reqwest::RequestBuilder, String>,
    {
        self.run(tag, allow_404, factory).await.map(|_| ())
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

    /// Store the recovery-code-wrapped UMK envelope for this account.
    ///
    /// Replacing it is how a regenerated code revokes the previous one: the blob
    /// the old code could open stops existing.
    pub async fn set_recovery_wrapped_umk(&self, recovery_wrapped_umk: String) -> Result<(), String> {
        let body = SetRecoveryUmkRequest { recovery_wrapped_umk };
        self.get_ok("set recovery umk", false, || {
            Ok(self
                .authed(Method::PUT, "/api/v1/auth/umk/recovery")?
                .json(&body))
        })
        .await
    }

    /// Drop the recovery envelope, for an account that just started over with a
    /// fresh UMK - the old envelope would otherwise hand a recovering client a
    /// key that decrypts nothing.
    pub async fn clear_recovery_wrapped_umk(&self) -> Result<(), String> {
        self.get_ok("clear recovery umk", false, || {
            self.authed(Method::DELETE, "/api/v1/auth/umk/recovery")
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

    /// Keeps the status rather than flattening it: a push that is refused for
    /// its body must not be queued for retry, and only the status says which
    /// kind of failure this was. See [`ApiError::is_permanent_rejection`].
    pub async fn push_entries(
        &self,
        entries: Vec<PushEntryRequest>,
    ) -> Result<PushResult, ApiError> {
        let body = PushBody { entries: &entries };
        self.get_json_classified("push", || {
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
        let resp = self
            .run("settings pull", true, || {
                self.authed(Method::GET, "/api/v1/settings")
            })
            .await?;
        // Nothing stored yet for this account, which is the normal first-run
        // answer rather than a failure.
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        resp.json::<SettingsPullResponse>()
            .await
            .map(Some)
            .map_err(|e| format!("settings pull parse: {e}"))
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

    /// Change a space's history policy (owner only). Returns the updated space,
    /// so the caller does not need a second round trip to refresh its list.
    pub async fn set_share_history(
        &self,
        space_id: &str,
        share_history: bool,
    ) -> Result<SpaceOut, String> {
        self.get_json("update space", || {
            Ok(self
                .authed(Method::PATCH, &format!("/api/v1/spaces/{space_id}"))?
                .json(&serde_json::json!({ "share_history": share_history })))
        })
        .await
    }

    pub async fn join_space(&self, req: JoinSpaceRequest) -> Result<JoinSpaceResponse, String> {
        self.get_json("join space", || {
            Ok(self.authed(Method::POST, "/api/v1/spaces/join")?.json(&req))
        })
        .await
    }

    /// Pending join requests on a space we may approve for.
    pub async fn list_join_requests(&self, space_id: &str) -> Result<Vec<JoinRequestOut>, String> {
        self.get_json("list join requests", || {
            Ok(self.authed(
                Method::GET,
                &format!("/api/v1/spaces/{space_id}/join-requests"),
            )?)
        })
        .await
    }

    /// Spaces we have asked to join and are still waiting on.
    pub async fn my_join_requests(&self) -> Result<Vec<MyJoinRequestOut>, String> {
        self.get_json("my join requests", || {
            Ok(self.authed(Method::GET, "/api/v1/spaces/my-join-requests")?)
        })
        .await
    }

    /// Let a requester in, handing over the Space Key in the same call.
    pub async fn approve_join_request(
        &self,
        space_id: &str,
        request_id: &str,
        wrapped_space_keys: Option<String>,
    ) -> Result<(), String> {
        self.get_ok("approve join request", false, || {
            Ok(self
                .authed(
                    Method::POST,
                    &format!("/api/v1/spaces/{space_id}/join-requests/{request_id}/approve"),
                )?
                .json(&ApproveJoinRequest {
                    wrapped_space_keys: wrapped_space_keys.clone(),
                }))
        })
        .await
    }

    /// Turn a request down. The server keeps the row, which is what stops the
    /// same code producing another knock.
    pub async fn decline_join_request(
        &self,
        space_id: &str,
        request_id: &str,
    ) -> Result<(), String> {
        self.get_ok("decline join request", false, || {
            Ok(self.authed(
                Method::POST,
                &format!("/api/v1/spaces/{space_id}/join-requests/{request_id}/decline"),
            )?)
        })
        .await
    }

    /// Choose who may approve join requests (owner only).
    pub async fn set_members_can_approve(
        &self,
        space_id: &str,
        members_can_approve: bool,
    ) -> Result<SpaceOut, String> {
        self.get_json("update space", || {
            Ok(self
                .authed(Method::PATCH, &format!("/api/v1/spaces/{space_id}"))?
                .json(&serde_json::json!({ "members_can_approve": members_can_approve })))
        })
        .await
    }

    /// Attach a wrapped keyring to a pending invite we sent.
    ///
    /// Accepting the invite moves it onto the new membership, so a member can read
    /// the space from the instant they join instead of waiting for a keyholder to
    /// come online.
    pub async fn attach_invite_key(
        &self,
        invite_id: &str,
        wrapped_space_keys: String,
    ) -> Result<(), String> {
        self.get_ok("attach invite key", false, || {
            Ok(self
                .authed(Method::PUT, &format!("/api/v1/invites/{invite_id}/key"))?
                .json(&AttachInviteKeyRequest {
                    wrapped_space_keys: wrapped_space_keys.clone(),
                }))
        })
        .await
    }

    /// Distribute wrapped Space keyrings to members who lack one. Any member
    /// holding the ring may call this; only the owner may name a fingerprint.
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

    /// Take a shared entry down from a space we own. Moderation, not deletion:
    /// the author keeps their personal copy, the space stops carrying it.
    pub async fn remove_space_entry(
        &self,
        space_id: &str,
        client_id: &str,
        entry_type: &str,
    ) -> Result<(), String> {
        self.get_ok("remove space entry", true, || {
            self.authed(
                Method::DELETE,
                &format!("/api/v1/spaces/{space_id}/entries/{client_id}"),
            )
            .map(|req| req.query(&[("entry_type", entry_type)]))
        })
        .await
    }

    // ── Space comments ────────────────────────────────────────────

    pub async fn add_space_comment(
        &self,
        space_id: &str,
        req: &CreateCommentRequest,
    ) -> Result<CommentOut, String> {
        self.get_json("add comment", || {
            Ok(self
                .authed(
                    Method::POST,
                    &format!("/api/v1/spaces/{space_id}/comments"),
                )?
                .json(req))
        })
        .await
    }

    pub async fn list_space_comments(
        &self,
        space_id: &str,
        client_id: &str,
        entry_type: &str,
    ) -> Result<Vec<CommentOut>, String> {
        self.get_json("list comments", || {
            self.authed(
                Method::GET,
                &format!("/api/v1/spaces/{space_id}/comments"),
            )
            .map(|req| req.query(&[("client_id", client_id), ("entry_type", entry_type)]))
        })
        .await
    }

    pub async fn space_comment_counts(
        &self,
        space_id: &str,
    ) -> Result<Vec<CommentCountOut>, String> {
        self.get_json("comment counts", || {
            self.authed(
                Method::GET,
                &format!("/api/v1/spaces/{space_id}/comments/counts"),
            )
        })
        .await
    }

    pub async fn delete_space_comment(
        &self,
        space_id: &str,
        comment_id: &str,
    ) -> Result<(), String> {
        self.get_ok("delete comment", true, || {
            self.authed(
                Method::DELETE,
                &format!("/api/v1/spaces/{space_id}/comments/{comment_id}"),
            )
        })
        .await
    }

    // ── Blob storage ──────────────────────────────────────────────

    /// Returns [`ApiError`] rather than a string: a 402 here means the account
    /// is out of storage, which the caller latches so it stops asking once per
    /// image for the rest of a bulk upload.
    pub async fn request_blob_upload(
        &self,
        req: BlobUploadRequest,
    ) -> Result<BlobUploadResponse, ApiError> {
        self.get_json_classified("blob request-upload", || {
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

    /// Give an upload back when the entry that would own it never landed.
    ///
    /// The server refuses (409) while a live entry still references the blob, so
    /// this cannot take an image away from an entry that is using it. Failure is
    /// the caller's to ignore: the hourly unreferenced sweep is the backstop, and
    /// nothing the user sees depends on this call succeeding.
    pub async fn release_blob_upload(&self, blob_key: &str) -> Result<(), String> {
        let body = BlobConfirmRequest {
            blob_key: blob_key.to_string(),
        };
        self.get_ok("blob release", false, || {
            Ok(self
                .authed(Method::POST, "/api/v1/blobs/release")?
                .json(&body))
        })
        .await
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

    /// The UMK wrapped for this device - the silent restore path.
    ///
    /// Three answers, not two. [`DeviceWrap::Absent`] ends the session and sends
    /// the user back to a password field, so it is only ever returned when the
    /// server said so in as many words: the route stamps its own 404 with
    /// `X-Wrap-Absent`. A 404 without that header did not come from the handler
    /// - a proxy, a rewritten path, a deployment older than the route - and is
    /// reported as unreachable instead, because the credentials in the keychain
    /// are still perfectly good and the retry loop will get the session back.
    pub async fn get_device_wrapped_umk(&self) -> Result<DeviceWrap, ApiError> {
        let resp = self
            .run("device umk", true, || {
                self.authed(Method::GET, "/api/v1/auth/umk/device")
            })
            .await?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            if resp.headers().contains_key("x-wrap-absent") {
                return Ok(DeviceWrap::Absent);
            }
            // No status: `ApiError::is_transient` reads a missing status as "the
            // request never reached what we asked", which is exactly the case
            // here and is the classification the caller needs.
            return Err(ApiError {
                status: None,
                message: "device umk: 404 from something other than the key-wrap route".into(),
            });
        }
        let body = resp.json::<serde_json::Value>().await.map_err(|e| ApiError {
            status: None,
            message: format!("device umk parse: {e}"),
        })?;
        match body.get("wrapped_umk").and_then(|w| w.as_str()) {
            Some(wrapped) => Ok(DeviceWrap::Present(wrapped.to_string())),
            // A 200 with no wrap in it is not the documented shape, so it is a
            // broken reply rather than a verdict on this device.
            None => Err(ApiError {
                status: None,
                message: "device umk: reply carried no wrap".into(),
            }),
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

    /// Announcements this account has not been handed yet.
    ///
    /// `since` is this device's watermark, and the reason dismissing sticks: the
    /// server keeps no per-user read state, so asking for the same window again
    /// would hand back rows the user had already cleared.
    pub async fn list_announcements(&self, since: u64) -> Result<AnnouncementListResponse, String> {
        self.get_json("list announcements", || {
            self.authed(Method::GET, &format!("/api/v1/announcements?since={since}"))
        })
        .await
    }

    /// Send an addressed invite for a space we own (also emails the code).
    /// Classified, unlike most calls: every refusal here is something the owner
    /// can act on (no account, already a member, own address), and the status is
    /// the only stable way to tell them apart - the frontend used to sniff the
    /// message text, which broke silently whenever the wording moved.
    pub async fn send_space_invite(
        &self,
        space_id: &str,
        email: &str,
    ) -> Result<InviteOut, ApiError> {
        let body = SendInviteRequest { email: email.to_string() };
        self.get_json_classified("send invite", || {
            Ok(self
                .authed(Method::POST, &format!("/api/v1/spaces/{space_id}/invites"))?
                .json(&body))
        })
        .await
    }

    /// Accept an invite addressed to us; joins its space server-side.
    /// Classified so the caller can tell "already answered" (409) from a real
    /// failure: the invite is settled either way, and only the second is worth
    /// putting in front of the user.
    pub async fn accept_invite(&self, invite_id: &str) -> Result<JoinSpaceResponse, ApiError> {
        self.get_json_classified("accept invite", || {
            Ok(self
                .authed(Method::POST, &format!("/api/v1/invites/{invite_id}/accept"))?
                .json(&serde_json::json!({})))
        })
        .await
    }

    /// See [`Self::accept_invite`] for why this is classified.
    pub async fn decline_invite(&self, invite_id: &str) -> Result<(), ApiError> {
        self.get_ok_classified("decline invite", true, || {
            Ok(self
                .authed(Method::POST, &format!("/api/v1/invites/{invite_id}/decline"))?
                .json(&serde_json::json!({})))
        })
        .await
    }

    /// See [`Self::accept_invite`] for why this is classified.
    pub async fn revoke_invite(&self, invite_id: &str) -> Result<(), ApiError> {
        self.get_ok_classified("revoke invite", true, || {
            self.authed(Method::DELETE, &format!("/api/v1/invites/{invite_id}"))
        })
        .await
    }
}
