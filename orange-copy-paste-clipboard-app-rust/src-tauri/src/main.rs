// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // One WebKit web process for every window instead of one per window.
    // The app keeps four webviews alive (main, the two popups, the toast),
    // and WebKitGTK's default gives each its own process at 60 to 100 MB
    // idle, which is most of what the app weighs on Linux. WebKit reads this
    // when it creates its web context, so it has to be set before tauri
    // starts. The trade is isolation: a renderer crash takes every window
    // with it, and the app's health recovery restarts it.
    #[cfg(target_os = "linux")]
    std::env::set_var("WEBKIT_USE_SINGLE_WEB_PROCESS", "1");
    // Prefer X11, which on a Wayland session means XWayland. Native Wayland
    // lets no app place a window, keep one above the others, or hear about
    // the clipboard while unfocused, so the corner toasts and the startup
    // splash land in the middle of the screen, under the main window. X11
    // honours all of it. The second entry is the fallback for a session with
    // no XWayland, and a value already in the environment wins, which is the
    // documented way back to native Wayland (see the site's Linux page).
    #[cfg(target_os = "linux")]
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11,wayland");
    }

    notrover_smart_clipboard_app_rust_lib::run()
}
