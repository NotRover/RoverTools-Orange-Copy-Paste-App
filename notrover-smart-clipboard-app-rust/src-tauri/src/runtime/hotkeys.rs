use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, ShortcutState};

use crate::clipboard::commands::read_clipboard_entry;
use crate::{
    clipboard::history::{ClipboardEntry, ClipboardHistory, EntryKind},
    runtime::platform,
    state::{CursorPopupPayload, CURSOR_POPUP_H, CURSOR_POPUP_W, PASTE_POPUP_H, PASTE_POPUP_W},
};

fn copy_shortcut() -> tauri_plugin_global_shortcut::Shortcut {
    tauri_plugin_global_shortcut::Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::SHIFT),
        Code::KeyC,
    )
}

fn paste_shortcut() -> tauri_plugin_global_shortcut::Shortcut {
    tauri_plugin_global_shortcut::Shortcut::new(
        Some(Modifiers::CONTROL | Modifiers::SHIFT),
        Code::KeyV,
    )
}

fn toggle_popup_if_visible(app: &tauri::AppHandle, label: &str) -> bool {
    if let Some(win) = app.get_webview_window(label) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            return true;
        }
    }

    false
}

fn entry_kind_label(kind: &EntryKind) -> &'static str {
    match kind {
        EntryKind::Text => "text",
        EntryKind::Image => "image",
        EntryKind::File => "file",
    }
}

fn show_cursor_popup(app: &tauri::AppHandle, entry: &ClipboardEntry) {
    let (px, py) = platform::popup_position(CURSOR_POPUP_W as i32, CURSOR_POPUP_H as i32);

    if let Some(win) = app.get_webview_window("cursor-popup") {
        let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
        let payload = CursorPopupPayload {
            kind: entry_kind_label(&entry.kind).to_string(),
            content: entry.content.clone(),
        };
        let _ = win.emit("clipboard:copied", &payload);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn register_copy_shortcut(
    app_handle: &tauri::AppHandle,
    history: Arc<Mutex<ClipboardHistory>>,
) -> Result<(), Box<dyn std::error::Error>> {
    let ah_copy = app_handle.clone();
    let hist_copy = Arc::clone(&history);
    let sc_copy = copy_shortcut();

    let _ = app_handle.global_shortcut().unregister(sc_copy);

    app_handle
        .global_shortcut()
        .on_shortcut(sc_copy, move |_app, _sc, event| {
            if event.state() == ShortcutState::Pressed {
                handle_copy_shortcut(ah_copy.clone(), Arc::clone(&hist_copy));
            }
        })?;

    Ok(())
}

fn register_paste_shortcut(
    app_handle: &tauri::AppHandle,
    history: Arc<Mutex<ClipboardHistory>>,
) -> Result<(), Box<dyn std::error::Error>> {
    let ah_paste = app_handle.clone();
    let sc_paste = paste_shortcut();

    let _ = app_handle.global_shortcut().unregister(sc_paste);

    app_handle
        .global_shortcut()
        .on_shortcut(sc_paste, move |_app, _sc, event| {
            if event.state() == ShortcutState::Pressed {
                handle_paste_shortcut(ah_paste.clone(), Arc::clone(&history));
            }
        })?;

    Ok(())
}

/// Register `Ctrl+Shift+C` (copy popup) and `Ctrl+Shift+V` (paste popup).
pub(crate) fn register_global_shortcuts(
    app: &tauri::App,
    history: Arc<Mutex<ClipboardHistory>>,
) -> Result<(), Box<dyn std::error::Error>> {
    let app_handle = app.handle().clone();

    register_copy_shortcut(&app_handle, Arc::clone(&history))?;
    register_paste_shortcut(&app_handle, history)?;

    Ok(())
}

fn handle_copy_shortcut(app: tauri::AppHandle, history: Arc<Mutex<ClipboardHistory>>) {
    if toggle_popup_if_visible(&app, "cursor-popup") {
        return;
    }

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));

        platform::simulate_copy();

        std::thread::sleep(std::time::Duration::from_millis(120));

        let entry = read_clipboard_entry();

        let Some(entry) = entry else {
            return;
        };

        let (entry, inserted): (ClipboardEntry, bool) = {
            let mut hist = history.lock();
            hist.push_if_distinct_with_flag(entry)
        };

        if inserted {
            let _ = app.emit("clipboard:new-entry", &entry);
        }
        show_cursor_popup(&app, &entry);
    });
}

fn handle_paste_shortcut(app: tauri::AppHandle, history: Arc<Mutex<ClipboardHistory>>) {
    if toggle_popup_if_visible(&app, "paste-popup") {
        return;
    }

    let entries = history.lock().top(3);

    let (px, py) = platform::popup_position(PASTE_POPUP_W as i32, PASTE_POPUP_H as i32);

    if let Some(win) = app.get_webview_window("paste-popup") {
        let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
        let _ = win.emit("paste-popup:entries", &entries);
        let _ = win.show();
    }
}
