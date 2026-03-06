//! Clipboard-related constants, timing helpers, and event payloads.

use crate::clipboard::history::ClipboardEntry;

//  Popup dimensions

pub(crate) const CURSOR_POPUP_W: f64 = 340.0;
pub(crate) const CURSOR_POPUP_H: f64 = 260.0;

pub(crate) const PASTE_POPUP_W: f64 = 340.0;
pub(crate) const PASTE_POPUP_H: f64 = 380.0;

//  Event payloads

/// Payload emitted with the `"clipboard:copied"` event to the cursor-popup
/// window so it can render an appropriate preview (text or image).
#[derive(serde::Serialize, Clone)]
pub(crate) struct CursorPopupPayload {
    /// `"text"` or `"image"`
    pub kind: String,
    /// For text: the plain-text content. For images: the `data:image/png;base64,…` URL.
    pub content: String,
}

/// Payload emitted with the `"paste-popup:entries"` event.
#[derive(serde::Serialize, Clone)]
pub(crate) struct PastePopupPayload {
    pub recent: Vec<ClipboardEntry>,
    pub pinned: Vec<ClipboardEntry>,
}
