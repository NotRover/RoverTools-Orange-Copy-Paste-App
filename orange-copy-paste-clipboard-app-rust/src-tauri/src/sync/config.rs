//! Sync configuration — reads the device-local sync settings from
//! `settings.json`.  These values are device-specific and are therefore never
//! included in the encrypted settings blob:
//!
//!   - `sync_enabled`         feature flag
//!   - `sync_server_url`      our FastAPI backend base URL
//!   - `supabase_url`         Supabase project URL (GoTrue auth lives here)
//!   - `supabase_anon_key`    Supabase anon/public API key
//!   - `reset_page_url`       where a password-reset mail lands
//!
//! Endpoints come from the `DEFAULT_*` constants below, optionally overridden
//! per-install by `settings.json`.
//!
//! When both are empty the app is *unconfigured*: [`SyncConfig::is_configured`]
//! returns false and the sign-in screen says so, rather than silently pointing
//! the app at a host nobody owns.

use tauri::Manager;

const KEY_ENABLED: &str = "sync_enabled";
const KEY_SERVER_URL: &str = "sync_server_url";
const KEY_SUPABASE_URL: &str = "supabase_url";
const KEY_SUPABASE_ANON_KEY: &str = "supabase_anon_key";
const KEY_RESET_PAGE_URL: &str = "reset_page_url";

/// `https://` anywhere, or plain `http://` only to the local machine.
fn is_trusted_endpoint(url: &str) -> bool {
    if url.starts_with("https://") {
        return true;
    }
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    let host = rest.split(['/', ':']).next().unwrap_or("");
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

// ── Deployment endpoints ──────────────────────────────────────────────
//
// Fill these in to hardcode the deployment this app ships against, so a plain
// `git clone && bun run tauri build` yields a working binary with no setup.
//
// These are PUBLIC values by design: the project URL and publishable key are the
// same pair any Supabase web app serves in its JS bundle, and on their own they
// grant nothing beyond the ability to *attempt* a sign-in. Real protection comes
// from the JWT check, the backend's per-user scoping, and end-to-end encryption.
//
// NEVER put a `service_role` / `sb_secret_…` key here — that is full admin
// access to the project, and anyone can read strings out of a shipped binary.
//
// Leave a value empty to build an app that reports itself as unconfigured.
const DEFAULT_SERVER_URL: &str = "https://api.orangecp.rovertools.ctx.cl";
const DEFAULT_SUPABASE_URL: &str = "https://dmtdusebizngdjtuhzzm.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY: &str = "sb_publishable_ZNs6Q9HfOdUBe8bEBEdPEg_z__qKE8e";

// Where the password-reset mail lands, and so also the `redirect_to` Supabase is
// asked for. The whole URL, not a base: it is the one thing this value is for,
// and building a path onto it here would only hide a mismatch with the
// allow-list entry it has to equal.
//
// The public site rather than the API: this page needs nothing from a server -
// it reads a code out of the query and hands it to the app - and hosting it
// away from the API means a reset no longer breaks when the API changes
// hostname. That is not hypothetical; it is what happened when the backend left
// Render and the new `/reset` was never added to Supabase's allow-list.
const DEFAULT_RESET_PAGE_URL: &str = "https://orange-copy-paste-app.pages.dev/reset";

#[derive(Debug, Clone)]
pub struct SyncConfig {
    pub enabled: bool,
    /// Whether `enabled` is what the file said, rather than what we fell back to.
    ///
    /// False when `settings.json` could not be read or parsed. `enabled` is
    /// `false` in that case because there is nothing else it could be, but the
    /// two are not the same claim: one is "the user turned sync off", the other
    /// is "we could not find out". Acting on the second as though it were the
    /// first puts the sign-in screen in front of a signed-in user, with the
    /// credentials still sitting untouched in the keychain, and nothing retries
    /// it for the life of the process.
    pub enabled_known: bool,
    pub server_url: String,
    pub supabase_url: String,
    pub supabase_anon_key: String,
    pub reset_page_url: String,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            enabled_known: true,
            server_url: DEFAULT_SERVER_URL.to_string(),
            supabase_url: DEFAULT_SUPABASE_URL.to_string(),
            supabase_anon_key: DEFAULT_SUPABASE_ANON_KEY.to_string(),
            reset_page_url: DEFAULT_RESET_PAGE_URL.to_string(),
        }
    }
}

impl SyncConfig {
    pub fn load(app: &tauri::AppHandle) -> Self {
        let defaults = Self::default();
        let Some(path) = app
            .path()
            .app_data_dir()
            .ok()
            .map(|d| d.join("settings.json"))
        else {
            return defaults;
        };
        // A read that fails is not "sync is off". `enabled` still has to be
        // something, and `false` is the only safe default - but `enabled_known`
        // carries the difference forward so the startup path can try a restore
        // anyway instead of drawing a sign-in screen over live credentials.
        let unknown = || Self {
            enabled_known: false,
            ..Self::default()
        };
        let map = match crate::settings_file::read_map(&path) {
            Ok(map) => map,
            Err(crate::settings_file::ReadError::Absent) => return defaults,
            Err(crate::settings_file::ReadError::Malformed(e)) => {
                crate::health::note("sync config: settings.json unparseable", &e);
                return unknown();
            }
            Err(crate::settings_file::ReadError::Unreadable(e)) => {
                crate::health::note(
                    "sync config: settings.json unreadable",
                    &format!("{e} - falling back to the stored session"),
                );
                return unknown();
            }
        };

        let str_or = |key: &str, fallback: &str| -> String {
            map.get(key)
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(fallback)
                .to_string()
        };

        // An endpoint that is not https is ignored in favour of the default.
        // Every credential the app holds travels to these two hosts, so a
        // plain-http override - however it got into the file - would hand
        // them to whatever is on the path. Loopback is the one exception, for
        // a developer running the stack locally.
        let https_or = |key: &str, fallback: &str| -> String {
            let value = str_or(key, fallback);
            if is_trusted_endpoint(&value) {
                value
            } else {
                crate::health::note(
                    "sync config: endpoint override ignored",
                    &format!("{key} is not https, using the built-in value"),
                );
                fallback.to_string()
            }
        };

        Self {
            enabled: map
                .get(KEY_ENABLED)
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            enabled_known: true,
            server_url: https_or(KEY_SERVER_URL, &defaults.server_url),
            supabase_url: https_or(KEY_SUPABASE_URL, &defaults.supabase_url),
            supabase_anon_key: str_or(KEY_SUPABASE_ANON_KEY, &defaults.supabase_anon_key),
            reset_page_url: str_or(KEY_RESET_PAGE_URL, &defaults.reset_page_url),
        }
    }

    /// Whether `key` is one of the endpoint or credential settings that only
    /// this file may set. The generic settings command refuses them, so a
    /// script running in the webview cannot repoint the app at another server.
    pub fn is_endpoint_key(key: &str) -> bool {
        matches!(
            key,
            KEY_SERVER_URL | KEY_SUPABASE_URL | KEY_SUPABASE_ANON_KEY | KEY_RESET_PAGE_URL
        )
    }

    /// True once every endpoint needed to reach a deployment is present.
    /// Sign-in cannot succeed without all three, so the UI gates on this.
    pub fn is_configured(&self) -> bool {
        !self.server_url.is_empty()
            && !self.supabase_url.is_empty()
            && !self.supabase_anon_key.is_empty()
    }
}
