//! Smart Clipboard – Tauri/Rust backend.

pub mod clipboard;
pub mod runtime;
pub mod state;

pub use state::AppState;

use crate::clipboard::history::ClipboardHistory;
use parking_lot::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tauri::Manager;

type SharedHistory = Arc<Mutex<ClipboardHistory>>;
type SuppressFlag = Arc<AtomicBool>;

/// Kill any other running instance of this executable before we start.
/// This releases OS-level global hotkeys held by the old process, preventing
/// the "HotKey already registered" panic on rapid restarts during development.
#[cfg(windows)]
fn kill_previous_instance() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();

    if exe.is_empty() {
        return;
    }

    let current_pid = std::process::id();

    // Use tasklist (available on all Windows versions) to find PIDs for our
    // executable, then kill any that aren't us. Failure is silently ignored.
    let Ok(output) = std::process::Command::new("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {exe}"), "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return;
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut killed = false;
    for line in stdout.lines() {
        // CSV lines look like: "executable.exe","12345","Console","1","10,000 K"
        let mut parts = line.splitn(3, ',');
        let _ = parts.next(); // executable name
        if let Some(pid_field) = parts.next() {
            let pid_str = pid_field.trim().trim_matches('"');
            if let Ok(pid) = pid_str.parse::<u32>() {
                if pid != current_pid && pid != 0 {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/F"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                    killed = true;
                }
            }
        }
    }

    if killed {
        // Give the OS a moment to reclaim the global hotkeys.
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
}

#[cfg(not(windows))]
fn kill_previous_instance() {}

fn create_shared_history() -> SharedHistory {
    Arc::new(Mutex::new(ClipboardHistory::new()))
}

fn app_state_from_history(history: &SharedHistory, suppress: &SuppressFlag) -> AppState {
    AppState {
        history: Arc::clone(history),
        suppress_next_capture: Arc::clone(suppress),
    }
}

fn setup_runtime(
    app: &mut tauri::App,
    history: &SharedHistory,
    suppress: &SuppressFlag,
) -> Result<(), Box<dyn std::error::Error>> {
    // Load pinned entries from disk before starting clipboard monitoring
    if let Ok(app_data) = app.path().app_data_dir() {
        let pinned_file: std::path::PathBuf = app_data.join("pinned_entries.json");
        let _ = history.lock().load_pinned_from_file(&pinned_file);
    }

    crate::runtime::popup_windows::setup_popup_windows(app)?;
    crate::runtime::hotkeys::register_global_shortcuts(app, Arc::clone(history))?;
    crate::runtime::clipboard_watcher::start_clipboard_watcher(
        &app.handle().clone(),
        Arc::clone(history),
        Arc::clone(suppress),
    );
    crate::runtime::popup_windows::setup_main_window_focus_handler(app);
    crate::runtime::window_state::restore(app);
    crate::runtime::window_state::setup_tracking(app);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    kill_previous_instance();

    let history = create_shared_history();
    let suppress: SuppressFlag = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        .manage(app_state_from_history(&history, &suppress))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            crate::clipboard::commands::get_history,
            crate::clipboard::commands::delete_entry,
            crate::clipboard::commands::clear_history,
            crate::clipboard::commands::pin_entry,
            crate::clipboard::commands::unpin_entry,
            crate::clipboard::commands::copy_entry,
            crate::clipboard::commands::paste_entry,
            crate::clipboard::commands::get_image_file_preview,
            crate::clipboard::commands::get_video_file_preview,
            crate::runtime::commands::close_cursor_popup,
            crate::runtime::commands::close_paste_popup,
        ])
        .on_window_event(|window, event| {
            // When the main window is destroyed, exit the entire process.
            // Without this, hidden popup windows and the clipboard-watcher
            // thread keep the process alive after the user closes the app.
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "main" {
                window.app_handle().exit(0);
            }
        })
        .setup(move |app| setup_runtime(app, &history, &suppress))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
