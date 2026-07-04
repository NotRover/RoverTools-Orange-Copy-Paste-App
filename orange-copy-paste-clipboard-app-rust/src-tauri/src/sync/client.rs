//! Async HTTP client for the cloud sync API (our FastAPI backend).
//!
//! Wraps `reqwest::Client` with:
//!   - Base URL injection
//!   - `Authorization: Bearer <supabase jwt>` from the in-memory access token
//!   - `X-Device-Id` header on device-scoped routes
//!   - Automatic 401 → Supabase token refresh → retry (once)
//!   - 10-second request timeout
//!
//! Identity itself (login / signup / refresh) is Supabase's; see
//! [`crate::sync::supabase`].  This client only carries the resulting JWT and
//! refreshes it through Supabase when the backend rejects it with a 401.
//!
//! All methods are `async`.  They run on whichever Tokio runtime the caller is
//! using (Tauri's runtime for commands, or the sync module's dedicated runtime
//! for background tasks).

use std::sync::Arc;

use parking_lot::Mutex;
use reqwest::Method;
use serde::{Deserialize, Serialize};

use crate::sync::supabase::SupabaseAuth;

const REQUEST_TIMEOUT_SECS: u64 = 10;

// ── API request / response types ─────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct BootstrapRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BootstrapResponse {
    pub user_id: String,
    /// base64-encoded salt used for Argon2id UMK derivation.
    pub kdf_salt: String,
    pub display_name: String,
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
    /// Live Share / pool group UUIDs this entry should fan out to.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub group_ids: Vec<String>,
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
    pub group_ids: Vec<String>,
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

// ── Pool groups ───────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct CreateGroupRequest {
    pub name: String,
    pub group_type: String, // "pool"
}

#[derive(Debug, Deserialize)]
pub struct CreateGroupResponse {
    pub group_id: String,
    pub invite_code: String,
}

/// One member of a pool group; `identity_pubkey` is null until they register keys.
#[derive(Debug, Deserialize)]
pub struct GroupMemberOut {
    pub user_id: String,
    pub role: String,
    pub joined_at: u64,
    #[serde(default)]
    pub identity_pubkey: Option<String>,
}

/// Full group record (`GET /groups` / `GET /groups/{id}`).
#[derive(Debug, Deserialize)]
pub struct GroupOut {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub group_type: String,
    #[serde(default)]
    pub invite_code: Option<String>,
    #[serde(default)]
    pub members: Vec<GroupMemberOut>,
}

#[derive(Debug, Serialize)]
pub struct JoinGroupRequest {
    pub invite_code: String,
    /// A member's own wrapped Group Key, when re-joining a group they already
    /// hold a key for; `None` on a fresh join (the owner distributes the key).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrapped_group_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct JoinGroupResponse {
    pub group_id: String,
    pub name: String,
    pub group_type: String,
}

// ── Group key distribution (§7.4) ───────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct WrappedKeyEntry {
    pub user_id: String,
    pub wrapped_group_key: String,
}

#[derive(Debug, Serialize)]
pub struct DistributeKeysRequest {
    pub wrapped_keys: Vec<WrappedKeyEntry>,
}

// ── Live Share ──────────────────────────────────────────────────────────

/// `POST /sharing/invite` — creates a live_share group *and* emails the invite.
#[derive(Debug, Serialize)]
pub struct SharingInviteRequest {
    pub email: String,
    pub share_scope: String, // "clipboard" | "notes" | "both"
}

#[derive(Debug, Deserialize)]
pub struct SharingInviteResponse {
    pub share_group_id: String,
    pub invite_code: String,
    pub expires_at: u64,
}

