//! Clipboard history store.
//!
//! Holds an in-memory ring-buffer of the last [`MAX_HISTORY`] clipboard
//! entries (text or images encoded as PNG data-URLs).  The store is wrapped
//! in a [`parking_lot::Mutex`] so it can be shared across Tauri commands and
//! global-shortcut handlers.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

// Constants

/// Maximum number of entries kept in history.
pub const MAX_HISTORY: usize = 100;

/// Global monotonically increasing ID counter for clipboard entries.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Advance the global ID counter past any loaded IDs to avoid collisions.
fn advance_id_past(entries: &[ClipboardEntry]) {
    let max_id = entries
        .iter()
        .filter_map(|e| e.id.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    let _ = NEXT_ID.fetch_max(max_id + 1, Ordering::Relaxed);
}

fn write_json_file(path: &std::path::Path, data: &str) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, data)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Text,
    Image,
    File,
}

/// A single clipboard history entry.
///
/// `content` is either a plain text string (for [`EntryKind::Text`]) or a
/// `data:image/png;base64,…` data-URL (for [`EntryKind::Image`]).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardEntry {
    pub id: String,
    /// Serialised as `"type"` so the frontend sees `{ type: "text" | "image" }`.
    #[serde(rename = "type")]
    pub kind: EntryKind,
    pub content: String,
    /// Unix epoch in milliseconds, matching `Date.now()` on the JS side.
    pub timestamp: u64,
    /// Whether this entry is pinned and persists across restarts.
    #[serde(default)]
    pub pinned: bool,
    /// User-defined group tags assigned to this entry.
    #[serde(default)]
    pub groups: Vec<String>,
}

impl ClipboardEntry {
    fn new(kind: EntryKind, content: String) -> Self {
        Self {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string(),
            kind,
            content,
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            pinned: false,
            groups: Vec::new(),
        }
    }

    pub fn new_text(content: String) -> Self {
        Self::new(EntryKind::Text, content)
    }

    pub fn new_image(data_url: String) -> Self {
        Self::new(EntryKind::Image, data_url)
    }

    /// `content` stores newline-delimited absolute file paths.
    pub fn new_file(content: String) -> Self {
        Self::new(EntryKind::File, content)
    }
}

// History

/// Shared clipboard history.
///
/// Entries are prepended (most-recent first) and the list is capped at
/// [`MAX_HISTORY`] entries.
#[derive(Debug, Default)]
pub struct ClipboardHistory {
    entries: Vec<ClipboardEntry>,
}

impl ClipboardHistory {
    pub fn new() -> Self {
        Self::default()
    }

    /// Prepend an entry and trim to [`MAX_HISTORY`] (excluding pinned entries).
    /// Returns a clone of the newly inserted entry.
    pub fn push(&mut self, entry: ClipboardEntry) -> ClipboardEntry {
        self.entries.insert(0, entry.clone());
        // Keep pinned entries + up to MAX_HISTORY unpinned entries
        if self.entries.len() > MAX_HISTORY {
            let pinned_count = self.entries.iter().filter(|e| e.pinned).count();
            if pinned_count < self.entries.len() {
                // Remove oldest unpinned entries beyond MAX_HISTORY limit
                let mut kept = Vec::new();
                let mut unpinned_count = 0;
                for e in self.entries.drain(..) {
                    if e.pinned || unpinned_count < MAX_HISTORY {
                        if !e.pinned {
                            unpinned_count += 1;
                        }
                        kept.push(e);
                    }
                }
                self.entries = kept;
            }
        }
        entry
    }

    /// Prepend an entry only when it differs from the current top entry.
    /// Returns the existing top entry when duplicate, or the inserted entry.
    pub fn push_if_distinct(&mut self, entry: ClipboardEntry) -> ClipboardEntry {
        self.push_if_distinct_with_flag(entry).0
    }

    /// Same as [`Self::push_if_distinct`], but also returns whether insertion happened.
    pub fn push_if_distinct_with_flag(&mut self, entry: ClipboardEntry) -> (ClipboardEntry, bool) {
        if let Some(existing) = self.entries.first() {
            if existing.kind == entry.kind && existing.content == entry.content {
                return (existing.clone(), false);
            }
        }

        (self.push(entry), true)
    }

    /// Return the full history slice (most-recent first).
    pub fn all(&self) -> &[ClipboardEntry] {
        &self.entries
    }

