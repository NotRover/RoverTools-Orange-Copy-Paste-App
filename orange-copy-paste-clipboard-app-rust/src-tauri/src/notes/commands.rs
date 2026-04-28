//! Tauri commands for notes management.

use crate::notes::store::Note;
use crate::AppState;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};

/// Counter to disambiguate filenames generated within the same nanosecond.
static IMAGE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Persist a pasted/dropped image to `app_data/note-attachments/images/` and
/// return the absolute file path. The frontend converts the path to a
/// `tauri-asset:` URL via `convertFileSrc` and stores `![](…)` in the markdown
/// — this avoids base64 round-trip breakage when switching between rich and
/// markdown modes.
#[tauri::command]
pub fn save_note_image(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    ext: String,
) -> Result<String, String> {
    let dir = note_attachments_dir(&app, "images")?;

    let safe_ext = match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "jpg",
        "png" => "png",
        "gif" => "gif",
        "webp" => "webp",
        "bmp" => "bmp",
        "svg" => "svg",
        _ => "png",
    };

    let ts = current_nanos()?;
    let seq = IMAGE_SEQ.fetch_add(1, AtomicOrdering::Relaxed);
    let filename = format!("note_{}_{}.{}", ts, seq, safe_ext);
    let filepath = dir.join(&filename);

    std::fs::write(&filepath, &bytes).map_err(|e| e.to_string())?;
    Ok(filepath.to_string_lossy().to_string())
}

/// Persist a non-image attachment (PDF, doc, zip, …) to
/// `app_data/note-attachments/files/`. The original filename is preserved
/// (after sanitization) and prefixed with a timestamp to keep collisions out
/// of the way. Returns the absolute path; the frontend turns it into a
/// `tauri-asset:` URL and inserts a markdown link `[name](url)`.
#[tauri::command]
pub fn save_note_file(
    app: tauri::AppHandle,
    bytes: Vec<u8>,
    name: String,
) -> Result<String, String> {
    let dir = note_attachments_dir(&app, "files")?;

    let safe_name: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe_name = safe_name.trim();
    let safe_name = if safe_name.is_empty() {
        "attachment".to_string()
    } else {
        safe_name.to_string()
    };

    let ts = current_nanos()?;
    let seq = IMAGE_SEQ.fetch_add(1, AtomicOrdering::Relaxed);
    let filename = format!("{}_{}_{}", ts, seq, safe_name);
    let filepath = dir.join(&filename);

    std::fs::write(&filepath, &bytes).map_err(|e| e.to_string())?;
    Ok(filepath.to_string_lossy().to_string())
}

fn note_attachments_dir(
    app: &tauri::AppHandle,
    sub: &str,
) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("note-attachments")
        .join(sub);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn current_nanos() -> Result<u128, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos())
}

#[tauri::command]
pub fn get_notes(state: State<'_, AppState>) -> Vec<Note> {
    state.notes.lock().all().to_vec()
}

#[tauri::command]
pub fn create_note(state: State<'_, AppState>) -> Note {
    let note = state.notes.lock().create();
    state.notes_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    note
}

#[tauri::command]
pub fn update_note(state: State<'_, AppState>, id: String, title: String, content: String) -> bool {
    let ok = state.notes.lock().update(&id, title, content);
    if ok {
        state.notes_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    ok
}

#[tauri::command]
pub fn delete_note(state: State<'_, AppState>, id: String) -> bool {
    let ok = state.notes.lock().delete(&id);
    if ok {
        state.notes_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    ok
}

#[tauri::command]
pub fn pin_note(state: State<'_, AppState>, id: String) -> bool {
    let ok = state.notes.lock().pin(&id);
    if ok {
        state.notes_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    ok
}

#[tauri::command]
pub fn unpin_note(state: State<'_, AppState>, id: String) -> bool {
    let ok = state.notes.lock().unpin(&id);
    if ok {
        state.notes_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    ok
}

#[tauri::command]
pub fn set_note_groups(state: State<'_, AppState>, id: String, groups: Vec<String>) -> bool {
    let ok = state.notes.lock().set_groups(&id, groups);
    if ok {
        state.notes_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    ok
}

#[tauri::command]
pub fn purge_group_from_notes(state: State<'_, AppState>, group: String) {
    state.notes.lock().purge_group(&group);
    state.notes_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
pub fn rename_group_in_notes(state: State<'_, AppState>, old_name: String, new_name: String) {
    state.notes.lock().rename_group(&old_name, &new_name);
    state.notes_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
}
