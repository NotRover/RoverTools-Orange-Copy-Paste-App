//! Clipboard-related constants, timing helpers, and event payloads.

use crate::clipboard::history::ClipboardEntry;

//  Popup dimensions

pub(crate) const COPY_POPUP_W: f64 = 340.0;
pub(crate) const COPY_POPUP_H: f64 = 260.0;

pub(crate) const PASTE_POPUP_W: f64 = 340.0;
pub(crate) const PASTE_POPUP_H: f64 = 460.0;

pub(crate) const COPY_NOTIF_W: f64 = 220.0;
pub(crate) const COPY_NOTIF_H: f64 = 72.0;

//  Event payloads

/// Payload emitted with the `"clipboard:copied"` event to the copy-popup
/// window so it can render an appropriate preview (text or image).
#[derive(serde::Serialize, Clone)]
pub(crate) struct CopyPopupPayload {
    /// The history entry ID so the popup can pin/delete without a separate `get_history` call.
    pub id: String,
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

/// Payload emitted with the `"copy-notification:show"` event.
#[derive(serde::Serialize, Clone)]
pub(crate) struct CopyNotificationPayload {
    pub kind: String,
    /// `"Copied"` or `"Pasted"` — displayed as the notification label.
    pub action: String,
}
