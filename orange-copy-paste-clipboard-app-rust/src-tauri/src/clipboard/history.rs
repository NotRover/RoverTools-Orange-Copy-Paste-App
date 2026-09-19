//! Clipboard history store.
//!
//! Holds an in-memory ring-buffer of the last [`MAX_HISTORY`] clipboard
//! entries (text or images encoded as PNG data-URLs).  The store is wrapped
//! in a [`parking_lot::Mutex`] so it can be shared across Tauri commands and
//! global-shortcut handlers.

use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};

// Constants

/// Maximum number of entries kept in history.
pub const MAX_HISTORY: usize = 100;

/// Largest text-shaped payload (text, rich text, file list) kept in history.
///
/// History caps how *many* entries it holds and, until this existed, not how
/// large one could be - and every entry is duplicated several times over on its
/// way to the user: into the store, into each webview that shows it, into
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

/// Serialize entries to MessagePack binary and write to `path`.
///
/// History and saved entries are the user's own data, rewritten wholesale on
/// every flush, so they take the strictest path: atomic, flushed, and refused
/// outright once the process is degraded.
fn save_entries_binary(
    entries: &[ClipboardEntry],
    path: &std::path::Path,
) -> Result<(), std::io::Error> {
    let msgpack = rmp_serde::to_vec(entries).map_err(std::io::Error::other)?;
    crate::health::write_state(path, &msgpack)
}

