//! Saved window geometry — tracks every move/resize and persists the latest
//! state to `{app_data_dir}/window-state.json` shortly after, so a hard kill
//! still preserves it.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tauri::Manager;

/// Minimum dimensions (physical pixels) below which we refuse to save or
/// restore, since they indicate a minimised / transitional window state.
const MIN_WIDTH: u32 = 200;
const MIN_HEIGHT: u32 = 200;

/// Latest geometry seen, waiting to be written.
///
/// Dragging or resizing a window emits `Moved`/`Resized` continuously — tens of
/// events a second — and each save is a durable replace ending in an fsync. Doing
/// that per event stalls the window-event thread badly enough to make the drag
/// stutter, so the handler only ever touches memory and a timer does the I/O.
/// Worst case a kill loses the last fraction of a second of window movement.
static PENDING: Mutex<Option<WindowGeometry>> = Mutex::new(None);
const PERSIST_INTERVAL_MS: u64 = 700;

/// `(maximized, fullscreen)` that startup could not apply because the window
/// was still hidden.  Consumed by [`apply_deferred_zoom`] on first show.
static DEFERRED_ZOOM: Mutex<Option<(bool, bool)>> = Mutex::new(None);

/// The window rectangle in its *normal* (restored) state, plus whichever
/// zoomed state was active on top of it. The two are stored separately so
/// un-maximizing after a restart lands back on the size the user last chose.
#[derive(Clone, Serialize, Deserialize)]
struct WindowGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    maximized: bool,
    #[serde(default)]
    fullscreen: bool,
}

fn load(app: &tauri::AppHandle) -> Option<WindowGeometry> {
    let path = app.path().app_data_dir().ok()?.join("window-state.json");
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn save(app: &tauri::AppHandle, geo: &WindowGeometry) {
    if let Ok(dir) = app.path().app_data_dir() {
        if let Ok(json) = serde_json::to_vec_pretty(geo) {
            // Atomic: a truncated file here means the window reopening at a
            // garbage size, which is worse than reopening at the default.
            let _ = crate::health::write_atomic(&dir.join("window-state.json"), &json);
        }
    }
}

//  Public API

/// Returns true if the window rectangle overlaps with at least one available monitor.
/// This guards against restoring a position that is entirely off-screen (e.g. because
/// a second monitor has been disconnected or the display resolution changed).
fn is_position_on_any_monitor(
    win: &tauri::WebviewWindow,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> bool {
    let Ok(monitors) = win.available_monitors() else {
        return true; // can't determine — assume it's fine
    };
    let win_x2 = x + width as i32;
    let win_y2 = y + height as i32;
    monitors.iter().any(|m| {
        let pos = m.position();
        let size = m.size();
        let mon_x2 = pos.x + size.width as i32;
        let mon_y2 = pos.y + size.height as i32;
        // Overlap check: window rect intersects monitor rect
        x < mon_x2 && win_x2 > pos.x && y < mon_y2 && win_y2 > pos.y
    })
}

/// Restore saved geometry and show the window.
/// Position is applied before *and* after show() — Windows resets position
/// during ShowWindow, so the second call is the snap fix.
/// If the saved position is off-screen (e.g. disconnected monitor), the window
/// is centered on the primary monitor instead.
pub fn restore(app: &tauri::App) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };

    let start_minimized = app
        .state::<crate::AppState>()
        .start_minimized
        .load(Ordering::Relaxed);

    if let Some(geo) = load(app.handle()) {
        // Reject saved geometry that is suspiciously small (e.g. from a
        // minimised window state that slipped past the old guard).
        let width = geo.width.max(MIN_WIDTH);
        let height = geo.height.max(MIN_HEIGHT);

        let _ = win.set_size(tauri::PhysicalSize::new(width, height));
        if is_position_on_any_monitor(&win, geo.x, geo.y, width, height) {
            let _ = win.set_position(tauri::PhysicalPosition::new(geo.x, geo.y));
            if !start_minimized {
                let _ = win.show();
                let _ = win.set_focus();
            }
            // Re-apply after show — Windows may reset position during ShowWindow.
            let _ = win.set_position(tauri::PhysicalPosition::new(geo.x, geo.y));
        } else {
            // Saved position is off-screen; center on the primary monitor instead.
            if !start_minimized {
                let _ = win.show();
                let _ = win.center();
                let _ = win.set_focus();
            }
        }
        // Re-apply the zoomed state. Windows ignores a maximize aimed at a
        // hidden window, so when starting minimised to tray it has to wait for
        // the first show instead of being dropped — dropping it is what used to
        // lose the state on every launch, since the next move or resize then
        // wrote the un-zoomed flag over it for good.
        if geo.maximized || geo.fullscreen {
            if start_minimized {
                *DEFERRED_ZOOM.lock() = Some((geo.maximized, geo.fullscreen));
            } else if geo.fullscreen {
                let _ = win.set_fullscreen(true);
            } else {
                let _ = win.maximize();
            }
        }
    } else if !start_minimized {
        let _ = win.show();
        let _ = win.center();
        let _ = win.set_focus();
    }
}

