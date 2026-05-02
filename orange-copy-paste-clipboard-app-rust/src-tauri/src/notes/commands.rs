//! Tauri commands for notes management.

use crate::notes::store::Note;
use crate::AppState;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};

/// Counter to disambiguate filenames generated within the same nanosecond.
static IMAGE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Persist a pasted/dropped image to `app_data/note-attachments/images/`.
/// Returns just the filename — the frontend turns
/// `note-attachment://<filename>` into a real `tauri-asset:` URL at render
/// time, keeping the markdown source clean and short.
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
    Ok(filename)
}

/// Persist a non-image attachment (PDF, doc, zip, …) to
/// `app_data/note-attachments/files/`. Returns just the filename; the
/// frontend stores `note-file://<filename>` and resolves it for display.
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
    Ok(filename)
}

/// Returns the absolute paths of the note-attachment directories so the
/// frontend can build `tauri-asset:` URLs for files referenced in markdown
/// via the `note-attachment://` and `note-file://` schemes.
#[tauri::command]
pub fn get_note_attachments_dirs(
    app: tauri::AppHandle,
) -> Result<NoteAttachmentDirs, String> {
    let images = note_attachments_dir(&app, "images")?;
    let files = note_attachments_dir(&app, "files")?;
    Ok(NoteAttachmentDirs {
        images: images.to_string_lossy().to_string(),
        files: files.to_string_lossy().to_string(),
    })
}

#[derive(serde::Serialize)]
pub struct NoteAttachmentDirs {
    pub images: String,
    pub files: String,
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

/// Export note content as a text file saved to the user's Downloads folder.
/// Returns the absolute path of the saved file.
#[tauri::command]
pub fn export_note_text(
    app: tauri::AppHandle,
    text: String,
    filename: String,
) -> Result<String, String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;

    // Sanitize filename: allow alphanumeric, space, dash, underscore, dot.
    let safe: String = filename
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' || c == '.' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim().to_string();
    let safe = if safe.is_empty() { "note.md".to_string() } else { safe };

    // Ensure .md extension.
    let fname = if safe.ends_with(".md") || safe.ends_with(".txt") {
        safe
    } else {
        format!("{}.md", safe)
    };

    // Avoid overwriting: append a counter if the file exists.
    let mut path = dir.join(&fname);
    let mut counter = 1u32;
    while path.exists() {
        let stem = fname.trim_end_matches(".md").trim_end_matches(".txt");
        let ext = if fname.ends_with(".txt") { "txt" } else { "md" };
        path = dir.join(format!("{} ({}).{}", stem, counter, ext));
        counter += 1;
    }

    std::fs::write(&path, text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}
