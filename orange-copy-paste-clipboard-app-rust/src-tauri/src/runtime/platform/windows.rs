//! Windows-specific clipboard monitoring, keystroke simulation,
//! and cursor/monitor helpers.
//!
//! # Safety
//! All functions call Win32 APIs through `unsafe` blocks.
//! They are safe to call from any thread.

use windows_sys::Win32::{
    Foundation::POINT,
    Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    UI::{
        HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI},
        Input::KeyboardAndMouse::{keybd_event, KEYEVENTF_KEYUP, VK_CONTROL, VK_SHIFT},
        WindowsAndMessaging::GetCursorPos,
    },
};

// Key simulation

/// Fire a single `keybd_event` call.
unsafe fn key_event(vk: u16, flags: u32) {
    keybd_event(vk as u8, 0, flags, 0);
}

/// Simulate **Ctrl + C** in the currently focused application.
///
/// First releases Shift and Ctrl (the user may still be holding them from the
/// Ctrl+Shift+C global shortcut), then sends a clean Ctrl+C down/up sequence.
pub fn simulate_copy() {
    unsafe {
        // Release Shift / Ctrl in case the user is still holding them.
        key_event(VK_SHIFT, KEYEVENTF_KEYUP);
        key_event(VK_CONTROL, KEYEVENTF_KEYUP);
        // Ctrl ↓  C ↓  C ↑  Ctrl ↑
        key_event(VK_CONTROL, 0);
        key_event(0x43, 0); // 'C'
        key_event(0x43, KEYEVENTF_KEYUP);
        key_event(VK_CONTROL, KEYEVENTF_KEYUP);
    }
}

/// Simulate **Ctrl + V** in the currently focused application.
///
/// Releases Shift and Ctrl first (same guard as `simulate_copy`) so that
/// lingering modifier state from the global shortcut or a concurrent
/// keystroke does not corrupt the paste.
pub fn simulate_paste() {
    unsafe {
        key_event(VK_SHIFT, KEYEVENTF_KEYUP);
        key_event(VK_CONTROL, KEYEVENTF_KEYUP);
        key_event(VK_CONTROL, 0);
        key_event(0x56, 0); // 'V'
        key_event(0x56, KEYEVENTF_KEYUP);
        key_event(VK_CONTROL, KEYEVENTF_KEYUP);
    }
}

// Cursor / monitor helpers

/// Return the cursor position in physical screen coordinates.
pub fn cursor_pos() -> (i32, i32) {
    let mut pt = POINT { x: 0, y: 0 };
    unsafe {
        GetCursorPos(&mut pt);
    }
    (pt.x, pt.y)
}

/// DPI scale factor (logical → physical) for the monitor under the given point.
///
/// Returns `1.0` on failure (safe fallback — clamping will use logical units,
/// which is the previous behaviour).
pub fn scale_factor_for_point(x: i32, y: i32) -> f64 {
    unsafe {
        let pt = POINT { x, y };
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);

        let mut dpi_x: u32 = 0;
        let mut dpi_y: u32 = 0;
        if GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) == 0 {
            return dpi_x as f64 / 96.0;
        }
        1.0
    }
}

pub fn work_area_for_point(x: i32, y: i32) -> (i32, i32, i32, i32) {
    unsafe {
        let pt = POINT { x, y };
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);

        // Zero-initialise and then set cbSize, as required by the Win32 API.
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;

        if GetMonitorInfoW(hmon, &mut mi) != 0 {
            let r = mi.rcWork;
            (r.left, r.top, r.right, r.bottom)
        } else {
            // Fallback: 1920×1080 full screen
            (0, 0, 1920, 1080)
        }
    }
}
