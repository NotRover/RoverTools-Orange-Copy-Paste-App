//! Tauri command handlers for clipboard history operations, plus internal
//! helpers for reading and writing clipboard content.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::LazyLock;

use base64::{engine::general_purpose::STANDARD as B64, Engine};

use arboard::Clipboard;
use parking_lot::Mutex;
use tauri::{Emitter, Manager, State};

use crate::clipboard::files::{
    content_to_files, files_to_content, read_files_from_clipboard, write_files_to_clipboard,
};
use crate::clipboard::history::{ClipboardEntry, MAX_TEXT_BYTES};
use crate::runtime::platform::simulate_paste;
use crate::runtime::popup_windows::hide_popup;
use crate::state::AppState;

#[cfg(not(windows))]
use crate::clipboard::image::data_url_to_rgba;
#[cfg(not(windows))]
use std::borrow::Cow;

const IMAGE_READ_RETRY_COUNT: usize = 5;
const IMAGE_READ_RETRY_DELAY_MS: u64 = 90;
const PASTE_DELAY_MS: u64 = 80;
const MAX_IMAGE_PREVIEW_BYTES: usize = 12 * 1024 * 1024;

/// Retries for `Clipboard::new()` — the clipboard can be locked by the
/// watcher thread or by external applications (e.g. Discord).
const CLIPBOARD_OPEN_RETRIES: usize = 6;
const CLIPBOARD_OPEN_RETRY_DELAY_MS: u64 = 50;

fn mime_from_image_ext(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "tif" | "tiff" => Some("image/tiff"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

fn find_entry_by_id(state: &State<'_, AppState>, id: &str) -> Option<ClipboardEntry> {
    state.history.lock().find(id).cloned()
}

fn schedule_paste() {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(PASTE_DELAY_MS));
        simulate_paste();
    });
}

#[tauri::command]
pub fn get_history(state: State<'_, AppState>) -> Vec<ClipboardEntry> {
    state.history.lock().all().to_vec()
}

#[tauri::command]
pub fn delete_entry(id: String, state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    // Read before the removal: an entry shared into a space leaves a
    // placeholder, and the placeholder sits where the entry sat.
    let entry_ts = state.history.lock().find(&id).map(|e| e.timestamp);
    let removed = state.history.lock().remove(&id);
    if removed {
        let _ = app.emit("clipboard:entry-deleted", &id);
        auto_save_history(&app);
        // Tombstone must propagate to sync even when offline (invariant #5)
        let sync = state.sync_client.lock().clone();
        if let Some(s) = sync {
            s.on_delete_clipboard_entry(id, entry_ts);
        }
    }
    removed
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    // Capture IDs of unpinned entries before clearing so tombstones can propagate (invariant #5).
    let deleted: Vec<(String, u64)> = state
        .history
        .lock()
        .all()
        .iter()
        .filter(|e| !e.pinned)
        .map(|e| (e.id.clone(), e.timestamp))
        .collect();

    state.history.lock().clear();
    auto_save_history(&app);

    if !deleted.is_empty() {
        let sync = state.sync_client.lock().clone();
        if let Some(s) = sync {
            for (id, entry_ts) in deleted {
                s.on_delete_clipboard_entry(id, Some(entry_ts));
            }
        }
    }
    true
}

fn app_data_file(app: &tauri::AppHandle, name: &str) -> Option<std::path::PathBuf> {
    Some(app.path().app_data_dir().ok()?.join(name))
}

fn get_saved_file_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app_data_file(app, "pinned_entries.bin")
}

pub(crate) fn get_history_file_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app_data_file(app, "history.bin")
}

fn get_settings_file_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app_data_file(app, "settings.json")
}

#[tauri::command]
pub fn pin_entry(id: String, state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    toggle_pin(&state, &app, &id, true)
}

#[tauri::command]
pub fn unpin_entry(id: String, state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    toggle_pin(&state, &app, &id, false)
}

const MAX_PINNED: usize = 10;

