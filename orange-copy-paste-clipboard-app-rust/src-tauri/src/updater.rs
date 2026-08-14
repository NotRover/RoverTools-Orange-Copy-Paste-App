//! Self-update against a signed release feed.
//!
//! Notify-first, in three deliberate steps the user drives:
//!
//! 1. **check** — asks the feed what the newest version is. Runs once a few
//!    seconds after launch (so it never sits in front of startup) and on demand
//!    from Settings. Costs one small HTTPS request; downloads nothing.
//! 2. **download** — fetches the bundle and verifies its signature. Only ever
//!    starts because the user asked. Reports progress so a slow connection looks
//!    like progress rather than a hang.
//! 3. **install** — swaps the app out. Ends this process, so it is kept behind a
//!    second confirmation: a user mid-paste should never lose the window to a
//!    background download finishing.
//!
//! Nothing here trusts the network. The bundle must carry a signature made with
//! the private half of the key baked into `tauri.conf.json`, or the install is
//! refused — which is what makes serving updates off a plain static file safe.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Delay before the automatic check, measured from app setup.
///
/// Long enough that the check never competes with window creation, history load
/// or the sync engine's own startup for the network and the disk.
const STARTUP_CHECK_DELAY_MS: u64 = 8_000;

/// Settings key: whether to check automatically at launch. Absent means yes.
const KEY_AUTO_CHECK: &str = "auto_check_updates";
/// Settings key: a version the user asked not to be told about again.
const KEY_SKIPPED: &str = "update_skipped_version";

/// What the UI needs to describe an update. Field names are snake_case to match
/// the rest of the Rust→TS surface (see `src/types.ts`).
#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    /// The version being offered.
    pub version: String,
    /// The version running right now, so the UI can say "0.1.0 → 0.2.0".
    pub current_version: String,
    /// Release notes, generated from the commits that went into the release.
    pub notes: Option<String>,
    /// True once the bundle is on disk and its signature checked, i.e. the only
    /// thing left is the restart.
    pub downloaded: bool,
    /// The user asked not to be told about this version again.
    ///
    /// Reported rather than hidden: Settings should still show what is available
    /// and let them install it, but the banner must not reappear on next launch —
    /// which it otherwise would, since a skipped update is still pending.
    pub skipped: bool,
}

/// Download progress, in bytes. `total` is absent when the server sends no
/// content-length, in which case the UI shows an indeterminate bar.
#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// The update found by the last check, and its bundle once downloaded.
///
/// Held across commands because the three steps are three separate user
/// actions: `install` needs the same handle `check` produced, and re-checking in
/// between could hand back a different release than the bytes belong to.
struct Pending {
    update: Update,
    bytes: Option<Vec<u8>>,
}

static PENDING: LazyLock<Mutex<Option<Pending>>> = LazyLock::new(|| Mutex::new(None));

/// Set while a check or download is in flight. Two overlapping downloads would
/// both write to `PENDING` and race over which bytes belong to which release, so
/// the second caller is turned away instead.
static BUSY: AtomicBool = AtomicBool::new(false);

/// Releases self-updates in debug builds.
///
/// A dev build reports the version in `Cargo.toml`, so it happily sees any
/// published release as an upgrade — and installing over `target/debug` replaces
/// a build that loads from `devUrl` with one that does not, breaking the app
/// until it is rebuilt. Refuse rather than explain that afterwards.
const ALLOW_UPDATES_IN_DEBUG_BUILD: bool = false;

fn updates_permitted() -> bool {
    !cfg!(debug_assertions) || ALLOW_UPDATES_IN_DEBUG_BUILD
}

const DEV_BUILD_REFUSAL: &str = "Updates are disabled in development builds.";

/// A guard that clears [`BUSY`] however the caller leaves, so an early `?` can
/// never wedge the updater in a permanently busy state.
struct BusyGuard;

