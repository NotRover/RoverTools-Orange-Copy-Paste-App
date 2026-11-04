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

    notrover_smart_clipboard_app_rust_lib::run()
}
