//! Tauri command handlers for clipboard history operations, plus internal
//! helpers for reading and writing clipboard content.

use std::borrow::Cow;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD as B64, Engine};

use arboard::Clipboard;
use tauri::{Manager, State};

use crate::clipboard::files::{
    content_to_files, files_to_content, read_files_from_clipboard, write_files_to_clipboard,
};
use crate::clipboard::history::ClipboardEntry;
use crate::clipboard::image::data_url_to_rgba;
use crate::runtime::platform::simulate_paste;
use crate::runtime::popup_windows::hide_popup;
use crate::state::AppState;

const IMAGE_READ_RETRY_COUNT: usize = 5;
const IMAGE_READ_RETRY_DELAY_MS: u64 = 90;
const PASTE_DELAY_MS: u64 = 80;
const MAX_IMAGE_PREVIEW_BYTES: usize = 12 * 1024 * 1024;
const MAX_VIDEO_PREVIEW_BYTES: usize = 36 * 1024 * 1024;

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

#[tauri::command]
pub fn pin_entry(id: String, state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    let success = state.history.lock().pin(&id);
    if success {
        if let Some(path) = get_pinned_file_path(&app) {
            let _ = state.history.lock().save_pinned_to_file(&path);
        }
        auto_save_history(&app, &state.history);
    }
    success
}

#[tauri::command]
pub fn unpin_entry(id: String, state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    let success = state.history.lock().unpin(&id);
    if success {
        if let Some(path) = get_pinned_file_path(&app) {
            let _ = state.history.lock().save_pinned_to_file(&path);
        }
        auto_save_history(&app, &state.history);
    }
    success
}

fn get_pinned_file_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let app_data = app.path().app_data_dir().ok()?;
    Some(app_data.join("pinned_entries.json"))
}

pub(crate) fn get_history_file_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let app_data = app.path().app_data_dir().ok()?;
    Some(app_data.join("history.json"))
}

pub(crate) fn get_settings_file_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let app_data = app.path().app_data_dir().ok()?;
    Some(app_data.join("settings.json"))
}

/// Read a user setting from `settings.json`.  Returns `null` if missing.
#[tauri::command]
pub fn get_setting(key: String, app: tauri::AppHandle) -> Option<serde_json::Value> {
    let path = get_settings_file_path(&app)?;
    if !path.exists() {
        return None;
    }
    let data = std::fs::read_to_string(&path).ok()?;
    let map: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&data).unwrap_or_default();
    map.get(&key).cloned()
}

/// Write a user setting to `settings.json`.
#[tauri::command]
pub fn set_setting(key: String, value: serde_json::Value, app: tauri::AppHandle) -> bool {
    let Some(path) = get_settings_file_path(&app) else {
        return false;
    };
    let mut map: serde_json::Map<String, serde_json::Value> = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|d| serde_json::from_str(&d).ok())
            .unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
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

/// Save the full history to disk (called from frontend on changes).
#[tauri::command]
pub fn save_history(state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    if let Some(path) = get_history_file_path(&app) {
        state.history.lock().save_all_to_file(&path).is_ok()
    } else {
        false
    }
}

/// Persist the full history to disk if the `persist_history` setting is
/// enabled.  Called internally after every mutation (push / delete / clear /
/// pin / unpin) so the on-disk file stays up-to-date.
pub(crate) fn auto_save_history(app: &tauri::AppHandle, history: &crate::SharedHistory) {
    let Some(settings_path) = get_settings_file_path(app) else {
        return;
    };
    if !crate::read_bool_setting(&settings_path, "persist_history") {
        return;
    }
    if let Some(path) = get_history_file_path(app) {
        let _ = history.lock().save_all_to_file(&path);
    }
}

#[tauri::command]
pub fn copy_entry(id: String, state: State<'_, AppState>) -> bool {
    let entry = find_entry_by_id(&state, &id);

    let Some(entry) = entry else { return false };

    let ok = write_entry_to_clipboard(&entry).is_ok();
    if ok {
        state
            .suppress_next_capture
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }
    ok
}

#[tauri::command]
pub fn paste_entry(id: String, state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    let entry = find_entry_by_id(&state, &id);

    let Some(entry) = entry else { return false };

    if write_entry_to_clipboard(&entry).is_err() {
        return false;
    }

    state
        .suppress_next_capture
        .store(true, std::sync::atomic::Ordering::Relaxed);

    hide_popup(&app, "paste-popup");
    schedule_paste();

    true
}

#[tauri::command]
pub fn get_image_file_preview(path: String) -> Option<String> {
    let path = Path::new(&path);
    let mime = mime_from_image_ext(path)?;

    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_PREVIEW_BYTES {
        return None;
    }

    Some(format!("data:{mime};base64,{}", B64.encode(bytes)))
}

#[tauri::command]
pub fn get_video_file_preview(path: String) -> Option<String> {
    let path = Path::new(&path);
    let mime = mime_from_video_ext(path)?;

    let bytes = std::fs::read(path).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_VIDEO_PREVIEW_BYTES {
        return None;
    }

    Some(format!("data:{mime};base64,{}", B64.encode(bytes)))
}

pub(crate) fn write_entry_to_clipboard(entry: &ClipboardEntry) -> Result<(), String> {
    use crate::clipboard::history::EntryKind;

    let mut cb = Clipboard::new().map_err(|e| e.to_string())?;

    match entry.kind {
        EntryKind::Text => {
            cb.set_text(entry.content.clone())
                .map_err(|e| e.to_string())?;
        }
        EntryKind::Image => {
            let (w, h, bytes) = data_url_to_rgba(&entry.content).map_err(|e| e.to_string())?;
            cb.set_image(arboard::ImageData {
                width: w,
                height: h,
                bytes: Cow::Owned(bytes),
            })
            .map_err(|e| e.to_string())?;
        }
        EntryKind::File => {
            let files = content_to_files(&entry.content);
            write_files_to_clipboard(&files)?;
        }
    }

    Ok(())
}

pub(crate) fn read_clipboard_entry() -> Option<ClipboardEntry> {
    let mut cb = match Clipboard::new() {
        Ok(cb) => cb,
        Err(_) => return None,
    };

    match cb.get_text() {
        Ok(text) if !text.trim().is_empty() => return Some(ClipboardEntry::new_text(text)),
        _ => {}
    }

    // Handle CF_HDROP (files copied in Explorer).
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
