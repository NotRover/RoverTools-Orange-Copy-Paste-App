//! Sync configuration — reads the device-local sync settings from
//! `settings.json`.  These values are device-specific and are therefore never
//! included in the encrypted settings blob:
//!
//!   - `sync_enabled`         feature flag
//!   - `sync_server_url`      our FastAPI backend base URL
//!   - `supabase_url`         Supabase project URL (GoTrue auth lives here)
//!   - `supabase_anon_key`    Supabase anon/public API key
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
const DEFAULT_SERVER_URL: &str = "https://rovertools-smart-clipboard-app-backend.onrender.com";
const DEFAULT_SUPABASE_URL: &str = "https://dmtdusebizngdjtuhzzm.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY: &str = "sb_publishable_ZNs6Q9HfOdUBe8bEBEdPEg_z__qKE8e";

#[derive(Debug, Clone)]
pub struct SyncConfig {
    pub enabled: bool,
    pub server_url: String,
    pub supabase_url: String,
    pub supabase_anon_key: String,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            server_url: DEFAULT_SERVER_URL.to_string(),
            supabase_url: DEFAULT_SUPABASE_URL.to_string(),
            supabase_anon_key: DEFAULT_SUPABASE_ANON_KEY.to_string(),
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
        let Ok(data) = std::fs::read_to_string(&path) else {
            return defaults;
        };
        let Ok(map) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&data)
        else {
            return defaults;
        };

        let str_or = |key: &str, fallback: &str| -> String {
            map.get(key)
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(fallback)
                .to_string()
        };

        Self {
            enabled: map
                .get(KEY_ENABLED)
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            server_url: str_or(KEY_SERVER_URL, &defaults.server_url),
            supabase_url: str_or(KEY_SUPABASE_URL, &defaults.supabase_url),
            supabase_anon_key: str_or(KEY_SUPABASE_ANON_KEY, &defaults.supabase_anon_key),
        }
    }

    /// True once every endpoint needed to reach a deployment is present.
    /// Sign-in cannot succeed without all three, so the UI gates on this.
    pub fn is_configured(&self) -> bool {
        !self.server_url.is_empty()
            && !self.supabase_url.is_empty()
            && !self.supabase_anon_key.is_empty()
    }
}
