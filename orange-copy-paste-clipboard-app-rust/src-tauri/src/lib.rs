//! Smart Clipboard – Tauri/Rust backend.

pub mod clipboard;
pub mod notes;
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
    // Read /proc/stat for btime (boot time in epoch seconds).
    // Available on all Linux kernels.  Falls back to 0 on other Unixes.
    if let Ok(stat) = std::fs::read_to_string("/proc/stat") {
        for line in stat.lines() {
            if let Some(rest) = line.strip_prefix("btime ") {
                if let Ok(v) = rest.trim().parse::<u64>() {
                    return v;
                }
            }
        }
    }
    0
}

fn read_bool_setting(path: &std::path::Path, key: &str, default: bool) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|data| {
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&data).ok()
        })
        .and_then(|map| map.get(key)?.as_bool())
        .unwrap_or(default)
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
fn kill_previous_instance() {
    let exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();

    if exe.is_empty() {
        return;
    }

    let current_pid = std::process::id();

    // Use `pgrep` to find other instances.  Silently ignore failures.
    let Ok(output) = std::process::Command::new("pgrep")
        .args(["-x", &exe])
        .output()
    else {
        return;
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut killed = false;
    for line in stdout.lines() {
        if let Ok(pid) = line.trim().parse::<u32>() {
            if pid != current_pid && pid != 0 {
                let _ = std::process::Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .output();
                killed = true;
            }
        }
    }

    if killed {
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
}

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

    let history_file = path("history.bin");
    let saved_file = path("pinned_entries.bin");
    let images_dir = path("images");
    let settings_file = path("settings.json");
    let boot_file = path("boot_id.txt");
    let notes_file = path("notes.bin");

    // Configure the images directory so pushed images are saved to disk.
    if let Some(ref dir) = images_dir {
        history.lock().set_images_dir(dir.clone());
    }

    // Seed the cached keep_history flag from disk (one-time read at boot).
    let keep_enabled = settings_file
        .as_deref()
        .map(|p| read_bool_setting(p, "keep_history", false))
        .unwrap_or(false);

    // Load history: full restore if same boot + keep enabled, saved-only otherwise.
    if keep_enabled {
        if let (Some(hf), Some(pf), Some(bf), Some(ad)) =
            (&history_file, &saved_file, &boot_file, &app_data)
        {
            let current_boot = system_boot_epoch_secs();
            let previous_boot: u64 = std::fs::read_to_string(bf)
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);

            let same_boot = current_boot.abs_diff(previous_boot) < 5;

            if same_boot && hf.exists() {
                // Same boot session — restore everything.
                let _ = history.lock().load_all_from_file(hf);
            } else if hf.exists() {
                // New boot — load full history then strip unsaved entries.
                let _ = history.lock().load_all_from_file(hf);
                history.lock().clear();
            } else {
                // Fallback: first run with keep enabled.
                let _ = history.lock().load_saved_from_file(pf);
            }

            let _ = std::fs::create_dir_all(ad);
            let _ = std::fs::write(bf, current_boot.to_string());
        }
    } else if let Some(pf) = &saved_file {
        let _ = history.lock().load_saved_from_file(pf);
    }

    // Load notes from disk.
    if let Some(ref nf) = notes_file {
        let _ = app.state::<AppState>().notes.lock().load_from_file(nf);
    }

    // Seed the in-memory boolean flags from disk.
    let state_ref: tauri::State<'_, AppState> = app.state();
    state_ref
        .keep_history
        .store(keep_enabled, Ordering::Relaxed);
    for (key, flag, default) in [
        ("close_to_tray", &state_ref.close_to_tray, false),
        ("start_minimized", &state_ref.start_minimized, false),
        ("autosave", &state_ref.autosave, false),
        ("show_splash", &state_ref.show_splash, true),
        // notification defaults to true when the key is absent from settings.json.
        // Operation-based notification flags also default to true.
        ("notification", &state_ref.notification_enabled, true),
        ("notif_copy", &state_ref.notif_copy, true),
        ("notif_paste", &state_ref.notif_paste, true),
    ] {
        let val = settings_file
            .as_deref()
            .map(|p| read_bool_setting(p, key, default))
            .unwrap_or(default);
        flag.store(val, Ordering::Relaxed);
    }

    // Set up system tray icon and menu.
    crate::runtime::tray::setup_tray(app)?;

    // Background flush thread: coalesces rapid mutations into a single disk write.
    {
        let hist = Arc::clone(history);
        let state: tauri::State<'_, AppState> = app.state();
        let dirty = Arc::clone(&state.history_dirty);
        let persist = Arc::clone(&state.keep_history);
        let notes_store = Arc::clone(&state.notes);
        let notes_dirty = Arc::clone(&state.notes_dirty);
        let app_handle = app.handle().clone();

        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(FLUSH_INTERVAL_MS));

            // Flush clipboard history.
            if persist.load(Ordering::Relaxed) && dirty.swap(false, Ordering::Relaxed) {
                if let Some(path) = crate::clipboard::commands::get_history_file_path(&app_handle) {
                    let _ = hist.lock().save_all_to_file(&path);
                }
                // Also keep the saved entries file up-to-date.
                if let Some(pf) = app_handle
                    .path()
                    .app_data_dir()
                    .ok()
                    .map(|d| d.join("pinned_entries.bin"))
                {
                    let _ = hist.lock().save_saved_to_file(&pf);
                }
            }

            // Flush notes.
            if notes_dirty.swap(false, Ordering::Relaxed) {
                if let Some(nf) = app_handle
                    .path()
                    .app_data_dir()
                    .ok()
                    .map(|d| d.join("notes.bin"))
                {
                    let _ = notes_store.lock().save_to_file(&nf);
                }
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
        keep_history: Arc::new(AtomicBool::new(false)),
        history_dirty: Arc::new(AtomicBool::new(false)),
        close_to_tray: Arc::new(AtomicBool::new(false)),
        start_minimized: Arc::new(AtomicBool::new(false)),
        notification_enabled: Arc::new(AtomicBool::new(true)),
        notif_copy: Arc::new(AtomicBool::new(true)),
        notif_paste: Arc::new(AtomicBool::new(true)),
        autosave: Arc::new(AtomicBool::new(false)),
        show_splash: Arc::new(AtomicBool::new(true)),
        active_clipboard_id: Arc::new(parking_lot::Mutex::new(String::new())),
        notes: Arc::new(parking_lot::Mutex::new(crate::notes::NoteStore::new())),
        notes_dirty: Arc::new(AtomicBool::new(false)),
    };

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
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
            crate::clipboard::commands::check_missing_files,
            crate::clipboard::commands::get_setting,
            crate::clipboard::commands::set_setting,
            crate::clipboard::commands::save_history,
            crate::clipboard::commands::set_entry_groups,
            crate::clipboard::commands::purge_group_from_entries,
            crate::clipboard::commands::rename_group_in_entries,
            crate::clipboard::commands::bulk_delete_entries,
            crate::clipboard::commands::bulk_pin_entries,
            crate::clipboard::commands::bulk_set_groups,
            crate::clipboard::commands::bulk_add_group,
            crate::clipboard::commands::bulk_remove_group,
            crate::clipboard::commands::get_active_clipboard_id,
            crate::runtime::commands::close_copy_popup,
            crate::runtime::commands::close_paste_popup,
            crate::runtime::commands::resize_paste_popup,
            crate::runtime::commands::resize_copy_popup,
            crate::runtime::commands::open_data_folder,
            crate::runtime::commands::get_autostart,
            crate::runtime::commands::set_autostart,
            crate::runtime::commands::close_notification,
            crate::notes::commands::get_notes,
            crate::notes::commands::create_note,
            crate::notes::commands::update_note,
            crate::notes::commands::delete_note,
            crate::notes::commands::pin_note,
            crate::notes::commands::unpin_note,
            crate::notes::commands::set_note_groups,
            crate::notes::commands::purge_group_from_notes,
            crate::notes::commands::rename_group_in_notes,
            crate::notes::commands::save_note_image,
            crate::notes::commands::save_note_file,
            crate::notes::commands::get_note_attachments_dirs,
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let close_to_tray = window
                        .app_handle()
                        .state::<AppState>()
                        .close_to_tray
                        .load(Ordering::Relaxed);
                    if close_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    window.app_handle().exit(0);
                }
                _ => {}
            }
        })
        .setup(move |app| {
            setup_runtime(app, &history, &suppress)?;
            // Close the splash window from Rust — JS close() is unreliable for
            // conf.json windows on Windows (handle can persist as a click-blocker).
            // If show_splash is off, close immediately (100 ms safety margin so
            // the webview has time to exist before we close it).
            let show = app.state::<AppState>().show_splash.load(Ordering::Relaxed);
            let delay_ms: u64 = if show { 3_200 } else { 100 };
            let ah = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                if let Some(w) = ah.get_webview_window("splash") {
                    let _ = w.close();
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
