//! Tauri-managed application state injected into command handlers.

use parking_lot::Mutex;
use std::sync::Arc;

use crate::clipboard::history::ClipboardHistory;

/// State managed by Tauri and injected into every command handler.
pub struct AppState {
    /// Thread-safe clipboard history (most-recent first).
    pub history: Arc<Mutex<ClipboardHistory>>,
}
