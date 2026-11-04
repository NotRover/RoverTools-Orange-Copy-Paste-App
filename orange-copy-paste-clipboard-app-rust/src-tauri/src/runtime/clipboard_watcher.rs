use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{Emitter, Manager};

use crate::clipboard::commands::{read_clipboard_capture, Capture};
use crate::clipboard::history::{ClipboardEntry, ClipboardHistory};
use crate::state::app_state::AppState;

const WATCH_INTERVAL_MS: u64 = 220;

/// A number the OS bumps on every clipboard write, where it keeps one: the
/// Win32 sequence number, the macOS pasteboard change count, and on Linux/X11
/// a count of the GTK clipboard's `owner-change` signals. Comparing it is far
/// cheaper than reading the clipboard, so the watcher only reads when it
/// changes. `None` where there is no such counter (Wayland, and X11 until the
/// first change is seen), and the watcher reads every cycle and relies on
/// the top-of-history dedupe instead.
#[cfg(windows)]
fn clipboard_change_token() -> Option<u64> {
    Some(unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() } as u64)
}

#[cfg(target_os = "macos")]
fn clipboard_change_token() -> Option<u64> {
    Some(crate::runtime::platform::macos::clipboard_change_count())
}

#[cfg(target_os = "linux")]
fn clipboard_change_token() -> Option<u64> {
    crate::runtime::platform::linux::clipboard_change_token()
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
fn clipboard_change_token() -> Option<u64> {
    None
}

/// Attempt to capture the current clipboard content into history.
///
/// Returns `true` when the change was handled (pushed, deduplicated, or
/// intentionally suppressed) and the caller should advance `last_token`.
/// Returns `false` when the clipboard could not be read (e.g. locked by
/// another application) so the caller should **not** advance the token and
/// retry on the next poll.
fn capture_clipboard_change(
    app: &tauri::AppHandle,
    history: &Arc<Mutex<ClipboardHistory>>,
    suppress: &Arc<AtomicBool>,
) -> bool {
    // If a copy_entry / paste_entry / copy-shortcut just wrote to the
    // clipboard, skip this capture so we don't re-add the entry as a
    // duplicate.  This counts as "handled".
    if suppress.swap(false, Ordering::Relaxed) {
        return true;
    }

    let entry = match read_clipboard_capture() {
        Capture::Entry(entry) => entry,
        Capture::TooLarge { what, bytes } => {
            // Handled, so the token advances: a payload left sitting on the
            // clipboard is measured once, not once every poll.
            crate::clipboard::commands::notify_capture_too_large(app, what, bytes);
            return true;
        }
        // Could not read the clipboard (locked by another app, etc.).
        // Signal the caller to keep the old token so we retry next cycle.
        Capture::Nothing => return false,
    };

    if history.lock().top_matches(&entry) {
        return true;
    }

    // The image just read was decoded and re-encoded on the way in; give the
    // freed heap back before it sits in the process for the rest of the day.
    #[cfg(target_os = "linux")]
    if entry.kind == crate::clipboard::history::EntryKind::Image {
        crate::runtime::platform::linux::release_free_memory();
    }

    // The toast goes up before anything touches the disk. A push writes its
    // row through to the database, and with it the "Saved" group and the sync
    // queue, each a committed transaction; put after those, the popup lagged
    // the copy by every fsync in between. It only needs the kind, which is
    // known here. The lock is not held across it: the window calls below hop
    // to the main thread, which may itself be waiting on the history.
    crate::runtime::notifications::notify_if_enabled(app, &entry);

    let (new_entry, inserted) = history.lock().push_if_distinct_with_flag(entry);
    if inserted {
        crate::clipboard::commands::set_active_clipboard_id(app, &new_entry.id);
        after_new_entry(app, history, &new_entry);
    }
    true
}

/// Post-capture bookkeeping shared by the watcher and the copy shortcut:
/// autosave grouping, frontend event, debounced persistence, and the sync
/// hook (invariant: only called after a confirmed push into history — the
/// SyncClient does all network work).
pub(crate) fn after_new_entry(
    app: &tauri::AppHandle,
    history: &Arc<Mutex<ClipboardHistory>>,
    entry: &ClipboardEntry,
) {
    let state: tauri::State<'_, AppState> = app.state();
    // If autosave is enabled, add the "Saved" group to the new entry.
    if state.autosave.load(Ordering::Relaxed) {
        history.lock().add_group(&entry.id, "Saved");
    }
    crate::clipboard::commands::allow_entry_assets(app, entry);
    let _ = app.emit("clipboard:new-entry", entry);
    let sync = state.sync_client.lock().clone();
    if let Some(s) = sync {
        s.on_new_clipboard_entry(entry.clone());
    }
}

pub(crate) fn start_clipboard_watcher(
    app: &tauri::AppHandle,
    history: Arc<Mutex<ClipboardHistory>>,
    suppress: Arc<AtomicBool>,
) {
    let app = app.clone();

    std::thread::spawn(move || {
        let mut last_token = clipboard_change_token();

        loop {
            std::thread::sleep(std::time::Duration::from_millis(WATCH_INTERVAL_MS));

            // With a change token, an unchanged clipboard costs one system
            // call per cycle and no read. Without one (`None` on both sides),
            // every cycle reads.
            let token = clipboard_change_token();
            if token.is_some() && token == last_token {
                continue;
            }

            // Only advance the token when capture succeeded.  If the
            // clipboard was locked (read returned None) we keep the old
            // token so the next poll will retry this change.
            if capture_clipboard_change(&app, &history, &suppress) {
                last_token = token;
            }
        }
    });
}
