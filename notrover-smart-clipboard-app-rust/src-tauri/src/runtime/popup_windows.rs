use tauri::Manager;

use crate::state::{COPY_POPUP_H, COPY_POPUP_W, PASTE_POPUP_H, PASTE_POPUP_W};

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

pub(crate) fn hide_popup(app: &tauri::AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.hide();
    }
}

pub(crate) fn hide_all_popups(app: &tauri::AppHandle) {
    hide_popup(app, "copy-popup");
    hide_popup(app, "paste-popup");
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
