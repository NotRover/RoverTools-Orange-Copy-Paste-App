//! Platform-specific implementations.
//!
//! The correct submodule is selected at compile time based on the target OS.
//! All platform functions are re-exported at this level so callers only need
//! `crate::runtime::platform::simulate_paste()` etc.

#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
mod linux;

//  Re-export the platform API

#[cfg(windows)]
pub use self::windows::{
    cursor_available, cursor_pos, scale_factor_for_point, simulate_copy, simulate_paste,
    work_area_for_point,
};

#[cfg(target_os = "linux")]
pub use self::linux::{
    cursor_available, cursor_pos, scale_factor_for_point, simulate_copy, simulate_paste,
    work_area_for_point,
};

//  Cross-platform utilities

/// Compute the best (x, y) position for a popup of `(popup_w, popup_h)` *logical*
/// pixels so that it appears just below-right of the cursor and stays fully
/// within the monitor work area.
///
/// The work area bounds are in physical pixels (from Win32), so we first scale
/// the logical popup dimensions to physical pixels using the monitor DPI before
/// clamping — this prevents clipping on HiDPI / scaled displays.
pub fn popup_position(popup_w: i32, popup_h: i32) -> (i32, i32) {
    let (cx, cy) = cursor_pos();
    let (wa_left, wa_top, wa_right, wa_bottom) = work_area_for_point(cx, cy);

    // Convert logical popup size → physical pixels for correct clamping.
    let scale = scale_factor_for_point(cx, cy);
    let phys_w = (popup_w as f64 * scale).round() as i32;
    let phys_h = (popup_h as f64 * scale).round() as i32;

    let px = (cx + 8).max(wa_left).min(wa_right - phys_w);
    let py = (cy + 8).max(wa_top).min(wa_bottom - phys_h);
    (px, py)
}

/// Position for a notification toast: bottom-right corner of the work area
/// on the monitor containing the cursor, with a small margin above the taskbar.
pub fn notification_position(popup_w: i32, popup_h: i32) -> (i32, i32) {
    let (cx, cy) = cursor_pos();
    let (_wa_left, _wa_top, wa_right, wa_bottom) = work_area_for_point(cx, cy);

    let scale = scale_factor_for_point(cx, cy);
    let phys_w = (popup_w as f64 * scale).round() as i32;
    let phys_h = (popup_h as f64 * scale).round() as i32;
    let margin = (12.0 * scale).round() as i32;

    (wa_right - phys_w - margin, wa_bottom - phys_h - margin)
}
