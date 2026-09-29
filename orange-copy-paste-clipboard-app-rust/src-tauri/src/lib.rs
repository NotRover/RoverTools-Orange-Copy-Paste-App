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

/// How long a quit or a restart waits, in all, for sync work already running
/// (uploads and blob downloads) and then for a token rotation. What is still
/// running after it is on disk in the pending-work record and finishes on the
/// next launch.
const SYNC_DRAIN_MS: u64 = 10_000;

/// Set while a sync drain has the main window hidden, so a restart that fails
/// can put it back.
static DRAIN_HID_WINDOW: AtomicBool = AtomicBool::new(false);

/// Set once the runtime has been asked for a restart. The exit that follows
/// writes everything, like the flush before it, instead of dropping entries.
static RESTARTING: AtomicBool = AtomicBool::new(false);

/// Set while a quit waits for sync work. Opening the app again meanwhile sets
/// [`QUIT_CANCELLED`], and the app stays instead of closing on the user.
static QUIT_DRAINING: AtomicBool = AtomicBool::new(false);
static QUIT_CANCELLED: AtomicBool = AtomicBool::new(false);

/// Stop new sync work and wait for what is running, then return what is left
/// of [`SYNC_DRAIN_MS`] for the rotation drain.
///
/// Returns at once when nothing is running. Otherwise the main window hides
/// and a notice, which stays up until the app exits, says why it has not gone
/// yet. A timeout is recorded, never enforced, as with [`drain_token_rotation`]:
/// the work left over is named in the pending-work record, so the next launch
/// runs it and the exit flush keeps its entry. Called from a plain thread,
/// never the main one: the notice needs the event loop running to show.
pub(crate) fn drain_sync_work(app: &tauri::AppHandle, restarting: bool) -> u64 {
    let start = std::time::Instant::now();
    let left = || SYNC_DRAIN_MS.saturating_sub(start.elapsed().as_millis() as u64);
    let Some(sync) = app.state::<AppState>().sync_client.lock().clone() else {
        return SYNC_DRAIN_MS;
    };
    sync.begin_quit();
    if !sync.work_running() {
        return SYNC_DRAIN_MS;
    }
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && w.hide().is_ok() {
            DRAIN_HID_WINDOW.store(true, Ordering::SeqCst);
        }
    }
    crate::runtime::notifications::notify_finishing_sync(app, restarting);
    QUIT_DRAINING.store(!restarting, Ordering::SeqCst);
    while sync.work_running() && left() > 0 && !QUIT_CANCELLED.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(DRAIN_POLL_MS));
    }
    QUIT_DRAINING.store(false, Ordering::SeqCst);
    if sync.work_running() && !QUIT_CANCELLED.load(Ordering::SeqCst) {
        crate::health::note(
            "exit: sync work did not finish",
            "the process is leaving with uploads or downloads running; the next launch runs them",
        );
    }
    left()
}

/// A quit or restart that was asked for did not happen (the user opened the
/// app again, or an update failed to install): sync starts again, and the
/// window a drain hid comes back.
pub(crate) fn resume_after_failed_restart(app: &tauri::AppHandle) {
    let sync = app.state::<AppState>().sync_client.lock().clone();
    if let Some(sync) = sync {
        sync.end_quit();
    }
    crate::runtime::popup_windows::hide_popup(app, "notification");
    if DRAIN_HID_WINDOW.swap(false, Ordering::SeqCst) {
        crate::runtime::tray::show_main_window(app);
    }
}

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

/// Fold a sealed session's leftover for `file` into its store, and discard it
/// only once a save holding it has landed. `merge` and `save` each take the
/// store's lock themselves, so the merge's guard is gone before the save locks
/// again (holding it across both deadlocked).
fn adopt_leftover(
    file: &std::path::Path,
    merge: impl FnOnce(&[u8]) -> Option<usize>,
    save: impl FnOnce() -> bool,
) {
    let Some(bytes) = crate::health::sealed_leftover(file) else {
        return;
    };
    let landed = match merge(&bytes) {
        Some(0) => true,
        Some(_) => save(),
        None => false,
    };
    if landed {
        crate::health::discard_sealed_leftover(file);
    }
}