fn toggle_pin(state: &State<'_, AppState>, app: &tauri::AppHandle, id: &str, pin: bool) -> bool {
    let success = {
        let mut hist = state.history.lock();
        // Enforce pin limit — pinning is now paste-popup only.
        if pin && hist.pinned_entries().len() >= MAX_PINNED {
            return false;
        }
        if pin {
            hist.pin(id)
        } else {
            hist.unpin(id)
        }
    };
    if success {
        auto_save_history(app);
        let _ = app.emit(
            "clipboard:entry-pinned",
            serde_json::json!({ "id": id, "pinned": pin }),
        );
        // Propagate pin metadata change to sync
        let entry = state.history.lock().find(id).cloned();
        let sync = state.sync_client.lock().clone();
        if let (Some(entry), Some(s)) = (entry, sync) {
            s.on_update_clipboard_entry(entry);
        }
    }
    success
}

#[tauri::command]
pub fn get_setting(key: String, app: tauri::AppHandle) -> Option<serde_json::Value> {
    let path = get_settings_file_path(&app)?;
    read_settings(&path)?.get(&key).cloned()
}

/// Load `settings.json`, recording a read that failed rather than letting it
/// pass for "no settings saved". `None` means genuinely nothing to read.
fn read_settings(path: &std::path::Path) -> Option<crate::settings_file::Map> {
    match crate::settings_file::read_map(path) {
        Ok(map) => Some(map),
        Err(crate::settings_file::ReadError::Absent) => None,
        Err(crate::settings_file::ReadError::Unreadable(e))
        | Err(crate::settings_file::ReadError::Malformed(e)) => {
            crate::health::note("settings.json could not be read", &e);
            None
        }
    }
}

/// Read a boolean setting straight from `settings.json`, for the places that
/// need a preference before a webview is up to answer (window placement at
/// popup-show time). Falls back to `default` when unset or unreadable.
pub(crate) fn read_bool_setting(app: &tauri::AppHandle, key: &str, default: bool) -> bool {
    get_settings_file_path(app)
        .and_then(|p| read_settings(&p))
        .and_then(|m| m.get(key).and_then(serde_json::Value::as_bool))
        .unwrap_or(default)
}