/// Load entries from a MessagePack binary file.
/// Load entries through the shared read contract: a missing file is an empty
/// history, a good load refreshes the `.bak` copy, and a file that will not
/// load is sealed against writes with the backup shown instead. An `Err` here
/// means the file failed *and* no backup could stand in.
fn load_entries_binary(path: &std::path::Path) -> Result<Vec<ClipboardEntry>, std::io::Error> {
    let parsed = crate::health::load_state(path, &|bytes| {
        rmp_serde::from_slice(bytes).map_err(|e| e.to_string())
    })?;
    Ok(parsed.unwrap_or_default())
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
    /// Fast content fingerprint for image deduplication.  Computed from the
    /// original data-URL at creation time so it survives externalisation to
    /// a file path.  Not persisted — only relevant within a single session.
    #[serde(skip)]
    pub content_hash: Option<u64>,
    // ── Transient sync fields — excluded from MessagePack serialization ──
    // These are populated at runtime by the SyncClient from id_map.json.
    // They drive the cloud-sync icon shown on entry cards in the UI.
    /// Server-assigned UUID for this entry after a successful push.
    #[serde(skip)]
    pub server_id: Option<String>,
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
            content_hash,
            server_id: None,
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
/// Entries are prepended (most-recent first) and the list is capped at
/// [`MAX_HISTORY`] entries.
#[derive(Debug, Default)]
pub struct ClipboardHistory {
    entries: Vec<ClipboardEntry>,
    /// Directory where externalised image files are stored.
    /// Configured once at startup via [`Self::set_images_dir`].
    images_dir: Option<std::path::PathBuf>,
    /// Directory where a synced file entry's blob is extracted, one subdir per
    /// entry (`received-files/{id}/`). Configured once at startup via
    /// [`Self::set_received_files_dir`]; swept for orphans on a full save.
    received_files_dir: Option<std::path::PathBuf>,
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
    /// entry id), so a full save can prune subdirs left by deleted entries.
    pub fn set_received_files_dir(&mut self, dir: std::path::PathBuf) {
        self.received_files_dir = Some(dir);
    }

    /// Prepend an entry and trim to [`MAX_HISTORY`] (excluding saved entries).
    /// Returns a clone of the newly inserted entry.
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
        self.entries.insert(0, entry.clone());
        // Keep saved entries + up to MAX_HISTORY non-saved entries
        if self.entries.len() > MAX_HISTORY {
            let mut normal_count = 0;
            self.entries.retain(|e| {
                if e.is_saved() {
                    true
                } else if normal_count < MAX_HISTORY {
                    normal_count += 1;
                    true
                } else {
                    false
                }
            });
        }
        entry
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
    /// externalisation and the MAX_HISTORY trim.  Call [`Self::sort_recent`]
    /// once after a merge batch to restore ordering.
    ///
    /// `false` when the entry was refused for its size. A device on a build
    /// without the capture cap can push an entry of any size, and taking it
    /// would put this device back in exactly the state the cap exists to
    /// prevent. Image content is a path to a file on disk, so it is exempt.
    pub fn upsert_synced(&mut self, entry: ClipboardEntry) -> bool {
        if !fits(&entry) {
            eprintln!(
                "[history] merge: {} is {} bytes, past the {} byte cap (skipped)",
                entry.id,
                entry.content.len(),
                MAX_TEXT_BYTES
            );
            return false;
        }
        if let Some(pos) = self.entries.iter().position(|e| e.id == entry.id) {
            self.entries[pos] = entry;
        } else {
            self.entries.push(entry);
        }
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
        self.entries.retain(|e| {
            if fits(e) {
                return true;
            }
            dropped.push(e.content.len());
            false
        });
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
            self.entries.remove(pos);
            true
        } else {
            false
        }
    }

    /// Clear all non-saved entries. Pinned and saved entries are retained.
    pub fn clear(&mut self) {
        self.entries.retain(|e| e.is_saved());
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
        self.find_mut(id)
            .map(|e| {
                e.pinned = true;
            })
            .is_some()
    }

    pub fn unpin(&mut self, id: &str) -> bool {
        self.find_mut(id).map(|e| e.pinned = false).is_some()
    }

    /// Get all pinned entries (for paste popup).
    pub fn pinned_entries(&self) -> Vec<ClipboardEntry> {
        self.entries.iter().filter(|e| e.pinned).cloned().collect()
    }

    /// Get all saved entries (pinned or saved — survive restarts).
    pub fn saved_entries(&self) -> Vec<ClipboardEntry> {
        self.entries
            .iter()
            .filter(|e| e.is_saved())
            .cloned()
            .collect()
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

    /// Rename a group across all entries that have it.
    pub fn rename_group(&mut self, old_name: &str, new_name: &str) {
        for e in &mut self.entries {
            for g in &mut e.groups {
                if g == old_name {
                    *g = new_name.to_string();
                }
            }
        }
    }

    /// Load saved entries from a file and merge them into history.
    /// Any existing entries with matching IDs are replaced.
    /// Advances the global ID counter past the highest loaded ID.
    pub fn load_saved_from_file(&mut self, path: &std::path::Path) -> Result<(), std::io::Error> {
        let loaded = load_entries_binary(path)?;
        if loaded.is_empty() {
            return Ok(());
        }

        advance_id_past(&loaded);

        let loaded_ids: std::collections::HashSet<_> = loaded.iter().map(|e| &e.id).collect();
        self.entries.retain(|e| !loaded_ids.contains(&e.id));

        // Prepend all saved entries
        for entry in loaded.into_iter().rev() {
            self.entries.insert(0, entry);
        }

        self.externalize_images();
        Ok(())
    }

    /// Save all saved entries (pinned + saved-group) to a file.
    pub fn save_saved_to_file(&self, path: &std::path::Path) -> Result<(), std::io::Error> {
        save_entries_binary(&self.saved_entries(), path)
    }

    /// Save the entire history (all entries) to a file.
    pub fn save_all_to_file(&self, path: &std::path::Path) -> Result<(), std::io::Error> {
        save_entries_binary(&self.entries, path)?;

        // Remove image files that are no longer referenced by any entry.
        if let Some(ref dir) = self.images_dir {
            let referenced: std::collections::HashSet<String> = self
                .entries
                .iter()
                .filter(|e| e.kind == EntryKind::Image && !e.content.starts_with("data:"))
                .filter_map(|e| {
                    std::path::Path::new(&e.content)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                })
                .collect();
            if let Ok(read_dir) = std::fs::read_dir(dir) {
                for entry in read_dir.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !referenced.contains(&name) {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }

        // Remove extracted file-entry subdirs (named by entry id) that no live
        // file entry still points at — the local counterpart to the server's
        // blob release when a synced file entry is deleted.
        if let Some(ref dir) = self.received_files_dir {
            let referenced: std::collections::HashSet<String> = self
                .entries
                .iter()
                .filter(|e| e.kind == EntryKind::File)
                .map(|e| e.id.clone())
                .collect();
            if let Ok(read_dir) = std::fs::read_dir(dir) {
                for entry in read_dir.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !referenced.contains(&name) {
                        let _ = std::fs::remove_dir_all(entry.path());
                    }
                }
            }
        }

        Ok(())
    }

    /// Fold in entries a sealed session captured while it could not read this
    /// file. By id, adding only what is missing: the main file is the elder
    /// copy and wins any overlap, and running twice adds nothing the second
    /// time - which is what lets the leftover survive until a save that
    /// includes it has actually landed.
    /// `None` means the bytes did not parse - the file stays on disk for
    /// recovery by hand. `Some(0)` means everything in it was already here,
    /// which makes the leftover safely redundant.
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

    /// Load the full history from a file, replacing all current entries.
    /// Advances the global ID counter past the highest loaded ID.
    pub fn load_all_from_file(&mut self, path: &std::path::Path) -> Result<(), std::io::Error> {
        let loaded = load_entries_binary(path)?;
        advance_id_past(&loaded);
        self.entries = loaded;
        self.externalize_images();
        Ok(())
    }

    /// Migrate any in-memory data-URL images to on-disk files.
    /// Called after loading entries from a previous session so that old
    /// inline images are externalised to the images directory.
    fn externalize_images(&mut self) {
        let Some(ref dir) = self.images_dir else {
            return;
        };
        for entry in &mut self.entries {
            if entry.kind == EntryKind::Image && entry.content.starts_with("data:") {
                if let Some(path) = save_image_to_disk(entry, dir) {
                    entry.content = path;
                }
            }
        }
    }
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

    /// A deleted synced file entry must not leave its extracted files behind on
    /// disk: a full save prunes the `received-files/{id}/` subdir of any entry no
    /// longer in history, the local counterpart to the server releasing its blob.
    #[test]
    fn a_full_save_prunes_orphaned_received_file_dirs() {
        let base = std::env::temp_dir().join(format!("rovertools-rf-{}", uuid::Uuid::new_v4()));
        let recv = base.join("received-files");
        std::fs::create_dir_all(recv.join("live-id")).unwrap();
        std::fs::create_dir_all(recv.join("gone-id")).unwrap();
        std::fs::write(recv.join("live-id/f.txt"), b"x").unwrap();
        std::fs::write(recv.join("gone-id/f.txt"), b"y").unwrap();

        let mut hist = ClipboardHistory::new();
        hist.set_received_files_dir(recv.clone());
        // One live file entry whose id matches the "live-id" subdir; "gone-id"
        // has no entry, standing in for one the user deleted.
        let mut entry = ClipboardEntry::new(EntryKind::File, "C:/somewhere/f.txt".into());
        entry.id = "live-id".to_string();
        hist.entries.push(entry);

        hist.save_all_to_file(&base.join("history.bin")).unwrap();

        assert!(recv.join("live-id").exists(), "referenced dir kept");
        assert!(!recv.join("gone-id").exists(), "orphaned dir removed");

        let _ = std::fs::remove_dir_all(&base);
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
}
