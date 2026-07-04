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
    ) -> Result<Vec<PushEntryResponse>, String> {
        self.get_json("push", || {
            Ok(self
                .authed(Method::POST, "/api/v1/sync/push")?
                .json(&entries))
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

    pub async fn delete_entry(&self, server_id: &str) -> Result<(), String> {
        self.get_ok("delete", true, || {
            self.authed(Method::DELETE, &format!("/api/v1/sync/entries/{server_id}"))
        })
        .await
    }

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

    pub async fn list_groups(&self) -> Result<Vec<ServerGroup>, String> {
        self.get_json("list groups", || self.authed(Method::GET, "/api/v1/groups"))
            .await
    }

    pub async fn create_group(&self, req: CreateGroupRequest) -> Result<ServerGroup, String> {
        self.get_json("create group", || {
            Ok(self.authed(Method::POST, "/api/v1/groups")?.json(&req))
        })
        .await
    }

    pub async fn join_group(&self, req: JoinGroupRequest) -> Result<ServerGroup, String> {
        self.get_json("join group", || {
            Ok(self.authed(Method::POST, "/api/v1/groups/join")?.json(&req))
        })
        .await
    }

    pub async fn leave_group(&self, group_id: &str) -> Result<(), String> {
        self.get_ok("leave group", true, || {
            self.authed(Method::DELETE, &format!("/api/v1/groups/{group_id}"))
        })
        .await
    }

    // ── Live Share ────────────────────────────────────────────────

    pub async fn create_sharing_session(
        &self,
        req: CreateSharingRequest,
    ) -> Result<CreateSharingResponse, String> {
        self.get_json("create sharing", || {
            Ok(self.authed(Method::POST, "/api/v1/sharing")?.json(&req))
        })
        .await
    }

    pub async fn invite_to_sharing(
        &self,
        share_group_id: &str,
        req: SharingInviteRequest,
    ) -> Result<SharingInviteResponse, String> {
        self.get_json("sharing invite", || {
            Ok(self
                .authed(Method::POST, &format!("/api/v1/sharing/{share_group_id}/invite"))?
                .json(&req))
        })
        .await
    }

    pub async fn join_sharing(
        &self,
        req: JoinSharingRequest,
    ) -> Result<JoinSharingResponse, String> {
        self.get_json("join sharing", || {
            Ok(self.authed(Method::POST, "/api/v1/sharing/join")?.json(&req))
        })
        .await
    }

    pub async fn update_sharing_scope(
        &self,
        share_group_id: &str,
        scope: &str,
    ) -> Result<(), String> {
        let body = UpdateScopeRequest {
            scope: scope.to_string(),
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