    /// Return the top `n` entries (most-recent first).
    pub fn top(&self, n: usize) -> Vec<ClipboardEntry> {
        self.entries.iter().take(n).cloned().collect()
    }

    /// Remove the entry with the given `id`. Returns `true` if found.
    /// Pinned entries can also be removed.
    pub fn remove(&mut self, id: &str) -> bool {
        if let Some(pos) = self.entries.iter().position(|e| e.id == id) {
            self.entries.remove(pos);
            true
        } else {
            false
        }
    }

    /// Clear all unpinned entries. Pinned entries are retained.
    pub fn clear(&mut self) {
        self.entries.retain(|e| e.pinned);
    }

    /// Look up an entry by `id`.
    pub fn find(&self, id: &str) -> Option<&ClipboardEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// Look up a mutable entry by `id`.
    pub fn find_mut(&mut self, id: &str) -> Option<&mut ClipboardEntry> {
        self.entries.iter_mut().find(|e| e.id == id)
    }

    /// Pin an entry by ID. Returns `true` if found and pinned.
    pub fn pin(&mut self, id: &str) -> bool {
        self.find_mut(id).map(|e| e.pinned = true).is_some()
    }

    pub fn unpin(&mut self, id: &str) -> bool {
        self.find_mut(id).map(|e| e.pinned = false).is_some()
    }

    /// Get all pinned entries.
    pub fn pinned_entries(&self) -> Vec<ClipboardEntry> {
        self.entries.iter().filter(|e| e.pinned).cloned().collect()
    }

    /// Replace the groups list for an entry. Returns `true` if found.
    pub fn set_groups(&mut self, id: &str, groups: Vec<String>) -> bool {
        self.find_mut(id).map(|e| e.groups = groups).is_some()
    }

    /// Add a single group to an entry (no duplicates). Returns `true` if found.
    pub fn add_group(&mut self, id: &str, group: &str) -> bool {
        if let Some(e) = self.find_mut(id) {
            if !e.groups.iter().any(|g| g == group) {
                e.groups.push(group.to_string());
            }
            true
        } else {
            false
        }
    }

    /// Remove a single group from an entry. Returns `true` if found.
    pub fn remove_group(&mut self, id: &str, group: &str) -> bool {
        if let Some(e) = self.find_mut(id) {
            e.groups.retain(|g| g != group);
            true
        } else {
            false
        }
    }

    /// Remove a group name from all entries that have it.
    pub fn purge_group(&mut self, group: &str) {
        for e in &mut self.entries {
            e.groups.retain(|g| g != group);
        }
    }

    /// Load pinned entries from a file and merge them into history.
    /// Any existing entries with matching IDs are replaced.
    /// Advances the global ID counter past the highest loaded ID.
    pub fn load_pinned_from_file(&mut self, path: &std::path::Path) -> Result<(), std::io::Error> {
        if !path.exists() {
            return Ok(());
        }
        let data = std::fs::read_to_string(path)?;
        let pinned: Vec<ClipboardEntry> = serde_json::from_str(&data).unwrap_or_default();

        advance_id_past(&pinned);

        let pinned_ids: std::collections::HashSet<_> = pinned.iter().map(|e| &e.id).collect();
        self.entries.retain(|e| !pinned_ids.contains(&e.id));

        // Prepend all pinned entries
        for entry in pinned.into_iter().rev() {
            self.entries.insert(0, entry);
        }

        Ok(())
    }

    /// Save all pinned entries to a file.
    pub fn save_pinned_to_file(&self, path: &std::path::Path) -> Result<(), std::io::Error> {
        write_json_file(path, &serde_json::to_string_pretty(&self.pinned_entries())?)
    }

    /// Save the entire history (all entries) to a file.
    pub fn save_all_to_file(&self, path: &std::path::Path) -> Result<(), std::io::Error> {
        write_json_file(path, &serde_json::to_string_pretty(&self.entries)?)
    }

    /// Load the full history from a file, replacing all current entries.
    /// Advances the global ID counter past the highest loaded ID.
    pub fn load_all_from_file(&mut self, path: &std::path::Path) -> Result<(), std::io::Error> {
        if !path.exists() {
            return Ok(());
        }
        let data = std::fs::read_to_string(path)?;
        let loaded: Vec<ClipboardEntry> = serde_json::from_str(&data).unwrap_or_default();
        advance_id_past(&loaded);
        self.entries = loaded;
        Ok(())
    }
}
