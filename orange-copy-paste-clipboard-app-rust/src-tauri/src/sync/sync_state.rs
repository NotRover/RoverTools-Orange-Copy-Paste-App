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
    /// Spaces whose back catalogue this device has already gone back for.
    ///
    /// An owner opening a space's history is announced over the socket, which
    /// only reaches members who are running at that moment. This is the durable
    /// half: a space that allows earlier items and is not listed here still owes
    /// this device a backfill, whenever it next signs in.
    #[serde(default)]
    pub history_backfilled: Vec<String>,
    /// `created_at` of the newest server announcement this device has been
    /// handed. Only newer ones are asked for, so dismissing one sticks instead
    /// of being undone by the next refresh.
    #[serde(default)]
    pub announcements_cursor: u64,
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

    /// Advance the announcement watermark, keeping the highest seen.
    pub fn set_announcements_cursor(&mut self, ts: u64) {
        if ts <= self.data.announcements_cursor {
            return;
        }
        self.data.announcements_cursor = ts;
        self.save();
    }

    /// Record that this device has pulled a space's earlier items, so it does
    /// not sweep the whole account again on every launch. Returns false when the
    /// space was already recorded.
    pub fn mark_history_backfilled(&mut self, space_id: &str) -> bool {
        if self.data.history_backfilled.iter().any(|s| s == space_id) {
            return false;
        }
        self.data.history_backfilled.push(space_id.to_string());
        self.save();
        true
    }

    pub fn has_history_backfilled(&self, space_id: &str) -> bool {
        self.data.history_backfilled.iter().any(|s| s == space_id)
    }

    pub fn set_device_id(&mut self, id: &str) {
        self.data.device_id = id.to_string();
        self.save();
    }

    /// The account this device last signed in as, empty before the first one.
    pub fn user_id(&self) -> &str {
        &self.data.user_id
    }

    /// Forget everything that described the previous account's server state.
    ///
    /// The cursor is the dangerous one: it is a wall-clock server timestamp, so
    /// the account being signed into inherits a mark set roughly "now" and pulls
    /// only what is created from here on. Its whole back catalogue is older than
    /// that, so it silently never arrives. The settings stamp and the backfill
    /// list are the same mistake in smaller form.
    ///
    /// `device_id` and `user_id` are left to the caller — it is about to write
    /// both for the account signing in.
    pub fn reset_for_new_account(&mut self) {
        self.data.last_server_ts = None;
        self.data.settings_updated_at = 0;
        self.data.history_backfilled.clear();
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
