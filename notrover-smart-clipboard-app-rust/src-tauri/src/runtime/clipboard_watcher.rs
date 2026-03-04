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

fn capture_clipboard_change(app: &tauri::AppHandle, history: &Arc<Mutex<ClipboardHistory>>) {
    let Some(entry) = read_clipboard_entry() else {
        return;
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
}

pub(crate) fn start_clipboard_watcher(
    app: &tauri::AppHandle,
    history: Arc<Mutex<ClipboardHistory>>,
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

                last_token = token;
                capture_clipboard_change(&app, &history);
            }

            #[cfg(not(windows))]
            {
                let _ = token;
                capture_clipboard_change(&app, &history);
            }
        }
    });
}
