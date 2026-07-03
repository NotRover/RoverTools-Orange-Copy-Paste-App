//! Persists the sync cursor and device identity to `{app_data}/sync_state.json`.
//! The cursor (last_server_ts) drives delta pull on startup and reconnect.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct SyncState {
    /// Server timestamp of the last successfully merged entry.  Used as the
    /// `after_ts` cursor for the next pull request.
    pub last_server_ts: Option<u64>,
    /// Stable per-device UUID assigned by the server on first login.
    pub device_id: String,
    /// User UUID — used to scope the keychain entry and id_map lookups.
    pub user_id: String,
    /// Unix ms of the most recent settings blob push.  Compared with the
    /// server's `updated_at` to determine LWW winner.
    pub settings_updated_at: u64,
}

pub struct SyncStateStore {
    pub data: SyncState,
    path: PathBuf,
}

impl SyncStateStore {
    pub fn load(path: PathBuf) -> Self {
        let data = crate::sync::persist::load_json(&path);
        Self { data, path }
    }

    pub fn save(&self) {
        crate::sync::persist::save_json(&self.path, &self.data);
    }

    /// Advance the pull cursor and persist.
    pub fn set_last_server_ts(&mut self, ts: u64) {
        self.data.last_server_ts = Some(ts);
        self.save();
    }

    pub fn set_device_id(&mut self, id: &str) {
        self.data.device_id = id.to_string();
        self.save();
    }

    pub fn set_user_id(&mut self, id: &str) {
        self.data.user_id = id.to_string();
        self.save();
    }

    pub fn set_settings_updated_at(&mut self, ts: u64) {
        self.data.settings_updated_at = ts;
        self.save();
    }
}

/// Derive the path for sync_state.json given an app_data directory.
pub fn state_path(app_data: &Path) -> PathBuf {
    app_data.join("sync_state.json")
}
