//! Tauri command handlers for clipboard history operations, plus internal
//! helpers for reading and writing clipboard content.

use std::borrow::Cow;

use arboard::Clipboard;
use tauri::State;

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
pub fn delete_entry(id: String, state: State<'_, AppState>) -> bool {
    state.history.lock().remove(&id)
}

#[tauri::command]
pub fn clear_history(state: State<'_, AppState>) -> bool {
    state.history.lock().clear();
    true
}

#[tauri::command]
pub fn copy_entry(id: String, state: State<'_, AppState>) -> bool {
    let entry = find_entry_by_id(&state, &id);

    let Some(entry) = entry else { return false };

    write_entry_to_clipboard(&entry).is_ok()
}

#[tauri::command]
pub fn paste_entry(id: String, state: State<'_, AppState>, app: tauri::AppHandle) -> bool {
    let entry = find_entry_by_id(&state, &id);

    let Some(entry) = entry else { return false };

    if write_entry_to_clipboard(&entry).is_err() {
        return false;
    }

    hide_popup(&app, "paste-popup");
    schedule_paste();

    true
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

    #[cfg(windows)]
    if crate::clipboard::files::any_file_format_available() {
        if let Some(paths) = read_files_from_clipboard() {
            return Some(ClipboardEntry::new_file(files_to_content(&paths)));
        }
    }

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
