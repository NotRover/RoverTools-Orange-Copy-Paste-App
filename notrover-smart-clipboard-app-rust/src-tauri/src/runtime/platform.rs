//! Platform-specific implementations.
//!
//! The correct submodule is selected at compile time based on the target OS.
//! All platform functions are re-exported at this level so callers only need
//! `crate::runtime::platform::simulate_paste()` etc.

#[cfg(windows)]
#[path = "platform_windows.rs"]
mod platform_windows;

// ── Re-export the platform API ────────────────────────────────────────────────

#[cfg(windows)]
pub use self::platform_windows::{cursor_pos, simulate_copy, simulate_paste, work_area_for_point};

// ── Cross-platform utilities ──────────────────────────────────────────────────

/// Compute the best (x, y) position for a popup of `(width, height)` pixels
/// so that it appears just below-right of the cursor and stays within the
/// monitor work area.
pub fn popup_position(popup_w: i32, popup_h: i32) -> (i32, i32) {
    let (cx, cy) = cursor_pos();
    let (wa_left, wa_top, wa_right, wa_bottom) = work_area_for_point(cx, cy);

    let px = (cx + 8).max(wa_left).min(wa_right - popup_w);
    let py = (cy + 8).max(wa_top).min(wa_bottom - popup_h);
    (px, py)
}
