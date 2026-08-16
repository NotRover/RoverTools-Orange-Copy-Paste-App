//! Client-to-server ID mapping, persisted to `{app_data}/id_map.json`.
//!
//! Maps `"clipboard:{client_id}"` → `server_uuid` and
//!      `"note:{client_id}"`      → `server_uuid`.
//!
//! Losing this file is safe — the server deduplicates by `client_id` on the
//! next push, so nothing is lost permanently.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Serialize, Deserialize)]
struct IdMapData {
    #[serde(default)]
    entries: HashMap<String, String>,
    /// Space ids each entry is shared into, keyed like `entries`.
    /// Which space an entry belongs to is sync bookkeeping, not a user tag, so
    /// it lives here next to the server ids rather than in the entry model —
    /// history.bin is a compact (positional) MessagePack array, and it also
    /// keeps machine ids out of the group chips the user sees.
    #[serde(default)]
    entry_shares: HashMap<String, Vec<String>>,
    /// Entries another member wrote, keyed like `entries`. Set when the entry's
    /// content key could only be unwrapped through a space keyring — our own
    /// entries always carry a "personal" wrap, so they never land here. This is
    /// what lets a space row say whether an item came in or went out.
    #[serde(default)]
    remote_entries: HashSet<String>,
}

pub struct IdMap {
    data: IdMapData,
    path: PathBuf,
}

impl IdMap {
    pub fn load(path: PathBuf) -> Self {
        let data = crate::sync::persist::load_json(&path);
        Self { data, path }
    }

    fn persist(&self) {
        crate::sync::persist::save_json(&self.path, &self.data);
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

    /// Keys of every entry the server has acknowledged.
    pub fn entry_keys(&self) -> Vec<String> {
        self.data.entries.keys().cloned().collect()
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
        self.data.entry_shares.remove(client_id);
        self.data.remote_entries.remove(client_id);
        self.persist();
    }

    // ── Direction ─────────────────────────────────────────────────

    /// Record that `client_id` arrived from another member. Idempotent: only a
    /// first mark writes the file, so re-merging the same entry costs nothing.
    pub fn mark_entry_remote(&mut self, client_id: &str) {
        if self.data.remote_entries.insert(client_id.to_string()) {
            self.persist();
        }
    }

    /// Keys of every entry that came from another member.
    pub fn remote_entries(&self) -> Vec<String> {
        self.data.remote_entries.iter().cloned().collect()
    }

    // ── Share membership ──────────────────────────────────────────

    /// Record which spaces an entry is shared into. An empty list drops the
    /// key, so an entry that stops being shared leaves nothing behind.
    pub fn set_entry_shares(&mut self, client_id: &str, space_ids: &[String]) {
        let changed = match self.data.entry_shares.get(client_id) {
            Some(existing) => existing.as_slice() != space_ids,
            None => !space_ids.is_empty(),
        };
        if !changed {
            return; // every push would otherwise rewrite the file for nothing
        }
        if space_ids.is_empty() {
            self.data.entry_shares.remove(client_id);
        } else {
            self.data
                .entry_shares
                .insert(client_id.to_string(), space_ids.to_vec());
        }
        self.persist();
    }

    /// The whole share map, for the Sync screen to match its feed against.
    pub fn entry_shares(&self) -> HashMap<String, Vec<String>> {
        self.data.entry_shares.clone()
    }

    pub fn remove_entry_by_server_id(&mut self, server_id: &str) -> Option<String> {
        let key = self
            .data
            .entries
            .iter()
            .find(|(_, v)| v.as_str() == server_id)
            .map(|(k, _)| k.clone())?;
        self.data.entries.remove(&key);
        self.data.entry_shares.remove(&key);
        self.data.remote_entries.remove(&key);
        self.persist();
        Some(key)
    }
}

/// Derive the path for id_map.json given an app_data directory.
pub fn id_map_path(app_data: &Path) -> PathBuf {
    app_data.join("id_map.json")
}
