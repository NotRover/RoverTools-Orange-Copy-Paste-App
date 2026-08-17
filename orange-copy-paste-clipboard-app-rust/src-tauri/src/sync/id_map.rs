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
    /// Who wrote each entry, keyed like `entries`. Only recorded for entries
    /// that arrived from someone else — our own are implied by their absence,
    /// so this stays empty for a single-user account.
    #[serde(default)]
    entry_owners: HashMap<String, String>,
    /// Items removed from a space, keyed like `entries`.
    ///
    /// Two jobs. It is what the Spaces feed renders as a placeholder, so a
    /// removal reads as "this was taken down" rather than a row silently
    /// vanishing. And it suppresses re-merge: a member who removes an item they
    /// received never pushes a tombstone (that would delete it for everyone),
    /// so without a local record the next pull would hand it straight back.
    #[serde(default)]
    deleted_markers: HashMap<String, DeletedMarker>,
}

/// A removed item, kept after its content is gone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeletedMarker {
    /// Spaces the item was in when it went.
    pub space_ids: Vec<String>,
    /// Account that wrote it, when known.
    pub owner_id: Option<String>,
    /// When it was removed, ms since epoch.
    pub deleted_at: u64,
    /// True when its author removed it, false when a space owner took it down.
    pub by_author: bool,
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
        self.data.entry_owners.remove(client_id);
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

    /// Whether another member wrote this one.
    pub fn is_remote(&self, client_id: &str) -> bool {
        self.data.remote_entries.contains(client_id)
    }

    /// Spaces one entry is shared into, without cloning the whole map.
    pub fn shares_for(&self, client_id: &str) -> Vec<String> {
        self.data
            .entry_shares
            .get(client_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Who wrote one entry, if it came from someone else.
    pub fn owner_of(&self, client_id: &str) -> Option<String> {
        self.data.entry_owners.get(client_id).cloned()
    }

    /// Record which account wrote `client_id`. Idempotent, for the same reason
    /// as `mark_entry_remote`: a re-merge must not rewrite the file.
    pub fn set_entry_owner(&mut self, client_id: &str, user_id: &str) {
        if self.data.entry_owners.get(client_id).map(String::as_str) == Some(user_id) {
            return;
        }
        self.data
            .entry_owners
            .insert(client_id.to_string(), user_id.to_string());
        self.persist();
    }

    /// Owner account id per entry key, for the Spaces feed to resolve against
    /// the space's member list.
    pub fn entry_owners(&self) -> HashMap<String, String> {
        self.data.entry_owners.clone()
    }

    // ── Removals ──────────────────────────────────────────────────

    /// Record that an item is gone, keeping enough to show a placeholder and to
    /// recognise it if the server offers it again.
    pub fn mark_deleted(&mut self, client_id: &str, marker: DeletedMarker) {
        self.data
            .deleted_markers
            .insert(client_id.to_string(), marker);
        self.persist();
    }

    /// Whether this item has already been removed here.
    pub fn is_deleted(&self, client_id: &str) -> bool {
        self.data.deleted_markers.contains_key(client_id)
    }

    /// Every removal, for the Spaces feed's placeholders.
    pub fn deleted_markers(&self) -> HashMap<String, DeletedMarker> {
        self.data.deleted_markers.clone()
    }

    /// Drop a removal record. Used when the user clears the placeholders, and
    /// when the same item is deliberately captured again locally.
    pub fn clear_deleted(&mut self, client_id: &str) {
        if self.data.deleted_markers.remove(client_id).is_some() {
            self.persist();
        }
    }

    /// Forget every removal in a space, for "clear removed items".
    pub fn clear_deleted_in_space(&mut self, space_id: &str) -> usize {
        let before = self.data.deleted_markers.len();
        self.data
            .deleted_markers
            .retain(|_, m| !m.space_ids.iter().any(|s| s == space_id));
        let removed = before - self.data.deleted_markers.len();
        if removed > 0 {
            self.persist();
        }
        removed
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
        self.data.entry_owners.remove(&key);
        self.persist();
        Some(key)
    }
}

/// Derive the path for id_map.json given an app_data directory.
pub fn id_map_path(app_data: &Path) -> PathBuf {
    app_data.join("id_map.json")
}
