use tauri::Manager;

use crate::state::{COPY_POPUP_H, COPY_POPUP_W, NOTIF_H, NOTIF_W, PASTE_POPUP_H, PASTE_POPUP_W};

const OFFSCREEN_POS: f64 = -9999.0;

struct PopupWindowSpec {
    label: &'static str,
    url: &'static str,
    width: f64,
    height: f64,
    focused: bool,
}

fn build_popup_window(
    app: &mut tauri::App,
    spec: &PopupWindowSpec,
) -> Result<(), Box<dyn std::error::Error>> {
    // NOTE: do NOT call `set_ignore_cursor_events` here. The window is built
    // `visible(false)` and is therefore unrealized; on GTK/Linux the backing
    // GDK window is `None` until first shown, so calling that method now panics
    // inside tao. Click-through (only the notification needs it) is applied in
    // `notifications.rs` *after* `show()`, once the window is realized.
    tauri::WebviewWindowBuilder::new(app, spec.label, tauri::WebviewUrl::App(spec.url.into()))
        .title("")
        .inner_size(spec.width, spec.height)
        .position(OFFSCREEN_POS, OFFSCREEN_POS)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(spec.focused)
        .visible(false)
        .build()?;

    Ok(())
}

/// Place a popup for display.
///
/// Where the platform can report the global cursor (Windows, Linux/X11) the
/// popup anchors just below-right of the cursor. Where it cannot (Linux/Wayland
/// forbids clients from reading the cursor *and* from self-positioning) we fall
/// back to centering on the active monitor — `center()` is the one placement
/// request Wayland compositors still honor, so the popup lands somewhere
/// predictable and on-screen instead of at an ignored coordinate.
pub(crate) fn place_popup_for_show(win: &tauri::WebviewWindow, w: i32, h: i32) {
    if crate::runtime::platform::cursor_available() {
        let (px, py) = crate::runtime::platform::popup_position(w, h);
        let _ = win.set_position(tauri::PhysicalPosition::new(px, py));
    } else {
        let _ = win.center();
    }
}

/// Nudge a popup fully back onto its current monitor after a resize.
///
/// The popup is placed once at show time for the size it had then; a later
/// resize (the paste popup widening for its preview, or either popup growing
/// to fit content) can push an edge past the screen. This shifts the window
/// just enough to fit, leaving it where it was when it already fits, so the
/// cursor anchor is preserved except when it would spill off-screen. A hidden
/// (offscreen) window is left alone.
pub(crate) fn clamp_popup_into_monitor(app: &tauri::AppHandle, label: &str) {
    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    let Ok(pos) = win.outer_position() else {
        return;
    };
    // Parked offscreen while hidden — never reposition it back into view.
    if (pos.x as f64) <= OFFSCREEN_POS + 1.0 {
        return;
    }
    let (Ok(size), Some(mon)) = (win.outer_size(), win.current_monitor().ok().flatten()) else {
        return;
    };
    let mp = mon.position();
    let ms = mon.size();
    let margin = 8i32;
    let min_x = mp.x + margin;
    let min_y = mp.y + margin;
    let max_x = mp.x + ms.width as i32 - size.width as i32 - margin;
    let max_y = mp.y + ms.height as i32 - size.height as i32 - margin;
    // max can fall below min on a monitor smaller than the popup; clamp to min.
    let new_x = pos.x.min(max_x.max(min_x)).max(min_x);
    let new_y = pos.y.min(max_y.max(min_y)).max(min_y);
    if new_x != pos.x || new_y != pos.y {
        let _ = win.set_position(tauri::PhysicalPosition::new(new_x, new_y));
    }
}

pub(crate) fn hide_popup(app: &tauri::AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        // Move offscreen FIRST so the window cannot intercept clicks during
        // the brief moment between position change and actual hide.  On some
        // Windows/WRY configurations `hide()` alone is not sufficient to
        // prevent hit-testing on transparent always-on-top windows.
        let _ = win.set_position(tauri::PhysicalPosition::new(
            OFFSCREEN_POS as i32,
            OFFSCREEN_POS as i32,
        ));
        let _ = win.hide();
    }
}

pub(crate) fn hide_all_popups(app: &tauri::AppHandle) {
    hide_popup(app, "copy-popup");
    hide_popup(app, "paste-popup");
    // NOTE: notification is NOT hidden here — it auto-dismisses on its
    // own timer and should remain visible even when the main window gains focus.
}

/// Create the copy-popup and paste-popup windows eagerly but hidden.
/// Both are frameless, transparent, always-on-top, and non-focusable —
/// matching the Electron configuration.
pub(crate) fn setup_popup_windows(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let specs = [
        PopupWindowSpec {
            label: "copy-popup",
            url: "src/components/copy-popup/copy-popup.html",
            width: COPY_POPUP_W,
            height: COPY_POPUP_H,
            focused: true,
        },
        PopupWindowSpec {
            label: "paste-popup",
            url: "src/components/paste-popup/paste-popup.html",
            width: PASTE_POPUP_W,
            height: PASTE_POPUP_H,
            focused: false,
        },
        PopupWindowSpec {
            label: "notification",
            url: "src/components/notifications/notification.html",
            width: NOTIF_W,
            height: NOTIF_H,
            focused: false,
        },
    ];

    for spec in &specs {
        build_popup_window(app, spec)?;
    }

    Ok(())
}

/// Hide both popups whenever the user brings the main window into focus.
/// This mirrors the Electron `app.on("browser-window-focus", …)` behaviour.
pub(crate) fn setup_main_window_focus_handler(app: &tauri::App) {
    let ah = app.handle().clone();
    if let Some(main_win) = app.get_webview_window("main") {
        main_win.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                hide_all_popups(&ah);
            }
        });
    }
}
