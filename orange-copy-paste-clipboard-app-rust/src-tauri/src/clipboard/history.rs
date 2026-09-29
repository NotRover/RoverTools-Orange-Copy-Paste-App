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
use std::{fs, io};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};

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
    /// Files of entries removed since the last save, as (entry id, path). Deleted
    /// only once a save lands, so a refused write never leaves the file on disk
    /// naming an entry whose file is gone.
    gone_files: Vec<(String, PathBuf)>,
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
        self.entries.insert(0, entry.clone());
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
    /// externalisation.  Call [`Self::sort_recent`]
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
            let e = self.entries.remove(pos);
            self.note_gone(&e);
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
        dropped
            .into_iter()
            .map(|e| {
                self.note_gone(&e);
                (e.id, e.timestamp)
            })
            .collect()
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
    fn load_saved_from_file(&mut self, path: &std::path::Path) -> Result<(), std::io::Error> {
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

    /// Write the saved entries, plus every entry `also_keep` names, to `path`.
    ///
    /// The one writer of history.bin. It goes through `health::write_state`, so
    /// degraded and sealed files stay protected. Only once the write has landed
    /// are removed entries' files deleted, and never for an id that is live
    /// again (removed, then restored). A refused write returns before that, so
    /// the files wait for the next save that lands.
    pub fn save_to_file(
        &mut self,
        path: &Path,
        also_keep: impl Fn(&str) -> bool,
    ) -> io::Result<()> {
        let kept: Vec<&ClipboardEntry> = self
            .entries
            .iter()
            .filter(|e| e.is_saved() || also_keep(&e.id))
            .collect();
        crate::health::write_state(path, &rmp_serde::to_vec(&kept).map_err(io::Error::other)?)?;
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
    fn load_all_from_file(&mut self, path: &std::path::Path) -> Result<(), std::io::Error> {
        let loaded = load_entries_binary(path)?;
        advance_id_past(&loaded);
        self.entries = loaded;
        self.externalize_images();
        Ok(())
    }

    /// Load history at startup.
    ///
    /// `legacy_saved` is pinned_entries.bin, which only a not-yet-upgraded install
    /// has; `legacy_keep` is what that build did with history.bin. With Keep
    /// history off it never read history.bin, so that copy is stale: it is moved
    /// to `history.bin.pre-upgrade`, which nothing reads or writes, rather than
    /// loaded or written over. The legacy file goes once a history.bin holding
    /// both has landed.
    ///
    /// The upgrade runs once. A `.pre-upgrade` copy already there (empty when
    /// there was nothing to set aside) means the one in history.bin is this
    /// build's own, and a legacy file that would not read or would not go is
    /// renamed out of the way, so a later launch never treats this build's
    /// history.bin as stale. A legacy file that could not go at all leaves a
    /// `.folded` marker: history.bin already holds it, so later launches only
    /// retry the removal rather than lay its copies back over deletions.
    pub fn load_from_disk(&mut self, history: &Path, legacy_saved: &Path, legacy_keep: bool) {
        let legacy = legacy_saved.exists();
        let pre_upgrade = history.with_extension("bin.pre-upgrade");
        let folded = legacy_saved.with_extension("bin.folded");
        let stale = legacy && !legacy_keep && !pre_upgrade.exists() && !folded.exists();
        if !stale {
            let _ = self.load_all_from_file(history);
        }
        if !legacy {
            return;
        }
        if !folded.exists() {
            let _ = self.load_saved_from_file(legacy_saved); // saved copy wins by id
            if stale && !history.exists() {
                // Nothing to set aside, but an empty copy still marks the upgrade
                // done, so a re-run never takes the history.bin below for stale.
                let _ = fs::write(&pre_upgrade, b"");
            } else if stale && fs::rename(history, &pre_upgrade).is_err() {
                // The stale copy is still in the way, so this session must not
                // write over it. Its writes wait in the sealed leftover for the
                // next launch.
                crate::health::seal(history, "the copy from before the upgrade could not be set aside");
                return;
            }
            if self.save_to_file(history, |_| true).is_err() {
                return;
            }
        }
        let gone = (!crate::health::is_sealed(legacy_saved) && fs::remove_file(legacy_saved).is_ok())
            || fs::rename(legacy_saved, legacy_saved.with_extension("bin.retired")).is_ok();
        if gone {
            let _ = fs::remove_file(&folded);
        } else {
            let _ = fs::write(&folded, b"");
        }
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

    /// A fresh history holding what `path` reads back as.
    fn reload(path: &Path) -> ClipboardHistory {
        let mut hist = ClipboardHistory::new();
        hist.load_all_from_file(path).unwrap();
        hist
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

    /// Saved entries are always written, whatever Keep history says.
    #[test]
    fn saved_entries_are_always_written() {
        let dir = scratch();
        let path = dir.join("history.bin");
        let mut hist = ClipboardHistory::new();
        hist.entries = vec![text_with_id("plain"), pinned("pin")];

        hist.save_to_file(&path, |_| false).unwrap();

        assert_eq!(ids(&reload(&path)), ["pin"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// With Keep history off, entries in the cloud or a space are still kept.
    #[test]
    fn also_keep_names_extra_entries() {
        let dir = scratch();
        let path = dir.join("history.bin");
        let mut hist = ClipboardHistory::new();
        hist.entries = vec![text_with_id("cloud"), text_with_id("local"), pinned("pin")];

        hist.save_to_file(&path, |id| id == "cloud").unwrap();

        assert_eq!(ids(&reload(&path)), ["cloud", "pin"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A removed entry's file goes with it, and only its file: the directory is
    /// no longer swept, so a file no entry ever named stays.
    #[test]
    fn a_save_deletes_files_only_for_removed_entries() {
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

        let mut hist = ClipboardHistory::new();
        hist.set_received_files_dir(recv.clone());
        hist.set_images_dir(images.clone());
        for id in ["live-id", "gone-id"] {
            let mut e = ClipboardEntry::new_file(format!("{}/f.txt", recv.join(id).display()));
            e.id = id.to_string();
            hist.entries.push(e);
        }
        let mut img = ClipboardEntry::new_image(image_file.to_string_lossy().to_string());
        img.id = "img-id".to_string();
        hist.entries.push(img);

        assert!(hist.remove("gone-id"));
        assert!(hist.remove("img-id"));
        hist.save_to_file(&dir.join("history.bin"), |_| true).unwrap();

        assert!(!recv.join("gone-id").exists(), "removed entry's dir kept");
        assert!(!image_file.exists(), "removed image's file kept");
        assert!(recv.join("live-id").exists(), "live entry's dir removed");
        assert!(recv.join("stray-id").exists(), "unnamed dir swept");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A sync merge can bring an entry back between its removal and the save.
    #[test]
    fn a_removed_then_restored_entry_keeps_its_file() {
        let dir = scratch();
        let recv = dir.join("received-files");
        fs::create_dir_all(recv.join("x")).unwrap();
        let mut hist = ClipboardHistory::new();
        hist.set_received_files_dir(recv.clone());
        let mut e = ClipboardEntry::new_file("f.txt".into());
        e.id = "x".to_string();
        hist.entries.push(e.clone());

        assert!(hist.remove("x"));
        assert!(hist.upsert_synced(e));
        hist.save_to_file(&dir.join("history.bin"), |_| true).unwrap();

        assert!(recv.join("x").exists(), "restored entry lost its file");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A refused write leaves history.bin naming the entry, so its file must
    /// stay until a save that drops the entry has landed.
    #[test]
    fn a_refused_save_keeps_the_file_delete_pending() {
        let dir = scratch();
        let recv = dir.join("received-files");
        fs::create_dir_all(recv.join("x")).unwrap();
        let mut hist = ClipboardHistory::new();
        hist.set_received_files_dir(recv.clone());
        let mut e = ClipboardEntry::new_file("f.txt".into());
        e.id = "x".to_string();
        hist.entries.push(e);
        assert!(hist.remove("x"));

        // A sealed path is refused the way a degraded process is, without
        // counting as a failed disk write.
        let sealed = dir.join("sealed.bin");
        crate::health::seal(&sealed, "test");
        assert!(hist.save_to_file(&sealed, |_| true).is_err());
        assert!(recv.join("x").exists(), "file deleted before a save landed");

        hist.save_to_file(&dir.join("history.bin"), |_| true).unwrap();
        assert!(!recv.join("x").exists(), "pending delete was dropped");
        let _ = fs::remove_dir_all(&dir);
    }

    /// With Keep history off, the last save before the process ends leaves out
    /// entries nothing keeps, and nothing else would ever delete their files.
    /// They go with that save, and only theirs.
    #[test]
    fn the_last_save_deletes_the_files_of_entries_it_leaves_out() {
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
        let mut hist = ClipboardHistory::new();
        hist.set_images_dir(images.clone());
        hist.set_received_files_dir(recv.clone());
        hist.entries = vec![
            image("local-img"),
            file("local-file"),
            image("cloud"),
            pinned_image,
            saved_file,
        ];

        let keep = |id: &str| id == "cloud";
        hist.drop_unkept(keep, &[]);
        hist.save_to_file(&dir.join("history.bin"), keep).unwrap();

        assert!(!images.join("local-img.png").exists(), "dropped image kept");
        assert!(!recv.join("local-file").exists(), "dropped entry's folder kept");
        for kept in [images.join("cloud.png"), images.join("pinned.png"), recv.join("saved")] {
            assert!(kept.exists(), "kept entry lost {}", kept.display());
        }
        assert_eq!(ids(&reload(&dir.join("history.bin"))), ["cloud", "pinned", "saved"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A dropped entry whose file the system clipboard still names keeps the
    /// file: the user copied it and may paste it after the app has gone.
    #[test]
    fn an_entry_whose_file_is_on_the_clipboard_is_kept() {
        let dir = scratch();
        let (images, recv) = (dir.join("images"), dir.join("received-files"));
        fs::create_dir_all(&images).unwrap();
        fs::create_dir_all(recv.join("got")).unwrap();
        fs::write(recv.join("got").join("a.txt"), b"a").unwrap();
        let png = images.join("img.png");
        fs::write(&png, b"png").unwrap();
        let mut hist = ClipboardHistory::new();
        hist.set_images_dir(images.clone());
        hist.set_received_files_dir(recv.clone());
        let mut file = ClipboardEntry::new_file(recv.join("got").join("a.txt").display().to_string());
        file.id = "got".to_string();
        let mut image = ClipboardEntry::new_image(png.to_string_lossy().to_string());
        image.id = "img".to_string();
        hist.entries = vec![file, image];

        let on_clipboard = vec![recv.join("got").join("a.txt")];
        hist.drop_unkept(|_| false, &on_clipboard);
        hist.save_to_file(&dir.join("history.bin"), |_| true).unwrap();

        assert!(recv.join("got").join("a.txt").exists(), "a file on the clipboard was deleted");
        assert!(hist.find("got").is_some(), "the entry naming it was dropped");
        assert!(!png.exists() && hist.find("img").is_none(), "an unreferenced entry was kept");
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

    /// A refused last save leaves history.bin as it was, which may still name
    /// the dropped entries, so their files stay.
    #[test]
    fn a_refused_last_save_deletes_nothing() {
        let dir = scratch();
        let recv = dir.join("received-files");
        fs::create_dir_all(recv.join("x")).unwrap();
        let mut hist = ClipboardHistory::new();
        hist.set_received_files_dir(recv.clone());
        let mut e = ClipboardEntry::new_file("f.txt".into());
        e.id = "x".to_string();
        hist.entries.push(e);

        let sealed = dir.join("sealed.bin");
        crate::health::seal(&sealed, "test");
        hist.drop_unkept(|_| false, &[]);
        assert!(hist.save_to_file(&sealed, |_| false).is_err());

        assert!(recv.join("x").exists(), "file deleted before a save landed");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Deletes are written like everything else: a restart must not bring
    /// the entry back.
    #[test]
    fn a_deleted_entry_stays_deleted_after_restart() {
        let dir = scratch();
        let path = dir.join("history.bin");
        let mut hist = ClipboardHistory::new();
        hist.entries = vec![text_with_id("a"), text_with_id("b")];
        hist.save_to_file(&path, |_| true).unwrap();
        assert!(hist.remove("a"));
        hist.save_to_file(&path, |_| true).unwrap();

        let mut fresh = ClipboardHistory::new();
        fresh.load_from_disk(&path, &dir.join("pinned_entries.bin"), true);

        assert_eq!(ids(&fresh), ["b"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// An older build with Keep history on wrote both files. The saved copy
    /// wins an overlap, everything lands in history.bin, and the legacy file
    /// goes.
    #[test]
    fn upgrade_with_keep_on_folds_both_files_and_retires_pinned_entries_bin() {
        let dir = scratch();
        let (hf, pf) = (dir.join("history.bin"), dir.join("pinned_entries.bin"));
        write_file(&hf, &[text_with_id("x"), text_with_id("p")]);
        write_file(&pf, &[pinned("p")]);

        let mut hist = ClipboardHistory::new();
        hist.load_from_disk(&hf, &pf, true);

        assert_eq!(ids(&hist), ["p", "x"]);
        assert!(hist.find("p").unwrap().pinned, "saved copy did not win");
        assert!(!pf.exists(), "legacy file kept");
        assert_eq!(ids(&reload(&hf)), ["p", "x"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// With Keep history off an older build never read history.bin, so what is
    /// in it must not come back - and it is set aside intact, not written over.
    #[test]
    fn upgrade_with_keep_off_ignores_a_stale_history_bin() {
        let dir = scratch();
        let (hf, pf) = (dir.join("history.bin"), dir.join("pinned_entries.bin"));
        write_file(&hf, &[text_with_id("x")]);
        let stale = fs::read(&hf).unwrap();
        write_file(&pf, &[pinned("p")]);

        let mut hist = ClipboardHistory::new();
        hist.load_from_disk(&hf, &pf, false);

        assert_eq!(ids(&hist), ["p"]);
        assert!(!pf.exists(), "legacy file kept");
        assert_eq!(ids(&reload(&hf)), ["p"]);
        assert_eq!(
            fs::read(dir.join("history.bin.pre-upgrade")).unwrap(),
            stale,
            "stale history.bin was not set aside intact"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// A legacy file that will not read must not re-run the upgrade on every
    /// launch: the second launch would take this build's own history.bin for
    /// the stale one and set it aside over the real stale copy.
    #[test]
    fn an_unreadable_legacy_file_upgrades_once() {
        let dir = scratch();
        let (hf, pf) = (dir.join("history.bin"), dir.join("pinned_entries.bin"));
        write_file(&hf, &[text_with_id("x")]);
        let stale = fs::read(&hf).unwrap();
        fs::write(&pf, b"not msgpack").unwrap();

        let mut first = ClipboardHistory::new();
        first.load_from_disk(&hf, &pf, false);
        assert!(!pf.exists(), "unreadable legacy file left in place");
        assert!(pf.with_extension("bin.retired").exists(), "unreadable legacy file lost");

        // This session's own history reaches disk.
        first.entries = vec![text_with_id("new")];
        first.save_to_file(&hf, |_| true).unwrap();

        let mut second = ClipboardHistory::new();
        second.load_from_disk(&hf, &pf, false);
        assert_eq!(ids(&second), ["new"]);
        assert_eq!(fs::read(dir.join("history.bin.pre-upgrade")).unwrap(), stale);
        let _ = fs::remove_dir_all(&dir);
    }

    /// An upgrade with no history.bin, whose legacy file then would not go: it
    /// is folded once. Later launches read this build's history.bin rather
    /// than set it aside as stale, and only retry the removal, so a pinned
    /// entry deleted since does not come back from the legacy copy.
    #[cfg(windows)]
    #[test]
    fn a_legacy_file_that_will_not_go_is_folded_once() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = scratch();
        let (hf, pf) = (dir.join("history.bin"), dir.join("pinned_entries.bin"));
        write_file(&pf, &[pinned("p")]);
        // Held open without share-delete, so it can be neither removed nor renamed.
        let lock = fs::OpenOptions::new().read(true).share_mode(1).open(&pf).unwrap();

        let mut first = ClipboardHistory::new();
        first.load_from_disk(&hf, &pf, false);
        assert_eq!(ids(&first), ["p"]);
        assert!(pf.exists() && pf.with_extension("bin.folded").exists());
        // The user deletes p and copies something new.
        first.entries = vec![text_with_id("new")];
        first.save_to_file(&hf, |_| true).unwrap();

        let mut second = ClipboardHistory::new();
        second.load_from_disk(&hf, &pf, false);
        assert_eq!(ids(&second), ["new"]);
        assert!(fs::read(dir.join("history.bin.pre-upgrade")).unwrap().is_empty());

        drop(lock);
        let mut third = ClipboardHistory::new();
        third.load_from_disk(&hf, &pf, false);
        assert_eq!(ids(&third), ["new"]);
        assert!(!pf.exists(), "legacy file kept");
        assert!(!pf.with_extension("bin.folded").exists(), "marker left behind");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Once upgraded, history.bin is the only file, whatever the Keep setting.
    #[test]
    fn after_upgrade_only_history_bin_is_read() {
        let dir = scratch();
        let (hf, pf) = (dir.join("history.bin"), dir.join("pinned_entries.bin"));
        write_file(&hf, &[text_with_id("x"), pinned("p")]);

        let mut hist = ClipboardHistory::new();
        hist.load_from_disk(&hf, &pf, false);

        assert_eq!(ids(&hist), ["x", "p"]);
        assert!(!pf.exists());
        assert!(!dir.join("history.bin.pre-upgrade").exists());
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
}
