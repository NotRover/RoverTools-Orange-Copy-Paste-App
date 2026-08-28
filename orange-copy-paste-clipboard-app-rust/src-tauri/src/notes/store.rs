//! Note data model and persistent store.

use std::sync::atomic::{AtomicU64, Ordering};

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

/// Note times are compared against other devices' - `updated_at` decides
/// last-write-wins - so they are taken in the shared frame. See `crate::clock`.
fn now_ms() -> u64 {
    crate::clock::now_ms()
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
    // ── Transient sync fields — excluded from MessagePack serialization ──
    /// Server-assigned UUID after a successful push.
    #[serde(skip)]
    pub server_id: Option<String>,
    /// Whether this note has been synced to the server.
    #[serde(skip, default)]
    pub sync_status: crate::sync::types::SyncStatus,
}

impl Default for Note {
    fn default() -> Self {
        Self::new()
    }
}

impl Note {
    pub fn new() -> Self {
        let now = now_ms();
        Self {
            // Globally-unique so it doubles as the cross-device sync client_id.
            id: uuid::Uuid::new_v4().to_string(),
            title: String::new(),
            content: String::new(),
            created_at: now,
            updated_at: now,
            pinned: false,
            groups: Vec::new(),
            server_id: None,
            sync_status: crate::sync::types::SyncStatus::LocalOnly,
        }
    }
}

// ── Persistence helpers ─────────────────────────────────────────────

/// Same durability contract as clipboard history: notes are the user's data, so
/// an atomic flushed replace, and no overwrite once the process is degraded.
fn save_notes_binary(notes: &[Note], path: &std::path::Path) -> Result<(), std::io::Error> {
    let msgpack =
        rmp_serde::to_vec(notes).map_err(std::io::Error::other)?;
    crate::health::write_state(path, &msgpack)
}

/// Same shared read contract as clipboard history: missing file means no notes
/// yet, a good load refreshes `.bak`, and a file that will not load is sealed
/// with the backup shown instead.
fn load_notes_binary(path: &std::path::Path) -> Result<Vec<Note>, std::io::Error> {
    let parsed = crate::health::load_state(path, &|bytes| {
        rmp_serde::from_slice(bytes).map_err(|e| e.to_string())
    })?;
    Ok(parsed.unwrap_or_default())
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

    /// Apply `f` to the note with the given ID. Returns `true` if found.
    fn with_note(&mut self, id: &str, f: impl FnOnce(&mut Note)) -> bool {
        match self.notes.iter_mut().find(|n| n.id == id) {
            Some(n) => {
                f(n);
                true
            }
            None => false,
        }
    }

    /// Update the title and content of a note. Returns `true` if found.
    pub fn update(&mut self, id: &str, title: String, content: String) -> bool {
        let found = self.with_note(id, |n| {
            n.title = title;
            n.content = content;
            n.updated_at = now_ms();
        });
        if found {
            // Re-sort so the most recently updated note is first.
            self.notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        }
        found
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

    /// Insert or replace a synced note by id, keeping the newer version (LWW).
    /// Used by the cloud-sync merge; call [`Self::sort_recent`] after a batch.
    pub fn upsert_synced(&mut self, note: Note) {
        if let Some(pos) = self.notes.iter().position(|n| n.id == note.id) {
            if note.updated_at >= self.notes[pos].updated_at {
                self.notes[pos] = note;
            }
        } else {
            self.notes.push(note);
        }
    }

    /// Re-sort most-recently-updated first.
    pub fn sort_recent(&mut self) {
        self.notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    }

    /// Look up a note by ID.
    pub fn find(&self, id: &str) -> Option<&Note> {
        self.notes.iter().find(|n| n.id == id)
    }

    /// Pin a note.
    pub fn pin(&mut self, id: &str) -> bool {
        self.with_note(id, |n| n.pinned = true)
    }

    /// Unpin a note.
    pub fn unpin(&mut self, id: &str) -> bool {
        self.with_note(id, |n| n.pinned = false)
    }

    /// Set groups on a note.
    pub fn set_groups(&mut self, id: &str, groups: Vec<String>) -> bool {
        self.with_note(id, |n| n.groups = groups)
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

    /// Fold in notes a sealed session captured while it could not read this
    /// file. LWW by `updated_at`, same as the sync merge, and idempotent, so
    /// the leftover can outlive a failed save and merge again next start.
    /// `None` means the bytes did not parse and the file is kept; `Some(0)`
    /// means it held nothing new and is safely redundant.
    pub fn merge_leftover(&mut self, bytes: &[u8]) -> Option<usize> {
        let Ok(notes) = rmp_serde::from_slice::<Vec<Note>>(bytes) else {
            return None;
        };
        advance_id_past(&notes);
        let before = self.notes.len();
        for note in notes {
            self.upsert_synced(note);
        }
        self.sort_recent();
        Some(self.notes.len() - before)
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
