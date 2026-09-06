//! Smart Clipboard – Tauri/Rust backend.

pub mod clipboard;
pub mod clock;
pub mod health;
pub mod notes;
pub mod notifications;
pub mod runtime;
pub mod settings_file;
pub mod state;
pub mod sync;
pub mod updater;

pub use state::AppState;

use crate::clipboard::history::ClipboardHistory;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};

pub type SharedHistory = Arc<Mutex<ClipboardHistory>>;
type SuppressFlag = Arc<AtomicBool>;

const FLUSH_INTERVAL_MS: u64 = 2000;

/// How long an exit or a relaunch waits for a refresh-token rotation to become
/// durable.
///
/// Sized from the keychain write's own retry ladder - `KEYCHAIN_WRITE_BACKOFF_MS`
/// in `sync/crypto.rs` spends 2420 ms across its five attempts - plus the write.
/// A rotation that is going to succeed should not be cut off one step from the
/// end, and the point of waiting is lost if the budget is shorter than the thing
/// being waited for.
const EXIT_DRAIN_MS: u64 = 3000;

const DRAIN_POLL_MS: u64 = 25;

/// Wait, up to `budget_ms`, for this process to finish spending a refresh token.
///
/// GoTrue revokes a refresh token the instant it is presented, so between that
/// request and the keychain write the account's only live credential exists
/// nowhere but memory. Dying there is not a retryable failure: the next launch
/// presents a token the server has already thrown away, and the user needs a
/// password. Every other kind of shutdown work is best-effort; this one is the
/// difference between a session and a sign-in.
///
/// Synchronous and runtime-free on purpose. Every caller is either Tauri's main
/// thread or a plain `std::thread`, and none of them may reach into the sync
/// module's runtime - so this polls an atomic rather than awaiting anything.
///
/// Returns whether the window closed in time. A timeout is recorded, never
/// enforced: an app that cannot be quit is a worse bug than a session that has
/// to be signed into again.
pub(crate) fn drain_token_rotation(budget_ms: u64) -> bool {
    if !crate::sync::client::rotation_in_flight() {
        return true;
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget_ms);
    while std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(DRAIN_POLL_MS));
        if !crate::sync::client::rotation_in_flight() {
            return true;
        }
    }
    crate::health::note(
        "exit: a refresh token rotation did not finish",
        "the process is leaving mid-rotation, so the next launch may have to sign in",
    );
    false
}

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

/// Write every dirty store to disk, once.
///
/// The single flush implementation: the background timer calls it every couple
/// of seconds, and every way out of the process calls it last — `RunEvent::Exit`
/// for ordinary quits, and the two restart commands, which bypass the event
/// loop. Without the exit calls, everything captured since the previous tick
/// (up to `FLUSH_INTERVAL_MS`) died with the process on every normal quit.
///
/// Idempotent and cheap when clean: each dirty flag is swapped off before its
/// write, so overlapping callers do the work once. Every save funnels through
/// `health::write_state`, so degraded and sealed files stay protected here the
/// same as everywhere else.
pub(crate) fn flush_dirty_stores(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Ok(app_data) = app.path().app_data_dir() else {
        return;
    };
    let state: tauri::State<'_, AppState> = app.state();

    if state.keep_history.load(Ordering::Relaxed)
        && state.history_dirty.swap(false, Ordering::Relaxed)
    {
        let _ = state.history.lock().save_all_to_file(&app_data.join("history.bin"));
        let _ = state
            .history
            .lock()
            .save_saved_to_file(&app_data.join("pinned_entries.bin"));
    }
    if state.notes_dirty.swap(false, Ordering::Relaxed) {
        let _ = state.notes.lock().save_to_file(&app_data.join("notes.bin"));
    }
    if state.notifications_dirty.swap(false, Ordering::Relaxed) {
        let _ = state
            .notifications
            .lock()
            .save_to_file(&app_data.join("notifications.bin"));
    }
}

