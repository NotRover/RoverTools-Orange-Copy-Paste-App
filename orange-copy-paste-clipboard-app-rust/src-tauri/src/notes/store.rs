//! Note data model and persistent store.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::storage::Db;

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
        }
    }
}

// ── NoteStore ───────────────────────────────────────────────────────

/// One `notes` row as the struct, in `SELECT id, title, content, created_at,
/// updated_at, pinned, groups` order.
fn row_to_note(r: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    let groups: String = r.get(6)?;
    Ok(Note {
        id: r.get(0)?,
        title: r.get(1)?,
        content: r.get(2)?,
        created_at: r.get::<_, i64>(3)? as u64,
        updated_at: r.get::<_, i64>(4)? as u64,
        pinned: r.get(5)?,
        groups: serde_json::from_str(&groups).unwrap_or_default(),
    })
}

fn upsert_note(tx: &rusqlite::Transaction<'_>, n: &Note) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO notes (id, title, content, created_at, updated_at, pinned, groups)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content,
             created_at = excluded.created_at, updated_at = excluded.updated_at,
             pinned = excluded.pinned, groups = excluded.groups",
        params![
            n.id,
            n.title,
            n.content,
            n.created_at as i64,
            n.updated_at as i64,
            n.pinned,
            serde_json::to_string(&n.groups).unwrap_or_else(|_| "[]".into()),
        ],
    )?;
    Ok(())
}

/// In-memory store for all notes. Memory is the model; the `notes` table
/// follows it, each mutation writing the rows it touched (see
/// `ClipboardHistory` for the contract).
#[derive(Debug, Default)]
pub struct NoteStore {
    notes: Vec<Note>,
    db: Option<Arc<Db>>,
}

impl NoteStore {
    pub fn new() -> Self {
        Self::default()
    }

    // ── Persistence ─────────────────────────────────────────────────

    /// Attach the database every mutation from now on writes through to.
    pub fn attach_db(&mut self, db: Arc<Db>) {
        self.db = Some(db);
    }

    /// Replace memory with the `notes` table, most recently updated first.
    pub fn load_from_db(&mut self) -> bool {
        let Some(db) = self.db.clone() else {
            return false;
        };
        let Some(rows) = db.read("load notes", |c| {
            let mut st = c.prepare(
                "SELECT id, title, content, created_at, updated_at, pinned, groups
                 FROM notes ORDER BY updated_at DESC",
            )?;
            let rows = st.query_map([], row_to_note)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        }) else {
            return false;
        };
        advance_id_past(&rows);
        self.notes = rows;
        true
    }

    /// Write every note held, in one transaction. For the one-time import.
    pub fn persist_all(&mut self) -> bool {
        let ids: Vec<String> = self.notes.iter().map(|n| n.id.clone()).collect();
        self.write_rows(&ids)
    }

    fn write_rows(&mut self, ids: &[String]) -> bool {
        let Some(db) = self.db.clone() else {
            return false;
        };
        db.write("write notes", |tx| {
            for n in self.notes.iter().filter(|n| ids.contains(&n.id)) {
                upsert_note(tx, n)?;
            }
            Ok(())
        })
        .is_some()
    }

    /// Write the pin flag and groups of these notes, the columns the metadata
    /// mutations change, without copying their content.
    fn write_metas(&mut self, ids: &[String]) -> bool {
        if ids.is_empty() {
            return true;
        }
        let Some(db) = self.db.clone() else {
            return false;
        };
        let rows: Vec<(String, bool, String)> = self
            .notes
            .iter()
            .filter(|n| ids.contains(&n.id))
            .map(|n| {
                (
                    n.id.clone(),
                    n.pinned,
                    serde_json::to_string(&n.groups).unwrap_or_else(|_| "[]".into()),
                )
            })
            .collect();
        db.write("write note metadata", |tx| {
            let mut st = tx.prepare("UPDATE notes SET pinned = ?1, groups = ?2 WHERE id = ?3")?;
            for (id, pinned, groups) in &rows {
                st.execute(params![pinned, groups, id])?;
            }
            Ok(())
        })
        .is_some()
    }

    fn delete_row(&mut self, id: &str) -> bool {
        let Some(db) = self.db.clone() else {
            return false;
        };
        db.write("delete note", |tx| {
            tx.execute("DELETE FROM notes WHERE id = ?1", [id]).map(|_| ())
        })
        .is_some()
    }

    // ── Reads and mutations ─────────────────────────────────────────

    /// Return all notes (most-recently updated first).
    pub fn all(&self) -> &[Note] {
        &self.notes
    }

