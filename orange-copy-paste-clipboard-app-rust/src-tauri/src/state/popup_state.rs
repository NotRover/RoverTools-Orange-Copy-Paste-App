//! Clipboard-related constants, timing helpers, and event payloads.

use crate::clipboard::history::ClipboardEntry;

//  Popup dimensions

pub(crate) const COPY_POPUP_W: f64 = 340.0;
pub(crate) const COPY_POPUP_H: f64 = 260.0;

pub(crate) const PASTE_POPUP_W: f64 = 340.0;
pub(crate) const PASTE_POPUP_H: f64 = 460.0;

// Wide and tall enough for the two-line refusal toast. The window anchors
// bottom-right and the pill inside it is bottom-aligned, so the one-line
// copy/paste toasts sit exactly where they always did.
pub(crate) const NOTIF_W: f64 = 320.0;
pub(crate) const NOTIF_H: f64 = 104.0;

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

/// Payload emitted with the `"notification:show"` event.
#[derive(serde::Serialize, Clone)]
pub(crate) struct NotificationPayload {
    pub kind: String,
    /// `"Copied"`, `"Pasted"` or `"Too large"` — displayed as the label.
    pub action: String,
    /// Shown in place of the kind when the kind alone does not explain the
    /// message: a refused copy says how big it was instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Second line, for a toast that has to say why. Only a refused copy sets
    /// one: "too large" on its own reads as "the copy failed", and what
    /// actually happened is that history skipped it while the system clipboard
    /// kept it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}
