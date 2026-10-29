//! Clipboard history store.
//!
//! Holds every clipboard entry in memory, most recent first (text, rich text,
//! file lists, or images externalised to files).  The store is wrapped
//! in a [`parking_lot::Mutex`] so it can be shared across Tauri commands and
//! global-shortcut handlers.

use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::fs;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::storage::cipher::Cipher;
use crate::storage::Db;

// Constants

/// Largest text-shaped payload (text, rich text, file list) kept in history.
///
/// Until this existed nothing capped how large one entry could be - and every
/// entry is duplicated several times over on its way to the user: into the
/// store, into each webview that shows it, into
/// MessagePack on every flush, and into ciphertext when sync pushes it. That
/// multiplier is harmless for a paragraph and fatal for a whole file; one
/// 500 MB copy took the process to several GB and crashed the UI.
///
/// Refusing past this point costs the user a history row and nothing else. The
/// OS clipboard is never touched by the capture path, so the data is still
/// there and an ordinary paste still works - and the refusal always shows a
/// toast, whatever the notification settings say, because the only other sign
/// is the item's absence.
///
/// Well above what the server will store (see `MAX_INLINE_SYNC_BYTES` in
/// `sync`), on purpose: what this app holds locally and what a row in the cloud
/// may weigh are different questions, and history is useful without sync. An
/// item between the two is kept and marked local-only.
pub const MAX_TEXT_BYTES: usize = 4 * 1024 * 1024;

/// Separator embedded in an `Html` entry's content between the HTML fragment
/// and its plain-text fallback.  Written by `new_html`, split by `html_parts`.
const HTML_PLAINTEXT_MARKER: &str = "\n---PLAINTEXT---\n";

/// Format a human-readable label for a clipboard image from its timestamp.
fn format_image_label(timestamp_ms: u64) -> String {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
        use windows_sys::Win32::System::Time::{
            FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime,
        };

        // Windows FILETIME epoch = 1601-01-01, offset from Unix epoch = 11644473600 seconds
        let ft_ticks =
            ((timestamp_ms / 1000) + 11_644_473_600) * 10_000_000 + (timestamp_ms % 1000) * 10_000;
        let ft = FILETIME {
            dwLowDateTime: ft_ticks as u32,
            dwHighDateTime: (ft_ticks >> 32) as u32,
        };
        let mut utc_st: SYSTEMTIME = unsafe { std::mem::zeroed() };
        let mut local_st: SYSTEMTIME = unsafe { std::mem::zeroed() };
        unsafe {
            FileTimeToSystemTime(&ft, &mut utc_st);
            SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc_st, &mut local_st);
        }
        let months = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
        ];
        let month = months
            .get(local_st.wMonth.wrapping_sub(1) as usize)
            .unwrap_or(&"???");
        let (h12, ampm) = match local_st.wHour {
            0 => (12, "AM"),
            1..=11 => (local_st.wHour, "AM"),
            12 => (12, "PM"),
            _ => (local_st.wHour - 12, "PM"),
        };
        format!(
            "Image {} {}, {}:{:02} {}",
            month, local_st.wDay, h12, local_st.wMinute, ampm
        )
    }
    #[cfg(not(windows))]
    {
        format!("Image {}", timestamp_ms)
    }
}

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

/// Decode a `data:<mime>;base64,<data>` URL and write the raw image bytes
/// to the images directory.  The file is named `{id}_{label}.{ext}` so it
/// is both human-readable and unique.  Returns the absolute file path on
/// success, or `None` if decoding / writing fails.
fn save_image_to_disk(entry: &ClipboardEntry, images_dir: &std::path::Path) -> Option<String> {
    let pos = entry.content.find(";base64,")?;
    let mime = &entry.content[5..pos];
    let b64_data = &entry.content[pos + 8..];
    let raw = B64.decode(b64_data).ok()?;

    let ext = match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        _ => "png",
    };

    let label = entry.label.as_deref().unwrap_or("Image");
    let safe: String = label
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let filename = format!("{}_{}.{}", entry.id, safe.trim(), ext);
    let filepath = images_dir.join(&filename);

    // Atomic: the caller stores this path on the entry, so a truncated file here
    // becomes a permanently broken thumbnail. Unflushed — images can be large and
    // this runs on the capture path, and a power cut costs one thumbnail.
    crate::health::replace_atomic(&filepath, &raw).ok()?;

    Some(filepath.to_string_lossy().to_string())
}

/// Check whether two entries have equivalent content.
///
/// For most entry types this is a simple string comparison.  For images,
/// the `content` field might be a data-URL in one entry and a file path
/// in the other (after externalisation).  To handle that cheaply, each
/// image entry carries a `content_hash` computed from the original
/// data-URL at creation time.  Comparing two u64 hashes is O(1) with no
/// I/O or base64 decoding.
pub(crate) fn content_matches(a: &ClipboardEntry, b: &ClipboardEntry) -> bool {
    if a.kind != b.kind {
        return false;
    }
    if a.content == b.content {
        return true;
    }
    // For images, compare the content hash (survives externalisation).
    if a.kind == EntryKind::Image {
        if let (Some(ha), Some(hb)) = (a.content_hash, b.content_hash) {
            return ha == hb;
        }
    }
    false
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Text,
    Image,
    File,
    Html,
}

impl EntryKind {
    /// Short lowercase label for this kind, used in event payloads and popups.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
            Self::File => "file",
            Self::Html => "html",
        }
    }

    /// Parse a wire label back into an `EntryKind` (defaults to `Text`).
    pub fn from_label(label: &str) -> Self {
        match label {
            "image" => Self::Image,
            "file" => Self::File,
            "html" => Self::Html,
            _ => Self::Text,
        }
    }
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
    /// Whether this entry is pinned (shown in paste popup's pinned section).
    #[serde(default)]
    pub pinned: bool,
    /// User-defined group tags assigned to this entry.
    #[serde(default)]
    pub groups: Vec<String>,
    /// Optional display label (e.g. "Image Mar 17, 2:45 PM" for clipboard images).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Whether the row on disk holds this entry's text sealed (section 7.1).
    /// Set by the write that stored it, never a request; the UI shows it as
    /// the shield badge.
    ///
    /// Last, and absent when false: an older build's MessagePack file is
    /// positional, with `label` dropped when `None`, so a field after `label`
    /// that is present when `label` is not would be read as the label. The
    /// import only ever reads such files, and never a sealed entry.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub encrypted: bool,
    /// Fast content fingerprint for image deduplication.  Computed from the
    /// original data-URL at creation time so it survives externalisation to
    /// a file path.  Not persisted — only relevant within a single session.
    #[serde(skip)]
    pub content_hash: Option<u64>,
}

/// Whether an entry's content is within [`MAX_TEXT_BYTES`], and so small
/// enough to keep.
///
/// Image content is a path to a file on disk however large the picture is, so
/// it is always within the cap.
pub fn fits(entry: &ClipboardEntry) -> bool {
    entry.kind == EntryKind::Image || entry.content.len() <= MAX_TEXT_BYTES
}