impl BusyGuard {
    /// `None` when another check or download already holds it.
    fn acquire() -> Option<Self> {
        if BUSY.swap(true, Ordering::AcqRel) {
            None
        } else {
            Some(BusyGuard)
        }
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}

fn info_of(app: &tauri::AppHandle, pending: &Pending) -> UpdateInfo {
    let version = pending.update.version.clone();
    UpdateInfo {
        skipped: skipped_version(app).as_deref() == Some(version.as_str()),
        version,
        current_version: pending.update.current_version.clone(),
        notes: pending.update.body.clone(),
        downloaded: pending.bytes.is_some(),
    }
}

fn read_setting(app: &tauri::AppHandle, key: &str) -> Option<serde_json::Value> {
    crate::clipboard::commands::get_setting(key.to_string(), app.clone())
}

fn write_setting(app: &tauri::AppHandle, key: &str, value: serde_json::Value) {
    crate::clipboard::commands::set_setting(key.to_string(), value, app.clone(), app.state());
}

/// The version the user chose to skip, if any.
fn skipped_version(app: &tauri::AppHandle) -> Option<String> {
    read_setting(app, KEY_SKIPPED)?.as_str().map(str::to_owned)
}

/// Ask the feed for a newer version and remember it if there is one.
///
/// A check that finds nothing clears any previously pending update, so a release
/// that gets pulled stops being offered.
async fn run_check(app: &tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;

    let Some(update) = found else {
        *PENDING.lock() = None;
        return Ok(None);
    };

    let pending = Pending {
        update,
        bytes: None,
    };
    let info = info_of(app, &pending);
    *PENDING.lock() = Some(pending);
    Ok(Some(info))
}

/// Check at launch and, if something is waiting, say so once.
///
/// Deliberately silent about failures: no network at the moment the app started
/// is the normal case, not something to interrupt anyone over. The next launch,
/// or a manual check, tries again.
pub fn spawn_startup_check(app: &tauri::AppHandle) {
    if !updates_permitted() {
        return;
    }
    // Absent key means yes — an install that has never opened Settings still
    // gets told about updates.
    let auto_check = read_setting(app, KEY_AUTO_CHECK)
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if !auto_check {
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(STARTUP_CHECK_DELAY_MS)).await;

        let Some(_busy) = BusyGuard::acquire() else {
            return;
        };
        let Ok(Some(info)) = run_check(&app).await else {
            return;
        };

        // A skipped version stays in PENDING — Settings still shows it, and
        // "Check for updates" still reports it — it just does not interrupt.
        if info.skipped {
            return;
        }
        let _ = app.emit("updater:available", info);
    });
}

/// Ask the feed for a newer version. `None` means this build is current.
#[tauri::command]
pub async fn updater_check(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    if !updates_permitted() {
        return Err(DEV_BUILD_REFUSAL.to_string());
    }
    let Some(_busy) = BusyGuard::acquire() else {
        return Err("Already checking for updates.".to_string());
    };
    run_check(&app).await
}

/// Whatever the last check found, for a window that mounted after it ran.
#[tauri::command]
pub fn updater_pending(app: tauri::AppHandle) -> Option<UpdateInfo> {
    let pending = PENDING.lock();
    pending.as_ref().map(|p| info_of(&app, p))
}

/// The running version, for display.
#[tauri::command]
pub fn updater_current_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Download the pending update's bundle and verify its signature.
///
/// Emits `updater:progress` as it goes. Leaves the update pending on failure so
/// the user can retry without checking again.
#[tauri::command]
pub async fn updater_download(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    if !updates_permitted() {
        return Err(DEV_BUILD_REFUSAL.to_string());
    }
    let Some(_busy) = BusyGuard::acquire() else {
        return Err("An update is already downloading.".to_string());
    };

    // Taken out of the lock rather than borrowed through it: the download below
    // is an await, and holding a lock across one blocks every other caller for
    // the length of a network transfer.
    let Some(mut pending) = PENDING.lock().take() else {
        return Err("No update is pending. Check for updates first.".to_string());
    };

    if pending.bytes.is_some() {
        let info = info_of(&app, &pending);
        *PENDING.lock() = Some(pending);
        return Ok(info);
    }

    let mut downloaded: u64 = 0;
    let mut last_emitted_pct: i64 = -1;
    let progress_app = app.clone();

    let result = pending
        .update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                // One event per whole percent. Per-chunk would put thousands of
                // messages through the event bridge to move a bar a few pixels.
                let pct = total
                    .filter(|t| *t > 0)
                    .map(|t| (downloaded * 100 / t) as i64)
                    .unwrap_or(-1);
                if pct != last_emitted_pct {
                    last_emitted_pct = pct;
                    let _ = progress_app.emit("updater:progress", Progress { downloaded, total });
                }
            },
            || {},
        )
        .await;

    match result {
        Ok(bytes) => {
            pending.bytes = Some(bytes);
            let info = info_of(&app, &pending);
            *PENDING.lock() = Some(pending);
            let _ = app.emit("updater:ready", info.clone());
            Ok(info)
        }
        Err(e) => {
            // Put it back so "Try again" works without a fresh check.
            *PENDING.lock() = Some(pending);
            Err(e.to_string())
        }
    }
}

/// Install the downloaded bundle. This ends the process.
///
/// On Windows the installer takes over and this process exits during the call;
/// on Linux the AppImage is replaced in place and the restart below runs. Either
/// way there is nothing useful after it, so the app is never left half-swapped
/// with a live window.
#[tauri::command]
pub fn updater_install(app: tauri::AppHandle) -> Result<(), String> {
    if !updates_permitted() {
        return Err(DEV_BUILD_REFUSAL.to_string());
    }

    let Some(pending) = PENDING.lock().take() else {
        return Err("No update is pending.".to_string());
    };
    let Some(bytes) = pending.bytes.as_ref() else {
        // Not downloaded yet — keep it pending so the UI can offer the download.
        let err = "The update has not finished downloading.".to_string();
        *PENDING.lock() = Some(pending);
        return Err(err);
    };

    pending.update.install(bytes).map_err(|e| e.to_string())?;
    app.restart()
}

/// Stop offering `version` until a newer one appears.
#[tauri::command]
pub fn updater_skip_version(app: tauri::AppHandle, version: String) {
    write_setting(&app, KEY_SKIPPED, serde_json::Value::String(version));
}
