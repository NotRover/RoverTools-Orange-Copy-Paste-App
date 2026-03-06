//! Persistent window geometry — saves to `{app_data_dir}/window-state.json`
//! on every move/resize so a hard kill still preserves the latest state.

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Minimum dimensions (physical pixels) below which we refuse to save or
/// restore, since they indicate a minimised / transitional window state.
const MIN_WIDTH: u32 = 200;
const MIN_HEIGHT: u32 = 200;

#[derive(Serialize, Deserialize)]
struct WindowGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    maximized: bool,
}

fn load(app: &tauri::AppHandle) -> Option<WindowGeometry> {
    let path = app.path().app_data_dir().ok()?.join("window-state.json");
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn save(app: &tauri::AppHandle, geo: &WindowGeometry) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(json) = serde_json::to_vec_pretty(geo) {
            let _ = std::fs::write(dir.join("window-state.json"), json);
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
    if let Some(geo) = load(app.handle()) {
        // Reject saved geometry that is suspiciously small (e.g. from a
        // minimised window state that slipped past the old guard).
        let width = geo.width.max(MIN_WIDTH);
        let height = geo.height.max(MIN_HEIGHT);

        let _ = win.set_size(tauri::PhysicalSize::new(width, height));
        if is_position_on_any_monitor(&win, geo.x, geo.y, width, height) {
            let _ = win.set_position(tauri::PhysicalPosition::new(geo.x, geo.y));
            let _ = win.show();
            let _ = win.set_focus();
            // Re-apply after show — Windows may reset position during ShowWindow.
            let _ = win.set_position(tauri::PhysicalPosition::new(geo.x, geo.y));
        } else {
            // Saved position is off-screen; center on the primary monitor instead.
            let _ = win.show();
            let _ = win.center();
            let _ = win.set_focus();
        }
        if geo.maximized {
            let _ = win.maximize();
        }
    } else {
        let _ = win.show();
        let _ = win.center();
        let _ = win.set_focus();
    }
}

/// Persist geometry on every move/resize so hard-kills still save state.
pub fn setup_tracking(app: &tauri::App) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.handle().clone();

    win.on_window_event(move |event| {
        if !matches!(
            event,
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
        ) {
            return;
        }
        let Some(w) = handle.get_webview_window("main") else {
            return;
        };

        let is_maximized = w.is_maximized().unwrap_or(false);
        let is_minimized = w.is_minimized().unwrap_or(false);

        // When the window is maximized or minimized, only update the
        // maximized flag — never overwrite the normal-state geometry,
        // because the OS-reported size in those states is meaningless
        // for the restored window rectangle.
        if is_maximized || is_minimized {
            if let Some(mut geo) = load(&handle) {
                geo.maximized = is_maximized;
                save(&handle, &geo);
            }
            return;
        }

        let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) else {
            return;
        };
        if size.width < MIN_WIDTH || size.height < MIN_HEIGHT {
            return;
        }
        save(
            &handle,
            &WindowGeometry {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
                maximized: false,
            },
        );
    });
}