/// Compute a fast 64-bit hash of the given string.
fn hash_content(s: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
}

impl ClipboardEntry {
    fn new(kind: EntryKind, content: String) -> Self {
        // Corrected against the server rather than read raw, so an entry
        // copied here is comparable with one copied on another machine. See
        // `crate::clock`.
        let timestamp = crate::clock::now_ms();
        let label = if kind == EntryKind::Image {
            Some(format_image_label(timestamp))
        } else {
            None
        };
        let content_hash = if kind == EntryKind::Image {
            Some(hash_content(&content))
        } else {
            None
        };
        Self {
            // Globally-unique so it doubles as the cross-device sync client_id.
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            content,
            timestamp,
            pinned: false,
            groups: Vec::new(),
            label,
            encrypted: false,
            content_hash,
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

    /// `content` stores the HTML fragment extracted from CF_HTML.
    /// A plain-text fallback is embedded via [`HTML_PLAINTEXT_MARKER`].
    pub fn new_html(html: String, plain_text: String) -> Self {
        let content = format!("{html}{HTML_PLAINTEXT_MARKER}{plain_text}");
        Self::new(EntryKind::Html, content)
    }

    /// For Html entries, split content into (html, plain_text).
    pub fn html_parts(&self) -> (&str, &str) {
        match self.content.find(HTML_PLAINTEXT_MARKER) {
            // `find` returns a char boundary and the marker is ASCII, so both
            // slices are always valid — never hardcode the marker's length here.
            Some(idx) => (
                &self.content[..idx],
                &self.content[idx + HTML_PLAINTEXT_MARKER.len()..],
            ),
            None => (&self.content, ""),
        }
    }

    /// Whether this entry is saved (pinned OR has the "Saved" group tag).
    pub fn is_saved(&self) -> bool {
        self.pinned || self.groups.iter().any(|g| g == "Saved")
    }
}

// History

/// Shared clipboard history.
///
/// Entries are prepended (most-recent first). Nothing caps how many are held.
#[derive(Debug, Default)]
pub struct ClipboardHistory {
    entries: Vec<ClipboardEntry>,
    /// Directory where externalised image files are stored.
    /// Configured once at startup via [`Self::set_images_dir`].
    images_dir: Option<std::path::PathBuf>,
    /// Directory where a synced file entry's blob is extracted, one subdir per
    /// entry (`received-files/{id}/`). Configured once at startup via
    /// [`Self::set_received_files_dir`].
    received_files_dir: Option<std::path::PathBuf>,
    /// Files of entries removed since the last write that landed, as (entry id,
    /// path). Deleted only once the write dropping their rows has committed, so
    /// a refused write never leaves a row naming a file that is gone.
    gone_files: Vec<(String, PathBuf)>,
    /// Where every mutation writes through to. `None` only before startup has
    /// attached it, and in tests of the in-memory behaviour.
    db: Option<Arc<Db>>,
    /// Encryption at rest. Set, every row written is sealed under it and every
    /// sealed row is opened with it; unset, rows are written in plain text.
    cipher: Option<Arc<Cipher>>,
}

const SELECT_ENTRY: &str = "id, kind, content, ts, pinned, label, groups, enc";

/// One `entries` row as the struct, in [`SELECT_ENTRY`] order. `Ok(None)` is a
/// sealed row this launch cannot open - no key, or not this key - which is
/// logged and left in the table for a launch that can.
fn row_to_entry(r: &rusqlite::Row<'_>, cipher: Option<&Cipher>) -> rusqlite::Result<Option<ClipboardEntry>> {
    let id: String = r.get(0)?;
    let kind: String = r.get(1)?;
    let mut content: String = r.get(2)?;
    let mut label: Option<String> = r.get(5)?;
    let groups: String = r.get(6)?;
    let encrypted: bool = r.get(7)?;
    if encrypted {
        let opened = cipher
            .ok_or_else(|| "no key loaded".to_string())
            .and_then(|c| {
                let content = c.open("entries", &id, "content", &content)?;
                let label = label.as_deref().map(|l| c.open("entries", &id, "label", l)).transpose()?;
                Ok((content, label))
            });
        match opened {
            Ok((c, l)) => {
                content = c;
                label = l;
            }
            Err(e) => {
                log::warn!(target: "storage", "entry {id} skipped: {e}");
                return Ok(None);
            }
        }
    }
    Ok(Some(ClipboardEntry {
        id,
        kind: EntryKind::from_label(&kind),
        content,
        timestamp: r.get::<_, i64>(3)? as u64,
        pinned: r.get(4)?,
        label,
        groups: serde_json::from_str(&groups).unwrap_or_default(),
        encrypted,
        content_hash: None,
    }))
}

const UPSERT_ENTRY: &str = "INSERT INTO entries (id, kind, content, ts, pinned, label, groups, enc)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, content = excluded.content,
         ts = excluded.ts, pinned = excluded.pinned, label = excluded.label, groups = excluded.groups,
         enc = excluded.enc";

/// Write `e` as its row, inserting or replacing, sealed when `cipher` is set.
fn upsert_entry(tx: &rusqlite::Transaction<'_>, e: &ClipboardEntry, cipher: Option<&Cipher>) -> rusqlite::Result<()> {
    let seal = |column: &str, text: &str| -> rusqlite::Result<String> {
        match cipher {
            Some(c) => c
                .seal("entries", &e.id, column, text)
                .map_err(|m| rusqlite::Error::ToSqlConversionFailure(m.into())),
            None => Ok(text.to_string()),
        }
    };
    let content = seal("content", &e.content)?;
    let label = e.label.as_deref().map(|l| seal("label", l)).transpose()?;
    tx.execute(
        UPSERT_ENTRY,
        params![
            e.id,
            e.kind.label(),
            content,
            e.timestamp as i64,
            e.pinned,
            label,
            serde_json::to_string(&e.groups).unwrap_or_else(|_| "[]".into()),
            cipher.is_some(),
        ],
    )?;
    Ok(())
}

impl ClipboardHistory {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the directory used to persist clipboard images as files on disk.
    pub fn set_images_dir(&mut self, dir: std::path::PathBuf) {
        self.images_dir = Some(dir);
    }

    /// Set the directory holding extracted synced-file entries (one subdir per
    /// entry id), so a save can delete the subdir of a removed entry.
    pub fn set_received_files_dir(&mut self, dir: std::path::PathBuf) {
        self.received_files_dir = Some(dir);
    }

    // ── Persistence ─────────────────────────────────────────────────
    //
    // Memory is the model; the `entries` table follows it. Each mutation below
    // updates the Vec and then writes exactly the rows it touched, so the two
    // never differ by more than the statement in flight. A write that fails is
    // reported by the health layer and memory keeps the change, same as a
    // refused file write did; the next write that lands carries it only if it
    // touches that row again, which is the one cost of row-level writes.

    /// Attach the database every mutation from now on writes through to.
    pub fn attach_db(&mut self, db: Arc<Db>) {
        self.db = Some(db);
    }

    /// Set, or clear, the cipher rows are written with from now on. Rows
    /// already on disk stay as they are until written again; `persist_all`
    /// rewrites them all.
    pub fn set_cipher(&mut self, cipher: Option<Arc<Cipher>>) {
        self.cipher = cipher;
    }

    /// Whether rows written now are sealed.
    pub fn cipher_active(&self) -> bool {
        self.cipher.is_some()
    }

    /// Replace memory with the `entries` table, newest first. `false` when the
    /// read failed or no database is attached; memory is then left alone.
    /// A sealed row the cipher will not open is skipped, not dropped.
    pub fn load_from_db(&mut self) -> bool {
        let Some(db) = self.db.clone() else {
            return false;
        };
        let cipher = self.cipher.clone();
        let Some(rows) = db.read("load entries", |c| {
            let mut st = c.prepare(&format!(
                // rowid breaks a same-millisecond tie the way memory ordered
                // them: the later insert first.
                "SELECT {SELECT_ENTRY} FROM entries ORDER BY ts DESC, rowid DESC"
            ))?;
            let rows = st.query_map([], |r| row_to_entry(r, cipher.as_deref()))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        }) else {
            return false;
        };
        let total = rows.len();
        let rows: Vec<ClipboardEntry> = rows.into_iter().flatten().collect();
        if rows.len() < total {
            log::warn!(target: "storage", "{} entries skipped: sealed and not opened by this launch's key", total - rows.len());
        }
        advance_id_past(&rows);
        self.entries = rows;
        self.externalize_images();
        true
    }

    /// Write every entry held, in one transaction. For the one-time import of
    /// a file-based history, and for turning encryption at rest on or off;
    /// idempotent, since rows are keyed by id.
    pub fn persist_all(&mut self) -> bool {
        let ids: Vec<String> = self.entries.iter().map(|e| e.id.clone()).collect();
        self.write_rows(&ids)
    }

    /// Write the rows of the entries with these ids. Ids not in memory are skipped.
    fn write_rows(&mut self, ids: &[String]) -> bool {
        let Some(db) = self.db.clone() else {
            return false;
        };
        let cipher = self.cipher.clone();
        let landed = db
            .write("write entries", |tx| {
                // Oldest first, so a batch's rowids order it the way memory does.
                for e in self.entries.iter().rev().filter(|e| ids.iter().any(|i| *i == e.id)) {
                    upsert_entry(tx, e, cipher.as_deref())?;
                }
                Ok(())
            })
            .is_some();
        if landed {
            let encrypted = cipher.is_some();
            for e in self.entries.iter_mut().filter(|e| ids.iter().any(|i| *i == e.id)) {
                e.encrypted = encrypted;
            }
            self.reap_gone_files();
        }
        landed
    }

    /// Write one entry's pin flag and groups, the columns the metadata
    /// mutations change. Avoids copying a large content column to flip a flag.
    fn write_meta(&mut self, id: &str) -> bool {
        let Some(db) = self.db.clone() else {
            return false;
        };
        let Some(e) = self.find(id) else {
            return false;
        };
        let groups = serde_json::to_string(&e.groups).unwrap_or_else(|_| "[]".into());
        let pinned = e.pinned;
        let landed = db
            .write("write entry metadata", |tx| {
                tx.execute(
                    "UPDATE entries SET pinned = ?1, groups = ?2 WHERE id = ?3",
                    params![pinned, groups, id],
                )
                .map(|_| ())
            })
            .is_some();
        if landed {
            self.reap_gone_files();
        }
        landed
    }

    /// Delete the rows for these ids. Their files, if any, are queued by the
    /// caller through [`Self::note_gone`] and go once this write has landed.
    fn delete_rows(&mut self, ids: &[String]) -> bool {
        if ids.is_empty() {
            return true;
        }
        let Some(db) = self.db.clone() else {
            return false;
        };
        let landed = db
            .write("delete entries", |tx| {
                let mut st = tx.prepare("DELETE FROM entries WHERE id = ?1")?;
                for id in ids {
                    st.execute([id])?;
                }
                Ok(())
            })
            .is_some();
        if landed {
            self.reap_gone_files();
        }
        landed
    }

    /// Delete the files of removed entries, now that the write dropping their
    /// rows has committed. Never for an id that is live again (removed, then
    /// restored by a merge).
    fn reap_gone_files(&mut self) {
        if self.gone_files.is_empty() {
            return;
        }
        let live: HashSet<&str> = self.entries.iter().map(|e| e.id.as_str()).collect();
        for (id, file) in std::mem::take(&mut self.gone_files) {
            if live.contains(id.as_str()) {
                continue;
            }
            let _ = if file.is_dir() {
                fs::remove_dir_all(&file)
            } else {
                fs::remove_file(&file)
            };
        }
    }

    // ── Mutations ───────────────────────────────────────────────────

    /// Prepend an entry. Returns a clone of the newly inserted entry.
    pub fn push(&mut self, mut entry: ClipboardEntry) -> ClipboardEntry {
        // For image entries still carrying an inline data-URL, persist the
        // raw bytes to disk and replace the content with the file path.
        // This keeps the in-memory footprint small and paste fast.
        if entry.kind == EntryKind::Image && entry.content.starts_with("data:") {
            if let Some(ref dir) = self.images_dir {
                if let Some(path) = save_image_to_disk(&entry, dir) {
                    entry.content = path;
                }
            }
        }
        self.entries.insert(0, entry);
        let id = self.entries[0].id.clone();
        self.write_rows(std::slice::from_ref(&id));
        // After the write, so the copy handed back says whether it was sealed.
        self.entries[0].clone()
    }

    /// Prepend an entry only when it differs from the current top entry.
    /// Returns the existing top entry when duplicate, or the inserted entry,
    /// plus whether insertion actually happened.
    pub fn push_if_distinct_with_flag(&mut self, entry: ClipboardEntry) -> (ClipboardEntry, bool) {
        if let Some(existing) = self.entries.first() {
            if content_matches(existing, &entry) {
                return (existing.clone(), false);
            }
        }

        (self.push(entry), true)
    }

    /// Insert or replace a synced entry by id.  Used by the cloud-sync merge:
    /// entries arrive already materialised, so this bypasses image
    /// externalisation.  Call [`Self::sort_recent`]
    /// once after a merge batch to restore ordering.
    ///
    /// `false` when the entry was refused for its size. A device on a build
    /// without the capture cap can push an entry of any size, and taking it
    /// would put this device back in exactly the state the cap exists to
    /// prevent. Image content is a path to a file on disk, so it is exempt.
    pub fn upsert_synced(&mut self, entry: ClipboardEntry) -> bool {
        if !fits(&entry) {
            log::warn!(target: "history", "merge: {} is {} bytes, past the {} byte cap (skipped)",
                entry.id,
                entry.content.len(),
                MAX_TEXT_BYTES
            );
            return false;
        }
        let id = entry.id.clone();
        if let Some(pos) = self.entries.iter().position(|e| e.id == entry.id) {
            self.entries[pos] = entry;
        } else {
            self.entries.push(entry);
        }
        self.write_rows(std::slice::from_ref(&id));
        true
    }

    /// Drop every entry past [`MAX_TEXT_BYTES`], returning the sizes removed.
    ///
    /// For a history file written before the cap existed. Such an entry cannot
    /// be shown, searched or pushed without the memory blowup the cap was added
    /// to stop, so keeping it only reproduces the fault on every launch. Image
    /// entries are exempt: their content is a path, and a legacy inline one has
    /// already been externalised by the time this runs.
    pub fn drop_oversized(&mut self) -> Vec<usize> {
        let mut dropped = Vec::new();
        let mut ids = Vec::new();
        self.entries.retain(|e| {
            if fits(e) {
                return true;
            }
            dropped.push(e.content.len());
            ids.push(e.id.clone());
            false
        });
        self.delete_rows(&ids);
        dropped
    }

    /// Re-sort most-recent first by timestamp.
    pub fn sort_recent(&mut self) {
        self.entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    }

    /// Return the full history slice (most-recent first).
    pub fn all(&self) -> &[ClipboardEntry] {
        &self.entries
    }

    /// Return the top `n` entries (most-recent first).
    pub fn top(&self, n: usize) -> Vec<ClipboardEntry> {
        self.entries.iter().take(n).cloned().collect()
    }

    /// Whether `entry` is the same content as the newest entry already held.
    ///
    /// The capture dedupe's question, answered without copying anything: the
    /// obvious `top(1)` spelling clones the newest entry on every clipboard
    /// change just to compare it and drop it again.
    pub fn top_matches(&self, entry: &ClipboardEntry) -> bool {
        self.entries
            .first()
            .is_some_and(|top| content_matches(top, entry))
    }

    /// Remove the entry with the given `id`. Returns `true` if found.
    /// Pinned entries can also be removed.
    pub fn remove(&mut self, id: &str) -> bool {
        if let Some(pos) = self.entries.iter().position(|e| e.id == id) {
            let e = self.entries.remove(pos);
            self.note_gone(&e);
            self.delete_rows(std::slice::from_ref(&e.id));
            true
        } else {
            false
        }
    }

    /// Clear all non-saved entries. Pinned and saved entries are retained.
    /// Returns the (id, timestamp) of each entry dropped, so exactly those are
    /// tombstoned.
    pub fn clear(&mut self) -> Vec<(String, u64)> {
        let (kept, dropped): (Vec<_>, Vec<_>) = std::mem::take(&mut self.entries)
            .into_iter()
            .partition(ClipboardEntry::is_saved);
        self.entries = kept;
        let out: Vec<(String, u64)> = dropped
            .into_iter()
            .map(|e| {
                self.note_gone(&e);
                (e.id, e.timestamp)
            })
            .collect();
        let ids: Vec<String> = out.iter().map(|(id, _)| id.clone()).collect();
        self.delete_rows(&ids);
        out
    }

    /// Drop every entry a save with this `also_keep` would not write, queueing
    /// its file for that save to delete. For the last save before the process
    /// ends only: nothing outlives it to show those entries, and nothing else
    /// would ever delete their files.
    ///
    /// An entry whose file something still points at stays, file and all: one
    /// of `clipboard_refs` (what the system clipboard holds right now, so a
    /// paste after the quit still works), or a path a kept entry names.
    pub fn drop_unkept(&mut self, also_keep: impl Fn(&str) -> bool, clipboard_refs: &[PathBuf]) {
        let keep = |e: &ClipboardEntry| e.is_saved() || also_keep(&e.id);
        let mut refs: Vec<PathBuf> = clipboard_refs.to_vec();
        refs.extend(self.entries.iter().filter(|e| keep(e)).flat_map(entry_paths));
        // An entry whose file the clipboard or a kept entry still points at
        // stays too: dropping it would leave a file nothing names.
        let (kept, dropped): (Vec<_>, Vec<_>) = std::mem::take(&mut self.entries)
            .into_iter()
            .partition(|e| keep(e) || self.owned_file(e).is_some_and(|f| path_in_use(&f, &refs)));
        self.entries = kept;
        for e in &dropped {
            self.note_gone(e);
        }
        let ids: Vec<String> = dropped.into_iter().map(|e| e.id).collect();
        self.delete_rows(&ids);
    }

    /// Queue the file a removed entry owns for the next save to delete.
    fn note_gone(&mut self, e: &ClipboardEntry) {
        if let Some(file) = self.owned_file(e) {
            self.gone_files.push((e.id.clone(), file));
        }
    }

    /// The file an entry owns under app data, if any. Only a single path
    /// component is joined onto its directory, so nothing outside `images/` or
    /// `received-files/` can be named.
    fn owned_file(&self, e: &ClipboardEntry) -> Option<PathBuf> {
        match e.kind {
            EntryKind::Image if !e.content.starts_with("data:") => self
                .images_dir
                .as_ref()
                .zip(Path::new(&e.content).file_name())
                .map(|(dir, name)| dir.join(name)),
            EntryKind::File => self
                .received_files_dir
                .as_ref()
                .zip(Path::new(&e.id).file_name())
                .map(|(dir, name)| dir.join(name)),
            EntryKind::Image | EntryKind::Text | EntryKind::Html => None,
        }
    }

    /// Look up an entry by `id`.
    pub fn find(&self, id: &str) -> Option<&ClipboardEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// Look up a mutable entry by `id`.
    pub fn find_mut(&mut self, id: &str) -> Option<&mut ClipboardEntry> {
        self.entries.iter_mut().find(|e| e.id == id)
    }

    /// Pin an entry by ID.
    /// Returns `true` if found and pinned.
    pub fn pin(&mut self, id: &str) -> bool {
        let found = self.find_mut(id).map(|e| e.pinned = true).is_some();
        if found {
            self.write_meta(id);
        }
        found
    }

    pub fn unpin(&mut self, id: &str) -> bool {
        let found = self.find_mut(id).map(|e| e.pinned = false).is_some();
        if found {
            self.write_meta(id);
        }
        found
    }

    /// Get all pinned entries (for paste popup).
    pub fn pinned_entries(&self) -> Vec<ClipboardEntry> {
        self.entries.iter().filter(|e| e.pinned).cloned().collect()
    }

    /// Replace the groups list for an entry. Returns `true` if found.
    pub fn set_groups(&mut self, id: &str, groups: Vec<String>) -> bool {
        let found = self.find_mut(id).map(|e| e.groups = groups).is_some();
        if found {
            self.write_meta(id);
        }
        found
    }

    /// Add a single group to an entry (no duplicates). Returns `true` if found.
    pub fn add_group(&mut self, id: &str, group: &str) -> bool {
        let Some(e) = self.find_mut(id) else {
            return false;
        };
        if !e.groups.iter().any(|g| g == group) {
            e.groups.push(group.to_string());
            self.write_meta(id);
        }
        true
    }

    /// Remove a single group from an entry. Returns `true` if found.
    pub fn remove_group(&mut self, id: &str, group: &str) -> bool {
        let Some(e) = self.find_mut(id) else {
            return false;
        };
        let before = e.groups.len();
        e.groups.retain(|g| g != group);
        if e.groups.len() != before {
            self.write_meta(id);
        }
        true
    }

    /// Remove a group name from all entries that have it.
    pub fn purge_group(&mut self, group: &str) {
        let mut changed = Vec::new();
        for e in &mut self.entries {
            let before = e.groups.len();
            e.groups.retain(|g| g != group);
            if e.groups.len() != before {
                changed.push(e.id.clone());
            }
        }
        self.write_metas(&changed);
    }

    /// Rename a group across all entries that have it.
    pub fn rename_group(&mut self, old_name: &str, new_name: &str) {
        let mut changed = Vec::new();
        for e in &mut self.entries {
            let mut hit = false;
            for g in &mut e.groups {
                if g == old_name {
                    *g = new_name.to_string();
                    hit = true;
                }
            }
            if hit {
                changed.push(e.id.clone());
            }
        }
        self.write_metas(&changed);
    }

    /// [`Self::write_meta`] for several entries, in one transaction.
    fn write_metas(&mut self, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        let Some(db) = self.db.clone() else {
            return;
        };
        let rows: Vec<(String, bool, String)> = self
            .entries
            .iter()
            .filter(|e| ids.contains(&e.id))
            .map(|e| {
                (
                    e.id.clone(),
                    e.pinned,
                    serde_json::to_string(&e.groups).unwrap_or_else(|_| "[]".into()),
                )
            })
            .collect();
        let landed = db
            .write("write entry metadata", |tx| {
                let mut st = tx.prepare("UPDATE entries SET pinned = ?1, groups = ?2 WHERE id = ?3")?;
                for (id, pinned, groups) in &rows {
                    st.execute(params![pinned, groups, id])?;
                }
                Ok(())
            })
            .is_some();
        if landed {
            self.reap_gone_files();
        }
    }

    /// Fold in a copy an older build set aside beside `history.bin`, for the
    /// import. By id, adding only what is missing: the main file wins any
    /// overlap. `None` means the bytes did not parse.
    pub fn merge_leftover(&mut self, bytes: &[u8]) -> Option<usize> {
        let Ok(entries) = rmp_serde::from_slice::<Vec<ClipboardEntry>>(bytes) else {
            // Adopting garbage would be its own data loss.
            return None;
        };
        advance_id_past(&entries);
        let mut added = 0;
        for entry in entries.into_iter().rev() {
            if self.find(&entry.id).is_none() {
                self.entries.insert(0, entry);
                added += 1;
            }
        }
        if added > 0 {
            self.externalize_images();
        }
        Some(added)
    }

    /// Read the files the pre-SQLite build wrote, once, for the import.
    ///
    /// `legacy_saved` is pinned_entries.bin, which only an install from before
    /// that file was folded into history.bin still has; `legacy_keep` is what
    /// that build did with history.bin. With Keep history off it never read
    /// history.bin, so that copy is stale and is left alone, unless a
    /// `.pre-upgrade` or `.folded` marker says a later build already folded
    /// the two. The saved copy wins an overlap by id.
    pub fn load_legacy(&mut self, history: &Path, legacy_saved: &Path, legacy_keep: bool) {
        let legacy = legacy_saved.exists();
        let pre_upgrade = history.with_extension("bin.pre-upgrade");
        let folded = legacy_saved.with_extension("bin.folded");
        let stale = legacy && !legacy_keep && !pre_upgrade.exists() && !folded.exists();
        let mut entries: Vec<ClipboardEntry> = if stale {
            Vec::new()
        } else {
            crate::storage::import::read_legacy(history)
        };
        if legacy && !folded.exists() {
            let saved: Vec<ClipboardEntry> = crate::storage::import::read_legacy(legacy_saved);
            let ids: HashSet<&str> = saved.iter().map(|e| e.id.as_str()).collect();
            entries.retain(|e| !ids.contains(e.id.as_str()));
            entries.splice(0..0, saved);
        }
        advance_id_past(&entries);
        self.entries = entries;
        self.externalize_images();
    }

    /// Migrate any in-memory data-URL images to on-disk files.
    /// Called after loading entries from a previous session so that old
    /// inline images are externalised to the images directory.
    fn externalize_images(&mut self) {
        let Some(ref dir) = self.images_dir else {
            return;
        };
        let mut changed = Vec::new();
        for entry in &mut self.entries {
            if entry.kind == EntryKind::Image && entry.content.starts_with("data:") {
                if let Some(path) = save_image_to_disk(entry, dir) {
                    entry.content = path;
                    changed.push(entry.id.clone());
                }
            }
        }
        if !changed.is_empty() {
            self.write_rows(&changed);
        }
    }
}

/// The paths on disk an entry points at: an image's file, a file entry's
/// files and folders.
fn entry_paths(e: &ClipboardEntry) -> Vec<PathBuf> {
    match e.kind {
        EntryKind::Image if !e.content.starts_with("data:") => vec![PathBuf::from(&e.content)],
        EntryKind::File => e
            .content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(PathBuf::from)
            .collect(),
        EntryKind::Image | EntryKind::Text | EntryKind::Html => Vec::new(),
    }
}

/// Whether `file` (a file, or a folder and everything under it) is one of
/// `refs` or holds one. Case-insensitive on Windows, where the file system is.
pub(crate) fn path_in_use(file: &Path, refs: &[PathBuf]) -> bool {
    let fold = |p: &Path| -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(p.to_string_lossy().to_lowercase())
        } else {
            p.to_path_buf()
        }
    };
    let file = fold(file);
    refs.iter().map(|r| fold(r)).any(|r| r.starts_with(&file))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `html_parts` used to skip a hardcoded 18 bytes past a 17-byte marker, so
    /// re-copying an Html entry panicked out of `write_entry_to_clipboard`:
    /// out of bounds when the plain-text fallback was empty (apps that offer
    /// CF_HTML without CF_UNICODETEXT), off a char boundary when it started with
    /// a multi-byte character, and silently eating the first byte otherwise.
    #[test]
    fn html_parts_round_trips_every_plain_text_fallback() {
        for plain in [
            "hello",  // ASCII: used to lose the 'h'
            "",       // empty: used to slice out of bounds
            "— dash", // leading multi-byte: used to hit a char boundary
            "日本語",
            "🎉 emoji",
            "has\n---PLAINTEXT---\nthe marker inside it",
        ] {
            let entry = ClipboardEntry::new_html("<b>hi</b>".into(), plain.to_string());
            let (html, recovered) = entry.html_parts();
            assert_eq!(html, "<b>hi</b>", "html half changed for {plain:?}");
            assert_eq!(recovered, plain, "plain half changed for {plain:?}");
        }
    }

