//! Process health: durable writes, and a one-way latch marking the process as
//! no longer trustworthy.
//!
//! The release profile unwinds rather than aborts (see `Cargo.toml`), so a panic
//! on a background thread leaves the app running. That is the right trade for a
//! clipboard manager — the window and the user's unsaved state survive — but it
//! introduces a second hazard: `parking_lot` mutexes do not poison, so a panic
//! raised mid-mutation leaves a half-updated value behind with no signal, and
//! the 2-second flush loop would write it straight over the good file on disk.
//!
//! So a panic latches [`mark_degraded`], and from that moment user-owned state
//! is never overwritten again. The process keeps working with what it has in
//! memory; it just stops treating that memory as something worth persisting.
//!
//! Three write entry points, in order of how much they promise:
//!
//! - [`write_state`] — user data the app cannot regenerate (history, notes).
//!   Atomic, flushed to the platter, and refused once degraded.
//! - [`write_atomic`] — small files that must survive a power cut but are not
//!   suspect after a panic, because their content came from disk or from the OS
//!   rather than from a mutated in-memory store (settings, window geometry).
//! - [`replace_atomic`] — same atomic replace without the flush, for data that
//!   can be rebuilt: sync bookkeeping, and image blobs written to a fresh name.
//!   A torn file would still be poison, so the rename stays; a power cut just
//!   costs a re-download or a re-push.

use parking_lot::Mutex;
use std::collections::BTreeSet;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Set once a panic has been observed. One-way: nothing clears it, because
/// nothing can prove the state became trustworthy again. Only a restart does.
///
/// Separate from `REASON` so the flush loop's check stays lock-free.
static DEGRADED: AtomicBool = AtomicBool::new(false);
static REASON: Mutex<Option<String>> = Mutex::new(None);
/// Paths already reported as quarantined, so a repeating flush logs once.
static QUARANTINE_LOGGED: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());
/// Makes each temp file unique, so two writers of one path cannot land in the
/// same scratch file and interleave their bytes.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Number of `rename` attempts before giving up. On Windows an antivirus scanner
/// or the search indexer can hold a transient handle to the target, which fails
/// the replace with a sharing violation that is gone milliseconds later.
const RENAME_ATTEMPTS: u32 = 4;
const RENAME_BACKOFF_MS: u64 = 25;

/// Latch the process as degraded. Idempotent; the first reason wins, since it is
/// the one that describes the original fault rather than its consequences.
pub fn mark_degraded(reason: impl Into<String>) {
    let first = !DEGRADED.swap(true, Ordering::SeqCst);
    if first {
        *REASON.lock() = Some(reason.into());
    }
}

pub fn is_degraded() -> bool {
    DEGRADED.load(Ordering::SeqCst)
}

/// Why the process is degraded, for the UI to show and the log to record.
pub fn degraded_reason() -> Option<String> {
    REASON.lock().clone()
}

/// Sibling path with `suffix` appended to the full file name, so `history.bin`
/// becomes `history.bin.quarantine` rather than losing its `.bin` extension.
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// Scratch path for one replace. Unique per call: a fixed `.tmp` name would let
/// two concurrent writers of the same target truncate each other's scratch file
/// and rename a mixture of both payloads over it.
fn temp_sibling(path: &Path) -> PathBuf {
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    sibling(path, &format!(".{}-{seq}.tmp", std::process::id()))
}

/// Atomic replace, flushed to the platter before the rename.
///
/// The rename is what makes this safe — it either happened or it did not, so a
/// crash can never leave a half-written file where the previous good one was.
/// `sync_all` covers the power-loss case on top of that: without it the rename
/// can land while the bytes are still in the page cache, leaving a valid name
/// pointing at nothing.
pub fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    replace(path, data, true)
}

/// Atomic replace without the flush — see the module doc for when to prefer it.
pub fn replace_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    replace(path, data, false)
}

fn replace(path: &Path, data: &[u8], flush: bool) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Sibling on purpose: across volumes a rename degrades into a non-atomic
    // copy, which would defeat the whole point.
    let tmp = temp_sibling(path);

    let result = write_tmp(&tmp, data, flush).and_then(|()| rename_with_retry(&tmp, path));
    if result.is_err() {
        // Every failure path lands here, so no scratch file is ever left behind
        // to be mistaken for real state later.
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn write_tmp(tmp: &Path, data: &[u8], flush: bool) -> io::Result<()> {
    let mut file = std::fs::File::create(tmp)?;
    file.write_all(data)?;
    if flush {
        file.sync_all()?;
    }
    Ok(())
}

fn rename_with_retry(tmp: &Path, path: &Path) -> io::Result<()> {
    for _ in 1..RENAME_ATTEMPTS {
        if std::fs::rename(tmp, path).is_ok() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(RENAME_BACKOFF_MS));
    }
    // Last attempt, unguarded: its error is the one worth reporting.
    std::fs::rename(tmp, path)
}

