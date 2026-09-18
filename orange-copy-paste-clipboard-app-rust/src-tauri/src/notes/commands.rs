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

    let ts = current_nanos();
    let seq = IMAGE_SEQ.fetch_add(1, AtomicOrdering::Relaxed);
    let filename = format!("note_{}_{}.{}", ts, seq, safe_ext);
    let filepath = dir.join(&filename);

    // Atomic: the returned name is embedded in the note body, so a half-written
    // file becomes a permanently broken image in that note.
    crate::health::replace_atomic(&filepath, &bytes).map_err(|e| e.to_string())?;
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

    let safe_name = sanitize_filename(&name, "attachment");

    let ts = current_nanos();
    let seq = IMAGE_SEQ.fetch_add(1, AtomicOrdering::Relaxed);
    let filename = format!("{}_{}_{}", ts, seq, safe_name);
    let filepath = dir.join(&filename);

    crate::health::replace_atomic(&filepath, &bytes).map_err(|e| e.to_string())?;
    Ok(filename)
}

/// Open an attachment with its default app, or reveal it in its folder.
/// `sub` names the store (`images` or `files`) and `filename` a bare name
/// inside it; anything with a path separator is refused so a note cannot
/// point this at an arbitrary file.
#[tauri::command]
pub fn open_note_attachment(
    app: tauri::AppHandle,
    sub: String,
    filename: String,
    reveal: bool,
) -> Result<(), String> {
    if sub != "images" && sub != "files" {
        return Err("unknown attachment store".into());
    }
    if filename.is_empty()
        || filename.contains(['/', '\\'])
        || filename == "."
        || filename == ".."
    {
        return Err("invalid attachment name".into());
    }
    let path = note_attachments_dir(&app, &sub)?.join(&filename);
    if !path.is_file() {
        return Err("attachment is missing".into());
    }
    if reveal {
        reveal_in_folder(&path)
    } else {
        open::that_detached(&path).map_err(|e| e.to_string())
    }
}

fn reveal_in_folder(path: &std::path::Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let dir = path.parent().ok_or("attachment has no folder")?;
        open::that_detached(dir).map_err(|e| e.to_string())
    }
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

fn current_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

/// Replace filesystem-unsafe characters with `_` and trim; returns `fallback`
/// when the result is empty. Allows alphanumeric, `.`, `-`, `_`, and space.
fn sanitize_filename(name: &str, fallback: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim();
    if safe.is_empty() {
        fallback.to_string()
    } else {
        safe.to_string()
    }
}

/// Mark the notes store dirty and propagate the updated note to sync.
fn after_note_update(state: &State<'_, AppState>, id: &str) {
    state
        .notes_dirty
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let note = state.notes.lock().find(id).cloned();
    let sync = state.sync_client.lock().clone();
    if let (Some(note), Some(s)) = (note, sync) {
        s.on_update_note(note);
    }
}

#[tauri::command]
pub fn get_notes(state: State<'_, AppState>) -> Vec<Note> {
    state.notes.lock().all().to_vec()
}

#[tauri::command]
pub fn create_note(state: State<'_, AppState>) -> Note {
    let note = state.notes.lock().create();
    state.notes_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    let sync = state.sync_client.lock().clone();
    if let Some(s) = sync { s.on_new_note(note.clone()); }
    note
}

#[tauri::command]
pub fn update_note(state: State<'_, AppState>, id: String, title: String, content: String) -> bool {
    // A note shared into a space belongs to whoever wrote it. The editor is
    // read-only for those, so reaching here means something bypassed it -
    // refuse rather than let the local copy drift away from the original.
    let sync = state.sync_client.lock().clone();
    if sync.is_some_and(|s| s.is_remote_entry("note", &id)) {
        return false;
    }

    let ok = state.notes.lock().update(&id, title, content);
    if ok {
        after_note_update(&state, &id);
    }
    ok
}

#[tauri::command]
pub fn delete_note(state: State<'_, AppState>, id: String) -> bool {
    // Read before the delete: a note shared into a space leaves a placeholder,
    // and the placeholder sits where the note sat.
    let entry_ts = state.notes.lock().find(&id).map(|n| n.updated_at);
    let ok = state.notes.lock().delete(&id);
    if ok {
        state.notes_dirty.store(true, std::sync::atomic::Ordering::Relaxed);
        let sync = state.sync_client.lock().clone();
        if let Some(s) = sync { s.on_delete_note(id.clone(), entry_ts); }
    }
    ok
}

#[tauri::command]
pub fn pin_note(state: State<'_, AppState>, id: String) -> bool {
    let ok = state.notes.lock().pin(&id);
    if ok {
        after_note_update(&state, &id);
    }
    ok
}

#[tauri::command]
pub fn unpin_note(state: State<'_, AppState>, id: String) -> bool {
    let ok = state.notes.lock().unpin(&id);
    if ok {
        after_note_update(&state, &id);
    }
    ok
}

#[tauri::command]
pub fn set_note_groups(state: State<'_, AppState>, id: String, groups: Vec<String>) -> bool {
    let ok = state.notes.lock().set_groups(&id, groups);
    if ok {
        after_note_update(&state, &id);
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

    let safe = sanitize_filename(&filename, "note.md");

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
