//! Platform-specific implementations.
//!
//! The correct submodule is selected at compile time based on the target OS.
//! All platform functions are re-exported at this level so callers only need
//! `crate::runtime::platform::simulate_paste()` etc.
//!
//! Units differ by platform and the callers do not need to know: Windows and
//! Linux report physical pixels, macOS reports points. [`position_at`] turns a
//! pair from this module into the `tauri::Position` that is right for the
//! platform, and `scale_factor_for_point` is `1.0` wherever the unit is
//! already logical.

#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
pub mod linux;

#[cfg(target_os = "macos")]
pub mod macos;

//  Re-export the platform API

#[cfg(windows)]
pub use self::windows::{
    cursor_available, cursor_pos, disable_show_animation, hide_window, scale_factor_for_point,
    show_without_focus, simulate_copy, simulate_paste, work_area_for_point,
};

#[cfg(target_os = "linux")]
pub use self::linux::{
    cursor_available, cursor_pos, scale_factor_for_point, simulate_copy, simulate_paste,
    work_area_for_point,
};

#[cfg(target_os = "macos")]
pub use self::macos::{
    cursor_available, cursor_pos, scale_factor_for_point, simulate_copy, simulate_paste,
    work_area_for_point,
};

//  Cross-platform utilities

/// A point from this module as the position tao should be given: physical
/// pixels on Windows and Linux, logical points on macOS (where tao would
/// otherwise divide a physical position by the scale factor of whichever
/// display the window was parked on, not the one the cursor is on).
pub fn position_at(x: i32, y: i32) -> tauri::Position {
    #[cfg(target_os = "macos")]
    {
        tauri::Position::Logical(tauri::LogicalPosition::new(x as f64, y as f64))
    }
    #[cfg(not(target_os = "macos"))]
    {
        tauri::Position::Physical(tauri::PhysicalPosition::new(x, y))
    }
}

/// Compute the best (x, y) position for a popup of `(popup_w, popup_h)` *logical*
/// pixels so that it appears just below-right of the cursor and stays fully
/// within the monitor work area.
///
/// The work area bounds are in the platform's unit (physical pixels on Windows
/// and Linux, points on macOS), so we first scale the logical popup dimensions
/// into that unit using the monitor scale factor before clamping — this
/// prevents clipping on HiDPI / scaled displays.
pub fn popup_position(popup_w: i32, popup_h: i32) -> (i32, i32) {
    let (cx, cy) = cursor_pos();
    let (wa_left, wa_top, wa_right, wa_bottom) = work_area_for_point(cx, cy);

    // Convert logical popup size → the work area's unit for correct clamping.
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
