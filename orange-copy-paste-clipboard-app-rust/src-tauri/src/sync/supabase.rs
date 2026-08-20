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

/// A failed GoTrue call, keeping the HTTP status the message was flattened from.
///
/// Session restore has to tell "GoTrue was unreachable" (the stored refresh
/// token is still good, try again later) from "GoTrue rejected the token"
/// (only a fresh login fixes it).  Once the status is folded into a string
/// that distinction is gone, so it travels alongside.
#[derive(Debug, Clone)]
pub struct AuthError {
    /// Status GoTrue replied with, or `None` when no response arrived at all.
    pub status: Option<u16>,
    pub message: String,
}

impl AuthError {
    fn transport(tag: &str, e: impl std::fmt::Display) -> Self {
        Self {
            status: None,
            message: format!("{tag}: {e}"),
        }
    }

    /// True when retrying later could plausibly succeed.  No response means
    /// offline / DNS / timeout; 5xx and 429 are the server's problem, not the
    /// token's.  Everything else (notably 400 "Invalid Refresh Token") is a
    /// verdict on the credentials and will fail identically forever.
    pub fn is_transient(&self) -> bool {
        match self.status {
            None => true,
            Some(status) => status == 408 || status == 429 || status >= 500,
        }
    }

    /// The same failure, said to the person who is looking at the screen.
    ///
    /// `message` is a diagnostic - it carries the call tag and the status because
    /// that is what a log needs. Putting it on screen produced
    /// `supabase login (400): Invalid login credentials`, which names our vendor,
    /// our internal tag and an HTTP status to somebody who mistyped a password.
    ///
    /// Status alone is not enough here: GoTrue answers 400 for a wrong password,
    /// an unconfirmed address and a dead refresh token alike, so the reply text is
    /// what separates them. Matched loosely and in lowercase, with a plain
    /// fallback per status, so a rewording upstream degrades to a vaguer sentence
    /// rather than leaking the raw one.
    pub fn user_message(&self) -> String {
        let detail = self.message.to_lowercase();
        let has = |needle: &str| detail.contains(needle);

        if has("invalid login credentials") {
            return "That email and password do not match an account.".into();
        }
        if has("email not confirmed") {
            return "Confirm your email first. The link is in your inbox.".into();
        }
        if has("already registered") || has("already been registered") {
            return "An account already uses that email. Sign in instead.".into();
        }
        if has("password should be") || has("password is too short") {
            return "Use a longer password - at least 8 characters.".into();
        }
        if has("refresh token") || (has("session") && has("expired")) {
            return "Your session expired. Sign in again.".into();
        }
        if has("email address") && has("invalid") {
            return "That does not look like an email address.".into();
        }

        match self.status {
            // No response at all: nothing was judged, so do not imply a verdict
            // on what the user typed.
            None => "Cannot reach the sign-in service. Check your connection and try again.".into(),
            Some(422) | Some(400) => "That did not work. Check the email and password and try again.".into(),
            Some(401) | Some(403) => "Your session expired. Sign in again.".into(),
            Some(429) => "Too many attempts just now. Wait a minute and try again.".into(),
            Some(s) if s >= 500 => "The sign-in service is having trouble. Try again shortly.".into(),
            Some(_) => "Could not sign in. Try again.".into(),
        }
    }
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<AuthError> for String {
    /// The user-facing sentence, with the diagnostic kept for the log. Commands
    /// return `Result<T, String>` and that string is rendered verbatim, so this
    /// conversion is the last place the two audiences can still be told apart.
    fn from(e: AuthError) -> Self {
        eprintln!("[auth] {}", e.message);
        e.user_message()
    }
}

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

    fn ensure_configured(&self) -> Result<(), AuthError> {
        if !self.is_configured() {
            return Err(AuthError {
                // Not a transient failure: no amount of retrying configures a
                // build that shipped without endpoints.
                status: Some(0),
                message: "Supabase is not configured. Set supabase_url and supabase_anon_key"
                    .into(),
            });
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
    ) -> Result<T, AuthError> {
        let resp = req
            .header("apikey", &self.anon_key)
            .send()
            .await
            .map_err(|e| AuthError::transport(tag, e))?;
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
            return Err(AuthError {
                status: Some(status.as_u16()),
                message: format!("{tag} ({}): {msg}", status.as_u16()),
            });
        }
        // A body we cannot parse came from a 2xx, so the call itself worked —
        // report it without a status so it is not read as a credential verdict.
        serde_json::from_str::<T>(&body).map_err(|e| AuthError::transport(&format!("{tag} parse"), e))
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
        .map_err(String::from)
    }

