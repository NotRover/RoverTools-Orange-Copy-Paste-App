//! Clipboard-related constants, timing helpers, and event payloads.

use crate::clipboard::history::ClipboardEntry;

//  Popup dimensions

pub(crate) const COPY_POPUP_W: f64 = 340.0;
pub(crate) const COPY_POPUP_H: f64 = 260.0;

/// List-only width (side preview collapsed).
pub(crate) const PASTE_POPUP_W: f64 = 360.0;
/// Width when the side preview panel is open.
pub(crate) const PASTE_POPUP_W_WIDE: f64 = 540.0;
pub(crate) const PASTE_POPUP_H: f64 = 540.0;

// Height budget for the paste popup, mirroring PastePopup.tsx so the window can
// be shown at its final content height instead of a fixed size that React then
// shrinks a frame later (the visible resize flash). These MUST match the JS
// constants of the same name in `src/components/paste-popup/PastePopup.tsx`.
const PASTE_CHROME_H: f64 = 138.0; // header + search + hints + padding
const PASTE_ITEM_H: f64 = 44.0; // one list row
const PASTE_LIST_MAX_H: f64 = 8.0 * PASTE_ITEM_H; // list scrolls past this
const PASTE_MIN_LIST_H: f64 = 84.0;
const PASTE_PREVIEW_MIN_H: f64 = 286.0; // keep the side preview panel tall enough

/// The height the paste popup will settle at for `recent_count` rows in the
/// (default) Recent tab, with the side preview open or closed. Same formula as
/// the popup's own resize effect, so showing at this height means the popup does
/// not visibly resize on open.
pub(crate) fn paste_popup_fit_height(recent_count: usize, preview_open: bool) -> f64 {
    let list_h = if recent_count > 0 {
        (recent_count as f64 * PASTE_ITEM_H).min(PASTE_LIST_MAX_H)
    } else {
        PASTE_MIN_LIST_H
    };
    let body_h = if preview_open {
        list_h.max(PASTE_PREVIEW_MIN_H)
    } else {
        list_h
    };
    PASTE_CHROME_H + body_h
}

/// How many recent entries to hand the paste popup. The popup renders a
/// scrollable list and searches within what it is given, so this is the reach
/// of its search, not just what's on screen. Pinned entries are sent in full
/// (there can be at most `MAX_PINNED`).
pub(crate) const PASTE_HISTORY_CAP: usize = 200;

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
    /// The entry's current state, sent up front so the popup renders its chips on
    /// the first paint instead of fetching them after it is already on screen.
    pub pinned: bool,
    pub groups: Vec<String>,
    /// Space ids this entry is already shared into (empty for a fresh capture).
    pub shares: Vec<String>,
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