/// The drain and flush a self-restart runs before it asks for the restart: the
/// runtime ignores an objection to a restart's exit, so nothing can wait there.
/// Sync work goes first, so what it lands is in the writes. Flushed on both
/// sides of the rotation drain: the second, forced write keeps whatever landed
/// while it finished. Blocks for up to [`SYNC_DRAIN_MS`], so the callers run it
/// off the main thread.
pub(crate) fn flush_for_restart(app: &tauri::AppHandle) {
    let left = drain_sync_work(app, true);
    flush_dirty_stores(app, Flush::Dirty);
    drain_token_rotation(left.min(EXIT_DRAIN_MS));
    flush_dirty_stores(app, Flush::Forced);
}

/// What a [`flush_dirty_stores`] call is for.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Flush {
    /// Write what is dirty: the timer, and a pull page before its cursor moves.
    Dirty,
    /// Write history too, dirty or not, before a self-restart. An update
    /// install can fail and hand back the running app, so nothing is dropped.
    Forced,
    /// The last write the process makes, forced. With Keep history off, the
    /// entries it leaves out are gone with the process, so their files go too.
    Exit,
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
///
/// Any `mode` but `Flush::Dirty` forces the history write, so the last one
/// before the process goes holds everything, dirty flag or not.
///
/// Saved entries are always written. With Keep history off, so are entries in
/// the cloud or a space, queued, or with an upload or download under way, all
/// of which this device's sync records name; the rest stay in memory only, and
/// at `Flush::Exit` their files go once the write lands - unless the system
/// clipboard still points at one. A record that would not read keeps
/// everything.
///
/// Never call this while holding `sync_client`, `history`, or any lock that
/// `SyncClient::keep_keys` takes. It takes those while holding `history`, so no
/// code may take `history` while holding one of them.
pub(crate) fn flush_dirty_stores(app: &tauri::AppHandle, mode: Flush) {
    use tauri::Manager;
    // A second caller waits for the write in progress instead of racing it.
    static FLUSH: Mutex<()> = Mutex::new(());
    let _one = FLUSH.lock();
    let Ok(app_data) = app.path().app_data_dir() else {
        return;
    };
    let state: tauri::State<'_, AppState> = app.state();

    if mode != Flush::Dirty {
        state.history_dirty.store(true, Ordering::Relaxed);
    }
    if state.history_dirty.swap(false, Ordering::Relaxed) {
        let keep_history = state.keep_history.load(Ordering::Relaxed);
        // What the system clipboard holds as files, read before the history
        // lock: an OS call, and only the exit deletes anything. A clipboard
        // that will not read may hold any file, so it deletes nothing.
        let clipboard_refs = if mode == Flush::Exit && !keep_history {
            crate::clipboard::files::clipboard_file_paths()
        } else {
            Some(Vec::new())
        };
        // The client, cloned out of the slot so the slot is not held across
        // the history lock. With sync off, this device's records on disk still
        // name what is in the cloud or a space; read under the slot, so no
        // client is built over these files meanwhile.
        let (client, on_disk) = if keep_history {
            (None, None)
        } else {
            let slot = state.sync_client.lock();
            match slot.clone() {
                Some(s) => (Some(s), None),
                None => (None, Some(keep_keys_on_disk(&app_data))),
            }
        };
        let mut history = state.history.lock();
        // Read while the history lock is held: an entry that lands in history
        // is named by its sync record before it lands (see `merge_pulled`), so
        // none can arrive between this read and the write it feeds.
        let kept: Option<std::collections::HashSet<String>> = if keep_history {
            None
        } else {
            match (&client, on_disk) {
                (Some(s), _) => s.keep_keys(),
                (None, Some(keys)) => keys,
                (None, None) => None,
            }
        }
        .map(|keys| {
            keys.into_iter()
                .filter_map(|k| k.strip_prefix("clipboard:").map(str::to_owned))
                .collect()
        });
        let keep_all = kept.is_none();
        let keep = |id: &str| keep_all || kept.as_ref().is_some_and(|k| k.contains(id));
        // After the exit prune, what is left is exactly what stays.
        let mut pruned = false;
        if mode == Flush::Exit && !keep_all {
            if let Some(refs) = &clipboard_refs {
                history.drop_unkept(keep, refs);
                pruned = true;
            }
        }
        let _ = history.save_to_file(&app_data.join("history.bin"), |id| pruned || keep(id));
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

/// Every entry key this device's sync records on disk name, for the flush
/// with sync off: the id map's keep set, the queue, and the pending-work
/// record. `None` when any of them is there and will not read, which keeps
/// everything this time rather than nothing.
fn keep_keys_on_disk(app_data: &std::path::Path) -> Option<std::collections::HashSet<String>> {
    let mut keys = crate::sync::id_map::IdMap::try_load(crate::sync::id_map::id_map_path(app_data))
        .ok()?
        .keep_keys();
    keys.extend(
        crate::sync::pending_queue::PendingQueue::try_keys(
            &crate::sync::pending_queue::pending_queue_path(app_data),
        )
        .ok()?,
    );
    keys.extend(
        crate::sync::pending_work::PendingWork::try_keys(
            &crate::sync::pending_work::pending_work_path(app_data),
        )
        .ok()?,
    );
    Some(keys)
}

/// The bundle identifier before the 2026 rename that dropped a personal handle
/// (`com.spect.*`). Kept only so an existing install's data can be carried across
/// the rename once; safe to delete a few releases after the renamed build ships.
const LEGACY_APP_DATA_IDENTIFIER: &str = "com.spect.orange-copy-paste";

/// TEMPORARY (added with the 2026 `com.spect.*` -> `io.github.notrover.*` identifier
/// rename). Delete this function and `migrate_legacy_webview_storage` together, with
/// `copy_dir_recursive`, `LEGACY_APP_DATA_IDENTIFIER`, their calls in `run` and
/// `setup`, the webview tests and the Windows `dirs` dependency, once every install has
/// run a renamed build at least once - a few stable releases after the rename ships.
/// At that point no install still keeps its data under the old identifier, so both
/// only ever no-op.
///
/// Copy the previous identifier's app-data folder into the current one, once.
///
/// The bundle identifier keys `app_data_dir()`, so renaming it points the app at
/// a fresh, empty folder and the user's history, notes and settings look wiped -
/// the old files are orphaned on disk, not gone. This copies them forward on the
/// first launch of the renamed build, before anything reads `app_data_dir`. It
/// copies rather than moves, so a failure leaves the old data untouched, and it
/// runs only when the new folder holds nothing yet, so it never clobbers a real
/// install and is a no-op on every later launch. The OS keychain is not keyed by
/// the identifier, so sign-in state carries over without any help here.
///
/// Returns the line for `crash.log`, which has no directory yet when this runs.
fn migrate_legacy_app_data(app: &tauri::AppHandle) -> Option<(&'static str, String)> {
    use tauri::Manager;
    let Ok(new_dir) = app.path().app_data_dir() else {
        return None;
    };
    let old_dir = new_dir.parent()?.join(LEGACY_APP_DATA_IDENTIFIER);
    if old_dir == new_dir || !old_dir.is_dir() {
        return None;
    }
    // Skip when the new location already holds data: an install that has run
    // before, or a migration that already happened.
    let new_has_data = std::fs::read_dir(&new_dir)
        .map(|mut it| it.next().is_some())
        .unwrap_or(false);
    if new_has_data {
        return None;
    }
    let paths = format!("{} -> {}", old_dir.display(), new_dir.display());
    Some(match copy_dir_recursive(&old_dir, &new_dir, &[]) {
        Ok(()) => ("migrate: carried app-data across the identifier rename", paths),
        Err(e) => ("migrate: app-data copy failed", format!("{paths}: {e}")),
    })
}

/// TEMPORARY - goes with `migrate_legacy_app_data`; its note says when.
///
/// Copy the previous identifier's WebView2 `localStorage` into the current
/// profile, once. The roots are the WebView2 user data folders tauri picks,
/// `%LOCALAPPDATA%\<identifier>`, for the old and the current identifier.
///
/// The profile is keyed by the identifier too, but it lives under local app
/// data rather than `app_data_dir`, so the app-data copy never reached it and
/// the rename reset every preference React keeps in `localStorage`: theme,
/// layouts, sort orders, groups, filters, pane widths. `Local Storage` is the
/// only part that holds user data - the app keeps nothing in IndexedDB, cookies
/// or caches - and the leveldb `LOCK` file is left behind; leveldb makes its own.
///
/// Runs only while the new profile has no `Local Storage`, so it never merges
/// into or overwrites a store WebView2 already made. The copy lands in a sibling
/// named for this process and is renamed into place, so a failure leaves no
/// half-copied store that looks complete, and WebView2 starts an empty one as it
/// would have without this. A sibling a killed launch left is removed once the
/// store is in place. The old profile is left as it was.
///
/// `None` when there was nothing to do.
#[cfg(windows)]
fn migrate_legacy_webview_storage(
    old_root: &std::path::Path,
    new_root: &std::path::Path,
) -> Option<std::io::Result<()>> {
    let store = std::path::Path::new("EBWebView")
        .join("Default")
        .join("Local Storage");
    let (from, to) = (old_root.join(&store), new_root.join(&store));
    if old_root == new_root || !from.is_dir() || to.exists() {
        return None;
    }
    let staging = to.with_file_name(format!("Local Storage.migrating-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    let copied = copy_dir_recursive(&from, &staging, &["LOCK"])
        .and_then(|()| std::fs::rename(&staging, &to));
    if copied.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    } else if let Some(Ok(siblings)) = to.parent().map(std::fs::read_dir) {
        // A launch killed mid-copy leaves its sibling behind. Cleared only once
        // the store is in place: before, it could be another first launch's copy
        // in progress, and none can be renamed over the store now.
        for e in siblings.flatten() {
            if e.file_name().to_string_lossy().starts_with("Local Storage.migrating-") {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    Some(copied)
}

/// Recursively copy a directory tree, leaving out files named in `skip`. Used
/// once by each of the identifier-rename migrations.
fn copy_dir_recursive(
    from: &std::path::Path,
    to: &std::path::Path,
    skip: &[&str],
) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&src, &dst, skip)?;
        } else if !skip.iter().any(|s| entry.file_name() == *s) {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
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

/// Path of the marker a self-initiated restart drops so the replacement launch
/// knows to take over the running copy instead of deferring to it.
///
/// Temp dir for the same reason as the rotation marker: `run()` executes before
/// Tauri is built, so there is no `AppHandle` to resolve an app-data path from,
/// and `%TEMP%` / `$TMPDIR` is the one place both processes agree on.
fn restart_takeover_marker_path() -> std::path::PathBuf {
    // `%TEMP%` is already per-user; `/tmp` is not.
    #[cfg(windows)]
    let scope = String::new();
    #[cfg(not(windows))]
    let scope = std::env::var("USER")
        .map(|u| format!("-{u}"))
        .unwrap_or_default();
    std::env::temp_dir().join(format!("orange-copy-paste-restart-takeover{scope}.lock"))
}

/// Announce that this process is about to restart itself (update install or
/// health recovery), so its replacement replaces the running copy rather than
/// surfacing it. Best-effort: if the write fails the worst case is the
/// replacement surfacing the dying process instead of taking over, which
/// resolves on the next launch.
pub(crate) fn mark_self_restart() {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = std::fs::write(restart_takeover_marker_path(), now.to_string());
}

/// Consume the self-restart marker, returning `true` when a fresh one was
/// present. The marker is removed either way. A stale marker - left by a crash
/// between the mark and a relaunch that never happened - is ignored, so it can
/// never force a user's later relaunch to replace the running app instead of
/// focusing it.
fn consume_self_restart_marker() -> bool {
    let path = restart_takeover_marker_path();
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return false;
    };
    let _ = std::fs::remove_file(&path);
    let Ok(stamped) = contents.trim().parse::<u128>() else {
        return false;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // A restart takes seconds; two minutes is a wide margin that still rejects a
    // marker orphaned by a crash.
    now.saturating_sub(stamped) < 120_000
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
    let notes_file = path("notes.bin");
    let notifications_file = path("notifications.bin");

    // Configure the images directory so pushed images are saved to disk.
    if let Some(ref dir) = images_dir {
        history.lock().set_images_dir(dir.clone());
    }
    // And the dir where synced file entries are extracted, so a save can
    // delete the subdir of an entry that was removed.
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
    let keep_enabled = bool_setting(settings.as_ref(), "keep_history", true);

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

    // Load history. An older build defaulted Keep history to off and, when off,
    // never read history.bin, so a stale copy there must not come back. Settings
    // that are absent or unreadable keep it: dropping what the user expected to
    // keep cannot be undone, keeping extra entries can.
    if let (Some(hf), Some(pf)) = (&history_file, &saved_file) {
        let legacy_keep = settings.as_ref().is_none_or(|m| {
            m.get("keep_history")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        });
        history.lock().load_from_disk(hf, pf, legacy_keep);
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
    // save, so nothing here can lose either copy. Each merge result is bound
    // before the save locks the store again.
    {
        let state_ref: tauri::State<'_, AppState> = app.state();
        if let Some(hf) = &history_file {
            // A pinned_entries.bin leftover lands in history.bin, its only file now.
            for file in std::iter::once(hf).chain(saved_file.as_ref()) {
                adopt_leftover(
                    file,
                    |b| state_ref.history.lock().merge_leftover(b),
                    || state_ref.history.lock().save_to_file(hf, |_| true).is_ok(),
                );
            }
        }
        if let Some(nf) = &notes_file {
            adopt_leftover(
                nf,
                |b| state_ref.notes.lock().merge_leftover(b),
                || state_ref.notes.lock().save_to_file(nf).is_ok(),
            );
        }
        if let Some(nf) = &notifications_file {
            adopt_leftover(
                nf,
                |b| state_ref.notifications.lock().merge_leftover(b),
                || state_ref.notifications.lock().save_to_file(nf).is_ok(),
            );
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
        ("autosave", &state_ref.autosave, true),
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
            flush_dirty_stores(&handle, Flush::Dirty);
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
    // primary.
    //
    // A plain relaunch must not kill it either: killing the running copy before
    // the single-instance plugin can hand off is exactly what made every
    // relaunch cold-start behind a splash instead of surfacing the window the
    // user already had. So a normal launch now defers to the plugin (below),
    // which forwards to the running instance and raises it.
    //
    // Two launches genuinely need to REPLACE a running copy: a dev rebuild
    // (`tauri dev`), and the app restarting itself for an update or health
    // recovery. The self-restart leaves a marker so this launch can tell it
    // apart from a user relaunch; dev is gated on the debug build.
    if !is_trigger && (cfg!(debug_assertions) || consume_self_restart_marker()) {
        kill_previous_instance();
    }

    let context = tauri::generate_context!();
    // Here rather than in `setup`: tauri builds the tauri.conf.json windows, and
    // WebView2 its profile with them, before `setup` runs. Logged from `setup`,
    // once the diag log has a directory. TEMPORARY - remove with
    // migrate_legacy_webview_storage.
    #[cfg(windows)]
    let webview_migration = dirs::data_local_dir().and_then(|local| {
        let old = local.join(LEGACY_APP_DATA_IDENTIFIER);
        let new = local.join(&context.config().identifier);
        let paths = format!("{} -> {}", old.display(), new.display());
        Some(match migrate_legacy_webview_storage(&old, &new)? {
            Ok(()) => ("migrate: carried webview storage across the identifier rename", paths),
            Err(e) => ("migrate: webview storage copy failed", format!("{paths}: {e}")),
        })
    });

    let history = create_shared_history();
    let suppress: SuppressFlag = Arc::new(AtomicBool::new(false));

    let app_state = AppState {
        history: Arc::clone(&history),
        suppress_next_capture: Arc::clone(&suppress),
        keep_history: Arc::new(AtomicBool::new(true)),
        history_dirty: Arc::new(AtomicBool::new(false)),
        close_to_tray: Arc::new(AtomicBool::new(false)),
        os_notifications: Arc::new(AtomicBool::new(true)),
        start_minimized: Arc::new(AtomicBool::new(false)),
        notification_enabled: Arc::new(AtomicBool::new(true)),
        notif_copy: Arc::new(AtomicBool::new(true)),
        notif_paste: Arc::new(AtomicBool::new(true)),
        autosave: Arc::new(AtomicBool::new(true)),
        show_splash: Arc::new(AtomicBool::new(true)),
        splash_updating: Arc::new(AtomicBool::new(false)),
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
            // Opened again while a quit waits for sync: the user wants the app,
            // so the quit is called off and the drain puts the window back.
            if QUIT_DRAINING.load(Ordering::SeqCst) {
                QUIT_CANCELLED.store(true, Ordering::SeqCst);
                return;
            }
            // Surface the already-running window the same way the tray does -
            // show, unminimize, and force to the foreground past the Windows
            // background-process focus block.
            crate::runtime::tray::show_main_window(app);
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
            crate::clipboard::commands::copy_entries,
            crate::clipboard::commands::paste_entry,
            crate::clipboard::commands::get_image_file_preview,
            crate::clipboard::commands::open_external_url,
            crate::clipboard::commands::check_missing_files,
            crate::clipboard::commands::stat_files,
            crate::clipboard::commands::get_setting,
            crate::clipboard::commands::set_setting,
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
            crate::runtime::commands::splash_set_updating,
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
            crate::notes::commands::open_note_attachment,
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
            crate::sync::commands::sync_restore_from_cloud,
            crate::sync::commands::sync_catch_up,
            crate::sync::commands::sync_set_enabled,
            crate::sync::commands::sync_get_connection,
            crate::sync::commands::sync_schedule_settings,
            crate::sync::commands::sync_settings,
            crate::sync::commands::sync_settings_refused,
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
            // Before anything reads app_data_dir: carry an existing install's
            // data across the identifier rename (see migrate_legacy_app_data),
            // so the diag dir and every store below resolve to the migrated
            // folder rather than a fresh empty one. TEMPORARY - remove this line
            // with migrate_legacy_app_data once the rename has propagated.
            let app_data_migration = migrate_legacy_app_data(app.handle());
            // Installed before any other setup work, so a panic inside it lands
            // in the log too.
            crate::health::set_diag_dir(app.path().app_data_dir().ok());
            crate::health::install_panic_hook(app.handle().clone());
            // Both migrations ran before the log had a directory. TEMPORARY -
            // remove with them.
            if let Some((headline, detail)) = app_data_migration {
                crate::health::note(headline, &detail);
            }
            #[cfg(windows)]
            if let Some((headline, detail)) = webview_migration {
                crate::health::note(headline, &detail);
            }
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
                //
                // While the splash is auto-installing an update, hold off: a
                // download can take far longer than any normal splash, and the
                // install restarts the process anyway. If it fails, the splash
                // clears the flag and closes itself.
                let updating = Arc::clone(&state.splash_updating);
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(11_000));
                    while updating.load(Ordering::Relaxed) {
                        std::thread::sleep(std::time::Duration::from_millis(2_000));
                    }
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
        .build(context)
        .expect("error while running tauri application")
        .run(|app, event| match event {
            // Two things are worth delaying a quit for: a refresh-token rotation
            // caught mid-flight (it costs the user their session), and sync work
            // already running (it costs them the upload or download). Everything
            // else about this arm leaves the ordinary quit untouched: with
            // neither running, the handler returns before allocating a thread or
            // preventing anything.
            tauri::RunEvent::ExitRequested { api, code, .. } => {
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
                // A restart: the runtime ignores `prevent_exit` for it, and the
                // command that asked has drained and flushed already.
                if code == Some(tauri::RESTART_EXIT_CODE) {
                    RESTARTING.store(true, Ordering::SeqCst);
                    return;
                }
                // Nothing new starts from here, waited for or not.
                let sync = app.state::<AppState>().sync_client.lock().clone();
                if let Some(sync) = &sync {
                    sync.begin_quit();
                }
                let syncing = sync.as_ref().is_some_and(|s| s.work_running());
                if !syncing && !crate::sync::client::rotation_in_flight() {
                    return;
                }
                api.prevent_exit();
                if DRAIN_STARTED.swap(true, Ordering::SeqCst) {
                    return;
                }
                // Off the main thread: the event loop has to keep running for
                // the toast to show and the re-issued exit to be delivered.
                let handle = app.clone();
                std::thread::spawn(move || {
                    let left = drain_sync_work(&handle, false);
                    if QUIT_CANCELLED.swap(false, Ordering::SeqCst) {
                        DRAIN_STARTED.store(false, Ordering::SeqCst);
                        resume_after_failed_restart(&handle);
                        return;
                    }
                    drain_token_rotation(left.min(EXIT_DRAIN_MS));
                    EXIT_REISSUED.store(true, Ordering::SeqCst);
                    handle.exit(0);
                });
            }
            // The last thing the process does with user data. `app.exit(0)` on
            // window destroy lands here too, and so does a restart the two
            // restart commands asked for off the main thread; that one keeps
            // everything, since it may be an update that hands the app back.
            tauri::RunEvent::Exit => {
                let mode = if RESTARTING.load(Ordering::SeqCst) { Flush::Forced } else { Flush::Exit };
                flush_dirty_stores(app, mode);
            }
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

    /// TEMPORARY - goes with `migrate_legacy_webview_storage`.
    #[cfg(windows)]
    #[test]
    fn legacy_webview_storage_is_copied_once_and_never_over_a_store() {
        use super::migrate_legacy_webview_storage as migrate;
        let dir = std::env::temp_dir().join(format!("rovertools-webview-{}", uuid::Uuid::new_v4()));
        let (old, new) = (dir.join("old"), dir.join("new"));
        let store = std::path::Path::new("EBWebView/Default/Local Storage/leveldb");

        // No old profile: nothing to do.
        assert!(migrate(&old, &new).is_none());

        std::fs::create_dir_all(old.join(store)).unwrap();
        std::fs::write(old.join(store).join("000003.log"), b"sc-theme").unwrap();
        std::fs::write(old.join(store).join("LOCK"), b"").unwrap();
        std::fs::create_dir_all(old.join("EBWebView/Default/Cache")).unwrap();
        // What a launch killed mid-copy leaves behind.
        std::fs::create_dir_all(new.join("EBWebView/Default/Local Storage.migrating-1")).unwrap();
        assert!(matches!(migrate(&old, &new), Some(Ok(()))));
        assert_eq!(std::fs::read(new.join(store).join("000003.log")).unwrap(), b"sc-theme");
        assert!(!new.join(store).join("LOCK").exists());
        assert!(!new.join("EBWebView/Default/Cache").exists());
        let default = std::fs::read_dir(new.join("EBWebView/Default")).unwrap().count();
        assert_eq!(default, 1, "only Local Storage lands, no staging folder is left");

        // The new profile has a store now: never merged into or overwritten.
        std::fs::write(old.join(store).join("000003.log"), b"changed").unwrap();
        assert!(migrate(&old, &new).is_none());
        assert_eq!(std::fs::read(new.join(store).join("000003.log")).unwrap(), b"sc-theme");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// TEMPORARY - goes with `migrate_legacy_webview_storage`.
    #[cfg(windows)]
    #[test]
    fn a_failed_webview_storage_copy_leaves_no_partial_store() {
        use super::migrate_legacy_webview_storage as migrate;
        use std::os::windows::fs::OpenOptionsExt;
        let dir = std::env::temp_dir().join(format!("rovertools-webview-{}", uuid::Uuid::new_v4()));
        let (old, new) = (dir.join("old"), dir.join("new"));
        let store = std::path::Path::new("EBWebView/Default/Local Storage/leveldb");
        std::fs::create_dir_all(old.join(store)).unwrap();
        std::fs::write(old.join(store).join("CURRENT"), b"MANIFEST-000001").unwrap();
        std::fs::write(old.join(store).join("MANIFEST-000001"), b"manifest").unwrap();

        // A file the old app's webview still holds fails the copy partway,
        // after CURRENT has already been copied.
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(old.join(store).join("MANIFEST-000001"))
            .unwrap();
        assert!(matches!(migrate(&old, &new), Some(Err(_))));
        let default = std::fs::read_dir(new.join("EBWebView/Default")).unwrap().count();
        assert_eq!(default, 0, "neither a store nor a staging folder is left");

        // Nothing left blocks a later copy. In the app that later copy happens
        // only if WebView2 made no store of its own in between, and it usually
        // makes one on the same launch.
        drop(held);
        assert!(matches!(migrate(&old, &new), Some(Ok(()))));
        assert_eq!(std::fs::read(new.join(store).join("MANIFEST-000001")).unwrap(), b"manifest");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
