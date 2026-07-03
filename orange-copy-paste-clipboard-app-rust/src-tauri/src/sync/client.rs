//! Async HTTP client for cloud sync API.
//!
//! Wraps `reqwest::Client` with:
//!   - Base URL injection
//!   - Bearer auth header from in-memory access token
//!   - Automatic 401 → token refresh → retry
//!   - 10-second request timeout
//!
//! All methods are `async`.  They run on whichever Tokio runtime the caller
//! is using (Tauri's runtime for commands, or the sync module's dedicated
//! runtime for background tasks).

use parking_lot::Mutex;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const REQUEST_TIMEOUT_SECS: u64 = 10;

// ── API request / response types ─────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    pub device_name: String,
    pub device_public_key: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: String,
    pub email: String,
    pub display_name: String,
    /// base64-encoded salt used for Argon2id UMK derivation.
    pub kdf_salt: String,
    pub device_id: String,
}

#[derive(Debug, Serialize)]
struct RefreshRequest {
    refresh_token: String,
}

#[derive(Debug, Deserialize)]
struct RefreshResponse {
    access_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushEntryRequest {
    pub client_id: String,
    pub encrypted_content: String,
    pub encrypted_metadata: String,
    pub entry_type: String,
    pub kind: String,
    /// For file entries: first file's blob_key; otherwise None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_key: Option<String>,
    /// Live Share group UUIDs this entry should fan out to.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub group_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct PushEntryResponse {
    pub client_id: String,
    pub server_id: String,
    pub server_ts: u64,
}

#[derive(Debug, Deserialize)]
pub struct PulledEntry {
    pub server_id: String,
    pub client_id: String,
    pub encrypted_content: String,
    pub encrypted_metadata: String,
    pub entry_type: String,
    pub kind: String,
    pub server_ts: u64,
    #[serde(default)]
    pub group_ids: Vec<String>,
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

#[derive(Debug, Serialize)]
pub struct CreateGroupRequest {
    pub name: String,
    pub group_type: String, // "pool"
}

#[derive(Debug, Deserialize)]
pub struct ServerGroup {
    pub id: String,
    pub name: String,
    pub group_type: String,
    pub member_count: u32,
}

#[derive(Debug, Serialize)]
pub struct JoinGroupRequest {
    pub invite_code: String,
}

#[derive(Debug, Serialize)]
pub struct CreateSharingRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub scope: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateSharingResponse {
    pub share_group_id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct SharingInviteRequest {
    pub email: String,
    pub scope: String,
}

#[derive(Debug, Deserialize)]
pub struct SharingInviteResponse {
    pub invite_code: String,
    pub share_group_id: String,
    pub expires_at: u64,
}

#[derive(Debug, Serialize)]
pub struct JoinSharingRequest {
    pub invite_code: String,
    pub scope: String,
    pub device_public_key: String,
}

#[derive(Debug, Deserialize)]
pub struct JoinSharingResponse {
    pub share_group_id: String,
    pub wrapped_group_key: String,
}

#[derive(Debug, Serialize)]
pub struct UpdateScopeRequest {
    pub scope: String,
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
    /// Short-lived JWT access token.  Replaced on 401 → refresh flow.
    access_token: Mutex<Option<String>>,
    user_id: Mutex<Option<String>>,
}

impl SyncHttpClient {
    pub fn new(base_url: String) -> Arc<Self> {
        let inner = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .expect("reqwest client");
        Arc::new(Self {
            inner,
            base_url,
            access_token: Mutex::new(None),
            user_id: Mutex::new(None),
        })
    }

    pub fn set_access_token(&self, token: String) {
        *self.access_token.lock() = Some(token);
    }

    pub fn set_user_id(&self, user_id: String) {
        *self.user_id.lock() = Some(user_id);
    }

    pub fn clear_auth(&self) {
        *self.access_token.lock() = None;
        *self.user_id.lock() = None;
    }

    pub fn is_authenticated(&self) -> bool {
        self.access_token.lock().is_some()
    }

    /// Current access token for use in WebSocket URL query param.
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