/// Read every boolean flag from one already-loaded settings map.
///
/// One read for the whole startup rather than one per key: nine reads of the
/// same file gave nine chances to hit a transient failure, and a missed
/// `keep_history` costs the user their restored history.
fn bool_setting(map: Option<&crate::settings_file::Map>, key: &str, default: bool) -> bool {
    map.and_then(|m| m.get(key)?.as_bool()).unwrap_or(default)
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
    let victims: Vec<u32> = list_instance_pids(&exe)
        .into_iter()
        .filter(|pid| *pid != current_pid && *pid != 0)
        .collect();
    if victims.is_empty() {
        return;
    }

    wait_out_rotation(&victims);
    for pid in &victims {
        kill_pid(*pid);
    }

    // Give the OS a moment to reclaim the global hotkeys.
    let ms = if cfg!(windows) { 400 } else { 300 };
    std::thread::sleep(std::time::Duration::from_millis(ms));
}

/// Hold off the kill while the instance being replaced is spending a refresh
/// token.
///
/// The exit drain cannot help here: the victim never learns it is about to die,
/// and a forced termination gives it nothing to finish with. So the killer has
/// to be the one that waits, which is why the rotation marker is a file rather
/// than the in-process counter the drain reads.
///
/// The marker names the process that claimed it, and that name is what keeps
/// this cheap. A marker abandoned by a crash belongs to a pid that is not among
/// the instances we are about to kill, so it costs a single file read rather
/// than the full wait on every launch that follows.
fn wait_out_rotation(victims: &[u32]) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(EXIT_DRAIN_MS);
    loop {
        match crate::sync::client::rotation_marker_pid() {
            Some(pid) if victims.contains(&pid) => {}
            // Either nothing is rotating, or what is rotating belongs to a
            // process we are not about to kill.
            _ => return,
        }
        if std::time::Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(DRAIN_POLL_MS));
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
    let received_files_dir = path("received-files");
    let settings_file = path("settings.json");
    let boot_file = path("boot_id.txt");
    let notes_file = path("notes.bin");
    let notifications_file = path("notifications.bin");

    // Configure the images directory so pushed images are saved to disk.
    if let Some(ref dir) = images_dir {
        history.lock().set_images_dir(dir.clone());
    }
    // And the dir where synced file entries are extracted, so a full save can
    // prune the subdirs of entries that have since been deleted.
    if let Some(ref dir) = received_files_dir {
        history.lock().set_received_files_dir(dir.clone());
    }

    // One read of settings.json for every flag below.
    let settings = settings_file.as_deref().and_then(|p| {
        match crate::settings_file::read_map(p) {
            Ok(map) => Some(map),
            Err(crate::settings_file::ReadError::Absent) => None,
            Err(crate::settings_file::ReadError::Unreadable(e))
            | Err(crate::settings_file::ReadError::Malformed(e)) => {
                crate::health::note(
                    "startup: settings.json could not be read",
                    &format!("{e} - every preference falls back to its default this launch"),
                );
                None
            }
        }
    });
    let keep_enabled = bool_setting(settings.as_ref(), "keep_history", false);

    // Adopt anything a degraded session had to set aside before its restart, so
    // what the user captured after the fault is not stranded on disk. A file-level
    // swap, so every load below reads the path it always did.
    for (path, label) in [
        (history_file.as_ref(), "clipboard history"),
        (saved_file.as_ref(), "clipboard history"),
        (notes_file.as_ref(), "notes"),
        (notifications_file.as_ref(), "notifications"),
    ] {
        if let Some(p) = path {
            crate::health::recover_quarantined(p, label);
        }
    }

    // Load history: full restore if same boot + keep enabled, saved-only otherwise.
    if keep_enabled {
        if let (Some(hf), Some(pf), Some(bf)) = (&history_file, &saved_file, &boot_file) {
            let current_boot = system_boot_epoch_secs();
            // A marker that is absent is a first run; a marker that is there and
            // will not read is a fault, and the two must not decide the same
            // thing. Reading it as "no previous boot" makes `same_boot` false and
            // sends the restore down the branch that strips every unsaved entry -
            // so one refused read costs the user their history on what was an
            // ordinary restart. When it cannot be read, keep what is on disk.
            let marker = crate::health::read_state(bf);
            let previous_boot: u64 = match &marker {
                Ok(Some(raw)) => String::from_utf8_lossy(raw)
                    .trim()
                    .parse()
                    .unwrap_or(0),
                _ => 0,
            };
            let marker_unreadable = marker.is_err();

            let same_boot = current_boot.abs_diff(previous_boot) < 5;

            if (same_boot || marker_unreadable) && hf.exists() {
                // Same boot session — restore everything. Also the safe branch
                // when the marker is unreadable: keeping entries the user may
                // have expected to be dropped is recoverable, dropping entries
                // they expected to keep is not.
                let _ = history.lock().load_all_from_file(hf);
            } else if hf.exists() {
                // New boot — load full history then strip unsaved entries. Only
                // reached when the load succeeded, since a sealed history is
                // empty for reasons that have nothing to do with the boot.
                let loaded = history.lock().load_all_from_file(hf).is_ok();
                if loaded {
                    history.lock().clear();
                }
            } else {
                // Fallback: first run with keep enabled.
                let _ = history.lock().load_saved_from_file(pf);
            }

            // Boot marker decides whether history survives a reboot, so a
            // half-written value must not be readable as a valid timestamp.
            let _ = crate::health::write_atomic(bf, current_boot.to_string().as_bytes());
        }
    } else if let Some(pf) = &saved_file {
        let _ = history.lock().load_saved_from_file(pf);
    }

    // Load notes from disk.
    if let Some(ref nf) = notes_file {
        let _ = app.state::<AppState>().notes.lock().load_from_file(nf);
    }

    // Load the notification feed from disk.
    if let Some(ref nf) = notifications_file {
        let _ = app
            .state::<AppState>()
            .notifications
            .lock()
            .load_from_file(nf);
    }

    // Fold in whatever a sealed session set aside - captures made while a state
    // file existed but would not read. Merged by id after the normal loads, so
    // the main file wins any overlap; the leftover is only discarded once a
    // save that includes it has landed, and a still-sealed file refuses that
    // save, so nothing here can lose either copy.
    {
        let state_ref: tauri::State<'_, AppState> = app.state();
        if let Some(hf) = &history_file {
            if let Some(bytes) = crate::health::sealed_leftover(hf) {
                match state_ref.history.lock().merge_leftover(&bytes) {
                    Some(0) => crate::health::discard_sealed_leftover(hf),
                    Some(_) if state_ref.history.lock().save_all_to_file(hf).is_ok() => {
                        crate::health::discard_sealed_leftover(hf)
                    }
                    _ => {}
                }
            }
        }
        if let Some(pf) = &saved_file {
            if let Some(bytes) = crate::health::sealed_leftover(pf) {
                match state_ref.history.lock().merge_leftover(&bytes) {
                    Some(0) => crate::health::discard_sealed_leftover(pf),
                    Some(_) if state_ref.history.lock().save_saved_to_file(pf).is_ok() => {
                        crate::health::discard_sealed_leftover(pf)
                    }
                    _ => {}
                }
            }
        }
        if let Some(nf) = &notes_file {
            if let Some(bytes) = crate::health::sealed_leftover(nf) {
                match state_ref.notes.lock().merge_leftover(&bytes) {
                    Some(0) => crate::health::discard_sealed_leftover(nf),
                    Some(_) if state_ref.notes.lock().save_to_file(nf).is_ok() => {
                        crate::health::discard_sealed_leftover(nf)
                    }
                    _ => {}
                }
            }
        }
        if let Some(nf) = &notifications_file {
            if let Some(bytes) = crate::health::sealed_leftover(nf) {
                match state_ref.notifications.lock().merge_leftover(&bytes) {
                    Some(0) => crate::health::discard_sealed_leftover(nf),
                    Some(_) if state_ref.notifications.lock().save_to_file(nf).is_ok() => {
                        crate::health::discard_sealed_leftover(nf)
                    }
                    _ => {}
                }
            }
        }
    }

    // Drop anything a history file written before the capture cap can be
    // holding. Placed after the loads and the sealed-leftover merges, so it
    // sees everything that made it into memory, and after the notification
    // store is up so the notice can be recorded.
    {
        let state_ref: tauri::State<'_, AppState> = app.state();
        let dropped = state_ref.history.lock().drop_oversized();
        if !dropped.is_empty() {
            state_ref.history_dirty.store(true, Ordering::Relaxed);
            crate::clipboard::commands::notify_oversized_dropped(app.handle(), &dropped);
        }
    }

    // Seed the in-memory boolean flags from disk.
    let state_ref: tauri::State<'_, AppState> = app.state();
    state_ref
        .keep_history
        .store(keep_enabled, Ordering::Relaxed);
    for (key, flag, default) in [
        ("close_to_tray", &state_ref.close_to_tray, false),
        ("os_notifications", &state_ref.os_notifications, true),
        ("start_minimized", &state_ref.start_minimized, false),
        ("autosave", &state_ref.autosave, false),
        ("show_splash", &state_ref.show_splash, true),
        // notification defaults to true when the key is absent from settings.json.
        // Operation-based notification flags also default to true.
        ("notification", &state_ref.notification_enabled, true),
        ("notif_copy", &state_ref.notif_copy, true),
        ("notif_paste", &state_ref.notif_paste, true),
    ] {
        flag.store(bool_setting(settings.as_ref(), key, default), Ordering::Relaxed);
    }

    // Set up system tray icon and menu.
    crate::runtime::tray::setup_tray(app)?;

    // Background flush thread: coalesces rapid mutations into a single disk
    // write. The body is the same `flush_dirty_stores` every exit path calls,
    // so there is exactly one flush to reason about.
    {
        let handle = app.handle().clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(FLUSH_INTERVAL_MS));
            flush_dirty_stores(&handle);
            // Reached only by taking and releasing every state lock above, so it
            // doubles as proof that none of them are wedged. The watchdog warns
            // the user if these stop arriving.
            crate::health::beat();
        });

        crate::health::start_stall_watchdog(app.handle().clone());
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
    //
    // Through the same helper the commands use, not a second hand-rolled
    // construction: building the client is only half of starting sync, and the
    // half this path used to skip - the passive pull and reminder loops - could
    // never be repaired later, because every command that would have started
    // them returns the client this path already installed. The gate stays out
    // here because the helper deliberately does not consult `enabled`; a
    // sign-in has to be able to build a client before sync was ever turned on.
    let sync_config = crate::sync::config::SyncConfig::load(&app.handle().clone());
    if sync_config.enabled {
        let handle = app.handle().clone();
        let state = app.state::<AppState>();
        if let Err(e) = crate::sync::commands::get_or_create_client_with(&state, &handle, sync_config)
        {
            eprintln!("[sync] init failed: {e}");
            crate::health::note("sync: could not start at launch", &e);
        }
    }

    // An in-place update reinstalls the app, and on Windows that rewrites the
    // executable the startup entry points at. Rewrite the entry from where this
    // build actually lives, so "Run on startup" survives an update instead of
    // silently pointing at a path the installer replaced.
    crate::runtime::commands::reconcile_autostart(&app.handle().clone());

    // Last: the update check is the least urgent thing the app does, and it
    // sleeps before running anyway.
    crate::updater::spawn_startup_check(&app.handle().clone());

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

