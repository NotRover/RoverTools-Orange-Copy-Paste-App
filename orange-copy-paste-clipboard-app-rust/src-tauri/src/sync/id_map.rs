//! Client-to-server ID mapping, persisted to `{app_data}/id_map.json`.
//!
//! Maps `"clipboard:{client_id}"` → `server_uuid` and
//!      `"note:{client_id}"`      → `server_uuid`.
//!
//! Losing this file is safe — the server deduplicates by `client_id` on the
//! next push, so nothing is lost permanently.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Serialize, Deserialize)]
struct IdMapData {
    #[serde(default)]
    entries: HashMap<String, String>,
    #[serde(default)]
    groups: HashMap<String, String>,
    /// Sharing session group UUIDs by share_group_id.
    #[serde(default)]
    sharing_sessions: HashMap<String, String>,
}

pub struct IdMap {
    data: IdMapData,
    path: PathBuf,
}

impl IdMap {
    pub fn load(path: PathBuf) -> Self {
        let data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { data, path }
    }

    fn persist(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&self.data) {
            let _ = std::fs::write(&self.path, json);
        }
    }

    // ── Clipboard / Note entries ──────────────────────────────────

    pub fn set_entry(&mut self, client_id: &str, server_id: &str) {
        self.data
            .entries
            .insert(client_id.to_string(), server_id.to_string());
        self.persist();
    }

    pub fn get_server_id(&self, client_id: &str) -> Option<&str> {
        self.data.entries.get(client_id).map(String::as_str)
    }

    pub fn get_client_id_by_server(&self, server_id: &str) -> Option<String> {
        self.data
            .entries
            .iter()
            .find(|(_, v)| v.as_str() == server_id)
            .map(|(k, _)| k.clone())
    }

    pub fn remove_entry(&mut self, client_id: &str) {
        self.data.entries.remove(client_id);
        self.persist();
    }

    pub fn remove_entry_by_server_id(&mut self, server_id: &str) -> Option<String> {
        let key = self
            .data
            .entries
            .iter()
            .find(|(_, v)| v.as_str() == server_id)
            .map(|(k, _)| k.clone())?;
        self.data.entries.remove(&key);
        self.persist();
        Some(key)
    }

    // ── Pool groups ───────────────────────────────────────────────

    pub fn set_group(&mut self, name: &str, server_id: &str) {
        self.data
            .groups
            .insert(name.to_string(), server_id.to_string());
        self.persist();
    }

    pub fn get_group_server_id(&self, name: &str) -> Option<&str> {
        self.data.groups.get(name).map(String::as_str)
    }

    pub fn remove_group_by_name(&mut self, name: &str) {
        self.data.groups.remove(name);
        self.persist();
    }

    // ── Live Share sessions ───────────────────────────────────────

    pub fn set_sharing_session(&mut self, share_group_id: &str) {
        self.data
            .sharing_sessions
            .insert(share_group_id.to_string(), share_group_id.to_string());
        self.persist();
    }

    pub fn remove_sharing_session(&mut self, share_group_id: &str) {
        self.data.sharing_sessions.remove(share_group_id);
        self.persist();
    }

    pub fn sharing_session_ids(&self) -> Vec<String> {
        self.data.sharing_sessions.keys().cloned().collect()
    }
}

/// Derive the path for id_map.json given an app_data directory.
pub fn id_map_path(app_data: &Path) -> PathBuf {
    app_data.join("id_map.json")
}
