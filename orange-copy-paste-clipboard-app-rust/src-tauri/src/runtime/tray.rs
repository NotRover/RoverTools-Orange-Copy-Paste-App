use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

/// Show, unminimize, and focus the main window.
///
/// Shared by the tray ("Show" / left-click) and the single-instance relaunch
/// path, so launching the app while it is already running surfaces the window
/// exactly like the tray does.
pub(crate) fn show_main_window(app_handle: &tauri::AppHandle) {
    if let Some(win) = app_handle.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        crate::runtime::window_state::apply_deferred_zoom(app_handle);
        let _ = win.set_focus();
        // A relaunch is triggered by a second process, and Windows denies a
        // background process the foreground - so set_focus() above shows the
        // window but leaves it behind. A brief always-on-top bounce forces it to
        // the front, the same trick the notification toast uses for Z-order. A
        // tray click already has the foreground, so this is a no-op there.
        #[cfg(windows)]
        {
            let _ = win.set_always_on_top(true);
            let _ = win.set_always_on_top(false);
        }
    }
}

pub fn setup_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItemBuilder::with_id("show", "Show Orange Copy Paste").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("app must have a default icon configured");

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Orange Copy Paste")
        .on_menu_event(|app_handle, event| match event.id().as_ref() {
            "show" => show_main_window(app_handle),
            "quit" => app_handle.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
