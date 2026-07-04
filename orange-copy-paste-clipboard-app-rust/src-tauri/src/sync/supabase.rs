//! Supabase Auth (GoTrue) REST client.
//!
//! Identity — signup, login, token refresh, verification, password reset — is
//! owned by Supabase Auth.  The client talks to GoTrue directly over its REST
//! API; our own FastAPI backend only *verifies* the resulting JWT.
//!
//! There is no mature official Supabase Rust SDK, so this is a thin hand-rolled
//! wrapper over the handful of GoTrue endpoints we need.  Every request carries
//! the project `apikey` header (the anon/public key).
//!
//! GoTrue base path is `{supabase_url}/auth/v1`.

use serde::Deserialize;

const REQUEST_TIMEOUT_SECS: u64 = 15;

/// A GoTrue session: the tokens plus the authenticated user.
#[derive(Debug, Clone, Deserialize)]
pub struct SupabaseSession {
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default)]
    pub expires_in: u64,
    pub user: SupabaseUser,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SupabaseUser {
    pub id: String,
    #[serde(default)]
    pub email: String,
}

/// Signup can either return a full session (when email confirmation is
/// disabled) or just the created user (when confirmation is required and no
/// session is issued yet).
pub enum SignUpOutcome {
    /// A session was issued — the account is immediately usable.
    Session(Box<SupabaseSession>),
    /// The account was created but email confirmation is pending.
    ConfirmationRequired,
}

pub struct SupabaseAuth {
    inner: reqwest::Client,
    /// `{supabase_url}/auth/v1`
    auth_base: String,
    anon_key: String,
    configured: bool,
}

impl SupabaseAuth {
    pub fn new(supabase_url: &str, anon_key: &str) -> Self {
        let inner = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .expect("reqwest client");
        let url = supabase_url.trim_end_matches('/');
        Self {
            inner,
            auth_base: format!("{url}/auth/v1"),
            anon_key: anon_key.to_string(),
            configured: !url.is_empty() && !anon_key.is_empty(),
        }
    }

    /// True when the client was configured with a URL and key.
    pub fn is_configured(&self) -> bool {
        self.configured
    }

    fn ensure_configured(&self) -> Result<(), String> {
        if !self.is_configured() {
            return Err(
                "Supabase is not configured — set supabase_url and supabase_anon_key".into(),
            );
        }
        Ok(())
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.auth_base, path)
    }

    /// Send a GoTrue request and surface a readable error on failure.  GoTrue
    /// returns `{ "error": "...", "error_description": "..." }` or
    /// `{ "msg": "..." }` on error — try both.
    async fn send_json<T: serde::de::DeserializeOwned>(
        &self,
        req: reqwest::RequestBuilder,
        tag: &str,
    ) -> Result<T, String> {
        let resp = req
            .header("apikey", &self.anon_key)
            .send()
            .await
            .map_err(|e| format!("{tag}: {e}"))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            let msg = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| {
                    v.get("error_description")
                        .or_else(|| v.get("msg"))
                        .or_else(|| v.get("error"))
                        .and_then(|m| m.as_str())
                        .map(str::to_string)
                })
                .unwrap_or(body);
            return Err(format!("{tag} ({}): {msg}", status.as_u16()));
        }
        serde_json::from_str::<T>(&body).map_err(|e| format!("{tag} parse: {e}"))
    }

    // ── Endpoints ─────────────────────────────────────────────────────

    /// Password grant: `POST /token?grant_type=password`.
    pub async fn sign_in_password(
        &self,
        email: &str,
        password: &str,
    ) -> Result<SupabaseSession, String> {
        self.ensure_configured()?;
        self.send_json(
            self.inner
                .post(self.url("/token?grant_type=password"))
                .json(&serde_json::json!({ "email": email, "password": password })),
            "supabase login",
        )
        .await
    }

    /// Refresh grant: `POST /token?grant_type=refresh_token`.
    pub async fn refresh(&self, refresh_token: &str) -> Result<SupabaseSession, String> {
        self.ensure_configured()?;
        self.send_json(
            self.inner
                .post(self.url("/token?grant_type=refresh_token"))
                .json(&serde_json::json!({ "refresh_token": refresh_token })),
            "supabase refresh",
        )
        .await
    }

    /// Register a new account: `POST /signup`.  When the project requires email
    /// confirmation, no session is issued and we return `ConfirmationRequired`.
    pub async fn sign_up(&self, email: &str, password: &str) -> Result<SignUpOutcome, String> {
        self.ensure_configured()?;
        let value: serde_json::Value = self
            .send_json(
                self.inner
                    .post(self.url("/signup"))
                    .json(&serde_json::json!({ "email": email, "password": password })),
                "supabase signup",
            )
            .await?;

        // A session response carries an access_token; a confirmation-pending
        // response carries only the user object.
        if value.get("access_token").and_then(|v| v.as_str()).is_some() {
            let session = serde_json::from_value::<SupabaseSession>(value)
                .map_err(|e| format!("supabase signup parse: {e}"))?;
            Ok(SignUpOutcome::Session(Box::new(session)))
        } else {
            Ok(SignUpOutcome::ConfirmationRequired)
        }
    }
}
