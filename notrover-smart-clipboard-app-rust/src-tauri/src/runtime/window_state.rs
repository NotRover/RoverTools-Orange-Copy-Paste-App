//! Persistent window geometry — saves to `{app_data_dir}/window-state.json`
//! on every move/resize so a hard kill still preserves the latest state.

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Serialize, Deserialize)]
struct WindowGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
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

// ── Public API ─────────────────────────────────────────────────────────────

/// Restore saved geometry and show the window.
/// Position is applied before *and* after show() — Windows resets position
/// during ShowWindow, so the second call is the snap fix.
pub fn restore(app: &tauri::App) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if let Some(geo) = load(app.handle()) {
        let _ = win.set_size(tauri::PhysicalSize::new(geo.width, geo.height));
        let _ = win.set_position(tauri::PhysicalPosition::new(geo.x, geo.y));
        let _ = win.show();
        let _ = win.set_focus();
        // Re-apply after show — Windows may reset position during ShowWindow.
        let _ = win.set_position(tauri::PhysicalPosition::new(geo.x, geo.y));
    } else {
        let _ = win.show();
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
        let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) else {
            return;
        };
        if size.width == 0 || size.height == 0 {
            return;
        } // minimised
        save(
            &handle,
            &WindowGeometry {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            },
        );
    });
}
