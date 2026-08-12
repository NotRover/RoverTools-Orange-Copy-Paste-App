//! Smart Clipboard – Tauri/Rust backend.

pub mod clipboard;
pub mod notes;
pub mod runtime;
pub mod state;
pub mod sync;

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
/// Failures are silently ignored.
fn kill_previous_instance() {
    let exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();
    if exe.is_empty() {
        return;
    }

    let current_pid = std::process::id();
    let mut killed = false;
    for pid in list_instance_pids(&exe) {
        if pid != current_pid && pid != 0 {
            kill_pid(pid);
            killed = true;
        }
    }

    if killed {
        // Give the OS a moment to reclaim the global hotkeys.
        let ms = if cfg!(windows) { 400 } else { 300 };
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// PIDs of all running processes whose image name is `exe`.
#[cfg(windows)]
fn list_instance_pids(exe: &str) -> Vec<u32> {
    use std::os::windows::process::CommandExt;
    let Ok(output) = std::process::Command::new("tasklist")
        .args(["/FI", &format!("IMAGENAME eq {exe}"), "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return Vec::new();
    };
    // CSV lines look like: "executable.exe","12345","Console","1","10,000 K"
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            line.split(',')
                .nth(1)?
                .trim()
                .trim_matches('"')
                .parse()
                .ok()
        })
        .collect()
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
fn list_instance_pids(exe: &str) -> Vec<u32> {
    let Ok(output) = std::process::Command::new("pgrep").args(["-x", exe]).output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .collect()
}

#[cfg(not(windows))]
fn kill_pid(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output();
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
        // Paths are stable for the app's lifetime — resolve once, not per tick.
        let history_file = history_file.clone();
        let saved_file = saved_file.clone();
        let notes_file = notes_file.clone();

        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(FLUSH_INTERVAL_MS));

            // Flush clipboard history (plus the saved-entries file).
            if persist.load(Ordering::Relaxed) && dirty.swap(false, Ordering::Relaxed) {
                if let Some(hf) = &history_file {
                    let _ = hist.lock().save_all_to_file(hf);
                }
                if let Some(pf) = &saved_file {
                    let _ = hist.lock().save_saved_to_file(pf);
                }
            }

            // Flush notes.
            if notes_dirty.swap(false, Ordering::Relaxed) {
                if let Some(nf) = &notes_file {
                    let _ = notes_store.lock().save_to_file(nf);
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

    // Initialize cloud sync if it was enabled when the app last quit.
    let sync_config = crate::sync::config::SyncConfig::load(&app.handle().clone());
    if sync_config.enabled {
        match crate::sync::SyncClient::new(app.handle().clone(), sync_config) {
            Ok(client) => {
                *app.state::<AppState>().sync_client.lock() =
                    Some(std::sync::Arc::new(client));
            }
            Err(e) => eprintln!("[sync] init failed: {e}"),
        }
    }

    Ok(())
}

/// Parse a `--trigger <action>` argument out of a process argv, returning the
/// action string (`"copy"` / `"paste"`). Accepts both the space-separated
/// (`--trigger copy`) and `=`-joined (`--trigger=copy`) forms.
///
/// This backs the Wayland popup fallback: users bind a compositor keybind to
/// `rovertools --trigger copy|paste`, and that relaunch is routed to the
/// running instance by the single-instance plugin.
fn parse_trigger_action(args: &[String]) -> Option<String> {
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let Some(rest) = arg.strip_prefix("--trigger") else {
            continue;
        };
        if let Some(val) = rest.strip_prefix('=') {
            if !val.is_empty() {
                return Some(val.to_string());
            }
        } else if rest.is_empty() {
            // Space-separated form: the value is the next argument.
            if let Some(next) = it.next() {
                return Some(next.clone());
            }
        }
    }
    None
}

/// Dispatch a forwarded CLI invocation to the matching popup handler.
/// A no-op for unrecognized actions.
fn dispatch_trigger(app: &tauri::AppHandle, args: &[String]) {
    match parse_trigger_action(args).as_deref() {
        Some("copy") => crate::runtime::hotkeys::trigger_copy_popup(app),
        Some("paste") => crate::runtime::hotkeys::trigger_paste_popup(app),
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launch_args: Vec<String> = std::env::args().collect();
    let is_trigger = parse_trigger_action(&launch_args).is_some();

    // A `--trigger` launch must reach the ALREADY-RUNNING instance (via the
    // single-instance plugin) and fire the popup there, so it must NOT kill the
    // primary. Normal launches keep the "new instance replaces old" behavior
    // that releases the old process's global hotkeys on restart.
    if !is_trigger {
        kill_previous_instance();
    }

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
        sync_client: parking_lot::Mutex::new(None),
    };

    tauri::Builder::default()
        // MUST be the first plugin registered. Runs the closure in the primary
        // instance whenever a second instance launches: a `--trigger` relaunch
        // fires the popup here; any other relaunch just surfaces the main window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if parse_trigger_action(&argv).is_some() {
                dispatch_trigger(app, &argv);
            } else if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
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
            crate::notes::commands::export_note_text,
            // Cloud sync commands
            crate::sync::commands::sync_login,
            crate::sync::commands::sync_signup,
            crate::sync::commands::sync_oauth_begin,
            crate::sync::commands::sync_oauth_complete,
            crate::sync::commands::sync_oauth_cancel,
            crate::sync::commands::sync_reset_password,
            crate::sync::commands::sync_logout,
            crate::sync::commands::sync_get_user,
            crate::sync::commands::sync_get_status,
            crate::sync::commands::sync_now,
            crate::sync::commands::sync_set_enabled,
            crate::sync::commands::sync_get_connection,
            crate::sync::commands::sync_receive_local_settings,
            crate::sync::commands::sync_push_settings,
            crate::sync::commands::sync_pull_settings,
            crate::sync::commands::sync_get_groups,
            crate::sync::commands::sync_create_group,
            crate::sync::commands::sync_join_group,
            crate::sync::commands::sync_leave_group,
            crate::sync::commands::sync_get_quota,
            crate::sync::commands::sync_list_devices,
            crate::sync::commands::sharing_invite,
            crate::sync::commands::sharing_accept,
            crate::sync::commands::sharing_get_sessions,
            crate::sync::commands::sharing_refresh_sessions,
            crate::sync::commands::sync_remove_member,
            crate::sync::commands::sync_delete_group,
            crate::sync::commands::sync_revoke_device,
            crate::sync::commands::sync_list_invites,
            crate::sync::commands::sync_send_invite,
            crate::sync::commands::sync_accept_invite,
            crate::sync::commands::sync_decline_invite,
            crate::sync::commands::sync_revoke_invite,
            crate::sync::commands::sharing_update_scope,
            crate::sync::commands::sharing_end_session,
            crate::sync::commands::sharing_leave_session,
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
            let state     = app.state::<AppState>();
            let show      = state.show_splash.load(Ordering::Relaxed);
            let minimized = state.start_minimized.load(Ordering::Relaxed);
            // Only hold the splash open when the main window is hidden.
            // If the main window is visible, dismiss immediately so the two
            // windows don't overlap.
            let delay_ms: u64 = if show && minimized { 3_200 } else { 100 };
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
