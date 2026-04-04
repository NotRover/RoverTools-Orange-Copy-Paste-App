//! Note data model and persistent store.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Global monotonically increasing ID counter for notes.
static NEXT_NOTE_ID: AtomicU64 = AtomicU64::new(1);

/// Advance the global ID counter past any loaded IDs to avoid collisions.
fn advance_id_past(notes: &[Note]) {
    let max_id = notes
        .iter()
        .filter_map(|n| n.id.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    let _ = NEXT_NOTE_ID.fetch_max(max_id + 1, Ordering::Relaxed);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// A single note.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub title: String,
    /// Rich-text content stored as sanitised HTML.
    pub content: String,
    /// Unix epoch in milliseconds.
    pub created_at: u64,
    /// Unix epoch in milliseconds.
    pub updated_at: u64,
    /// Whether this note is pinned to the top of the list.
    #[serde(default)]
    pub pinned: bool,
    /// User-defined group tags (shared with clipboard groups).
    #[serde(default)]
    pub groups: Vec<String>,
}

impl Note {
    pub fn new() -> Self {
        let now = now_ms();
        Self {
            id: NEXT_NOTE_ID.fetch_add(1, Ordering::Relaxed).to_string(),
            title: String::new(),
            content: String::new(),
            created_at: now,
            updated_at: now,
            pinned: false,
            groups: Vec::new(),
        }
    }
}

// ── Persistence helpers ─────────────────────────────────────────────

fn write_binary(path: &std::path::Path, data: &[u8]) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, data)
}

fn save_notes_binary(notes: &[Note], path: &std::path::Path) -> Result<(), std::io::Error> {
    let msgpack =
        rmp_serde::to_vec(notes).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    write_binary(path, &msgpack)
}

fn load_notes_binary(path: &std::path::Path) -> Result<Vec<Note>, std::io::Error> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read(path)?;
    rmp_serde::from_slice(&data)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

// ── NoteStore ───────────────────────────────────────────────────────

/// In-memory store for all notes, with MessagePack persistence.
#[derive(Debug, Default)]
pub struct NoteStore {
    notes: Vec<Note>,
}

impl NoteStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return all notes (most-recently updated first).
    pub fn all(&self) -> &[Note] {
        &self.notes
    }

    /// Create a new blank note and return a clone of it.
    pub fn create(&mut self) -> Note {
        let note = Note::new();
        self.notes.insert(0, note.clone());
        note
    }

    /// Update the title and content of a note. Returns `true` if found.
    pub fn update(&mut self, id: &str, title: String, content: String) -> bool {
        if let Some(n) = self.notes.iter_mut().find(|n| n.id == id) {
            n.title = title;
            n.content = content;
            n.updated_at = now_ms();
            // Re-sort so the most recently updated note is first.
            self.notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            true
        } else {
            false
        }
    }

    /// Delete a note by ID. Returns `true` if found.
    pub fn delete(&mut self, id: &str) -> bool {
        if let Some(pos) = self.notes.iter().position(|n| n.id == id) {
            self.notes.remove(pos);
            true
        } else {
            false
        }
    }

    /// Look up a note by ID.
    pub fn find(&self, id: &str) -> Option<&Note> {
        self.notes.iter().find(|n| n.id == id)
    }

    /// Pin a note.
    pub fn pin(&mut self, id: &str) -> bool {
        if let Some(n) = self.notes.iter_mut().find(|n| n.id == id) {
            n.pinned = true;
            true
        } else {
            false
        }
    }

    /// Unpin a note.
    pub fn unpin(&mut self, id: &str) -> bool {
        if let Some(n) = self.notes.iter_mut().find(|n| n.id == id) {
            n.pinned = false;
            true
        } else {
            false
        }
    }

    /// Set groups on a note.
    pub fn set_groups(&mut self, id: &str, groups: Vec<String>) -> bool {
        if let Some(n) = self.notes.iter_mut().find(|n| n.id == id) {
            n.groups = groups;
            true
        } else {
            false
        }
    }

    /// Remove a group name from all notes.
    pub fn purge_group(&mut self, group: &str) {
        for n in &mut self.notes {
            n.groups.retain(|g| g != group);
        }
    }

    /// Rename a group across all notes.
    pub fn rename_group(&mut self, old_name: &str, new_name: &str) {
        for n in &mut self.notes {
            for g in &mut n.groups {
                if g == old_name {
                    *g = new_name.to_string();
                }
            }
        }
    }

    // ── Persistence ─────────────────────────────────────────────────

    /// Load notes from disk, replacing current in-memory state.
    pub fn load_from_file(&mut self, path: &std::path::Path) -> Result<(), std::io::Error> {
        let loaded = load_notes_binary(path)?;
        advance_id_past(&loaded);
        self.notes = loaded;
        // Ensure sorted by updated_at desc.
        self.notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(())
    }

    /// Save all notes to disk.
    pub fn save_to_file(&self, path: &std::path::Path) -> Result<(), std::io::Error> {
        save_notes_binary(&self.notes, path)
    }
}
