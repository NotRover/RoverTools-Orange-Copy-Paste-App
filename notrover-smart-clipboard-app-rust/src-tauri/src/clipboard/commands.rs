//! Tauri command handlers for clipboard history operations, plus internal
//! helpers for reading and writing clipboard content.

use std::path::Path;
use std::sync::atomic::Ordering;

use base64::{engine::general_purpose::STANDARD as B64, Engine};

use arboard::Clipboard;
use tauri::{Manager, State};

use crate::clipboard::files::{
    content_to_files, files_to_content, read_files_from_clipboard, write_files_to_clipboard,
};
use crate::clipboard::history::ClipboardEntry;
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
const MAX_VIDEO_PREVIEW_BYTES: usize = 36 * 1024 * 1024;

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

fn mime_from_video_ext(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mov" => Some("video/quicktime"),
        "mkv" => Some("video/x-matroska"),
        "avi" => Some("video/x-msvideo"),
        "wmv" => Some("video/x-ms-wmv"),
        "mpeg" | "mpg" => Some("video/mpeg"),
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
    use tauri::Emitter;
    let removed = state.history.lock().remove(&id);
    if removed {
        let _ = app.emit("clipboard:entry-deleted", &id);
        auto_save_history(&app, &state.history);
    }
    removed
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    state.history.lock().clear();
    auto_save_history(&app, &state.history);
    true
}

fn app_data_file(app: &tauri::AppHandle, name: &str) -> Option<std::path::PathBuf> {
    Some(app.path().app_data_dir().ok()?.join(name))
}

fn get_saved_file_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app_data_file(app, "pinned_entries.json")
}

pub(crate) fn get_history_file_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app_data_file(app, "history.json")
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
    use tauri::Emitter;

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
        auto_save_history(app, &state.history);
        let _ = app.emit(
            "clipboard:entry-pinned",
            serde_json::json!({ "id": id, "pinned": pin }),
        );
    }
    success
}

#[tauri::command]
pub fn get_setting(key: String, app: tauri::AppHandle) -> Option<serde_json::Value> {
    let path = get_settings_file_path(&app)?;
    let data = std::fs::read_to_string(&path).ok()?;
    let map: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&data).ok()?;
    map.get(&key).cloned()
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
        "start_minimized" => Some(&state.start_minimized),
        "copy_notification" => Some(&state.copy_notification),
        "notif_copy" => Some(&state.notif_copy),
        "autosave" => Some(&state.autosave),
        _ => None,
    };
    if let Some(flag) = flag {
        flag.store(value.as_bool().unwrap_or(false), Ordering::Relaxed);
    }

    let Some(path) = get_settings_file_path(&app) else {
        return false;
    };
    let mut map: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|d| serde_json::from_str(&d).ok())
        .unwrap_or_default();
    map.insert(key, value);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&map).unwrap_or_default(),
    )
    .is_ok()
}

// ── Bulk operations ─────────────────────────────────────────────────

