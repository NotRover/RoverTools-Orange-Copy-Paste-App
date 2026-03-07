//! Smart Clipboard – Tauri/Rust backend.

pub mod clipboard;
pub mod runtime;
pub mod state;

pub use state::AppState;

use crate::clipboard::history::ClipboardHistory;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;

pub type SharedHistory = Arc<Mutex<ClipboardHistory>>;
type SuppressFlag = Arc<AtomicBool>;

const FLUSH_INTERVAL_MS: u64 = 2000;

/// System boot timestamp (seconds since UNIX epoch) for detecting reboots.
#[cfg(windows)]
fn system_boot_epoch_secs() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let uptime = unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() } / 1000;
    now.saturating_sub(uptime)
}

#[cfg(not(windows))]
fn system_boot_epoch_secs() -> u64 {
    0
}

fn read_bool_setting(path: &std::path::Path, key: &str) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|data| {
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&data).ok()
        })
        .and_then(|map| map.get(key)?.as_bool())
        .unwrap_or(false)
}

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

fn setup_runtime(
    app: &mut tauri::App,
    history: &SharedHistory,
    suppress: &SuppressFlag,
) -> Result<(), Box<dyn std::error::Error>> {
    // Resolve paths once, reuse everywhere.
    let app_data = app.path().app_data_dir().ok();
    let path = |name: &str| app_data.as_ref().map(|d| d.join(name));

    let history_file = path("history.json");
    let pinned_file = path("pinned_entries.json");
    let settings_file = path("settings.json");
    let boot_file = path("boot_id.txt");

    // Seed the cached persist_history flag from disk (one-time read at boot).
    let persist_enabled = settings_file
        .as_deref()
        .map(|p| read_bool_setting(p, "persist_history"))
        .unwrap_or(false);

    // Load history: full restore if same boot + persist enabled, pinned-only otherwise.
    if persist_enabled {
        if let (Some(hf), Some(pf), Some(bf), Some(ad)) =
            (&history_file, &pinned_file, &boot_file, &app_data)
        {
            let current_boot = system_boot_epoch_secs();
            let previous_boot: u64 = std::fs::read_to_string(bf)
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);

            if current_boot.abs_diff(previous_boot) < 5 && hf.exists() {
                let _ = history.lock().load_all_from_file(hf);
            } else {
                let _ = history.lock().load_pinned_from_file(pf);
            }

            let _ = std::fs::create_dir_all(ad);
            let _ = std::fs::write(bf, current_boot.to_string());
        }
    } else if let Some(pf) = &pinned_file {
        let _ = history.lock().load_pinned_from_file(pf);
    }

    // Seed the in-memory persist flag.
    app.state::<AppState>()
        .persist_history
        .store(persist_enabled, Ordering::Relaxed);

    // Background flush thread: coalesces rapid mutations into a single disk write.
    {
        let hist = Arc::clone(history);
        let state: tauri::State<'_, AppState> = app.state();
        let dirty = Arc::clone(&state.history_dirty);
        let persist = Arc::clone(&state.persist_history);
        let app_handle = app.handle().clone();

        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(FLUSH_INTERVAL_MS));

            if !persist.load(Ordering::Relaxed) {
                continue;
            }
            if !dirty.swap(false, Ordering::Relaxed) {
                continue;
            }
            if let Some(path) = crate::clipboard::commands::get_history_file_path(&app_handle) {
                let _ = hist.lock().save_all_to_file(&path);
            }
        });
    }

    crate::runtime::popup_windows::setup_popup_windows(app)?;
    crate::runtime::hotkeys::register_global_shortcuts(
        app,
        Arc::clone(history),
        Arc::clone(suppress),
    )?;
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

    let app_state = AppState {
        history: Arc::clone(&history),
        suppress_next_capture: Arc::clone(&suppress),
        persist_history: Arc::new(AtomicBool::new(false)),
        history_dirty: Arc::new(AtomicBool::new(false)),
    };

    tauri::Builder::default()
        .manage(app_state)
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
            crate::clipboard::commands::get_setting,
            crate::clipboard::commands::set_setting,
            crate::clipboard::commands::save_history,
            crate::runtime::commands::close_copy_popup,
            crate::runtime::commands::close_paste_popup,
            crate::runtime::commands::resize_paste_popup,
            crate::runtime::commands::open_data_folder,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) && window.label() == "main" {
                window.app_handle().exit(0);
            }
        })
        .setup(move |app| setup_runtime(app, &history, &suppress))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