/// Write a user setting to `settings.json`.
#[tauri::command]
pub fn set_setting(
    key: String,
    value: serde_json::Value,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> bool {
    // Keep the in-memory cache in sync when boolean flags change.
    let flag = match key.as_str() {
        "keep_history" => Some(&state.keep_history),
        "close_to_tray" => Some(&state.close_to_tray),
        "os_notifications" => Some(&state.os_notifications),
        "start_minimized" => Some(&state.start_minimized),
        "notification" => Some(&state.notification_enabled),
        "notif_copy" => Some(&state.notif_copy),
        "notif_paste" => Some(&state.notif_paste),
        "autosave" => Some(&state.autosave),
        _ => None,
    };
    if let Some(flag) = flag {
        flag.store(value.as_bool().unwrap_or(false), Ordering::Relaxed);
    }

    let Some(path) = get_settings_file_path(&app) else {
        return false;
    };
    // Read-modify-write of the whole file, so a failed read must not become an
    // empty map: writing that back erases every other preference, sync_enabled
    // included. Only a genuinely absent file starts from empty.
    let mut map = match crate::settings_file::read_map(&path) {
        Ok(map) => map,
        Err(crate::settings_file::ReadError::Absent) => crate::settings_file::Map::new(),
        Err(crate::settings_file::ReadError::Unreadable(e))
        | Err(crate::settings_file::ReadError::Malformed(e)) => {
            crate::health::note(
                "settings write skipped: settings.json could not be read",
                &format!("{e} - refusing to overwrite it with a blank file"),
            );
            return false;
        }
    };
    map.insert(key.clone(), value);
    // Read-modify-write of the whole preferences file, so a torn write loses
    // every setting rather than one key.
    let written = crate::health::write_atomic(
        &path,
        serde_json::to_string_pretty(&map).unwrap_or_default().as_bytes(),
    )
    .is_ok();

    // Schedule a settings sync push when a synced key changes
    const SYNCED_KEYS: &[&str] = &[
        "keep_history",
        "close_to_tray",
        "os_notifications",
        "start_minimized",
        "notification",
        "notif_copy",
        "notif_paste",
        "autosave",
    ];
    if written && SYNCED_KEYS.contains(&key.as_str()) {
        let sync = state.sync_client.lock().clone();
        if let Some(s) = sync {
            s.schedule_settings_push();
        }
    }

    written
}

// ── Bulk operations ─────────────────────────────────────────────────

/// Shared tail of the bulk update commands: persist, then propagate the
/// updated entries to sync.
fn finish_bulk_update(
    app: &tauri::AppHandle,
    state: &State<'_, AppState>,
    ids: &[String],
    group_change: bool,
) {
    if group_change {
        save_after_group_change(app, state);
    } else {
        auto_save_history(app);
    }
    let sync = state.sync_client.lock().clone();
    if let Some(s) = sync {
        for id in ids {
            let entry = state.history.lock().find(id).cloned();
            if let Some(entry) = entry {
                s.on_update_clipboard_entry(entry);
            }
        }
    }
}

/// Shared body of the bulk group commands: apply `mutate` per entry, emit
/// `clipboard:entry-groups-changed` with the entry's resulting groups, then
/// persist and sync. Returns the number of entries changed.
fn bulk_modify_groups(
    ids: &[String],
    state: &State<'_, AppState>,
    app: &tauri::AppHandle,
    mutate: impl Fn(&mut crate::clipboard::history::ClipboardHistory, &str) -> bool,
) -> u32 {
    let mut hist = state.history.lock();
    let mut changed = 0u32;
    for id in ids {
        if mutate(&mut hist, id) {
            if let Some(e) = hist.find(id) {
                let _ = app.emit(
                    "clipboard:entry-groups-changed",
                    serde_json::json!({ "id": id, "groups": e.groups }),
                );
            }
            changed += 1;
        }
    }
    drop(hist);
    if changed > 0 {
        finish_bulk_update(app, state, ids, true);
    }
    changed
}

/// Delete multiple entries at once. Returns the number of entries actually removed.
#[tauri::command]
pub fn bulk_delete_entries(
    ids: Vec<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> u32 {
    let mut hist = state.history.lock();
    let mut removed = 0u32;
    let mut deleted_ids: Vec<(String, Option<u64>)> = Vec::new();
    for id in &ids {
        // Timestamp first: it is gone from the store a line later, and a space
        // placeholder has to sort where the entry did.
        let entry_ts = hist.find(id).map(|e| e.timestamp);
        if hist.remove(id) {
            let _ = app.emit("clipboard:entry-deleted", id);
            deleted_ids.push((id.clone(), entry_ts));
            removed += 1;
        }
    }
    drop(hist);
    if removed > 0 {
        auto_save_history(&app);
        let sync = state.sync_client.lock().clone();
        if let Some(s) = sync {
            for (id, entry_ts) in deleted_ids {
                s.on_delete_clipboard_entry(id, entry_ts);
            }
        }
    }
    removed
}

/// Pin or unpin multiple entries at once. Returns the number of entries changed.
/// Respects the MAX_PINNED limit — stops pinning once the limit is reached.
#[tauri::command]
pub fn bulk_pin_entries(
    ids: Vec<String>,
    pin: bool,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> u32 {
    let mut hist = state.history.lock();
    let mut changed = 0u32;

    for id in &ids {
        if pin {
            // Enforce pin limit
            if hist.pinned_entries().len() >= MAX_PINNED {
                break;
            }
            if hist.pin(id) {
                let _ = app.emit(
                    "clipboard:entry-pinned",
                    serde_json::json!({ "id": id, "pinned": true }),
                );
                changed += 1;
            }
        } else if hist.unpin(id) {
            let _ = app.emit(
                "clipboard:entry-pinned",
                serde_json::json!({ "id": id, "pinned": false }),
            );
            changed += 1;
        }
    }

    drop(hist);
    if changed > 0 {
        finish_bulk_update(&app, &state, &ids, false);
    }
    changed
}

/// Add a single group to multiple entries (without replacing existing groups).
/// Returns the number of entries changed.
#[tauri::command]
pub fn bulk_add_group(
    ids: Vec<String>,
    group: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> u32 {
    bulk_modify_groups(&ids, &state, &app, |hist, id| hist.add_group(id, &group))
}

/// Remove a single group from multiple entries.
/// Returns the number of entries changed.
#[tauri::command]
pub fn bulk_remove_group(
    ids: Vec<String>,
    group: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> u32 {
    bulk_modify_groups(&ids, &state, &app, |hist, id| hist.remove_group(id, &group))
}

/// Trigger an immediate flush of the full history to disk.
/// Called from the frontend when the user first enables keep_history.
#[tauri::command]
pub fn save_history(state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    match get_history_file_path(&app) {
        Some(p) => state.history.lock().save_all_to_file(&p).is_ok(),
        _ => false,
    }
}

/// Set the groups for a clipboard entry.
#[tauri::command]
pub fn set_entry_groups(
    id: String,
    groups: Vec<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> bool {
    let success = state.history.lock().set_groups(&id, groups.clone());
    if success {
        save_after_group_change(&app, &state);
        let _ = app.emit(
            "clipboard:entry-groups-changed",
            serde_json::json!({ "id": id, "groups": groups }),
        );
        let entry = state.history.lock().find(&id).cloned();
        let sync = state.sync_client.lock().clone();
        if let (Some(entry), Some(s)) = (entry, sync) {
            s.on_update_clipboard_entry(entry);
        }
    }
    success
}

/// Remove a group tag from every entry that has it.
#[tauri::command]
pub fn purge_group_from_entries(
    group: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> bool {
    state.history.lock().purge_group(&group);
    save_after_group_change(&app, &state);
    true
}

/// Rename a group across all entries that have it.
#[tauri::command]
pub fn rename_group_in_entries(
    old_name: String,
    new_name: String,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> bool {
    state.history.lock().rename_group(&old_name, &new_name);
    save_after_group_change(&app, &state);
    true
}

fn save_after_group_change(app: &tauri::AppHandle, state: &State<'_, AppState>) {
    if let Some(path) = get_saved_file_path(app) {
        let _ = state.history.lock().save_saved_to_file(&path);
    }
    auto_save_history(app);
}

/// Mark the history as needing a flush to disk.  The actual I/O happens on
/// a background timer (~2 s) so rapid clipboard changes are coalesced into a
/// single write.  Cost: one atomic load + one atomic store (≈2 ns total).
pub(crate) fn auto_save_history(app: &tauri::AppHandle) {
    let state: tauri::State<'_, AppState> = app.state();
    if state.keep_history.load(Ordering::Relaxed) {
        state.history_dirty.store(true, Ordering::Relaxed);
    }
}

/// Write an entry to the clipboard on the app's own behalf (a manual copy, or
/// sync auto-copy from a space).  Sets the watcher suppress flag *before* the
/// write so the change is not re-captured as a duplicate (and reverts it on
/// failure so the next legit copy is not swallowed), then keeps the
/// active-clipboard-id consistent with a manual copy.  Safe from any thread.
pub(crate) fn copy_entry_suppressed(
    app: &tauri::AppHandle,
    entry: &crate::clipboard::history::ClipboardEntry,
) -> bool {
    let state: tauri::State<'_, AppState> = app.state();
    state.suppress_next_capture.store(true, Ordering::Relaxed);
    match write_entry_to_clipboard(entry) {
        Ok(()) => {
            set_active_clipboard_id(app, &entry.id);
            true
        }
        Err(e) => {
            eprintln!("[clipboard] suppressed write failed: {e}");
            state.suppress_next_capture.store(false, Ordering::Relaxed);
            false
        }
    }
}

#[tauri::command]
pub fn copy_entry(id: String, state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    let Some(entry) = find_entry_by_id(&state, &id) else {
        return false;
    };
    let ok = copy_entry_suppressed(&app, &entry);
    if ok {
        crate::notifications::cue(&app, crate::notifications::Cue::Copy);
        crate::runtime::notifications::notify_if_enabled(&app, &entry);
    }
    ok
}

#[tauri::command]
pub fn paste_entry(id: String, state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    // Hide the OS window immediately before any heavy image decoding blocks the thread.
    hide_popup(&app, "paste-popup");

    let Some(entry) = find_entry_by_id(&state, &id) else {
        return false;
    };

    let suppress_next_capture = state.suppress_next_capture.clone();
    let app_handle = app.clone();

    // Spawn a background thread so we don't block the Tauri event loop
    // during heavy image decoding/clipboard writing.
    std::thread::spawn(move || {
        // Set the suppress flag BEFORE the clipboard write so the watcher
        // ignores the clipboard change we are about to make.
        suppress_next_capture.store(true, Ordering::Relaxed);

        match write_entry_to_clipboard(&entry) {
            Ok(()) => {
                set_active_clipboard_id(&app_handle, &entry.id);
                crate::notifications::cue(&app_handle, crate::notifications::Cue::Paste);
                crate::runtime::notifications::notify_paste_if_enabled(&app_handle, &entry);
                schedule_paste();
            }
            Err(e) => {
                eprintln!("[paste_entry] clipboard write failed: {e}");
                // Revert suppress so the next legit copy is not swallowed.
                suppress_next_capture.store(false, Ordering::Relaxed);
            }
        }
    });

    true
}

fn get_file_preview(
    path_str: &str,
    mime_fn: fn(&Path) -> Option<&'static str>,
    max_bytes: usize,
) -> Option<String> {
    let path = Path::new(path_str);
    let mime = mime_fn(path)?;
    // Measure before reading. Reading first and rejecting the length afterwards
    // meant asking for a preview of a 30 GB video pulled all 30 GB into memory
    // just to throw it away.
    let len = std::fs::metadata(path).ok()?.len();
    if len == 0 || len > max_bytes as u64 {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() || bytes.len() > max_bytes {
        return None;
    }
    Some(format!("data:{mime};base64,{}", B64.encode(bytes)))
}

// ── Image preview cache ──────────────────────────────────────────────
//
// Encoding an image preview reads the whole file and base64-encodes it. This
// cache lets repeat requests — including from separate windows (grid, copy /
// paste popups), which don't share JS memory — skip that work. Bounded by total
// bytes to respect the app's file-backed / low-RAM image strategy, and keyed by
// (path, mtime, len) so an on-disk change transparently refreshes the entry.
const PREVIEW_CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;

struct PreviewEntry {
    mtime: u64,
    len: u64,
    data_url: String,
}

#[derive(Default)]
struct PreviewCache {
    entries: HashMap<String, PreviewEntry>,
    /// Access order, front = least-recently used.
    order: Vec<String>,
    bytes: usize,
}

impl PreviewCache {
    fn detach(&mut self, path: &str) {
        if let Some(pos) = self.order.iter().position(|p| p == path) {
            self.order.remove(pos);
        }
    }

    fn get(&mut self, path: &str, mtime: u64, len: u64) -> Option<String> {
        match self.entries.get(path) {
            Some(e) if e.mtime == mtime && e.len == len => {
                let url = e.data_url.clone();
                self.detach(path);
                self.order.push(path.to_string());
                Some(url)
            }
            // Missing or stale (file changed): drop any stale copy.
            Some(_) => {
                self.remove(path);
                None
            }
            None => None,
        }
    }

    fn remove(&mut self, path: &str) {
        if let Some(e) = self.entries.remove(path) {
            self.bytes -= e.data_url.len();
            self.detach(path);
        }
    }

    fn insert(&mut self, path: String, mtime: u64, len: u64, data_url: String) {
        // A single item larger than the whole budget is served but not cached.
        if data_url.len() > PREVIEW_CACHE_MAX_BYTES {
            return;
        }
        self.remove(&path);
        self.bytes += data_url.len();
        self.entries
            .insert(path.clone(), PreviewEntry { mtime, len, data_url });
        self.order.push(path);
        while self.bytes > PREVIEW_CACHE_MAX_BYTES {
            let Some(lru) = self.order.first().cloned() else {
                break;
            };
            self.remove(&lru);
        }
    }
}

static PREVIEW_CACHE: LazyLock<Mutex<PreviewCache>> =
    LazyLock::new(|| Mutex::new(PreviewCache::default()));

/// Current (mtime-secs, len) stamp for cache validation, or None if missing.
fn file_stamp(path: &Path) -> Option<(u64, u64)> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some((mtime, md.len()))
}

#[tauri::command]
pub fn get_image_file_preview(path: String) -> Option<String> {
    let stamp = file_stamp(Path::new(&path));
    if let Some((mtime, len)) = stamp {
        let cached = PREVIEW_CACHE.lock().get(&path, mtime, len);
        if let Some(hit) = cached {
            return Some(hit);
        }
    }
    let data_url = get_file_preview(&path, mime_from_image_ext, MAX_IMAGE_PREVIEW_BYTES)?;
    if let Some((mtime, len)) = stamp {
        PREVIEW_CACHE
            .lock()
            .insert(path, mtime, len, data_url.clone());
    }
    Some(data_url)
}

/// Given a list of file paths, return those that no longer exist on disk.
#[tauri::command]
pub fn check_missing_files(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| !Path::new(p).exists())
        .collect()
}

/// Open an arboard clipboard handle, retrying a few times if the clipboard
/// is temporarily locked by another thread or application.
fn open_clipboard_with_retry() -> Result<Clipboard, String> {
    let mut last_err = String::new();
    for attempt in 0..CLIPBOARD_OPEN_RETRIES {
        match Clipboard::new() {
            Ok(cb) => return Ok(cb),
            Err(e) => {
                last_err = e.to_string();
                if attempt + 1 < CLIPBOARD_OPEN_RETRIES {
                    std::thread::sleep(std::time::Duration::from_millis(
                        CLIPBOARD_OPEN_RETRY_DELAY_MS,
                    ));
                }
            }
        }
    }
    Err(format!(
        "failed to open clipboard after {CLIPBOARD_OPEN_RETRIES} attempts: {last_err}"
    ))
}

/// Update the active clipboard entry ID and notify the frontend.
pub(crate) fn set_active_clipboard_id(app: &tauri::AppHandle, id: &str) {
    let state: tauri::State<'_, AppState> = app.state();
    *state.active_clipboard_id.lock() = id.to_owned();
    let _ = app.emit("clipboard:active-id", id);
}

#[tauri::command]
pub fn get_active_clipboard_id(state: State<'_, AppState>) -> String {
    state.active_clipboard_id.lock().clone()
}

pub(crate) fn write_entry_to_clipboard(entry: &ClipboardEntry) -> Result<(), String> {
    use crate::clipboard::history::EntryKind;

    match entry.kind {
        EntryKind::Text => {
            let mut cb = open_clipboard_with_retry()?;
            cb.set_text(entry.content.clone())
                .map_err(|e| e.to_string())?;
        }
        EntryKind::Html => {
            let (html, plain) = entry.html_parts();
            crate::clipboard::html::write_html_to_clipboard(html, plain)?;
        }
        EntryKind::Image => {
            #[cfg(windows)]
            {
                if entry.content.starts_with("data:") {
                    // In-memory data-URL (legacy or migration path).
                    crate::clipboard::image::write_image_to_clipboard(&entry.content)?;
                } else {
                    // File-backed image: write as CF_HDROP so the paste target
                    // receives the file directly — no image decode or pixel
                    // conversion, matching Explorer-copy performance.
                    write_files_to_clipboard(std::slice::from_ref(&entry.content))?;
                }
            }
            #[cfg(not(windows))]
            {
                let (w, h, bytes) = data_url_to_rgba(&entry.content).map_err(|e| e.to_string())?;
                let mut cb = open_clipboard_with_retry()?;
                cb.set_image(arboard::ImageData {
                    width: w,
                    height: h,
                    bytes: Cow::Owned(bytes),
                })
                .map_err(|e| e.to_string())?;
            }
        }
        EntryKind::File => {
            let files = content_to_files(&entry.content);
            write_files_to_clipboard(&files)?;
        }
    }

    Ok(())
}

// Capture size guard

/// What one attempt to read the clipboard produced.
///
/// The three cases have to stay apart: content to keep, a payload deliberately
/// refused, and a read that did not work. An `Option` collapsed the last two,
/// and the watcher treats "did not work" as retry-on-the-next-poll - so a
/// refused payload would be re-measured every 220 ms for as long as it sat on
/// the clipboard.
pub(crate) enum Capture {
    /// Content worth keeping.
    Entry(ClipboardEntry),
    /// Readable, but past [`MAX_TEXT_BYTES`]. `what` names the shape for the
    /// message; `bytes` is the measured size.
    TooLarge { what: &'static str, bytes: usize },
    /// Nothing to take: an empty clipboard, a format this app does not handle,
    /// or a clipboard another app has locked. The caller should retry.
    Nothing,
}

/// What the OS will say about one clipboard format's size.
///
/// `Locked` has to stay distinct from `Absent`. Collapsing them into "no
/// opinion" is what let a refused payload get read anyway: the app that just
/// put a 500 MB selection on the clipboard is still holding it when the next
/// poll lands, the measurement cannot be taken, and falling through to the
/// ordinary read means waiting out the lock and then decoding the whole thing -
/// the exact allocation the measurement exists to prevent.
#[cfg(windows)]
enum FormatSize {
    /// Measured, in bytes.
    Bytes(usize),
    /// The format is not on the clipboard.
    Absent,
    /// Another app holds the clipboard. Nothing can be measured, and nothing
    /// should be read either - try again on the next poll.
    Locked,
}

/// Byte size of one clipboard format's payload, without copying it.
///
/// The point of the size guard is to never allocate what it is about to refuse,
/// so it measures the OS handle rather than a `String` already built from it.
#[cfg(windows)]
fn clipboard_format_bytes(fmt: u32) -> FormatSize {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::GlobalSize;

    if fmt == 0 {
        return FormatSize::Absent;
    }
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return FormatSize::Locked;
        }
        let handle = GetClipboardData(fmt);
        let size = if handle.is_null() {
            FormatSize::Absent
        } else {
            FormatSize::Bytes(GlobalSize(handle) as usize)
        };
        CloseClipboard();
        size
    }
}

/// The verdict on `CF_UNICODETEXT` before anything is decoded.
#[cfg(windows)]
enum TextPreflight {
    /// Past the cap by the most generous reading. Refuse without reading.
    Oversized(usize),
    /// Small enough to read, or not text at all.
    WithinCap,
    /// The clipboard could not be opened. Do not read.
    Locked,
}

/// Measure `CF_UNICODETEXT` so a caller can refuse it before `arboard` copies
/// it in.
///
/// The handle holds UTF-16, and the UTF-8 `String` it decodes to is anywhere
/// between half its size (all ASCII) and one and a half times it. Only the
/// lower bound can be trusted here, so this refuses when even the all-ASCII
/// reading would be over and leaves anything nearer the line to the exact
/// post-read check. The most that still gets through is twice the cap, which is
/// the point: bounded.
#[cfg(windows)]
fn text_preflight() -> TextPreflight {
    const CF_UNICODETEXT: u32 = 13;
    match clipboard_format_bytes(CF_UNICODETEXT) {
        FormatSize::Locked => TextPreflight::Locked,
        FormatSize::Absent => TextPreflight::WithinCap,
        FormatSize::Bytes(utf16_bytes) => {
            let min_utf8 = utf16_bytes / 2;
            if min_utf8 > MAX_TEXT_BYTES {
                TextPreflight::Oversized(min_utf8)
            } else {
                TextPreflight::WithinCap
            }
        }
    }
}

/// Tell the user a copy was refused for its size.
///
/// One rolling row rather than one per copy: the same oversized selection often
/// lands several times in a row, and a stack of identical lines would bury
/// everything else in the centre.
pub(crate) fn notify_capture_too_large(app: &tauri::AppHandle, what: &str, bytes: usize) {
    eprintln!("[clipboard] refused a {bytes} byte {what} copy (cap {MAX_TEXT_BYTES})");
    // The toast is the part the user cannot turn off: an item they copied is
    // missing, and the alternative to saying so is letting them find out by
    // looking for it. The row below carries the why.
    crate::runtime::notifications::notify_capture_skipped(app, bytes);
    let cap = crate::sync::format_bytes(MAX_TEXT_BYTES as u64);
    crate::notifications::raise_rolling_quiet(
        app,
        crate::notifications::Notification::new(
            "clipboard-too-large",
            crate::notifications::NotificationKind::Reminder,
            format!("Skipped a {} copy", crate::sync::format_bytes(bytes as u64)),
        )
        .with_body(format!(
            "Keeping it would have cost far more memory than the item is worth, so history skipped it: one item holds up to {cap} of {what}. Nothing was lost. Your system clipboard still holds the copy, so pasting it works as usual - it just will not be here later."
        )),
    );
}

/// Tell the user which history items were too large to keep.
///
/// Raised once at startup, after a history file written before the cap was
/// pruned. Says the size, because "an item was removed" with no number is the
/// kind of notice that reads as a bug.
pub(crate) fn notify_oversized_dropped(app: &tauri::AppHandle, sizes: &[usize]) {
    let total: u64 = sizes.iter().map(|s| *s as u64).sum();
    let title = if sizes.len() == 1 {
        format!("Removed a {} history item", crate::sync::format_bytes(total))
    } else {
        format!("Removed {} oversized history items", sizes.len())
    };
    let cap = crate::sync::format_bytes(MAX_TEXT_BYTES as u64);
    crate::notifications::raise_rolling(
        app,
        crate::notifications::Notification::new(
            "clipboard-oversized-dropped",
            crate::notifications::NotificationKind::Reminder,
            title,
        )
        .with_body(format!(
            "{} in all, past the {cap} one item can hold. Items that large kept the app slow every time it started.",
            crate::sync::format_bytes(total)
        )),
    );
}

/// Read whatever is on the clipboard into a would-be history entry.
///
/// Every capture path goes through here - the watcher, the copy shortcut, and
/// the CLI trigger - so the size guard only has to live in one place.
pub(crate) fn read_clipboard_capture() -> Capture {
    // Handle CF_HDROP (files copied in Explorer) first.
    // All file drops - including single image files - are stored as File entries
    // so that re-copying writes CF_HDROP back and the files can be pasted in
    // Explorer and other apps that expect file paths.  The frontend handles
    // showing the correct "Image" chip for single-image file entries.
    #[cfg(windows)]
    if crate::clipboard::files::any_file_format_available() {
        if let Some(paths) = read_files_from_clipboard() {
            // A path is small; a selection of a few hundred thousand is not.
            let content = files_to_content(&paths);
            if content.len() > MAX_TEXT_BYTES {
                return Capture::TooLarge {
                    what: "file paths",
                    bytes: content.len(),
                };
            }
            return Capture::Entry(ClipboardEntry::new_file(content));
        }
    }

    // CF_HTML - rich text with inline images (Word, Teams, etc.).
    // Only triggers when the HTML contains images mixed with text, or tables.
    // Pure image copies and plain styled text are intentionally skipped.
    #[cfg(windows)]
    if crate::clipboard::html::any_html_format_available() {
        // CF_HTML is UTF-8 on the handle, so its size needs no slack.
        match clipboard_format_bytes(crate::clipboard::html::html_format_id()) {
            FormatSize::Bytes(bytes) if bytes > MAX_TEXT_BYTES => {
                return Capture::TooLarge {
                    what: "rich text",
                    bytes,
                }
            }
            FormatSize::Locked => return Capture::Nothing,
            _ => {}
        }
        if let Some(html_fragment) = crate::clipboard::html::read_html_from_clipboard() {
            // Also grab the plain-text fallback for search/preview.  It is a
            // second rendering of the same content, so it gets the same guard.
            let plain = match text_preflight() {
                TextPreflight::WithinCap => Clipboard::new()
                    .ok()
                    .and_then(|mut cb| cb.get_text().ok())
                    .unwrap_or_default(),
                TextPreflight::Oversized(_) | TextPreflight::Locked => String::new(),
            };
            // Both halves live in one entry, so the cap is on their sum.
            let total = html_fragment.len() + plain.len();
            if total > MAX_TEXT_BYTES {
                return Capture::TooLarge {
                    what: "rich text",
                    bytes: total,
                };
            }
            return Capture::Entry(ClipboardEntry::new_html(html_fragment, plain));
        }
    }

    // Plain text.  Measured off the OS handle first, so a payload this app will
    // not keep is never decoded into it.
    #[cfg(windows)]
    match text_preflight() {
        TextPreflight::Oversized(bytes) => {
            return Capture::TooLarge {
                what: "text",
                bytes,
            }
        }
        // Very often the app that just placed a huge selection is still
        // holding the clipboard. Reading through the lock would mean
        // `arboard` waiting it out and then decoding the payload in full,
        // which is the allocation this guard exists to avoid. Retry instead.
        TextPreflight::Locked => return Capture::Nothing,
        TextPreflight::WithinCap => {}
    }

    let Ok(mut cb) = Clipboard::new() else {
        return Capture::Nothing;
    };

    if let Ok(text) = cb.get_text() {
        // The authoritative check: the pre-flight above exists only on Windows,
        // and deliberately allows some slack.
        if text.len() > MAX_TEXT_BYTES {
            return Capture::TooLarge {
                what: "text",
                bytes: text.len(),
            };
        }
        if !text.trim().is_empty() {
            return Capture::Entry(ClipboardEntry::new_text(text));
        }
    }

    // Non-file images: screenshots, copies from browsers/apps, etc.
    #[cfg(windows)]
    if !crate::clipboard::image::any_image_format_available() {
        return Capture::Nothing;
    }
    for attempt in 0..IMAGE_READ_RETRY_COUNT {
        if let Some(data_url) = crate::clipboard::image::read_image_from_clipboard() {
            return Capture::Entry(ClipboardEntry::new_image(data_url));
        }
        if attempt + 1 < IMAGE_READ_RETRY_COUNT {
            std::thread::sleep(std::time::Duration::from_millis(IMAGE_READ_RETRY_DELAY_MS));
        }
    }

    Capture::Nothing
}
