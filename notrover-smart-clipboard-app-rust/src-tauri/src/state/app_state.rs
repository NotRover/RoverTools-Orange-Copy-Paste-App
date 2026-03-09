//! Tauri-managed application state injected into command handlers.

use parking_lot::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::clipboard::history::ClipboardHistory;

/// State managed by Tauri and injected into every command handler.
pub struct AppState {
    /// Thread-safe clipboard history (most-recent first).
    pub history: Arc<Mutex<ClipboardHistory>>,
    /// When `true`, the clipboard watcher skips the next detected change
    /// (used to suppress re-adding an entry that was written back to the
    /// clipboard by `copy_entry` / `paste_entry`).
    pub suppress_next_capture: Arc<AtomicBool>,
    /// Cached mirror of the `keep_history` setting.  Checked on every
    /// clipboard mutation — an atomic load is ~1 ns vs ~0.5 ms for a disk read.
    pub keep_history: Arc<AtomicBool>,
    /// Set to `true` whenever the in-memory history diverges from the on-disk
    /// `history.json`.  A background thread periodically flushes when dirty.
    pub history_dirty: Arc<AtomicBool>,
    /// When `true`, closing the main window hides it to the system tray
    /// instead of quitting the app.
    pub close_to_tray: Arc<AtomicBool>,
    /// When `true`, the app starts hidden (minimized to tray).
    pub start_minimized: Arc<AtomicBool>,
    /// When `true`, a small toast is shown at the bottom-right of the screen
    /// whenever new clipboard content is captured.
    pub copy_notification: Arc<AtomicBool>,
    /// When `true`, show notifications for copy operations.
    pub notif_copy: Arc<AtomicBool>,
    /// When `true`, every new clipboard entry is automatically added to the
    /// "Saved" group so it persists across restarts.
    pub autosave: Arc<AtomicBool>,
}
