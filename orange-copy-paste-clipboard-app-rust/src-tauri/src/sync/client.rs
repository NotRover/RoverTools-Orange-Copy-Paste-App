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

    // ── Auth ──────────────────────────────────────────────────────

    pub async fn login(&self, req: LoginRequest) -> Result<LoginResponse, String> {
        let resp = self
            .inner
            .post(self.url("/api/v1/auth/login"))
            .json(&req)
            .send()
            .await
            .map_err(|e| format!("login request: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("login {status}: {body}"));
        }
        resp.json::<LoginResponse>()
            .await
            .map_err(|e| format!("login parse: {e}"))
    }

    pub async fn refresh_token(&self, user_id: &str) -> Result<String, String> {
        let refresh_token =
            crate::sync::crypto::load_refresh_token(user_id)?;
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
        if let Some(auth) = self.auth_header() {
            let _ = self
                .inner
                .post(self.url("/api/v1/auth/logout"))
                .header("Authorization", auth)
                .send()
                .await;
        }
        self.clear_auth();
        Ok(())
    }

    // ── Sync push / pull ──────────────────────────────────────────

    pub async fn push_entries(
        &self,
        entries: Vec<PushEntryRequest>,
    ) -> Result<Vec<PushEntryResponse>, String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .post(self.url("/api/v1/sync/push"))
            .header("Authorization", auth)
            .json(&entries)
            .send()
            .await
            .map_err(|e| format!("push request: {e}"))?;
        if !resp.status().is_success() {
            let s = resp.status().as_u16();
            let b = resp.text().await.unwrap_or_default();
            return Err(format!("push {s}: {b}"));
        }
        resp.json::<Vec<PushEntryResponse>>()
            .await
            .map_err(|e| format!("push parse: {e}"))
    }

    pub async fn pull_entries(
        &self,
        after_ts: Option<u64>,
        limit: u32,
    ) -> Result<PullResponse, String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let mut url = self.url("/api/v1/sync/pull");
        url.push_str(&format!("?limit={limit}"));
        if let Some(ts) = after_ts {
            url.push_str(&format!("&after_ts={ts}"));
        }
        let resp = self
            .inner
            .get(&url)
            .header("Authorization", auth)
            .send()
            .await
            .map_err(|e| format!("pull request: {e}"))?;
        if !resp.status().is_success() {
            let s = resp.status().as_u16();
            let b = resp.text().await.unwrap_or_default();
            return Err(format!("pull {s}: {b}"));
        }
        resp.json::<PullResponse>()
            .await
            .map_err(|e| format!("pull parse: {e}"))
    }

    pub async fn advance_cursor(&self, last_server_ts: u64) -> Result<(), String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .post(self.url("/api/v1/sync/cursor"))
            .header("Authorization", auth)
            .json(&CursorRequest { last_server_ts })
            .send()
            .await
            .map_err(|e| format!("cursor request: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("cursor {}", resp.status().as_u16()));
        }
        Ok(())
    }

    pub async fn delete_entry(&self, server_id: &str) -> Result<(), String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .delete(self.url(&format!("/api/v1/sync/entries/{server_id}")))
            .header("Authorization", auth)
            .send()
            .await
            .map_err(|e| format!("delete request: {e}"))?;
        if !resp.status().is_success() && resp.status().as_u16() != 404 {
            return Err(format!("delete {}", resp.status().as_u16()));
        }
        Ok(())
    }

    // ── Settings ──────────────────────────────────────────────────

    pub async fn push_settings(
        &self,
        req: SettingsPushRequest,
    ) -> Result<SettingsPushResponse, String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .put(self.url("/api/v1/settings"))
            .header("Authorization", auth)
            .json(&req)
            .send()
            .await
            .map_err(|e| format!("settings push request: {e}"))?;
        if !resp.status().is_success() {
            let s = resp.status().as_u16();
            let b = resp.text().await.unwrap_or_default();
            return Err(format!("settings push {s}: {b}"));
        }
        resp.json::<SettingsPushResponse>()
            .await
            .map_err(|e| format!("settings push parse: {e}"))
    }

    pub async fn pull_settings(&self) -> Result<Option<SettingsPullResponse>, String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .get(self.url("/api/v1/settings"))
            .header("Authorization", auth)
            .send()
            .await
            .map_err(|e| format!("settings pull request: {e}"))?;
        if resp.status().as_u16() == 404 {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(format!("settings pull {}", resp.status().as_u16()));
        }
        let parsed = resp
            .json::<SettingsPullResponse>()
            .await
            .map_err(|e| format!("settings pull parse: {e}"))?;
        Ok(Some(parsed))
    }

    // ── Pool groups ───────────────────────────────────────────────

    pub async fn list_groups(&self) -> Result<Vec<ServerGroup>, String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .get(self.url("/api/v1/groups"))
            .header("Authorization", auth)
            .send()
            .await
            .map_err(|e| format!("list groups: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("list groups {}", resp.status().as_u16()));
        }
        resp.json().await.map_err(|e| format!("list groups parse: {e}"))
    }

    pub async fn create_group(&self, req: CreateGroupRequest) -> Result<ServerGroup, String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .post(self.url("/api/v1/groups"))
            .header("Authorization", auth)
            .json(&req)
            .send()
            .await
            .map_err(|e| format!("create group: {e}"))?;
        if !resp.status().is_success() {
            let s = resp.status().as_u16();
            let b = resp.text().await.unwrap_or_default();
            return Err(format!("create group {s}: {b}"));
        }
        resp.json().await.map_err(|e| format!("create group parse: {e}"))
    }

    pub async fn join_group(&self, req: JoinGroupRequest) -> Result<ServerGroup, String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .post(self.url("/api/v1/groups/join"))
            .header("Authorization", auth)
            .json(&req)
            .send()
            .await
            .map_err(|e| format!("join group: {e}"))?;
        if !resp.status().is_success() {
            let s = resp.status().as_u16();
            let b = resp.text().await.unwrap_or_default();
            return Err(format!("join group {s}: {b}"));
        }
        resp.json().await.map_err(|e| format!("join group parse: {e}"))
    }

    pub async fn leave_group(&self, group_id: &str) -> Result<(), String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .delete(self.url(&format!("/api/v1/groups/{group_id}")))
            .header("Authorization", auth)
            .send()
            .await
            .map_err(|e| format!("leave group: {e}"))?;
        if !resp.status().is_success() && resp.status().as_u16() != 404 {
            return Err(format!("leave group {}", resp.status().as_u16()));
        }
        Ok(())
    }

    // ── Live Share ────────────────────────────────────────────────

    pub async fn create_sharing_session(
        &self,
        req: CreateSharingRequest,
    ) -> Result<CreateSharingResponse, String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .post(self.url("/api/v1/sharing"))
            .header("Authorization", auth)
            .json(&req)
            .send()
            .await
            .map_err(|e| format!("create sharing: {e}"))?;
        if !resp.status().is_success() {
            let s = resp.status().as_u16();
            let b = resp.text().await.unwrap_or_default();
            return Err(format!("create sharing {s}: {b}"));
        }
        resp.json().await.map_err(|e| format!("create sharing parse: {e}"))
    }

    pub async fn invite_to_sharing(
        &self,
        share_group_id: &str,
        req: SharingInviteRequest,
    ) -> Result<SharingInviteResponse, String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .post(self.url(&format!("/api/v1/sharing/{share_group_id}/invite")))
            .header("Authorization", auth)
            .json(&req)
            .send()
            .await
            .map_err(|e| format!("sharing invite: {e}"))?;
        if !resp.status().is_success() {
            let s = resp.status().as_u16();
            let b = resp.text().await.unwrap_or_default();
            return Err(format!("sharing invite {s}: {b}"));
        }
        resp.json().await.map_err(|e| format!("sharing invite parse: {e}"))
    }

    pub async fn join_sharing(
        &self,
        req: JoinSharingRequest,
    ) -> Result<JoinSharingResponse, String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .post(self.url("/api/v1/sharing/join"))
            .header("Authorization", auth)
            .json(&req)
            .send()
            .await
            .map_err(|e| format!("join sharing: {e}"))?;
        if !resp.status().is_success() {
            let s = resp.status().as_u16();
            let b = resp.text().await.unwrap_or_default();
            return Err(format!("join sharing {s}: {b}"));
        }
        resp.json().await.map_err(|e| format!("join sharing parse: {e}"))
    }

    pub async fn update_sharing_scope(
        &self,
        share_group_id: &str,
        scope: &str,
    ) -> Result<(), String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .patch(self.url(&format!(
                "/api/v1/sharing/sessions/{share_group_id}/scope"
            )))
            .header("Authorization", auth)
            .json(&UpdateScopeRequest {
                scope: scope.to_string(),
            })
            .send()
            .await
            .map_err(|e| format!("update scope: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("update scope {}", resp.status().as_u16()));
        }
        Ok(())
    }

    pub async fn end_sharing_session(&self, share_group_id: &str) -> Result<(), String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .delete(self.url(&format!("/api/v1/sharing/sessions/{share_group_id}")))
            .header("Authorization", auth)
            .send()
            .await
            .map_err(|e| format!("end sharing: {e}"))?;
        if !resp.status().is_success() && resp.status().as_u16() != 404 {
            return Err(format!("end sharing {}", resp.status().as_u16()));
        }
        Ok(())
    }

    pub async fn leave_sharing_session(&self, share_group_id: &str) -> Result<(), String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .delete(self.url(&format!(
                "/api/v1/sharing/sessions/{share_group_id}/leave"
            )))
            .header("Authorization", auth)
            .send()
            .await
            .map_err(|e| format!("leave sharing: {e}"))?;
        if !resp.status().is_success() && resp.status().as_u16() != 404 {
            return Err(format!("leave sharing {}", resp.status().as_u16()));
        }
        Ok(())
    }

    // ── Blob storage ──────────────────────────────────────────────

    pub async fn request_blob_upload(
        &self,
        req: BlobUploadRequest,
    ) -> Result<BlobUploadResponse, String> {
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .post(self.url("/api/v1/blobs/request-upload"))
            .header("Authorization", auth)
            .json(&req)
            .send()
            .await
            .map_err(|e| format!("blob request-upload: {e}"))?;
        if !resp.status().is_success() {
            let s = resp.status().as_u16();
            let b = resp.text().await.unwrap_or_default();
            return Err(format!("blob request-upload {s}: {b}"));
        }
        resp.json().await.map_err(|e| format!("blob parse: {e}"))
    }

    pub async fn upload_blob_bytes(&self, upload_url: &str, data: Vec<u8>) -> Result<(), String> {
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
        let auth = self.auth_header().ok_or("not authenticated")?;
        let resp = self
            .inner
            .post(self.url("/api/v1/blobs/confirm-upload"))
            .header("Authorization", auth)
            .json(&BlobConfirmRequest {
                blob_key: blob_key.to_string(),
            })
            .send()
            .await
            .map_err(|e| format!("blob confirm: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("blob confirm {}", resp.status().as_u16()));
        }
        Ok(())
    }
}
