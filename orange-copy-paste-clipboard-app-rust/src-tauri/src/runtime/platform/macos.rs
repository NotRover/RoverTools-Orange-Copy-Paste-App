//! macOS keystroke simulation, cursor position, screen helpers, and the two
//! AppKit calls the popups need to hand focus back.
//!
//! # Coordinates
//! Everything here is in **points** (AppKit logical units) with the origin at
//! the top-left of the primary display, which is what CoreGraphics reports for
//! the cursor and what tao expects for a `LogicalPosition`. AppKit's own
//! bottom-left origin is flipped on the way out of `NSScreen`. Because the unit
//! is already logical, `scale_factor_for_point` is `1.0` and
//! `platform::position_at` hands tao a logical position; see `mod.rs`.
//!
//! # Keystrokes and the Accessibility permission
//! `CGEvent` keyboard events reach other apps only once this app is listed
//! under System Settings > Privacy & Security > Accessibility. The app asks for
//! it once at startup ([`request_input_permission`]); until it is granted the
//! synthetic Cmd+C / Cmd+V is skipped and logged, and everything else - the
//! capture, the popups, the clipboard write - still happens. The user can
//! still press Cmd+V by hand.
//!
//! # Focus
//! A popup that takes keyboard input activates this app, and macOS leaves an
//! app active after its last window hides. A Cmd+V posted then would land in
//! us. [`deactivate`] hides the app (`NSApp hide:`), which is the one call that
//! reliably hands focus back to the previous app, and [`unhide_quietly`] undoes
//! the window-hiding half of that without activating, so a toast can still
//! appear afterwards.

use std::sync::OnceLock;

use core_graphics::display::CGDisplay;
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSPasteboard, NSScreen};
use parking_lot::Mutex;

// ANSI keyboard virtual key codes (Carbon `kVK_ANSI_*`); layout-independent
// for the purpose of a shortcut, which is how every app reads Cmd+C / Cmd+V.
const KEY_C: CGKeyCode = 8;
const KEY_V: CGKeyCode = 9;

// ── Accessibility permission ────────────────────────────────────────────────

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef) -> u8;
    static kAXTrustedCheckOptionPrompt: core_foundation::string::CFStringRef;
}

/// Whether this process may post keyboard events to other apps.
///
/// With `prompt`, macOS shows its own "would like to control this computer"
/// dialog the first time (and only then; afterwards the user has to visit
/// System Settings). The check itself is cheap and safe to call every time.
fn accessibility_trusted(prompt: bool) -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    unsafe {
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let value = if prompt {
            CFBoolean::true_value()
        } else {
            CFBoolean::false_value()
        };
        let options = CFDictionary::from_CFType_pairs(&[(key, value)]);
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) != 0
    }
}

/// Ask for the Accessibility permission if it is not granted yet. Called once
/// from setup, so the system prompt appears on the first launch and not in the
/// middle of the first paste.
pub fn request_input_permission() {
    if accessibility_trusted(true) {
        log::info!(target: "platform", "accessibility: granted");
    } else {
        log::warn!(target: "platform", "accessibility: not granted; Cmd+C / Cmd+V will not be sent until it is");
    }
}

/// Whether synthetic keystrokes would currently reach other apps.
pub fn input_permission_granted() -> bool {
    accessibility_trusted(false)
}

// ── Key simulation ──────────────────────────────────────────────────────────

/// Post `Cmd + key` (down, then up) to the frontmost app.
///
/// The event carries its own modifier flags, so whatever the user is still
/// physically holding from the global shortcut (Shift, Cmd) does not change
/// what the receiving app sees - the release dance Windows needs is not needed
/// here.
fn post_cmd_key(key: CGKeyCode) {
    if !accessibility_trusted(false) {
        log::warn!(target: "platform", "keystroke skipped: Accessibility permission not granted");
        return;
    }
    let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
        return;
    };
    for down in [true, false] {
        let Ok(event) = CGEvent::new_keyboard_event(source.clone(), key, down) else {
            return;
        };
        event.set_flags(CGEventFlags::CGEventFlagCommand);
        event.post(CGEventTapLocation::HID);
    }
}

/// Simulate **Cmd + C** in the currently focused application.
pub fn simulate_copy() {
    post_cmd_key(KEY_C);
}

/// Simulate **Cmd + V** in the currently focused application.
pub fn simulate_paste() {
    post_cmd_key(KEY_V);
}

// ── Cursor / screens ────────────────────────────────────────────────────────

/// Whether the global cursor position can be read. Always, on macOS.
pub fn cursor_available() -> bool {
    true
}