    /// Scratch directory unique to one test run.
    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rovertools-hist-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn text_with_id(id: &str) -> ClipboardEntry {
        let mut e = ClipboardEntry::new_text(format!("text {id}"));
        e.id = id.to_string();
        e
    }

    fn pinned(id: &str) -> ClipboardEntry {
        let mut e = text_with_id(id);
        e.pinned = true;
        e
    }

    fn ids(hist: &ClipboardHistory) -> Vec<String> {
        hist.all().iter().map(|e| e.id.clone()).collect()
    }

    /// Write `entries` as a history file, the way an older build did.
    fn write_file(path: &Path, entries: &[ClipboardEntry]) {
        fs::write(path, rmp_serde::to_vec(entries).unwrap()).unwrap();
    }

    /// A fresh history holding what the database reads back as.
    fn reload(db: &Arc<Db>) -> ClipboardHistory {
        let mut hist = with_db(db);
        hist.load_from_db();
        hist
    }

    /// Make every later write on `db` fail, the way a full or refusing disk
    /// would. Returns a guard: the failures land in the process-wide write
    /// notice, which is cleared again when the guard drops.
    fn break_writes(db: &Db) -> impl Drop {
        struct Clear {
            _one_at_a_time: parking_lot::MutexGuard<'static, ()>,
        }
        impl Drop for Clear {
            fn drop(&mut self) {
                crate::health::note_store_write_ok();
            }
        }
        let hold = Clear { _one_at_a_time: crate::health::WRITE_NOTICE_TEST_LOCK.lock() };
        db.read("break", |c| c.execute_batch("DROP TABLE entries"));
        hold
    }