/// What an `orange://` URL is asking for.
#[derive(Debug, PartialEq)]
enum DeepLink {
    /// `orange://join?code=<invite code>`
    Join(String),
    /// `orange://reset?code=<one-time code>` - the password-reset mail, by way of
    /// the web page the link actually points at.
    Reset(String),
}

/// Read an `orange://` URL.
///
/// Keyed on the host, with one deliberate exception: anything other than `reset`
/// that carries a code is a join. Invite links in the wild predate the host being
/// meaningful (`orange://join?code=`, and older lax forms), and they have been
/// pasted into mail that is not going to be re-sent.
fn parse_deep_link(url: &str) -> Option<DeepLink> {
    let rest = url.strip_prefix("orange://")?;
    let (host, query) = rest.split_once('?')?;
    let code = query.split('&').find_map(|pair| {
        let value = pair.strip_prefix("code=")?.trim();
        (!value.is_empty()).then(|| value.to_string())
    })?;
    let host = host.trim_end_matches('/');
    Some(if host == "reset" {
        DeepLink::Reset(code)
    } else {
        DeepLink::Join(code)
    })
}

/// Hand an opened `orange://` URL to the UI. A URL that asks for nothing we
/// recognize is ignored rather than surfacing an error for something the user
/// never typed.
///
/// Raising the window happens *before* the parse, so a bare `orange://` is a
/// usable "bring the app forward" link. The OAuth callback page in the browser
/// uses exactly that as its manual fallback.
fn dispatch_deep_link(app: &tauri::AppHandle, url: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    match parse_deep_link(url) {
        Some(DeepLink::Join(code)) => {
            let _ = app.emit("spaces:join-code", serde_json::json!({ "code": code }));
        }
        Some(DeepLink::Reset(code)) => {
            let _ = app.emit("sync:password-reset", serde_json::json!({ "code": code }));
        }
        None => {}
    }
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
    // A deep link is handled like a trigger: it belongs to the running instance,
    // so this process must forward it rather than replace the app the user is
    // already looking at.
    let is_deep_link = launch_args.iter().any(|a| a.starts_with("orange://"));
    let is_trigger = parse_trigger_action(&launch_args).is_some() || is_deep_link;

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
        os_notifications: Arc::new(AtomicBool::new(true)),
        start_minimized: Arc::new(AtomicBool::new(false)),
        notification_enabled: Arc::new(AtomicBool::new(true)),
        notif_copy: Arc::new(AtomicBool::new(true)),
        notif_paste: Arc::new(AtomicBool::new(true)),
        autosave: Arc::new(AtomicBool::new(false)),
        show_splash: Arc::new(AtomicBool::new(true)),
        active_clipboard_id: Arc::new(parking_lot::Mutex::new(String::new())),
        notes: Arc::new(parking_lot::Mutex::new(crate::notes::NoteStore::new())),
        notes_dirty: Arc::new(AtomicBool::new(false)),
        notifications: Arc::new(parking_lot::Mutex::new(
            crate::notifications::NotificationStore::new(),
        )),
        notifications_dirty: Arc::new(AtomicBool::new(false)),
        sync_client: parking_lot::Mutex::new(None),
        ui_view: Arc::new(parking_lot::Mutex::new(
            crate::state::app_state::UiView::default(),
        )),
    };

    tauri::Builder::default()
        // MUST be the first plugin registered. Runs the closure in the primary
        // instance whenever a second instance launches: a `--trigger` relaunch
        // fires the popup here; any other relaunch just surfaces the main window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if parse_trigger_action(&argv).is_some() {
                dispatch_trigger(app, &argv);
                return;
            }
            // An invite link opened while the app is already running arrives
            // here as an argument to the second launch, not through the
            // deep-link plugin's own callback.
            if let Some(url) = argv.iter().find(|a| a.starts_with("orange://")) {
                dispatch_deep_link(app, url);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                crate::runtime::window_state::apply_deferred_zoom(app);
                let _ = w.set_focus();
            }
        }))
        .manage(app_state)
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            crate::health::health_degraded_reason,
            crate::health::health_sealed_notice,
            crate::health::health_trouble,
            crate::health::health_recovery_notice,
            crate::health::health_restart_app,
            crate::clipboard::commands::get_history,
            crate::clipboard::commands::delete_entry,
            crate::clipboard::commands::clear_history,
            crate::clipboard::commands::pin_entry,
            crate::clipboard::commands::unpin_entry,
            crate::clipboard::commands::copy_entry,
            crate::clipboard::commands::paste_entry,
            crate::clipboard::commands::get_image_file_preview,
            crate::clipboard::commands::check_missing_files,
            crate::clipboard::commands::stat_files,
            crate::clipboard::commands::get_setting,
            crate::clipboard::commands::set_setting,
            crate::clipboard::commands::save_history,
            crate::clipboard::commands::set_entry_groups,
            crate::clipboard::commands::purge_group_from_entries,
            crate::clipboard::commands::rename_group_in_entries,
            crate::clipboard::commands::bulk_delete_entries,
            crate::clipboard::commands::bulk_pin_entries,
            crate::clipboard::commands::bulk_add_group,
            crate::clipboard::commands::bulk_remove_group,
            crate::clipboard::commands::get_active_clipboard_id,
            crate::runtime::commands::close_copy_popup,
            crate::runtime::commands::present_copy_popup,
            crate::runtime::commands::close_paste_popup,
            crate::runtime::commands::resize_paste_popup,
            crate::runtime::commands::resize_copy_popup,
            crate::runtime::commands::clamp_popup,
            crate::runtime::commands::open_data_folder,
            crate::runtime::commands::get_autostart,
            crate::runtime::commands::set_autostart,
            crate::updater::updater_check,
            crate::updater::updater_pending,
            crate::updater::updater_current_version,
            crate::updater::updater_download,
            crate::updater::updater_install,
            crate::updater::updater_skip_version,
            crate::runtime::commands::close_notification,
            crate::runtime::commands::close_splash,
            crate::runtime::commands::ui_screen_changed,
            crate::runtime::commands::ui_space_changed,
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
            crate::notifications::commands::notifications_list,
            crate::notifications::commands::notifications_refresh,
            crate::notifications::commands::notifications_mark_read,
            crate::notifications::commands::notifications_mark_all_read,
            crate::notifications::commands::notifications_dismiss,
            crate::notifications::commands::notifications_clear_read,
            // Cloud sync commands
            crate::sync::commands::sync_login,
            crate::sync::commands::sync_signup,
            crate::sync::commands::sync_oauth_begin,
            crate::sync::commands::sync_oauth_complete,
            crate::sync::commands::sync_oauth_cancel,
            crate::sync::commands::sync_oauth_pending,
            crate::sync::commands::sync_reset_password,
            crate::sync::commands::sync_complete_password_reset,
            crate::sync::commands::sync_cancel_password_reset,
            crate::sync::commands::sync_change_password,
            crate::sync::commands::sync_create_recovery_code,
            crate::sync::commands::sync_has_recovery_code,
            crate::sync::commands::sync_restore_session,
            crate::sync::commands::sync_logout,
            crate::sync::commands::sync_get_user,
            crate::sync::commands::sync_get_status,
            crate::sync::commands::sync_clear_skipped,
            crate::sync::commands::sync_retry_skipped,
            crate::sync::commands::sync_preview_unsynced,
            crate::sync::commands::sync_push_unsynced,
            crate::sync::commands::sync_push_entries,
            crate::sync::commands::sync_unpush_entries,
            crate::sync::commands::sync_unpush_all,
            crate::sync::commands::sync_server_entry_count,
            crate::sync::commands::sync_server_breakdown,
            crate::sync::commands::sync_bulk_progress,
            crate::sync::commands::sync_get_entry_shares,
            crate::sync::commands::sync_get_remote_entries,
            crate::sync::commands::sync_get_entry_owners,
            crate::sync::commands::sync_get_entry_arrivals,
            crate::sync::commands::clock_offset_ms,
            crate::sync::commands::sync_get_deleted_markers,
            crate::sync::commands::space_clear_removed,
            crate::sync::commands::sync_get_entry_states,
            crate::sync::commands::sync_now,
            crate::sync::commands::sync_catch_up,
            crate::sync::commands::sync_set_enabled,
            crate::sync::commands::sync_get_connection,
            crate::sync::commands::sync_receive_local_settings,
            crate::sync::commands::sync_pull_settings,
            crate::sync::commands::spaces_list,
            crate::sync::commands::spaces_cached,
            crate::sync::commands::space_create,
            crate::sync::commands::space_join,
            crate::sync::commands::space_join_requests,
            crate::sync::commands::space_my_join_requests,
            crate::sync::commands::space_approve_join,
            crate::sync::commands::space_decline_join,
            crate::sync::commands::space_set_members_can_approve,
            crate::sync::commands::space_invite_link,
            crate::sync::commands::space_leave,
            crate::sync::commands::space_delete,
            crate::sync::commands::space_remove_member,
            crate::sync::commands::space_remove_entry,
            crate::sync::commands::space_set_entry_shares,
            crate::sync::commands::space_set_autocopy,
            crate::sync::commands::space_set_share_history,
            crate::sync::commands::space_comment_add,
            crate::sync::commands::space_comments_list,
            crate::sync::commands::space_comment_counts,
            crate::sync::commands::space_comment_delete,
            crate::sync::commands::space_set_send_filter,
            crate::sync::commands::space_get_send_filters,
            crate::sync::commands::sync_set_mode,
            crate::sync::commands::sync_get_mode,
            crate::sync::commands::sync_get_quota,
            crate::sync::commands::sync_list_devices,
            crate::sync::commands::sync_revoke_device,
            crate::sync::commands::sync_list_invites,
            crate::sync::commands::sync_send_invite,
            crate::sync::commands::sync_accept_invite,
            crate::sync::commands::sync_decline_invite,
            crate::sync::commands::sync_revoke_invite,
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
            // Installed before any other setup work, so a panic inside it lands
            // in the log too.
            crate::health::set_diag_dir(app.path().app_data_dir().ok());
            crate::health::install_panic_hook(app.handle().clone());
            setup_runtime(app, &history, &suppress)?;
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Installed builds get the scheme from the installer; a dev or
                // portable run has to claim it at startup or the link has no
                // handler at all.
                let _ = app.deep_link().register_all();
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        dispatch_deep_link(&handle, url.as_str());
                    }
                });
            }
            // The startup splash is a compact toast docked at the bottom-right
            // corner, by the tray. It is created hidden (tauri.conf.json) so it
            // can be positioned before it appears - otherwise it would flash at
            // the default location first. Reuses the same corner math and margin
            // as the app's notification toast.
            //
            // Keep 340x76 in sync with the splash window size in tauri.conf.json.
            let state = app.state::<AppState>();
            let show  = state.show_splash.load(Ordering::Relaxed);
            let ah = app.handle().clone();
            if show {
                if let Some(w) = ah.get_webview_window("splash") {
                    let (px, py) = crate::runtime::platform::notification_position(340, 76);
                    let _ = w.set_position(tauri::PhysicalPosition::new(px, py));
                    let _ = w.show();
                    // Non-interactive: never blocks a click in the corner it
                    // covers. Must run after show() (see notifications.rs).
                    let _ = w.set_ignore_cursor_events(true);
                }
                // Hard-cap fallback close. The splash normally closes itself via
                // the `close_splash` command once its sequence finishes - it owns
                // the timing because it holds longer when it has an update to
                // announce. This timer only fires if that never arrives (a stalled
                // webview), so it sits well above every JS-driven close time in
                // SplashScreen.tsx. Routed through Rust because a JS close() on
                // this conf.json window can leave a click-blocking handle behind.
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(11_000));
                    if let Some(w) = ah.get_webview_window("splash") {
                        let _ = w.close();
                    }
                });
            } else if let Some(w) = ah.get_webview_window("splash") {
                // Splash disabled in settings: it was never shown, just discard it.
                let _ = w.close();
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match event {
            // Quitting mid-rotation is the one shutdown that costs the user
            // their session, so it is the one worth delaying. Everything else
            // about this arm is arranged to leave the ordinary quit untouched:
            // the check is an atomic read, and when nothing is rotating the
            // handler returns before allocating a thread or preventing anything.
            tauri::RunEvent::ExitRequested { api, .. } => {
                // Two flags, because there are two independent ways to arrive
                // here - the last window being destroyed, and an explicit
                // `exit` - and the drain re-issues the exit itself. One flag
                // stops the drain starting twice; the other stops us blocking
                // the very exit we asked for. Collapsing them into one gives
                // either a skipped drain or an app that cannot be quit.
                static DRAIN_STARTED: AtomicBool = AtomicBool::new(false);
                static EXIT_REISSUED: AtomicBool = AtomicBool::new(false);
                if EXIT_REISSUED.load(Ordering::SeqCst) {
                    return;
                }
                if !crate::sync::client::rotation_in_flight() {
                    return;
                }
                api.prevent_exit();
                if DRAIN_STARTED.swap(true, Ordering::SeqCst) {
                    return;
                }
                // Off the main thread: the event loop has to keep running for
                // the re-issued exit to be delivered at all.
                let handle = app.clone();
                std::thread::spawn(move || {
                    drain_token_rotation(EXIT_DRAIN_MS);
                    EXIT_REISSUED.store(true, Ordering::SeqCst);
                    handle.exit(0);
                });
            }
            // The last thing the process does with user data. `app.exit(0)` on
            // window destroy lands here too; only `app.restart()` bypasses the
            // event loop, and both restart sites flush for themselves.
            tauri::RunEvent::Exit => flush_dirty_stores(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{parse_deep_link, DeepLink};

    #[test]
    fn reset_links_are_told_apart_from_invites() {
        assert_eq!(
            parse_deep_link("orange://reset?code=abc123"),
            Some(DeepLink::Reset("abc123".into()))
        );
        assert_eq!(
            parse_deep_link("orange://join?code=KX7Q2M4X"),
            Some(DeepLink::Join("KX7Q2M4X".into()))
        );
    }

    /// Links already in the wild predate the host carrying meaning, so anything
    /// with a code that is not a reset must still join.
    #[test]
    fn an_unknown_host_with_a_code_still_joins() {
        assert_eq!(
            parse_deep_link("orange://anything?code=KX7Q2M4X"),
            Some(DeepLink::Join("KX7Q2M4X".into()))
        );
        assert_eq!(
            parse_deep_link("orange://?code=KX7Q2M4X"),
            Some(DeepLink::Join("KX7Q2M4X".into()))
        );
    }

    #[test]
    fn a_bare_link_carries_no_action() {
        // Still raises the window - that happens before this parse.
        assert_eq!(parse_deep_link("orange://"), None);
        assert_eq!(parse_deep_link("orange://reset"), None);
        assert_eq!(parse_deep_link("orange://join?code="), None);
        assert_eq!(parse_deep_link("https://example.com/?code=x"), None);
    }

    #[test]
    fn a_code_is_read_from_any_position_and_stops_at_the_separator() {
        assert_eq!(
            parse_deep_link("orange://reset?type=recovery&code=abc123"),
            Some(DeepLink::Reset("abc123".into()))
        );
    }
}