/// The cursor position in points, top-left origin.
pub fn cursor_pos() -> (i32, i32) {
    CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .ok()
        .and_then(|source| CGEvent::new(source).ok())
        .map(|event| {
            let p = event.location();
            (p.x.round() as i32, p.y.round() as i32)
        })
        .unwrap_or((0, 0))
}

/// Already in points, so the "logical to physical" step in `popup_position`
/// is the identity here.
pub fn scale_factor_for_point(_x: i32, _y: i32) -> f64 {
    1.0
}

/// One display: its full frame and the part not covered by the menu bar or
/// the Dock, both `(left, top, right, bottom)` in points, top-left origin.
#[derive(Clone, Copy)]
struct Screen {
    frame: (i32, i32, i32, i32),
    visible: (i32, i32, i32, i32),
}

/// The screen table as of the last main-thread query.
///
/// `NSScreen` may only be used on the main thread, and the callers here run
/// wherever the clipboard watcher or a paste command happens to be. The table
/// is primed at setup and refreshed by any caller that is on the main thread
/// (the hotkey handlers are), so an off-thread caller sees a layout at most one
/// popup old. A display change with no popup in between is picked up on the
/// next one.
static SCREENS: OnceLock<Mutex<Vec<Screen>>> = OnceLock::new();

fn screens_cache() -> &'static Mutex<Vec<Screen>> {
    SCREENS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Read the screen table from AppKit. Main thread only, by construction.
fn query_screens(mtm: MainThreadMarker) -> Vec<Screen> {
    let screens = NSScreen::screens(mtm);
    // AppKit's origin is the bottom-left of the primary display (the first
    // screen); flipping needs its height.
    let Some(primary) = screens.iter().next() else {
        return Vec::new();
    };
    let primary_h = primary.frame().size.height;
    let flip = |r: objc2_foundation::NSRect| -> (i32, i32, i32, i32) {
        let left = r.origin.x;
        let top = primary_h - (r.origin.y + r.size.height);
        (
            left.round() as i32,
            top.round() as i32,
            (left + r.size.width).round() as i32,
            (top + r.size.height).round() as i32,
        )
    };
    screens
        .iter()
        .map(|s| Screen {
            frame: flip(s.frame()),
            visible: flip(s.visibleFrame()),
        })
        .collect()
}

/// Refresh the screen table. A no-op off the main thread.
pub fn prime_screens() {
    if let Some(mtm) = MainThreadMarker::new() {
        *screens_cache().lock() = query_screens(mtm);
    }
}

/// Usable area `(left, top, right, bottom)` of the display under the point:
/// the display's frame minus the menu bar and the Dock. Falls back to the full
/// bounds of the main display when the table is empty and the caller is off
/// the main thread, which only happens before setup has run.
pub fn work_area_for_point(x: i32, y: i32) -> (i32, i32, i32, i32) {
    prime_screens();
    let screens = screens_cache().lock();
    let contains = |(l, t, r, b): (i32, i32, i32, i32)| x >= l && x < r && y >= t && y < b;
    if let Some(s) = screens
        .iter()
        .find(|s| contains(s.frame))
        .or_else(|| screens.first())
    {
        return s.visible;
    }
    let b = CGDisplay::main().bounds();
    (
        b.origin.x.round() as i32,
        b.origin.y.round() as i32,
        (b.origin.x + b.size.width).round() as i32,
        (b.origin.y + b.size.height).round() as i32,
    )
}

// ── Clipboard change token ──────────────────────────────────────────────────

/// The general pasteboard's change count: bumped by every write, by any app.
/// The macOS counterpart of `GetClipboardSequenceNumber`.
pub fn clipboard_change_count() -> u64 {
    // The count is signed in AppKit only because every NSInteger is; it never
    // goes negative.
    NSPasteboard::generalPasteboard().changeCount().max(0) as u64
}

// ── App activation ──────────────────────────────────────────────────────────

/// Hide the app so the previously active app becomes active again (and gets
/// the Cmd+V). Runs on the main thread through the app handle; the hide itself
/// is `NSApp hide:`, which is what tauri's `AppHandle::hide` wraps.
pub fn deactivate(app: &tauri::AppHandle) {
    let _ = app.hide();
}

/// Undo [`deactivate`]'s hiding of our windows without taking focus, so a
/// window shown next (the toast) actually appears. A hidden app's windows stay
/// invisible until the app unhides, and tauri's `AppHandle::show` would also
/// activate us, which is exactly what the toast must not do.
pub fn unhide_quietly(app: &tauri::AppHandle) {
    let _ = app.run_on_main_thread(|| {
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm).unhideWithoutActivation();
        }
    });
}
