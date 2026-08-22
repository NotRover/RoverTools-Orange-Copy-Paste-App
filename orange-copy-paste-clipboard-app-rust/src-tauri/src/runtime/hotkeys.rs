use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, ShortcutState};

use crate::clipboard::commands::{read_clipboard_capture, Capture};
use crate::{
    clipboard::history::{ClipboardEntry, ClipboardHistory},
    runtime::platform,
    state::{
        CopyPopupPayload, PastePopupPayload, COPY_POPUP_H, COPY_POPUP_W, PASTE_POPUP_H,
        PASTE_POPUP_W,
    },
};

/// `Ctrl+Shift+<code>` global shortcut.
fn ctrl_shift(code: Code) -> tauri_plugin_global_shortcut::Shortcut {
    tauri_plugin_global_shortcut::Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), code)
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

fn show_copy_popup(app: &tauri::AppHandle, entry: &ClipboardEntry) {
    if let Some(win) = app.get_webview_window("copy-popup") {
        crate::runtime::popup_windows::place_popup_for_show(
            &win,
            COPY_POPUP_W as i32,
            COPY_POPUP_H as i32,
        );
        let payload = CopyPopupPayload {
            id: entry.id.clone(),
            kind: entry.kind.label().to_string(),
            content: entry.content.clone(),
        };
        let _ = win.emit("clipboard:copied", &payload);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Register `Ctrl+Shift+C` (copy popup) and `Ctrl+Shift+V` (paste popup).
pub(crate) fn register_global_shortcuts(
    app: &tauri::App,
    history: Arc<Mutex<ClipboardHistory>>,
    suppress: Arc<AtomicBool>,
) -> Result<(), Box<dyn std::error::Error>> {
    let gs = app.global_shortcut();

    let sc_copy = ctrl_shift(Code::KeyC);
    let _ = gs.unregister(sc_copy);
    let ah = app.handle().clone();
    let hist = Arc::clone(&history);
    gs.on_shortcut(sc_copy, move |_app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            handle_copy_shortcut(ah.clone(), Arc::clone(&hist), Arc::clone(&suppress));
        }
    })?;

    let sc_paste = ctrl_shift(Code::KeyV);
    let _ = gs.unregister(sc_paste);
    let ah = app.handle().clone();
    gs.on_shortcut(sc_paste, move |_app, _sc, event| {
        if event.state() == ShortcutState::Pressed {
            handle_paste_shortcut(ah.clone(), Arc::clone(&history));
        }
    })?;

    Ok(())
}

fn handle_copy_shortcut(
    app: tauri::AppHandle,
    history: Arc<Mutex<ClipboardHistory>>,
    suppress: Arc<AtomicBool>,
) {
    if toggle_popup_if_visible(&app, "copy-popup") {
        return;
    }

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));

        // Tell the clipboard watcher to skip the next detected change so it
        // doesn't race with us to push the same entry.
        suppress.store(true, Ordering::Relaxed);
        platform::simulate_copy();

        std::thread::sleep(std::time::Duration::from_millis(120));

        let entry = match read_clipboard_capture() {
            Capture::Entry(entry) => entry,
            Capture::TooLarge { what, bytes } => {
                // No entry to confirm, so the copy popup would have nothing to
                // show; the notification carries the news instead.
                crate::clipboard::commands::notify_capture_too_large(&app, what, bytes);
                return;
            }
            Capture::Nothing => return,
        };

        let (entry, inserted): (ClipboardEntry, bool) = {
            let mut hist = history.lock();
            hist.push_if_distinct_with_flag(entry)
        };

        if inserted {
            // Ctrl+Shift+C entries bypass the watcher (suppress flag is set),
            // so run the shared post-capture bookkeeping here directly.
            crate::runtime::clipboard_watcher::after_new_entry(&app, &history, &entry);
        }
        crate::clipboard::commands::set_active_clipboard_id(&app, &entry.id);
        show_copy_popup(&app, &entry);
    });
}

/// Fire the copy-popup flow from a source other than the OS global shortcut —
/// used by the `--trigger copy` CLI invocation (the Wayland fallback where the
/// compositor doesn't deliver global hotkeys to the app). Pulls the shared
/// history + suppress flag from app state so it runs the *identical* path to
/// the registered `Ctrl+Shift+C` handler, including the watcher-suppress dance.
pub(crate) fn trigger_copy_popup(app: &tauri::AppHandle) {
    let state = app.state::<crate::state::app_state::AppState>();
    let history = Arc::clone(&state.history);
    let suppress = Arc::clone(&state.suppress_next_capture);
    handle_copy_shortcut(app.clone(), history, suppress);
}

/// Fire the paste-popup flow from the `--trigger paste` CLI invocation — the
/// Wayland counterpart to the `Ctrl+Shift+V` handler.
pub(crate) fn trigger_paste_popup(app: &tauri::AppHandle) {
    let state = app.state::<crate::state::app_state::AppState>();
    let history = Arc::clone(&state.history);
    handle_paste_shortcut(app.clone(), history);
}

fn handle_paste_shortcut(app: tauri::AppHandle, history: Arc<Mutex<ClipboardHistory>>) {
    if toggle_popup_if_visible(&app, "paste-popup") {
        return;
    }

    let hist = history.lock();
    let payload = PastePopupPayload {
        recent: hist.top(10),
        pinned: hist.pinned_entries().into_iter().take(10).collect(),
    };
    drop(hist);

    if let Some(win) = app.get_webview_window("paste-popup") {
        crate::runtime::popup_windows::place_popup_for_show(
            &win,
            PASTE_POPUP_W as i32,
            PASTE_POPUP_H as i32,
        );
        let _ = win.emit("paste-popup:entries", &payload);
        let _ = win.show();
        let _ = win.set_focus();
    }
}
