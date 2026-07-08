//! Linux-specific keystroke simulation, cursor position, and monitor helpers.
//!
//! # Display servers
//! Desktop Linux runs on either **X11** or **Wayland**, and neither exposes a
//! single universal way to inject keystrokes or read the global cursor.  This
//! module detects the session at runtime and uses a *capability ladder* that
//! tries the best-available mechanism and falls back on failure, so a single
//! Linux binary works across both without configuration where possible.
//!
//! ## Keystroke injection ladder
//! | Session            | Tool      | Setup required                          |
//! |--------------------|-----------|-----------------------------------------|
//! | X11 (or XWayland)  | `xdotool` | none                                    |
//! | Wayland (wlroots)  | `wtype`   | none (virtual-keyboard protocol)        |
//! | Wayland (GNOME/KDE)| `ydotool` | `ydotoold` daemon + uinput access       |
//!
//! Each rung only runs when the previous one is missing or exits non-zero, so
//! adding a rung can never regress a working setup.  If no tool succeeds, the
//! injection is a silent no-op (the clipboard content is still captured; only
//! the synthetic paste/copy keystroke is skipped).
//!
//! ## Cursor / monitor
//! X11 exposes the global pointer and screen geometry via `xdotool` / `xdpyinfo`.
//! Wayland deliberately hides both from clients, so we fall back to safe
//! defaults and let Tauri/WRY place windows on its own.

use std::process::Command;

// ── Display-server detection ─────────────────────────────────────────────────

/// True when the current session is Wayland.
///
/// Checks `WAYLAND_DISPLAY` first (set by every Wayland compositor for its
/// clients) and falls back to `XDG_SESSION_TYPE=wayland` for the rare case
/// where the app is launched before `WAYLAND_DISPLAY` is inherited.
fn is_wayland() -> bool {
    if std::env::var("WAYLAND_DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    matches!(
        std::env::var("XDG_SESSION_TYPE").as_deref(),
        Ok("wayland")
    )
}

// ── Command helpers ──────────────────────────────────────────────────────────

/// Run `cmd args` to completion and report whether it succeeded.
///
/// Returns `false` if the binary is missing (`NotFound`) or exits non-zero —
/// exactly the signal the injection ladder needs to fall through to the next
/// tool.  Output is discarded; these are fire-and-forget helper tools.
fn run(cmd: &str, args: &[&str]) -> bool {
    Command::new(cmd)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ── Key simulation ───────────────────────────────────────────────────────────

/// `xdotool key --clearmodifiers <combo>` — X11 (and XWayland) injection.
fn xdotool_key(combo: &str) -> bool {
    run("xdotool", &["key", "--clearmodifiers", combo])
}

/// `wtype` press-modifier / press-key / release-key / release-modifier —
/// Wayland injection for compositors implementing the virtual-keyboard
/// protocol (wlroots: Sway, Hyprland, River, …).  Fails on GNOME/KDE Wayland,
/// which is the ladder's cue to try `ydotool`.
fn wtype_ctrl(letter: &str) -> bool {
    run(
        "wtype",
        &["-M", "ctrl", "-P", letter, "-p", letter, "-m", "ctrl"],
    )
}

/// `ydotool key <events>` — compositor-agnostic Wayland injection via the
/// kernel uinput device.  Works on GNOME/KDE Wayland once `ydotoold` is running
/// and the user has uinput access, but requires that one-time setup.
///
/// Events use Linux input keycodes with a `:press` suffix (`1` = down,
/// `0` = up): LEFTCTRL = 29, C = 46, V = 47.
fn ydotool_ctrl(letter_code: &str) -> bool {
    let down = format!("{letter_code}:1");
    let up = format!("{letter_code}:0");
    run(
        "ydotool",
        &["key", "29:1", down.as_str(), up.as_str(), "29:0"],
    )
}

/// Simulate **Ctrl + C** in the currently focused application.
pub fn simulate_copy() {
    if is_wayland() {
        // wlroots first (zero-setup), then the uinput fallback for GNOME/KDE.
        if wtype_ctrl("c") {
            return;
        }
        let _ = ydotool_ctrl("46"); // KEY_C
    } else {
        if xdotool_key("ctrl+c") {
            return;
        }
        // X11 without xdotool: uinput works regardless of display server.
        let _ = ydotool_ctrl("46");
    }
}

/// Simulate **Ctrl + V** in the currently focused application.
pub fn simulate_paste() {
    if is_wayland() {
        if wtype_ctrl("v") {
            return;
        }
        let _ = ydotool_ctrl("47"); // KEY_V
    } else {
        if xdotool_key("ctrl+v") {
            return;
        }
        let _ = ydotool_ctrl("47");
    }
}

// ── Cursor / monitor helpers ─────────────────────────────────────────────────

/// Whether the global cursor position can be read on this session.
///
/// True on X11 (queryable via `xdotool`), false on Wayland — the compositor
/// deliberately hides the global pointer from clients, so callers should place
/// windows by centering rather than anchoring to the cursor.
pub fn cursor_available() -> bool {
    !is_wayland()
}

/// Return the cursor position in physical screen coordinates.
///
/// X11 exposes the global pointer via `xdotool`.  Wayland does not expose the
/// global cursor to clients at all, so we fall back to `(0, 0)` and let
/// Tauri/WRY place popups using its own logic.
pub fn cursor_pos() -> (i32, i32) {
    // Skip the query entirely on Wayland — xdotool can't read the global
    // pointer there and would just spawn a failing process each popup.
    if is_wayland() {
        return (0, 0);
    }

    if let Ok(output) = Command::new("xdotool")
        .args(["getmouselocation", "--shell"])
        .output()
    {
        if output.status.success() {
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
    }
    (0, 0)
}

/// DPI scale factor for the monitor containing the given point.
///
/// On Linux, Tauri/WRY handles scaling internally, so we return `1.0` and let
/// the toolkit do the work.
pub fn scale_factor_for_point(_x: i32, _y: i32) -> f64 {
    1.0
}

/// Work area bounds `(left, top, right, bottom)` for the monitor containing
/// the given point.
///
/// Reads the root-window geometry via `xdpyinfo` on X11 (also works under
/// XWayland).  Falls back to a generous 1920×1080 default on Wayland or when
/// `xdpyinfo` is unavailable.
pub fn work_area_for_point(_x: i32, _y: i32) -> (i32, i32, i32, i32) {
    if let Ok(output) = Command::new("xdpyinfo").output() {
        if output.status.success() {
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
    }
    (0, 0, 1920, 1080)
}
