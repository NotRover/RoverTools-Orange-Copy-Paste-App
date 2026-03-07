use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::Emitter;

use crate::clipboard::commands::read_clipboard_entry;
use crate::clipboard::history::{ClipboardEntry, ClipboardHistory};

const WATCH_INTERVAL_MS: u64 = 220;

#[cfg(windows)]
fn clipboard_change_token() -> u32 {
    unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

#[cfg(not(windows))]
fn clipboard_change_token() -> u32 {
    0
}

fn is_duplicate_top(history: &ClipboardHistory, entry: &ClipboardEntry) -> bool {
    history
        .top(1)
        .first()
        .map(|top| top.kind == entry.kind && top.content == entry.content)
        .unwrap_or(false)
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

    let Some(entry) = read_clipboard_entry() else {
        // Could not read the clipboard (locked by another app, etc.).
        // Signal the caller to keep the old token so we retry next cycle.
        return false;
    };

    let maybe_new_entry = {
        let mut hist = history.lock();
        if is_duplicate_top(&hist, &entry) {
            None
        } else {
            Some(hist.push(entry))
        }
    };

    if let Some(new_entry) = maybe_new_entry {
        let _ = app.emit("clipboard:new-entry", &new_entry);
    }
    true
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

            let token = clipboard_change_token();

            #[cfg(windows)]
            {
                if token == last_token {
                    continue;
                }

                // Only advance the token when capture succeeded.  If the
                // clipboard was locked (read returned None) we keep the old
                // token so the next poll will retry this change.
                if capture_clipboard_change(&app, &history, &suppress) {
                    last_token = token;
                }
            }

            #[cfg(not(windows))]
            {
                let _ = token;
                capture_clipboard_change(&app, &history, &suppress);
            }
        }
    });
}