    /// Build an authenticated request for `path` (joined onto the base URL).
    fn authed(&self, method: Method, path: &str) -> Result<reqwest::RequestBuilder, String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        Ok(self
            .inner
            .request(method, self.url(path))
            .header("Authorization", auth))
    }

    /// Send a request; map transport/status errors to `"{tag} …"` strings.
    /// With `allow_404`, a 404 response yields `Ok(None)` instead of an error.
    async fn send_checked(
        req: reqwest::RequestBuilder,
        tag: &str,
        allow_404: bool,
    ) -> Result<Option<reqwest::Response>, String> {
        let resp = req.send().await.map_err(|e| format!("{tag}: {e}"))?;
        if allow_404 && resp.status().as_u16() == 404 {
            return Ok(None);
        }
        if !resp.status().is_success() {
            let s = resp.status().as_u16();
            let b = resp.text().await.unwrap_or_default();
            return Err(format!("{tag} {s}: {b}"));
        }
        Ok(Some(resp))
    }

    /// Send, check status, and parse the JSON body as `T`.
    async fn expect_json<T: serde::de::DeserializeOwned>(
        req: reqwest::RequestBuilder,
        tag: &str,
    ) -> Result<T, String> {
        let resp = Self::send_checked(req, tag, false)
            .await?
            .expect("404 not allowed here");
        resp.json::<T>()
            .await
            .map_err(|e| format!("{tag} parse: {e}"))
    }

    /// Send and check status, discarding the response body.
    async fn expect_ok(
        req: reqwest::RequestBuilder,
        tag: &str,
        allow_404: bool,
    ) -> Result<(), String> {
        Self::send_checked(req, tag, allow_404).await.map(|_| ())
    }

    // ── Auth ──────────────────────────────────────────────────────

    pub async fn login(&self, req: LoginRequest) -> Result<LoginResponse, String> {
        Self::expect_json(
            self.inner.post(self.url("/api/v1/auth/login")).json(&req),
            "login",
        )
        .await
    }

    pub async fn refresh_token(&self, user_id: &str) -> Result<String, String> {
        let refresh_token = crate::sync::crypto::load_refresh_token(user_id)?;
        let resp = self
            .inner
            .post(self.url("/api/v1/auth/refresh"))
            .json(&RefreshRequest { refresh_token })
            .send()
            .await
            .map_err(|e| format!("refresh request: {e}"))?;
        if resp.status().as_u16() == 401 {
            return Err("refresh token expired — re-login required".into());
        }
        let parsed = resp
            .json::<RefreshResponse>()
            .await
            .map_err(|e| format!("refresh parse: {e}"))?;
        Ok(parsed.access_token)
    }

    pub async fn logout(&self) -> Result<(), String> {
        if let Ok(req) = self.authed(Method::POST, "/api/v1/auth/logout") {
            let _ = req.send().await;
        }
        self.clear_auth();
        Ok(())
    }

    // ── Sync push / pull ──────────────────────────────────────────

    pub async fn push_entries(
        &self,
        entries: Vec<PushEntryRequest>,
    ) -> Result<Vec<PushEntryResponse>, String> {
        Self::expect_json(
            self.authed(Method::POST, "/api/v1/sync/push")?.json(&entries),
            "push",
        )
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
        Self::expect_json(self.authed(Method::GET, &path)?, "pull").await
    }

    pub async fn advance_cursor(&self, last_server_ts: u64) -> Result<(), String> {
        Self::expect_ok(
            self.authed(Method::POST, "/api/v1/sync/cursor")?
                .json(&CursorRequest { last_server_ts }),
            "cursor",
            false,
        )
        .await
    }

    pub async fn delete_entry(&self, server_id: &str) -> Result<(), String> {
        Self::expect_ok(
            self.authed(Method::DELETE, &format!("/api/v1/sync/entries/{server_id}"))?,
            "delete",
            true,
        )
        .await
    }

    // ── Settings ──────────────────────────────────────────────────

    pub async fn push_settings(
        &self,
        req: SettingsPushRequest,
    ) -> Result<SettingsPushResponse, String> {
        Self::expect_json(
            self.authed(Method::PUT, "/api/v1/settings")?.json(&req),
            "settings push",
        )
        .await
    }

