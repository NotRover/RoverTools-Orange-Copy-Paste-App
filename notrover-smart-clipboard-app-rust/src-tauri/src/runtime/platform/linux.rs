//! Linux-specific keystroke simulation, cursor position, and monitor helpers.
//!
//! Keystroke simulation uses `xdotool` (X11) or `wtype` (Wayland), both widely
//! available on desktop Linux distributions.  Cursor and monitor queries use
//! `xdotool` on X11 and fall back to safe defaults on Wayland (Tauri/WRY
//! handles popup placement well enough on its own).

use std::process::Command;

// ── Display server detection ────────────────────────────────────────────────

fn is_wayland() -> bool {
    std::env::var("WAYLAND_DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

// ── Key simulation ──────────────────────────────────────────────────────────

/// Simulate **Ctrl + C** in the currently focused application.
pub fn simulate_copy() {
    if is_wayland() {
        // wtype: release modifiers then send Ctrl+C
        let _ = Command::new("wtype").args(["-M", "ctrl", "-P", "c", "-p", "c", "-m", "ctrl"]).output();
    } else {
        // xdotool: clear modifiers, send ctrl+c
        let _ = Command::new("xdotool").args(["key", "--clearmodifiers", "ctrl+c"]).output();
    }
}

/// Simulate **Ctrl + V** in the currently focused application.
pub fn simulate_paste() {
    if is_wayland() {
        let _ = Command::new("wtype").args(["-M", "ctrl", "-P", "v", "-p", "v", "-m", "ctrl"]).output();
    } else {
        let _ = Command::new("xdotool").args(["key", "--clearmodifiers", "ctrl+v"]).output();
    }
}

// ── Cursor / monitor helpers ────────────────────────────────────────────────

/// Return the cursor position in physical screen coordinates.
///
/// Falls back to `(0, 0)` if the position cannot be determined (e.g. on
/// Wayland without a pointer query tool).
pub fn cursor_pos() -> (i32, i32) {
    // xdotool works on X11.  On Wayland we fall back to (0,0) —
    // Tauri itself positions popups reasonably.
    if let Ok(output) = Command::new("xdotool").args(["getmouselocation", "--shell"]).output() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut x = 0i32;
        let mut y = 0i32;
        for line in stdout.lines() {
            if let Some(val) = line.strip_prefix("X=") {
                x = val.trim().parse().unwrap_or(0);
            } else if let Some(val) = line.strip_prefix("Y=") {
                y = val.trim().parse().unwrap_or(0);
            }
        }
        return (x, y);
    }
    (0, 0)
}

/// DPI scale factor for the monitor containing the given point.
///
/// On Linux, Tauri/WRY handles scaling internally, so we return `1.0` and
/// let the toolkit do the work.
pub fn scale_factor_for_point(_x: i32, _y: i32) -> f64 {
    1.0
}

/// Work area bounds `(left, top, right, bottom)` for the monitor containing
/// the given point.
///
/// Attempts to read the screen geometry via `xdpyinfo` on X11.  Falls back
/// to a generous 1920×1080 default.
pub fn work_area_for_point(_x: i32, _y: i32) -> (i32, i32, i32, i32) {
    // Try xdpyinfo for the root window dimensions (X11).
    if let Ok(output) = Command::new("xdpyinfo").output() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let trimmed = line.trim();
            // Line looks like: "dimensions:    1920x1080 pixels (508x285 millimeters)"
            if trimmed.starts_with("dimensions:") {
                if let Some(dims) = trimmed.split_whitespace().nth(1) {
                    let parts: Vec<&str> = dims.split('x').collect();
                    if parts.len() == 2 {
                        let w: i32 = parts[0].parse().unwrap_or(1920);
                        let h: i32 = parts[1].parse().unwrap_or(1080);
                        return (0, 0, w, h);
                    }
                }
            }
        }
    }
    (0, 0, 1920, 1080)
}
