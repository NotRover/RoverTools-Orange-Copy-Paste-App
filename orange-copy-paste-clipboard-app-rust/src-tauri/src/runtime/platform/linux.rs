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
//! The cursor and the monitor table come from GDK through tao, the same source
//! tauri's own `center()` uses, so the work area is the one of the monitor
//! under the cursor (minus panels and docks) rather than the whole X screen.
//! That needs the app handle, which [`init`] stores at setup; `xdotool` is the
//! fallback for the cursor until then. Wayland deliberately hides the global
//! pointer from clients and ignores a client's own position, so there the
//! cursor reads `(0, 0)`, `cursor_available()` is false, and windows are
//! centered by tauri instead of anchored.

use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

use tauri::{AppHandle, Monitor};

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Keep the app handle the cursor and monitor queries go through, and start
/// counting clipboard changes. Called once from setup, on the main thread,
/// before the first popup or toast.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    log_display_server();
    watch_clipboard_owner();
}

/// One log line naming the display server, so a report of a window in the
/// wrong place (or not showing at all) can be read without asking. The
/// session says what the desktop runs; the GDK backend says what this
/// process actually talks to, which differs when an app is pushed through
/// XWayland.
fn log_display_server() {
    use gtk::prelude::*;
    let session = if session_is_wayland() { "wayland" } else { "x11" };
    let Some(display) = gtk::gdk::Display::default() else {
        log::info!(target: "app", "linux: session={session} gdk=none");
        return;
    };
    let gdk_wayland = display.backend().is_wayland();
    GDK_BACKEND.store(
        if gdk_wayland { BACKEND_WAYLAND } else { BACKEND_X11 },
        Ordering::Release,
    );
    log::info!(
        target: "app",
        "linux: session={session} gdk={}",
        if gdk_wayland { "wayland" } else { "x11" }
    );
}

// ── Clipboard change counter ─────────────────────────────────────────────────

/// Bumped on every `owner-change` the GTK clipboard reports; see
/// [`clipboard_change_token`].
static CLIPBOARD_CHANGES: AtomicU64 = AtomicU64::new(0);
/// Set once the signal has fired at least once, which is the proof that this
/// session delivers it.
static CLIPBOARD_SIGNAL_SEEN: AtomicBool = AtomicBool::new(false);

/// Connect to the GTK clipboard's `owner-change` signal. On X11, GDK asks
/// the server (XFixes) to report every `SetSelectionOwner` on CLIPBOARD,
/// which is every write by any app, so the counter is the Linux counterpart
/// of the Win32 sequence number.
///
/// Not on Wayland: there a client only hears about the clipboard while one
/// of its surfaces has keyboard focus, so a counter would go quiet exactly
/// when the user is copying in another app. The watcher keeps polling there.
fn watch_clipboard_owner() {
    use gtk::prelude::*;

    if is_wayland() || !gtk::is_initialized_main_thread() {
        return;
    }
    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    // gtk-rs does not bind this signal (its event argument type is skipped),
    // so it is connected by name; the arguments are not needed.
    clipboard.connect_local("owner-change", false, |_| {
        CLIPBOARD_CHANGES.fetch_add(1, Ordering::Relaxed);
        CLIPBOARD_SIGNAL_SEEN.store(true, Ordering::Release);
        None
    });
}

/// The clipboard change counter, once it has proven itself: `None` until the
/// first `owner-change` arrives (and always on Wayland), so a session where
/// the signal never comes keeps the read-every-cycle behaviour instead of
/// never reading again. Once a change has been seen, an unchanged clipboard
/// costs the watcher one atomic load per cycle and no read, where before it
/// read files, HTML, text and the image, decoding and re-encoding a copied
/// picture every 220 ms.
pub fn clipboard_change_token() -> Option<u64> {
    if CLIPBOARD_SIGNAL_SEEN.load(Ordering::Acquire) {
        Some(CLIPBOARD_CHANGES.load(Ordering::Relaxed))
    } else {
        None
    }
}

/// Hand freed heap back to the OS. A clipboard image is decoded to RGBA and
/// re-encoded to PNG on the way in, tens of megabytes for a screenshot, and
/// glibc keeps what it freed in the process. On Windows the allocator
/// returns it on its own, which is the difference between the two numbers
/// in the task manager. Called after an image capture.
pub fn release_free_memory() {
    // SAFETY: malloc_trim takes a pad in bytes and touches only the
    // allocator's own free lists.
    unsafe {
        libc::malloc_trim(0);
    }
}

// ── Display-server detection ─────────────────────────────────────────────────

