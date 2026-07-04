//! Sync configuration — reads the device-local sync settings from
//! `settings.json`.  These values are device-specific and are therefore never
//! included in the encrypted settings blob:
//!
//!   - `sync_enabled`         feature flag
//!   - `sync_server_url`      our FastAPI backend base URL
//!   - `supabase_url`         Supabase project URL (GoTrue auth lives here)
//!   - `supabase_anon_key`    Supabase anon/public API key
//!
//! `supabase_url` / `supabase_anon_key` normally ship with the build (via the
//! `SUPABASE_URL` / `SUPABASE_ANON_KEY` env vars at compile time) but can be
//! overridden per-install through `settings.json` for self-hosted deployments.

use tauri::Manager;

pub const DEFAULT_SERVER_URL: &str = "https://api.orangeclipboard.app";

const KEY_ENABLED: &str = "sync_enabled";
const KEY_SERVER_URL: &str = "sync_server_url";
const KEY_SUPABASE_URL: &str = "supabase_url";
const KEY_SUPABASE_ANON_KEY: &str = "supabase_anon_key";

/// Compile-time Supabase defaults, baked from env at build time when present.
const BUILD_SUPABASE_URL: Option<&str> = option_env!("SUPABASE_URL");
const BUILD_SUPABASE_ANON_KEY: Option<&str> = option_env!("SUPABASE_ANON_KEY");

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
            supabase_url: BUILD_SUPABASE_URL.unwrap_or_default().to_string(),
            supabase_anon_key: BUILD_SUPABASE_ANON_KEY.unwrap_or_default().to_string(),
        }
    }
}

impl SyncConfig {
    pub fn load(app: &tauri::AppHandle) -> Self {
        let defaults = Self::default();
        let Some(path) = app.path().app_data_dir().ok().map(|d| d.join("settings.json")) else {
            return defaults;
        };
        let Ok(data) = std::fs::read_to_string(&path) else {
            return defaults;
        };
        let Ok(map) =
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&data)
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
            enabled: map.get(KEY_ENABLED).and_then(|v| v.as_bool()).unwrap_or(false),
            server_url: str_or(KEY_SERVER_URL, &defaults.server_url),
            supabase_url: str_or(KEY_SUPABASE_URL, &defaults.supabase_url),
            supabase_anon_key: str_or(KEY_SUPABASE_ANON_KEY, &defaults.supabase_anon_key),
        }
    }
}
