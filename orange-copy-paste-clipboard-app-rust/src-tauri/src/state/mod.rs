//! Shared application state.
//!
//! `AppState` is managed by Tauri and injected into command handlers.
//! Constants, timing helpers, and event payloads live in the submodules.

pub mod app_state;
pub mod popup_state;

pub use app_state::AppState;

pub(crate) use popup_state::{
    paste_popup_fit_height, CopyPopupPayload, NotificationPayload, PastePopupPayload, COPY_POPUP_H,
    COPY_POPUP_W, NOTIF_H, NOTIF_W, PASTE_HISTORY_CAP, PASTE_POPUP_H, PASTE_POPUP_W,
    PASTE_POPUP_W_WIDE,
};