    /// Create a new blank note and return a clone of it.
    pub fn create(&mut self) -> Note {
        let note = Note::new();
        self.notes.insert(0, note.clone());
        self.write_rows(std::slice::from_ref(&note.id));
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
            self.write_rows(&[id.to_string()]);
        }
        found
    }

    /// Delete a note by ID. Returns `true` if found.
    pub fn delete(&mut self, id: &str) -> bool {
        if let Some(pos) = self.notes.iter().position(|n| n.id == id) {
            self.notes.remove(pos);
            self.delete_row(id);
            true
        } else {
            false
        }
    }

    /// Insert or replace a synced note by id, keeping the newer version (LWW).
    /// Used by the cloud-sync merge; call [`Self::sort_recent`] after a batch.
    pub fn upsert_synced(&mut self, note: Note) {
        let id = note.id.clone();
        if let Some(pos) = self.notes.iter().position(|n| n.id == note.id) {
            if note.updated_at >= self.notes[pos].updated_at {
                self.notes[pos] = note;
            } else {
                return;
            }
        } else {
            self.notes.push(note);
        }
        self.write_rows(&[id]);
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
        let found = self.with_note(id, |n| n.pinned = true);
        if found {
            self.write_metas(&[id.to_string()]);
        }
        found
    }

    /// Unpin a note.
    pub fn unpin(&mut self, id: &str) -> bool {
        let found = self.with_note(id, |n| n.pinned = false);
        if found {
            self.write_metas(&[id.to_string()]);
        }
        found
    }

    /// Set groups on a note.
    pub fn set_groups(&mut self, id: &str, groups: Vec<String>) -> bool {
        let found = self.with_note(id, |n| n.groups = groups);
        if found {
            self.write_metas(&[id.to_string()]);
        }
        found
    }

    /// Remove a group name from all notes.
    pub fn purge_group(&mut self, group: &str) {
        let mut changed = Vec::new();
        for n in &mut self.notes {
            let before = n.groups.len();
            n.groups.retain(|g| g != group);
            if n.groups.len() != before {
                changed.push(n.id.clone());
            }
        }
        self.write_metas(&changed);
    }

    /// Rename a group across all notes.
    pub fn rename_group(&mut self, old_name: &str, new_name: &str) {
        let mut changed = Vec::new();
        for n in &mut self.notes {
            let mut hit = false;
            for g in &mut n.groups {
                if g == old_name {
                    *g = new_name.to_string();
                    hit = true;
                }
            }
            if hit {
                changed.push(n.id.clone());
            }
        }
        self.write_metas(&changed);
    }

    /// Fold in a copy an older build set aside beside `notes.bin`, for the
    /// import. LWW by `updated_at`, same as the sync merge. `None` means the
    /// bytes did not parse.
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

    // ── Import ──────────────────────────────────────────────────────

    /// Read the `notes.bin` the pre-SQLite build wrote, once, for the import.
    pub fn load_legacy(&mut self, path: &std::path::Path) {
        let loaded: Vec<Note> = crate::storage::import::read_legacy(path);
        advance_id_past(&loaded);
        self.notes = loaded;
        self.notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_db(db: &Arc<Db>) -> NoteStore {
        let mut store = NoteStore::new();
        store.attach_db(Arc::clone(db));
        store
    }

    #[test]
    fn mutations_write_through_to_the_database() {
        let db = Db::open_in_memory();
        let mut store = with_db(&db);
        let a = store.create();
        let b = store.create();
        assert!(store.update(&a.id, "Title".into(), "<p>body</p>".into()));
        assert!(store.pin(&b.id));
        assert!(store.set_groups(&a.id, vec!["Work".into()]));
        store.rename_group("Work", "Office");
        let c = store.create();
        assert!(store.delete(&c.id));

        let mut again = with_db(&db);
        assert!(again.load_from_db());
        assert_eq!(again.all().len(), 2);
        let a2 = again.find(&a.id).unwrap();
        assert_eq!(a2.title, "Title");
        assert_eq!(a2.groups, vec!["Office"]);
        assert!(again.find(&b.id).unwrap().pinned);
        assert!(again.find(&c.id).is_none());
    }

    /// The merge keeps the newer copy, and only a copy that was taken is written.
    #[test]
    fn upsert_synced_is_last_write_wins_in_the_table_too() {
        let db = Db::open_in_memory();
        let mut store = with_db(&db);
        let mut newer = Note::new();
        newer.title = "new".into();
        let mut older = newer.clone();
        older.title = "old".into();
        older.updated_at -= 1;
        store.upsert_synced(newer.clone());
        store.upsert_synced(older);
        let mut again = with_db(&db);
        again.load_from_db();
        assert_eq!(again.find(&newer.id).unwrap().title, "new");
    }
}