    pub async fn pull_settings(&self) -> Result<Option<SettingsPullResponse>, String> {
        match Self::send_checked(
            self.authed(Method::GET, "/api/v1/settings")?,
            "settings pull",
            true,
        )
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

    pub async fn list_groups(&self) -> Result<Vec<ServerGroup>, String> {
        Self::expect_json(self.authed(Method::GET, "/api/v1/groups")?, "list groups").await
    }

    pub async fn create_group(&self, req: CreateGroupRequest) -> Result<ServerGroup, String> {
        Self::expect_json(
            self.authed(Method::POST, "/api/v1/groups")?.json(&req),
            "create group",
        )
        .await
    }

    pub async fn join_group(&self, req: JoinGroupRequest) -> Result<ServerGroup, String> {
        Self::expect_json(
            self.authed(Method::POST, "/api/v1/groups/join")?.json(&req),
            "join group",
        )
        .await
    }

    pub async fn leave_group(&self, group_id: &str) -> Result<(), String> {
        Self::expect_ok(
            self.authed(Method::DELETE, &format!("/api/v1/groups/{group_id}"))?,
            "leave group",
            true,
        )
        .await
    }

    // ── Live Share ────────────────────────────────────────────────

    pub async fn create_sharing_session(
        &self,
        req: CreateSharingRequest,
    ) -> Result<CreateSharingResponse, String> {
        Self::expect_json(
            self.authed(Method::POST, "/api/v1/sharing")?.json(&req),
            "create sharing",
        )
        .await
    }

    pub async fn invite_to_sharing(
        &self,
        share_group_id: &str,
        req: SharingInviteRequest,
    ) -> Result<SharingInviteResponse, String> {
        Self::expect_json(
            self.authed(Method::POST, &format!("/api/v1/sharing/{share_group_id}/invite"))?
                .json(&req),
            "sharing invite",
        )
        .await
    }

    pub async fn join_sharing(
        &self,
        req: JoinSharingRequest,
    ) -> Result<JoinSharingResponse, String> {
        Self::expect_json(
            self.authed(Method::POST, "/api/v1/sharing/join")?.json(&req),
            "join sharing",
        )
        .await
    }

    pub async fn update_sharing_scope(
        &self,
        share_group_id: &str,
        scope: &str,
    ) -> Result<(), String> {
        Self::expect_ok(
            self.authed(
                Method::PATCH,
                &format!("/api/v1/sharing/sessions/{share_group_id}/scope"),
            )?
            .json(&UpdateScopeRequest {
                scope: scope.to_string(),
            }),
            "update scope",
            false,
        )
        .await
    }

    pub async fn end_sharing_session(&self, share_group_id: &str) -> Result<(), String> {
        Self::expect_ok(
            self.authed(
                Method::DELETE,
                &format!("/api/v1/sharing/sessions/{share_group_id}"),
            )?,
            "end sharing",
            true,
        )
        .await
    }

    pub async fn leave_sharing_session(&self, share_group_id: &str) -> Result<(), String> {
        Self::expect_ok(
            self.authed(
                Method::DELETE,
                &format!("/api/v1/sharing/sessions/{share_group_id}/leave"),
            )?,
            "leave sharing",
            true,
        )
        .await
    }

    // ── Blob storage ──────────────────────────────────────────────

    pub async fn request_blob_upload(
        &self,
        req: BlobUploadRequest,
    ) -> Result<BlobUploadResponse, String> {
        Self::expect_json(
            self.authed(Method::POST, "/api/v1/blobs/request-upload")?
                .json(&req),
            "blob request-upload",
        )
        .await
    }

    pub async fn upload_blob_bytes(&self, upload_url: &str, data: Vec<u8>) -> Result<(), String> {
        Self::expect_ok(self.inner.put(upload_url).body(data), "blob upload", false).await
    }

    pub async fn confirm_blob_upload(&self, blob_key: &str) -> Result<(), String> {
        Self::expect_ok(
            self.authed(Method::POST, "/api/v1/blobs/confirm-upload")?
                .json(&BlobConfirmRequest {
                    blob_key: blob_key.to_string(),
                }),
            "blob confirm",
            false,
        )
        .await
    }
}
