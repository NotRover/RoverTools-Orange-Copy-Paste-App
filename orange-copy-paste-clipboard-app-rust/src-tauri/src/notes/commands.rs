//! Tauri commands for notes management.

use crate::notes::store::Note;
use crate::AppState;
use tauri::State;

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
