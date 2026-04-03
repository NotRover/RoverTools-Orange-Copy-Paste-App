//! Clipboard history store.
//!
//! Holds an in-memory ring-buffer of the last [`MAX_HISTORY`] clipboard
//! entries (text or images encoded as PNG data-URLs).  The store is wrapped
//! in a [`parking_lot::Mutex`] so it can be shared across Tauri commands and
//! global-shortcut handlers.

use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};

// Constants

/// Maximum number of entries kept in history.
pub const MAX_HISTORY: usize = 100;

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

fn write_binary_file(path: &std::path::Path, data: &[u8]) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, data)
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

    std::fs::create_dir_all(images_dir).ok()?;
    std::fs::write(&filepath, &raw).ok()?;

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
fn save_entries_binary(
    entries: &[ClipboardEntry],
    path: &std::path::Path,
) -> Result<(), std::io::Error> {
    let msgpack = rmp_serde::to_vec(entries)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    write_binary_file(path, &msgpack)
}

/// Load entries from a MessagePack binary file.
fn load_entries_binary(path: &std::path::Path) -> Result<Vec<ClipboardEntry>, std::io::Error> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read(path)?;
    rmp_serde::from_slice(&data)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
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

/// Compute a fast 64-bit hash of the given string.
fn hash_content(s: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
}

impl ClipboardEntry {
    fn new(kind: EntryKind, content: String) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
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
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string(),
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
    /// A plain-text fallback is embedded via `\n---PLAINTEXT---\n`.
    pub fn new_html(html: String, plain_text: String) -> Self {
        let content = format!("{html}\n---PLAINTEXT---\n{plain_text}");
        Self::new(EntryKind::Html, content)
    }

    /// For Html entries, split content into (html, plain_text).
    pub fn html_parts(&self) -> (&str, &str) {
        if let Some(idx) = self.content.find("\n---PLAINTEXT---\n") {
            (&self.content[..idx], &self.content[idx + 18..])
        } else {
            (&self.content, "")
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
}

impl ClipboardHistory {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set the directory used to persist clipboard images as files on disk.
    pub fn set_images_dir(&mut self, dir: std::path::PathBuf) {
        self.images_dir = Some(dir);
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
    /// Returns the existing top entry when duplicate, or the inserted entry.
    pub fn push_if_distinct(&mut self, entry: ClipboardEntry) -> ClipboardEntry {
        self.push_if_distinct_with_flag(entry).0
    }

    /// Same as [`Self::push_if_distinct`], but also returns whether insertion happened.
    pub fn push_if_distinct_with_flag(&mut self, entry: ClipboardEntry) -> (ClipboardEntry, bool) {
        if let Some(existing) = self.entries.first() {
            if content_matches(existing, &entry) {
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

        Ok(())
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
