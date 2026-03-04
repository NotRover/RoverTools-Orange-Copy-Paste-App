//! Shared application state.
//!
//! `AppState` is managed by Tauri and injected into command handlers.
//! Constants, timing helpers, and event payloads live in the submodules.

pub mod app_state;
pub mod popup_state;

pub use app_state::AppState;

pub(crate) use popup_state::{
    CursorPopupPayload, CURSOR_POPUP_H, CURSOR_POPUP_W, PASTE_POPUP_H, PASTE_POPUP_W,
};