/// Write whatever the handler last recorded.
///
/// Deliberately does not re-query the window's zoom state: this also runs on
/// the way out, and a window that is hidden or already tearing down reports
/// itself as not maximized — which would write the flag away at the very moment
/// it needs to survive. The handler samples the state while the window is still
/// live, so its snapshot is the one to trust.
fn flush(handle: &tauri::AppHandle) {
    let pending = PENDING.lock().take();
    if let Some(geo) = pending {
        save(handle, &geo);
    }
}

/// Apply the zoom state startup had to defer, now that the window is being
/// shown for the first time.  Call right after `show()` on the main window.
///
/// A no-op once consumed, and whenever the window was already visible at
/// startup (the state was applied directly then).
pub fn apply_deferred_zoom(app: &tauri::AppHandle) {
    let Some((maximized, fullscreen)) = DEFERRED_ZOOM.lock().take() else {
        return;
    };
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if fullscreen {
        let _ = win.set_fullscreen(true);
    } else if maximized {
        let _ = win.maximize();
    }
}

/// Track geometry on every move/resize so hard-kills still save state.
pub fn setup_tracking(app: &tauri::App) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.handle().clone();

    // Writer for whatever the handler last recorded. One thread, so writes can
    // never overlap, and a run of events collapses into a single file replace.
    {
        let handle = handle.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(PERSIST_INTERVAL_MS));
                flush(&handle);
            }
        });
    }

    win.on_window_event(move |event| {
        match event {
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {}
            // On the way out the timer gets no further turn, so write now — this
            // is what keeps "moved the window, then quit" from losing the move.
            tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                flush(&handle);
                return;
            }
            _ => return,
        }
        let Some(w) = handle.get_webview_window("main") else {
            return;
        };

        let is_maximized = w.is_maximized().unwrap_or(false);
        let is_fullscreen = w.is_fullscreen().unwrap_or(false);
        let is_minimized = w.is_minimized().unwrap_or(false);

        // While minimized the OS-reported rectangle says nothing about where
        // the window should return to, so leave the stored one alone. Nothing
        // to record either: minimizing is not a state we restore into.
        if is_minimized {
            return;
        }

        // Zoomed: keep the stored normal rectangle and update only the flags.
        // Take the pending value if there is one, so this does not read back a
        // file the writer thread has not caught up to yet.
        if is_maximized || is_fullscreen {
            let mut pending = PENDING.lock();
            if let Some(mut geo) = pending.take().or_else(|| load(&handle)) {
                geo.maximized = is_maximized;
                geo.fullscreen = is_fullscreen;
                *pending = Some(geo);
            }
            return;
        }

        let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) else {
            return;
        };
        if size.width < MIN_WIDTH || size.height < MIN_HEIGHT {
            return;
        }
        *PENDING.lock() = Some(WindowGeometry {
            x: pos.x,
            y: pos.y,
            width: size.width,
            height: size.height,
            maximized: false,
            fullscreen: false,
        });
    });
}
