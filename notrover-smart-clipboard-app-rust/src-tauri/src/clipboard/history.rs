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

// Types

/// The content kind of a clipboard entry.
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
}

impl ClipboardEntry {
    fn next_id() -> String {
        NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string()
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Create a new **text** entry.
    pub fn new_text(content: String) -> Self {
        Self {
            id: Self::next_id(),
            kind: EntryKind::Text,
            content,
            timestamp: Self::now_ms(),
        }
    }

    /// Create a new **image** entry from a PNG data-URL.
    pub fn new_image(data_url: String) -> Self {
        Self {
            id: Self::next_id(),
            kind: EntryKind::Image,
            content: data_url,
            timestamp: Self::now_ms(),
        }
    }

    /// Create a new **file-list** entry.
    ///
    /// `content` stores newline-delimited absolute file paths.
    pub fn new_file(content: String) -> Self {
        Self {
            id: Self::next_id(),
            kind: EntryKind::File,
            content,
            timestamp: Self::now_ms(),
        }
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

    /// Prepend an entry and trim to [`MAX_HISTORY`].
    /// Returns a clone of the newly inserted entry.
    pub fn push(&mut self, entry: ClipboardEntry) -> ClipboardEntry {
        self.entries.insert(0, entry.clone());
        self.entries.truncate(MAX_HISTORY);
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
    pub fn remove(&mut self, id: &str) -> bool {
        if let Some(pos) = self.entries.iter().position(|e| e.id == id) {
            self.entries.remove(pos);
            true
        } else {
            false
        }
    }

    /// Clear all entries.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Look up an entry by `id`.
    pub fn find(&self, id: &str) -> Option<&ClipboardEntry> {
        self.entries.iter().find(|e| e.id == id)
    }
}