#[derive(Debug, Deserialize)]
pub struct SessionMemberOut {
    pub user_id: String,
    pub display_name: String,
    pub scope: String,
    #[serde(default)]
    pub identity_pubkey: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SessionOut {
    pub share_group_id: String,
    pub members: Vec<SessionMemberOut>,
    pub my_scope: String,
    pub active_since: u64,
}

#[derive(Debug, Serialize)]
pub struct UpdateScopeRequest {
    pub share_scope: String,
}

#[derive(Debug, Serialize)]
pub struct BlobUploadRequest {
    pub filename: String,
    pub content_type: String,
    pub size_bytes: u64,
}

#[derive(Debug, Deserialize)]
pub struct BlobUploadResponse {
    pub blob_key: String,
    pub upload_url: String,
}

#[derive(Debug, Serialize)]
pub struct BlobConfirmRequest {
    pub blob_key: String,
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
}

impl SyncHttpClient {
    pub fn new(base_url: String, supabase: Arc<SupabaseAuth>) -> Arc<Self> {
        let inner = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
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
        })
    }

    pub fn set_access_token(&self, token: String) {
        *self.access_token.lock() = Some(token);
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
        if let Some(device_id) = self.device_id.lock().clone() {
            rb = rb.header("X-Device-Id", device_id);
        }
        Ok(rb)
    }

    /// Exchange the stored refresh token for a fresh access token via Supabase.
    /// Rotates and persists the refresh token on success.
    async fn refresh_access_token(&self) -> Result<(), String> {
        let refresh = self
            .refresh_token
            .lock()
            .clone()
            .ok_or("session expired — re-login required")?;
        let session = self.supabase.refresh(&refresh).await?;
        self.set_access_token(session.access_token);
        *self.refresh_token.lock() = Some(session.refresh_token.clone());
        if let Some(user_id) = self.user_id.lock().clone() {
            let _ = crate::sync::crypto::store_refresh_token(&user_id, &session.refresh_token);
        }
        Ok(())
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
    ) -> Result<Option<reqwest::Response>, String>
    where
        F: Fn() -> Result<reqwest::RequestBuilder, String>,
    {
        let mut refreshed = false;
        loop {
            let resp = factory()?
                .send()
                .await
                .map_err(|e| format!("{tag}: {e}"))?;
            let code = resp.status().as_u16();
            if code == 401 && !refreshed {
                self.refresh_access_token().await?;
                refreshed = true;
                continue;
            }
            if allow_404 && code == 404 {
                return Ok(None);
            }
            if !resp.status().is_success() {
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("{tag} {code}: {body}"));
            }
            return Ok(Some(resp));
        }
    }

    /// Run and parse the JSON body as `T`.
    async fn get_json<T, F>(&self, tag: &str, factory: F) -> Result<T, String>
    where
        T: serde::de::DeserializeOwned,
        F: Fn() -> Result<reqwest::RequestBuilder, String>,
    {
        let resp = self
            .run(tag, false, factory)
            .await?
            .expect("404 not allowed here");
        resp.json::<T>()
            .await
            .map_err(|e| format!("{tag} parse: {e}"))
    }

    /// Run and discard the response body.
    async fn get_ok<F>(&self, tag: &str, allow_404: bool, factory: F) -> Result<(), String>
    where
        F: Fn() -> Result<reqwest::RequestBuilder, String>,
    {
        self.run(tag, allow_404, factory).await.map(|_| ())
    }

    // ── Auth (profile / devices / keys) ───────────────────────────

    /// Idempotently ensure a profile exists; returns the KDF salt for UMK
    /// derivation.  Called right after a successful Supabase login.
    pub async fn bootstrap(
        &self,
        display_name: Option<String>,
    ) -> Result<BootstrapResponse, String> {
        let body = BootstrapRequest { display_name };
        self.get_json("bootstrap", || {
            Ok(self.authed(Method::POST, "/api/v1/auth/bootstrap")?.json(&body))
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

    // ── Pool groups ───────────────────────────────────────────────

    pub async fn list_groups(&self) -> Result<Vec<GroupOut>, String> {
        self.get_json("list groups", || self.authed(Method::GET, "/api/v1/groups"))
            .await
    }

    pub async fn get_group(&self, group_id: &str) -> Result<GroupOut, String> {
        self.get_json("get group", || {
            self.authed(Method::GET, &format!("/api/v1/groups/{group_id}"))
        })
        .await
    }

    pub async fn create_group(
        &self,
        req: CreateGroupRequest,
    ) -> Result<CreateGroupResponse, String> {
        self.get_json("create group", || {
            Ok(self.authed(Method::POST, "/api/v1/groups")?.json(&req))
        })
        .await
    }

    pub async fn join_group(&self, req: JoinGroupRequest) -> Result<JoinGroupResponse, String> {
        self.get_json("join group", || {
            Ok(self.authed(Method::POST, "/api/v1/groups/join")?.json(&req))
        })
        .await
    }

    /// Distribute per-member wrapped Group Keys (owner action, §7.4).
    pub async fn distribute_group_keys(
        &self,
        group_id: &str,
        req: DistributeKeysRequest,
    ) -> Result<(), String> {
        self.get_ok("distribute keys", false, || {
            Ok(self
                .authed(Method::POST, &format!("/api/v1/groups/{group_id}/keys"))?
                .json(&req))
        })
        .await
    }

    /// Delete a group the caller owns.
    pub async fn delete_group(&self, group_id: &str) -> Result<(), String> {
        self.get_ok("delete group", true, || {
            self.authed(Method::DELETE, &format!("/api/v1/groups/{group_id}"))
        })
        .await
    }

    /// Leave a pool group (self-removal) — the owner may also remove others.
    pub async fn remove_group_member(
        &self,
        group_id: &str,
        member_user_id: &str,
    ) -> Result<(), String> {
        self.get_ok("remove member", true, || {
            self.authed(
                Method::DELETE,
                &format!("/api/v1/groups/{group_id}/members/{member_user_id}"),
            )
        })
        .await
    }

    // ── Live Share ────────────────────────────────────────────────

    /// Create a live_share group and email an invite in one call.
    pub async fn create_sharing_invite(
        &self,
        req: SharingInviteRequest,
    ) -> Result<SharingInviteResponse, String> {
        self.get_json("sharing invite", || {
            Ok(self.authed(Method::POST, "/api/v1/sharing/invite")?.json(&req))
        })
        .await
    }

    pub async fn list_sharing_sessions(&self) -> Result<Vec<SessionOut>, String> {
        self.get_json("list sessions", || {
            self.authed(Method::GET, "/api/v1/sharing/sessions")
        })
        .await
    }

    pub async fn update_sharing_scope(
        &self,
        share_group_id: &str,
        share_scope: &str,
    ) -> Result<(), String> {
        let body = UpdateScopeRequest {
            share_scope: share_scope.to_string(),
        };
        self.get_ok("update scope", false, || {
            Ok(self
                .authed(
                    Method::PATCH,
                    &format!("/api/v1/sharing/sessions/{share_group_id}/scope"),
                )?
                .json(&body))
        })
        .await
    }

    pub async fn end_sharing_session(&self, share_group_id: &str) -> Result<(), String> {
        self.get_ok("end sharing", true, || {
            self.authed(
                Method::DELETE,
                &format!("/api/v1/sharing/sessions/{share_group_id}"),
            )
        })
        .await
    }

    pub async fn leave_sharing_session(&self, share_group_id: &str) -> Result<(), String> {
        self.get_ok("leave sharing", true, || {
            self.authed(
                Method::DELETE,
                &format!("/api/v1/sharing/sessions/{share_group_id}/leave"),
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

    pub async fn upload_blob_bytes(&self, upload_url: &str, data: Vec<u8>) -> Result<(), String> {
        // Presigned URL upload — no auth header, no retry (not our origin).
        let resp = self
            .inner
            .put(upload_url)
            .body(data)
            .send()
            .await
            .map_err(|e| format!("blob upload: {e}"))?;
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
}
