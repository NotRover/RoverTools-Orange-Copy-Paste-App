//! Clipboard-related constants, timing helpers, and event payloads.

// ── Popup dimensions ─────────────────────────────────────────────────────────

pub(crate) const CURSOR_POPUP_W: f64 = 340.0;
pub(crate) const CURSOR_POPUP_H: f64 = 260.0;

pub(crate) const PASTE_POPUP_W: f64 = 300.0;
pub(crate) const PASTE_POPUP_H: f64 = 200.0;

// ── Event payloads ───────────────────────────────────────────────────────────

/// Payload emitted with the `"clipboard:copied"` event to the cursor-popup
/// window so it can render an appropriate preview (text or image).
#[derive(serde::Serialize, Clone)]
pub(crate) struct CursorPopupPayload {
    /// `"text"` or `"image"`
    pub kind: String,
    /// For text: the plain-text content. For images: the `data:image/png;base64,…` URL.
    pub content: String,
}