/// What GDK connected to, recorded by [`init`]: one of the `BACKEND_*`
/// values below, `BACKEND_UNKNOWN` until then.
static GDK_BACKEND: AtomicU8 = AtomicU8::new(BACKEND_UNKNOWN);
const BACKEND_UNKNOWN: u8 = 0;
const BACKEND_X11: u8 = 1;
const BACKEND_WAYLAND: u8 = 2;

/// True when this process talks to a Wayland compositor directly.
///
/// The session type is not the answer: `main.rs` asks GDK for X11 first, so
/// on a Wayland desktop the app normally runs through XWayland, where
/// window placement, keep-above and the clipboard signal all work. What
/// matters to every caller is which protocol GDK ended up on, so this reads
/// the backend recorded at [`init`] and only falls back to the session
/// variables before that.
fn is_wayland() -> bool {
    match GDK_BACKEND.load(Ordering::Acquire) {
        BACKEND_X11 => false,
        BACKEND_WAYLAND => true,
        _ => session_is_wayland(),
    }
}

/// True when the desktop session is Wayland, whatever this process uses.
///
/// Checks `WAYLAND_DISPLAY` first (set by every Wayland compositor for its
/// clients) and falls back to `XDG_SESSION_TYPE=wayland` for the rare case
/// where the app is launched before `WAYLAND_DISPLAY` is inherited.
fn session_is_wayland() -> bool {
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
/// True on X11 (GDK reports it), false on Wayland — the compositor
/// deliberately hides the global pointer from clients, so callers should place
/// windows by centering rather than anchoring to the cursor.
pub fn cursor_available() -> bool {
    !is_wayland()
}

/// Return the cursor position in physical screen coordinates.
///
/// X11 exposes the global pointer; GDK reads it (through tao) and `xdotool`
/// is the fallback before setup has stored the app handle. Wayland does not
/// expose the global cursor to clients at all, so we return `(0, 0)` and let
/// Tauri/WRY place popups using its own logic.
pub fn cursor_pos() -> (i32, i32) {
    // Skip the queries entirely on Wayland: GDK reports (0, 0) there and
    // xdotool would just spawn a failing process each popup.
    if is_wayland() {
        return (0, 0);
    }
    if let Some(pos) = gdk_cursor_pos() {
        return pos;
    }
    xdotool_cursor_pos().unwrap_or((0, 0))
}

/// The pointer as GDK reports it, in physical pixels. GDK is not thread-safe
/// and the callers run on the clipboard watcher as often as on the main
/// thread, so the query is run on the main thread and waited for; a stalled
/// main thread makes this give up rather than hang the watcher.
fn gdk_cursor_pos() -> Option<(i32, i32)> {
    let app = APP.get()?;
    let (tx, rx) = mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(handle.cursor_position().ok());
    })
    .ok()?;
    rx.recv_timeout(Duration::from_millis(500))
        .ok()
        .flatten()
        .map(|p| (p.x.round() as i32, p.y.round() as i32))
}

/// `xdotool getmouselocation --shell`, parsed.
fn xdotool_cursor_pos() -> Option<(i32, i32)> {
    let output = Command::new("xdotool")
        .args(["getmouselocation", "--shell"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
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
    Some((x, y))
}

/// The monitor whose bounds contain the point, else the primary one, else
/// the first one tao knows about. `None` before setup has run.
fn monitor_for_point(x: i32, y: i32) -> Option<Monitor> {
    let app = APP.get()?;
    let monitors = app.available_monitors().ok()?;
    let under = monitors.iter().find(|m| {
        let p = m.position();
        let s = m.size();
        x >= p.x && x < p.x + s.width as i32 && y >= p.y && y < p.y + s.height as i32
    });
    if let Some(m) = under {
        return Some(m.clone());
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

/// DPI scale factor for the monitor containing the given point, as GDK
/// reports it (`GDK_SCALE`); `1.0` before setup has run.
pub fn scale_factor_for_point(x: i32, y: i32) -> f64 {
    monitor_for_point(x, y)
        .map(|m| m.scale_factor())
        .unwrap_or(1.0)
}

/// Work area bounds `(left, top, right, bottom)` for the monitor containing
/// the given point, in physical pixels: the monitor's geometry minus panels
/// and docks, from GDK's `workarea`. Falls back to a 1920x1080 screen at the
/// origin before setup has run.
pub fn work_area_for_point(x: i32, y: i32) -> (i32, i32, i32, i32) {
    match monitor_for_point(x, y) {
        Some(m) => {
            let wa = m.work_area();
            (
                wa.position.x,
                wa.position.y,
                wa.position.x + wa.size.width as i32,
                wa.position.y + wa.size.height as i32,
            )
        }
        None => (0, 0, 1920, 1080),
    }
}