/// Delete multiple entries at once. Returns the number of entries actually removed.
#[tauri::command]
pub fn bulk_delete_entries(
    ids: Vec<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> u32 {
    use tauri::Emitter;
    let mut hist = state.history.lock();
    let mut removed = 0u32;
    for id in &ids {
        if hist.remove(id) {
            let _ = app.emit("clipboard:entry-deleted", id);
            removed += 1;
        }
    }
    drop(hist);
    if removed > 0 {
        auto_save_history(&app, &state.history);
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
    use tauri::Emitter;
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
        auto_save_history(&app, &state.history);
    }
    changed
}

/// Assign the same set of groups to multiple entries at once.
/// Returns the number of entries changed.
#[tauri::command]
pub fn bulk_set_groups(
    ids: Vec<String>,
    groups: Vec<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> u32 {
    use tauri::Emitter;
    let mut hist = state.history.lock();
    let mut changed = 0u32;

    for id in &ids {
        if hist.set_groups(id, groups.clone()) {
            let _ = app.emit(
                "clipboard:entry-groups-changed",
                serde_json::json!({ "id": id, "groups": &groups }),
            );
            changed += 1;
        }
    }

    drop(hist);
    if changed > 0 {
        save_after_group_change(&app, &state);
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
    use tauri::Emitter;
    let mut hist = state.history.lock();
    let mut changed = 0u32;

    for id in &ids {
        if hist.add_group(id, &group) {
            if let Some(e) = hist.find(id) {
                let groups = e.groups.clone();
                let _ = app.emit(
                    "clipboard:entry-groups-changed",
                    serde_json::json!({ "id": id, "groups": groups }),
                );
            }
            changed += 1;
        }
    }

    drop(hist);
    if changed > 0 {
        save_after_group_change(&app, &state);
    }
    changed
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
    use tauri::Emitter;
    let mut hist = state.history.lock();
    let mut changed = 0u32;

    for id in &ids {
        if hist.remove_group(id, &group) {
            if let Some(e) = hist.find(id) {
                let groups = e.groups.clone();
                let _ = app.emit(
                    "clipboard:entry-groups-changed",
                    serde_json::json!({ "id": id, "groups": groups }),
                );
            }
            changed += 1;
        }
    }

    drop(hist);
    if changed > 0 {
        save_after_group_change(&app, &state);
    }
    changed
}

/// Trigger an immediate flush of the full history to disk.
/// Called from the frontend when the user first enables keep_history.
#[tauri::command]
pub fn save_history(state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    get_history_file_path(&app)
        .map(|p| state.history.lock().save_all_to_file(&p).is_ok())
        .unwrap_or(false)
}

/// Set the groups for a clipboard entry.
#[tauri::command]
pub fn set_entry_groups(
    id: String,
    groups: Vec<String>,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> bool {
    use tauri::Emitter;

    let success = state.history.lock().set_groups(&id, groups.clone());
    if success {
        save_after_group_change(&app, &state);
        let _ = app.emit(
            "clipboard:entry-groups-changed",
            serde_json::json!({ "id": id, "groups": groups }),
        );
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
    auto_save_history(app, &state.history);
}

/// Mark the history as needing a flush to disk.  The actual I/O happens on
/// a background timer (~2 s) so rapid clipboard changes are coalesced into a
/// single write.  Cost: one atomic load + one atomic store (≈2 ns total).
pub(crate) fn auto_save_history(app: &tauri::AppHandle, _history: &crate::SharedHistory) {
    let state: tauri::State<'_, AppState> = app.state();
    if state.keep_history.load(Ordering::Relaxed) {
        state.history_dirty.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub fn copy_entry(id: String, state: State<'_, AppState>) -> bool {
    let Some(entry) = find_entry_by_id(&state, &id) else {
        return false;
    };
    let ok = write_entry_to_clipboard(&entry).is_ok();
    if ok {
        state.suppress_next_capture.store(true, Ordering::Relaxed);
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

    // Spawn a background thread so we don't block the Tauri event loop
    // during heavy image decoding/clipboard writing.
    std::thread::spawn(move || {
        // Set the suppress flag BEFORE the clipboard write so the watcher
        // ignores the clipboard change we are about to make.
        suppress_next_capture.store(true, Ordering::Relaxed);

        match write_entry_to_clipboard(&entry) {
            Ok(()) => {
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
    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() || bytes.len() > max_bytes {
        return None;
    }
    Some(format!("data:{mime};base64,{}", B64.encode(bytes)))
}

#[tauri::command]
pub fn get_image_file_preview(path: String) -> Option<String> {
    get_file_preview(&path, mime_from_image_ext, MAX_IMAGE_PREVIEW_BYTES)
}

#[tauri::command]
pub fn get_video_file_preview(path: String) -> Option<String> {
    get_file_preview(&path, mime_from_video_ext, MAX_VIDEO_PREVIEW_BYTES)
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
            // Bypass arboard entirely — its internal proxy-thread architecture
            // races with the clipboard watcher and external apps, producing
            // OS error 1418 ("Thread does not have a clipboard open").
            // Direct Win32 API with retries is fully reliable.
            #[cfg(windows)]
            {
                crate::clipboard::image::write_image_to_clipboard(&entry.content)?;
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

pub(crate) fn read_clipboard_entry() -> Option<ClipboardEntry> {
    // Handle CF_HDROP (files copied in Explorer) first.
    // All file drops — including single image files — are stored as File entries
    // so that re-copying writes CF_HDROP back and the files can be pasted in
    // Explorer and other apps that expect file paths.  The frontend handles
    // showing the correct "Image" chip for single-image file entries.
    #[cfg(windows)]
    if crate::clipboard::files::any_file_format_available() {
        if let Some(paths) = read_files_from_clipboard() {
            return Some(ClipboardEntry::new_file(files_to_content(&paths)));
        }
    }

    // CF_HTML — rich text with inline images (Word, Teams, etc.).
    // Only triggers when the HTML contains images mixed with text, or tables.
    // Pure image copies and plain styled text are intentionally skipped.
    #[cfg(windows)]
    if crate::clipboard::html::any_html_format_available() {
        if let Some(html_fragment) = crate::clipboard::html::read_html_from_clipboard() {
            // Also grab the plain-text fallback for search/preview
            let plain = Clipboard::new()
                .ok()
                .and_then(|mut cb| cb.get_text().ok())
                .unwrap_or_default();
            return Some(ClipboardEntry::new_html(html_fragment, plain));
        }
    }

    // Plain text
    let mut cb = Clipboard::new().ok()?;

    if let Ok(text) = cb.get_text() {
        if !text.trim().is_empty() {
            return Some(ClipboardEntry::new_text(text));
        }
    }

    // Non-file images: screenshots, copies from browsers/apps, etc.
    #[cfg(windows)]
    if !crate::clipboard::image::any_image_format_available() {
        return None;
    }
    for attempt in 0..IMAGE_READ_RETRY_COUNT {
        if let Some(data_url) = crate::clipboard::image::read_image_from_clipboard() {
            return Some(ClipboardEntry::new_image(data_url));
        }
        if attempt + 1 < IMAGE_READ_RETRY_COUNT {
            std::thread::sleep(std::time::Duration::from_millis(IMAGE_READ_RETRY_DELAY_MS));
        }
    }

    None
}
