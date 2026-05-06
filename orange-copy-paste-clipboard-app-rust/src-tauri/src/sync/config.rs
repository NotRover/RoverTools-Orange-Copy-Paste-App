//! Sync configuration — reads `sync_enabled` and `sync_server_url` from
//! `settings.json`.  These are the only two settings that are device-specific
//! and are therefore never included in the encrypted settings blob.

use tauri::Manager;

pub const DEFAULT_SERVER_URL: &str = "https://api.orangeclipboard.app";

const KEY_ENABLED: &str = "sync_enabled";
const KEY_SERVER_URL: &str = "sync_server_url";

#[derive(Debug, Clone)]
pub struct SyncConfig {
    pub enabled: bool,
    pub server_url: String,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            server_url: DEFAULT_SERVER_URL.to_string(),
        }
    }
}

impl SyncConfig {
    pub fn load(app: &tauri::AppHandle) -> Self {
        let Some(path) = app.path().app_data_dir().ok().map(|d| d.join("settings.json")) else {
            return Self::default();
        };
        let Ok(data) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        let Ok(map) =
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&data)
        else {
            return Self::default();
        };

        let enabled = map
            .get(KEY_ENABLED)
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let server_url = map
            .get(KEY_SERVER_URL)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(DEFAULT_SERVER_URL)
            .to_string();

        Self { enabled, server_url }
    }
}