    /// Refresh grant: `POST /token?grant_type=refresh_token`.
    ///
    /// Returns [`AuthError`] rather than a string so callers can tell a dead
    /// refresh token from an unreachable GoTrue — session restore retries the
    /// second and only the second.
    pub async fn refresh(&self, refresh_token: &str) -> Result<SupabaseSession, AuthError> {
        self.ensure_configured()?;
        self.send_json(
            self.inner
                .post(self.url("/token?grant_type=refresh_token"))
                .json(&serde_json::json!({ "refresh_token": refresh_token })),
            "supabase refresh",
        )
        .await
    }

    /// Build the browser-facing OAuth authorization URL for `provider` using the
    /// PKCE flow.  The user opens this in their browser; GoTrue redirects to
    /// `redirect_to` with a `?code=` once consent is granted.
    ///
    /// `code_challenge` is the S256 challenge from [`crate::sync::crypto::pkce_pair`].
    pub fn authorize_url(
        &self,
        provider: &str,
        redirect_to: &str,
        code_challenge: &str,
    ) -> Result<String, String> {
        self.ensure_configured()?;
        let url = reqwest::Url::parse_with_params(
            &self.url("/authorize"),
            &[
                ("provider", provider),
                ("redirect_to", redirect_to),
                ("code_challenge", code_challenge),
                ("code_challenge_method", "s256"),
            ],
        )
        .map_err(|e| format!("authorize url: {e}"))?;
        Ok(url.to_string())
    }

    /// Exchange an OAuth authorization `code` for a session:
    /// `POST /token?grant_type=pkce`.  `code_verifier` is the plaintext half of
    /// the PKCE pair generated before the browser hop.
    pub async fn exchange_code_pkce(
        &self,
        code: &str,
        code_verifier: &str,
    ) -> Result<SupabaseSession, String> {
        self.ensure_configured()?;
        self.send_json(
            self.inner
                .post(self.url("/token?grant_type=pkce"))
                .json(&serde_json::json!({
                    "auth_code": code,
                    "code_verifier": code_verifier,
                })),
            "supabase oauth exchange",
        )
        .await
        .map_err(String::from)
    }

    /// Set (or change) the account password for the authenticated user:
    /// `PUT /user`.  Used to give an OAuth-first account a real password that
    /// doubles as the E2E secret and enables later email+password login.
    pub async fn update_password(&self, access_token: &str, password: &str) -> Result<(), String> {
        self.ensure_configured()?;
        let _: serde_json::Value = self
            .send_json(
                self.inner
                    .put(self.url("/user"))
                    .bearer_auth(access_token)
                    .json(&serde_json::json!({ "password": password })),
                "supabase update password",
            )
            .await?;
        Ok(())
    }

    /// Request a password-reset email: `POST /recover`.  Returns `Ok` on 200
    /// even though the body is empty, so we don't route through `send_json`.
    ///
    /// PKCE, same shape as [`Self::authorize_url`]: the emailed link comes back
    /// carrying `?code=` in the query, and that code is useless without the
    /// verifier, which stays in this machine's keychain. The alternative - the
    /// implicit flow - puts a live access token in the URL fragment, where it
    /// reaches the browser, its history, and any extension reading the page.
    ///
    /// `redirect_to` must be in the project's Redirect URLs allow-list or GoTrue
    /// refuses it and falls back to the Site URL, which is how this used to mail
    /// a localhost link: the call passed no redirect at all.
    pub async fn recover(
        &self,
        email: &str,
        redirect_to: &str,
        code_challenge: &str,
    ) -> Result<(), String> {
        self.ensure_configured()?;
        let resp = self
            .inner
            .post(self.url("/recover"))
            .query(&[("redirect_to", redirect_to)])
            .header("apikey", &self.anon_key)
            .json(&serde_json::json!({
                "email": email,
                "code_challenge": code_challenge,
                "code_challenge_method": "s256",
            }))
            .send()
            .await
            .map_err(|e| {
                eprintln!("[auth] supabase recover: {e}");
                "Cannot reach the sign-in service. Check your connection and try again."
                    .to_string()
            })?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
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
            eprintln!("[auth] supabase recover ({}): {msg}", status.as_u16());
            return Err(AuthError {
                status: Some(status.as_u16()),
                message: format!("supabase recover ({}): {msg}", status.as_u16()),
            }
            .user_message());
        }
        Ok(())
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
                .map_err(|e| {
                    eprintln!("[auth] supabase signup parse: {e}");
                    "The account was created but the reply was unreadable. Sign in to continue."
                        .to_string()
                })?;
            Ok(SignUpOutcome::Session(Box::new(session)))
        } else {
            Ok(SignUpOutcome::ConfirmationRequired)
        }
    }
}