    /// History was capped at 100 unsaved entries, so older captures fell off the
    /// end without the user doing anything.
    #[test]
    fn history_has_no_entry_cap() {
        let mut hist = ClipboardHistory::new();
        for i in 0..150 {
            hist.push(ClipboardEntry::new_text(format!("entry {i}")));
        }
        assert_eq!(hist.all().len(), 150);
    }

    /// Clear all tombstones exactly what it drops, so the list must come from
    /// the same pass that drops them.
    #[test]
    fn clear_returns_what_it_dropped_and_keeps_saved() {
        let mut hist = ClipboardHistory::new();
        let mut saved = text_with_id("saved");
        saved.groups.push("Saved".into());
        let plain = text_with_id("plain");
        let plain_ts = plain.timestamp;
        hist.entries = vec![pinned("pin"), plain, saved];

        let dropped = hist.clear();

        assert_eq!(dropped, vec![("plain".to_string(), plain_ts)]);
        assert_eq!(ids(&hist), ["pin", "saved"]);
    }

    /// A removed entry's file goes with it, and only its file: the directory is
    /// never swept, so a file no entry ever named stays.
    #[test]
    fn a_remove_deletes_files_only_for_removed_entries() {
        let db = Db::open_in_memory();
        let dir = scratch();
        let recv = dir.join("received-files");
        let images = dir.join("images");
        for sub in ["live-id", "gone-id", "stray-id"] {
            fs::create_dir_all(recv.join(sub)).unwrap();
            fs::write(recv.join(sub).join("f.txt"), b"x").unwrap();
        }
        fs::create_dir_all(&images).unwrap();
        let image_file = images.join("img-id.png");
        fs::write(&image_file, b"png").unwrap();

        let mut hist = with_db(&db);
        hist.set_received_files_dir(recv.clone());
        hist.set_images_dir(images.clone());
        for id in ["live-id", "gone-id"] {
            let mut e = ClipboardEntry::new_file(format!("{}/f.txt", recv.join(id).display()));
            e.id = id.to_string();
            hist.push(e);
        }
        let mut img = ClipboardEntry::new_image(image_file.to_string_lossy().to_string());
        img.id = "img-id".to_string();
        hist.push(img);

        assert!(hist.remove("gone-id"));
        assert!(hist.remove("img-id"));

        assert!(!recv.join("gone-id").exists(), "removed entry's dir kept");
        assert!(!image_file.exists(), "removed image's file kept");
        assert!(recv.join("live-id").exists(), "live entry's dir removed");
        assert!(recv.join("stray-id").exists(), "unnamed dir swept");
        assert_eq!(ids(&reload(&db)), ["live-id"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A write that fails leaves the row naming the entry, so its file must
    /// stay until a write that drops the row has landed.
    #[test]
    fn a_failed_write_keeps_the_file_delete_pending() {
        let db = Db::open_in_memory();
        let dir = scratch();
        let recv = dir.join("received-files");
        fs::create_dir_all(recv.join("x")).unwrap();
        let mut hist = with_db(&db);
        hist.set_received_files_dir(recv.clone());
        let mut e = ClipboardEntry::new_file("f.txt".into());
        e.id = "x".to_string();
        hist.push(e);

        let _broken = break_writes(&db);
        assert!(hist.remove("x"));
        assert!(recv.join("x").exists(), "file deleted before a write landed");
        let _ = fs::remove_dir_all(&dir);
    }

    /// With Keep history off, the exit prune drops entries nothing keeps, and
    /// nothing else would ever delete their files. They go with that write,
    /// and only theirs.
    #[test]
    fn the_exit_prune_deletes_the_files_of_entries_it_drops() {
        let db = Db::open_in_memory();
        let dir = scratch();
        let (images, recv) = (dir.join("images"), dir.join("received-files"));
        fs::create_dir_all(&images).unwrap();
        let image = |id: &str| {
            let file = images.join(format!("{id}.png"));
            fs::write(&file, b"png").unwrap();
            let mut e = ClipboardEntry::new_image(file.to_string_lossy().to_string());
            e.id = id.to_string();
            e
        };
        let file = |id: &str| {
            fs::create_dir_all(recv.join(id)).unwrap();
            let mut e = ClipboardEntry::new_file(format!("{}/f.txt", recv.join(id).display()));
            e.id = id.to_string();
            e
        };
        let mut pinned_image = image("pinned");
        pinned_image.pinned = true;
        let mut saved_file = file("saved");
        saved_file.groups.push("Saved".into());
        let mut hist = with_db(&db);
        hist.set_images_dir(images.clone());
        hist.set_received_files_dir(recv.clone());
        for e in [image("local-img"), file("local-file"), image("cloud"), pinned_image, saved_file] {
            hist.push(e);
        }

        hist.drop_unkept(|id| id == "cloud", &[]);

        assert!(!images.join("local-img.png").exists(), "dropped image kept");
        assert!(!recv.join("local-file").exists(), "dropped entry's folder kept");
        for kept in [images.join("cloud.png"), images.join("pinned.png"), recv.join("saved")] {
            assert!(kept.exists(), "kept entry lost {}", kept.display());
        }
        let mut left = ids(&reload(&db));
        left.sort();
        assert_eq!(left, ["cloud", "pinned", "saved"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A dropped entry whose file the system clipboard still names keeps the
    /// file: the user copied it and may paste it after the app has gone.
    #[test]
    fn an_entry_whose_file_is_on_the_clipboard_is_kept() {
        let db = Db::open_in_memory();
        let dir = scratch();
        let (images, recv) = (dir.join("images"), dir.join("received-files"));
        fs::create_dir_all(&images).unwrap();
        fs::create_dir_all(recv.join("got")).unwrap();
        fs::write(recv.join("got").join("a.txt"), b"a").unwrap();
        let png = images.join("img.png");
        fs::write(&png, b"png").unwrap();
        let mut hist = with_db(&db);
        hist.set_images_dir(images.clone());
        hist.set_received_files_dir(recv.clone());
        let mut file = ClipboardEntry::new_file(recv.join("got").join("a.txt").display().to_string());
        file.id = "got".to_string();
        let mut image = ClipboardEntry::new_image(png.to_string_lossy().to_string());
        image.id = "img".to_string();
        hist.push(file);
        hist.push(image);

        let on_clipboard = vec![recv.join("got").join("a.txt")];
        hist.drop_unkept(|_| false, &on_clipboard);

        assert!(recv.join("got").join("a.txt").exists(), "a file on the clipboard was deleted");
        assert!(hist.find("got").is_some(), "the entry naming it was dropped");
        assert!(!png.exists() && hist.find("img").is_none(), "an unreferenced entry was kept");
        assert_eq!(ids(&reload(&db)), ["got"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_in_use_matches_the_folder_and_what_is_under_it() {
        let root = PathBuf::from("root").join("id");
        assert!(path_in_use(&root, &[root.join("a.txt")]));
        assert!(path_in_use(&root, std::slice::from_ref(&root)));
        assert!(!path_in_use(&root, &[PathBuf::from("root").join("id2")]));
        assert!(!path_in_use(&root, &[]));
    }

    /// A failed exit prune leaves the rows as they were, still naming the
    /// dropped entries, so their files stay.
    #[test]
    fn a_failed_exit_prune_deletes_nothing() {
        let db = Db::open_in_memory();
        let dir = scratch();
        let recv = dir.join("received-files");
        fs::create_dir_all(recv.join("x")).unwrap();
        let mut hist = with_db(&db);
        hist.set_received_files_dir(recv.clone());
        let mut e = ClipboardEntry::new_file("f.txt".into());
        e.id = "x".to_string();
        hist.push(e);

        let _broken = break_writes(&db);
        hist.drop_unkept(|_| false, &[]);

        assert!(recv.join("x").exists(), "file deleted before a write landed");
        let _ = fs::remove_dir_all(&dir);
    }

    /// An older build with Keep history on wrote both files. The saved copy
    /// wins an overlap.
    #[test]
    fn legacy_keep_on_folds_both_files() {
        let dir = scratch();
        let (hf, pf) = (dir.join("history.bin"), dir.join("pinned_entries.bin"));
        write_file(&hf, &[text_with_id("x"), text_with_id("p")]);
        write_file(&pf, &[pinned("p")]);

        let mut hist = ClipboardHistory::new();
        hist.load_legacy(&hf, &pf, true);

        assert_eq!(ids(&hist), ["p", "x"]);
        assert!(hist.find("p").unwrap().pinned, "saved copy did not win");
        let _ = fs::remove_dir_all(&dir);
    }

    /// With Keep history off an older build never read history.bin, so what is
    /// in it must not come back.
    #[test]
    fn legacy_keep_off_ignores_a_stale_history_bin() {
        let dir = scratch();
        let (hf, pf) = (dir.join("history.bin"), dir.join("pinned_entries.bin"));
        write_file(&hf, &[text_with_id("x")]);
        write_file(&pf, &[pinned("p")]);

        let mut hist = ClipboardHistory::new();
        hist.load_legacy(&hf, &pf, false);

        assert_eq!(ids(&hist), ["p"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A build between the two already folded pinned_entries.bin into
    /// history.bin and left a marker, so history.bin is the one to read,
    /// whatever the Keep setting, and the legacy file is not laid back over it.
    #[test]
    fn a_folded_marker_means_history_bin_already_holds_the_legacy_copy() {
        let dir = scratch();
        let (hf, pf) = (dir.join("history.bin"), dir.join("pinned_entries.bin"));
        write_file(&hf, &[text_with_id("new")]);
        write_file(&pf, &[pinned("p")]);
        fs::write(pf.with_extension("bin.folded"), b"").unwrap();

        let mut hist = ClipboardHistory::new();
        hist.load_legacy(&hf, &pf, false);

        assert_eq!(ids(&hist), ["new"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Without a legacy file, history.bin is the only file, whatever the Keep
    /// setting. A history.bin that will not parse falls back to its `.bak`.
    #[test]
    fn a_history_bin_that_will_not_parse_falls_back_to_its_backup() {
        let dir = scratch();
        let (hf, pf) = (dir.join("history.bin"), dir.join("pinned_entries.bin"));
        write_file(&hf, &[text_with_id("x"), pinned("p")]);
        let mut hist = ClipboardHistory::new();
        hist.load_legacy(&hf, &pf, false);
        assert_eq!(ids(&hist), ["x", "p"]);

        fs::write(&hf, b"not msgpack").unwrap();
        write_file(&dir.join("history.bin.bak"), &[text_with_id("backup")]);
        let mut hist = ClipboardHistory::new();
        hist.load_legacy(&hf, &pf, true);
        assert_eq!(ids(&hist), ["backup"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// One 500 MB copy took the app to several GB and crashed the UI: nothing
    /// capped how large a single entry could be, and every entry is duplicated
    /// several times over between the store, each webview, MessagePack and
    /// ciphertext. A history file written before the cap has to be pruned on
    /// load, or the fault comes back on every launch.
    #[test]
    fn oversized_entries_are_dropped_on_load() {
        let mut hist = ClipboardHistory::new();
        let big = "a".repeat(MAX_TEXT_BYTES + 1);
        hist.entries.push(ClipboardEntry::new_text("keep me".into()));
        hist.entries.push(ClipboardEntry::new_text(big.clone()));
        hist.entries.push(ClipboardEntry::new_html(big, "plain".into()));
        // Image content is a path to a file on disk, however large the picture.
        hist.entries
            .push(ClipboardEntry::new_image("C:/images/shot.png".into()));

        let dropped = hist.drop_oversized();

        assert_eq!(dropped.len(), 2, "both oversized entries should go");
        assert!(dropped.iter().all(|n| *n > MAX_TEXT_BYTES));
        assert_eq!(hist.all().len(), 2);
        assert_eq!(hist.all()[0].content, "keep me");
        assert_eq!(hist.all()[1].kind, EntryKind::Image);
    }

    /// A device still on a build without the capture cap can push an entry of
    /// any size, so the merge has to refuse what capture would have.
    #[test]
    fn merge_refuses_an_oversized_entry() {
        let mut hist = ClipboardHistory::new();
        let over = ClipboardEntry::new_text("a".repeat(MAX_TEXT_BYTES + 1));
        let under = ClipboardEntry::new_text("a".repeat(MAX_TEXT_BYTES));

        assert!(!hist.upsert_synced(over), "oversized entry was accepted");
        assert!(hist.upsert_synced(under), "entry at the cap was refused");
        assert_eq!(hist.all().len(), 1);
    }

    /// The capture dedupe asks whether the newest entry already holds this
    /// content. It used to answer by cloning that entry - so every clipboard
    /// change copied the whole of the previous one just to compare and drop it.
    #[test]
    fn top_matches_without_copying() {
        let mut hist = ClipboardHistory::new();
        assert!(!hist.top_matches(&ClipboardEntry::new_text("hello".into())));

        hist.push(ClipboardEntry::new_text("hello".into()));
        assert!(hist.top_matches(&ClipboardEntry::new_text("hello".into())));
        assert!(!hist.top_matches(&ClipboardEntry::new_text("goodbye".into())));
        // Same bytes, different kind, is not the same content.
        assert!(!hist.top_matches(&ClipboardEntry::new_file("hello".into())));
    }

    /// Content with no marker at all — entries written before the Html kind
    /// existed, and every other entry kind — reads back as pure HTML.
    #[test]
    fn html_parts_without_a_marker_is_all_html() {
        let entry = ClipboardEntry::new(EntryKind::Html, "<i>legacy</i>".into());
        assert_eq!(entry.html_parts(), ("<i>legacy</i>", ""));
    }

    // ── Database-backed behaviour ───────────────────────────────────

    fn with_db(db: &Arc<Db>) -> ClipboardHistory {
        let mut hist = ClipboardHistory::new();
        hist.attach_db(Arc::clone(db));
        hist
    }

    /// Every mutation writes through: a fresh store on the same database reads
    /// back exactly what the first one holds.
    #[test]
    fn mutations_write_through_to_the_database() {
        let db = Db::open_in_memory();
        let mut hist = with_db(&db);
        hist.push(text_with_id("a"));
        hist.push(text_with_id("b"));
        hist.push(text_with_id("c"));
        assert!(hist.pin("b"));
        assert!(hist.set_groups("a", vec!["Saved".into(), "Work".into()]));
        assert!(hist.remove("c"));
        hist.rename_group("Work", "Office");

        let mut again = with_db(&db);
        assert!(again.load_from_db());
        assert_eq!(ids(&again), ids(&hist));
        assert!(again.find("b").unwrap().pinned);
        assert_eq!(again.find("a").unwrap().groups, vec!["Saved", "Office"]);
        assert!(again.find("c").is_none());
    }

    /// Clear all drops the unsaved rows and keeps the saved ones, in the table
    /// as in memory.
    /// With a cipher set, the row on disk is sealed and the entry says so; the
    /// same key opens it, no key skips it and leaves it, and clearing the
    /// cipher rewrites it in plain text.
    #[test]
    fn a_cipher_seals_rows_and_the_flag_follows_the_write() {
        let db = Db::open_in_memory();
        let cipher = Arc::new(Cipher::generate());
        let mut hist = with_db(&db);
        hist.set_cipher(Some(Arc::clone(&cipher)));
        let pushed = hist.push(text_with_id("a"));
        assert!(pushed.encrypted);
        let raw: (String, bool) = db
            .read("raw", |c| c.query_row("SELECT content, enc FROM entries WHERE id = 'a'", [], |r| Ok((r.get(0)?, r.get(1)?))))
            .unwrap();
        assert!(raw.1 && raw.0 != "text a");

        let mut same_key = with_db(&db);
        same_key.set_cipher(Some(Arc::clone(&cipher)));
        same_key.load_from_db();
        assert_eq!(same_key.find("a").map(|e| e.content.as_str()), Some("text a"));
        assert!(same_key.find("a").unwrap().encrypted);

        let mut no_key = with_db(&db);
        no_key.load_from_db();
        assert!(no_key.all().is_empty());
        let still: i64 = db.read("count", |c| c.query_row("SELECT count(*) FROM entries", [], |r| r.get(0))).unwrap();
        assert_eq!(still, 1);

        hist.set_cipher(None);
        assert!(hist.persist_all());
        assert!(!hist.find("a").unwrap().encrypted);
        let raw: (String, bool) = db
            .read("raw", |c| c.query_row("SELECT content, enc FROM entries WHERE id = 'a'", [], |r| Ok((r.get(0)?, r.get(1)?))))
            .unwrap();
        assert_eq!(raw, ("text a".to_string(), false));
    }

    #[test]
    fn clear_drops_rows_and_keeps_saved_ones() {
        let db = Db::open_in_memory();
        let mut hist = with_db(&db);
        hist.push(text_with_id("plain"));
        hist.push(pinned("kept"));
        assert_eq!(hist.clear().len(), 1);
        let mut again = with_db(&db);
        again.load_from_db();
        assert_eq!(ids(&again), vec!["kept"]);
    }

    /// An image's file goes only once the write dropping its row has landed,
    /// and never for an id that came back meanwhile.
    #[test]
    fn a_removed_image_loses_its_file_after_the_delete_commits() {
        let db = Db::open_in_memory();
        let dir = scratch();
        let mut hist = with_db(&db);
        hist.set_images_dir(dir.clone());
        let mut img = ClipboardEntry::new_image("data:image/png;base64,aGk=".into());
        img.id = "img".into();
        let img = hist.push(img);
        let file = PathBuf::from(&img.content);
        assert!(file.exists());
        assert!(hist.remove("img"));
        assert!(!file.exists(), "file deleted once the row delete committed");
    }

    /// First launch of this build: the file-based history is read through the
    /// old loader, written to the table, and the file retired.
    #[test]
    fn legacy_history_is_imported_once() {
        let db = Db::open_in_memory();
        let dir = scratch();
        let file = dir.join("history.bin");
        write_file(&file, &[text_with_id("old-1"), pinned("old-2")]);

        let mut hist = ClipboardHistory::new();
        assert!(crate::storage::import::history(&dir, &mut hist, &db, true));
        assert!(!file.exists());
        assert!(dir.join("history.bin.migrated").exists());

        let mut again = with_db(&db);
        again.load_from_db();
        assert_eq!(ids(&again), vec!["old-1", "old-2"]);

        // Nothing left to import: the caller loads from the table instead.
        let mut third = ClipboardHistory::new();
        assert!(!crate::storage::import::history(&dir, &mut third, &db, true));
    }

    /// What an older build's degraded or sealed session set aside beside the
    /// file is folded in, and every sibling is retired with the file.
    #[test]
    fn the_import_folds_the_old_quarantines_and_retires_every_sibling() {
        let db = Db::open_in_memory();
        let dir = scratch();
        let file = dir.join("history.bin");
        write_file(&file, &[text_with_id("main")]);
        write_file(&dir.join("history.bin.sealed.quarantine"), &[text_with_id("sealed")]);
        write_file(&dir.join("history.bin.bak"), &[text_with_id("bak")]);
        // Older than the file: a snapshot a later session superseded.
        write_file(&dir.join("history.bin.quarantine"), &[text_with_id("stale")]);
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        fs::OpenOptions::new()
            .write(true)
            .open(dir.join("history.bin.quarantine"))
            .unwrap()
            .set_modified(old)
            .unwrap();

        let mut hist = ClipboardHistory::new();
        assert!(crate::storage::import::history(&dir, &mut hist, &db, true));

        assert_eq!(ids(&reload(&db)), ["sealed", "main"]);
        for name in ["history.bin", "history.bin.sealed.quarantine", "history.bin.bak", "history.bin.quarantine"] {
            assert!(!dir.join(name).exists(), "{name} left in place");
            assert!(dir.join(format!("{name}.migrated")).exists(), "{name} not retired");
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