/// [`write_atomic`] for state the user would miss — clipboard history, saved
/// entries, notes.
///
/// Once the process is degraded this refuses to touch the real file, because the
/// bytes may have been serialized from a half-mutated structure. They still go
/// to `<name>.quarantine`, so anything captured after the fault is recoverable
/// by hand rather than dropped on the floor.
pub fn write_state(path: &Path, data: &[u8]) -> io::Result<()> {
    if !is_degraded() {
        return write_atomic(path, data);
    }

    let quarantine = sibling(path, ".quarantine");
    if QUARANTINE_LOGGED.lock().insert(path.to_path_buf()) {
        eprintln!(
            "[health] degraded — not overwriting {}; writing {} instead",
            path.display(),
            quarantine.display()
        );
    }
    // Keep the newest payload rather than the first. Every later snapshot holds
    // the same suspect state plus everything captured since, so it is a superset
    // — the first one is the least useful copy to have kept.
    write_atomic(&quarantine, data)?;
    Err(io::Error::other(
        "process degraded after a panic; state file left untouched",
    ))
}

// ── Panic hook ──────────────────────────────────────────────────────

/// Latch degraded state, record the panic, and tell the UI.
///
/// A panic that unwinds out of a background thread otherwise vanishes: the
/// thread dies, the app keeps running, and there is nothing left to diagnose.
/// Appending (never truncating) keeps a repeating crash's history, and each
/// entry carries the location plus the backtrace when `RUST_BACKTRACE` is set.
pub fn install_panic_hook(app_data: Option<PathBuf>, app: tauri::AppHandle) {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Latch first, before anything below can fail: from here on the flush
        // loop must not overwrite user state with possibly half-mutated memory.
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".into());
        mark_degraded(format!("internal error at {location}"));

        // Then the log, before the emit below — appending to a file touches
        // nothing else in the process, while emitting re-enters Tauri's event
        // machinery from a thread that is already unwinding. Ordering it this
        // way means a blocked or broken emit still leaves a diagnosable trace.
        if let Some(dir) = app_data.as_ref() {
            let _ = std::fs::create_dir_all(dir);
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or_default();
            let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
            let entry = format!(
                "── panic @ epoch {secs}s\n  thread:   {thread}\n  location: {location}\n  message:  {info}\n\n"
            );
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("crash.log"))
            {
                let _ = f.write_all(entry.as_bytes());
            }
        }

        // A panic in here would be a double panic, which aborts regardless of
        // the unwind setting. Swallow it — the latch and the log already landed.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            use tauri::Emitter;
            let _ = app.emit("health:degraded", degraded_reason());
        }));

        default_hook(info);
    }));
}

// ── Commands ────────────────────────────────────────────────────────

/// Degraded reason, or `None` while healthy. Polled once at startup so a window
/// reload after a panic still shows the warning — the `health:degraded` event
/// only reaches listeners that were attached when it fired.
#[tauri::command]
pub fn health_degraded_reason() -> Option<String> {
    degraded_reason()
}

/// Restart the app. The only real recovery from a degraded process: it rebuilds
/// every in-memory structure from what is on disk, which was protected from the
/// bad state precisely so this would be safe.
#[tauri::command]
pub fn health_restart_app(app: tauri::AppHandle) {
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Names of everything sitting next to `path`, to catch leftover scratch
    /// files whose names are deliberately unpredictable.
    fn siblings_of(path: &Path) -> Vec<String> {
        let dir = path.parent().unwrap();
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect()
    }

    /// `DEGRADED` is process-global and one-way, so both halves live in a single
    /// test: latching it from a separate test would race every other one.
    #[test]
    fn writes_are_durable_then_quarantined_once_degraded() {
        let dir = std::env::temp_dir().join(format!("rovertools-health-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("history.bin");
        let quarantine = sibling(&path, ".quarantine");

        // Healthy: writes land, and no scratch file is left behind. The parent
        // directory does not exist yet — the write is expected to create it.
        write_state(&path, b"good").expect("healthy write");
        assert_eq!(std::fs::read(&path).unwrap(), b"good");
        assert_eq!(siblings_of(&path), vec!["history.bin".to_string()]);

        // Replacing an existing file must also work — on Windows a plain rename
        // over an existing target fails, so this is the case that regresses.
        write_state(&path, b"better").expect("healthy overwrite");
        assert_eq!(std::fs::read(&path).unwrap(), b"better");

        // The unflushed variant has the same replace semantics.
        replace_atomic(&path, b"unflushed").expect("replace_atomic");
        assert_eq!(std::fs::read(&path).unwrap(), b"unflushed");
        write_atomic(&path, b"better").expect("restore");

        mark_degraded("test");
        assert!(is_degraded());
        assert_eq!(degraded_reason().as_deref(), Some("test"));

        // Degraded: the real file keeps its pre-panic bytes, and the payload is
        // diverted so it is recoverable by hand.
        write_state(&path, b"suspect").expect_err("degraded write should report failure");
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"better",
            "degraded write overwrote good state"
        );
        assert_eq!(std::fs::read(&quarantine).unwrap(), b"suspect");

        // The flush loop keeps ticking; the newest payload wins, since it is a
        // superset of the earlier one.
        write_state(&path, b"suspect and more").expect_err("degraded write should report failure");
        assert_eq!(std::fs::read(&quarantine).unwrap(), b"suspect and more");
        assert_eq!(std::fs::read(&path).unwrap(), b"better");

        // The first reason wins — it describes the fault, not its consequences.
        mark_degraded("second");
        assert_eq!(degraded_reason().as_deref(), Some("test"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
