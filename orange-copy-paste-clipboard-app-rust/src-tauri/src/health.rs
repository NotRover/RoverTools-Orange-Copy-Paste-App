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
    use std::sync::atomic::AtomicU32;

    /// Anything sitting next to `path`. Scratch names are deliberately
    /// unpredictable, so leftovers can only be caught by listing the directory.
    fn siblings_of(path: &Path) -> Vec<String> {
        std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect()
    }

    /// Test directory named after the calling test, so tests cannot collide.
    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rovertools-health-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// Nothing here may latch `DEGRADED`: it is process-global and one-way, so a
    /// test that trips it would change the behaviour of every test running
    /// alongside it. The degraded path is covered by `tests/degraded_mode.rs`,
    /// which gets its own process.
    #[test]
    fn creates_missing_directories_and_replaces_existing_files() {
        let dir = scratch_dir("create");
        let path = dir.join("history.bin");

        // The parent does not exist yet.
        write_atomic(&path, b"first").expect("first write");
        assert_eq!(std::fs::read(&path).unwrap(), b"first");

        // Replacing an existing file is the case that regresses on Windows,
        // where a plain rename onto an occupied name fails.
        write_atomic(&path, b"second").expect("replace");
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        replace_atomic(&path, b"third").expect("replace unflushed");
        assert_eq!(std::fs::read(&path).unwrap(), b"third");

        // No scratch file survived any of that.
        assert_eq!(siblings_of(&path), vec!["history.bin".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The guarantee the flush loop depends on: a reader either sees the old file
    /// or the new one, never a partial or blended write. Payloads differ in
    /// length so a mixture cannot masquerade as a valid one.
    #[test]
    fn concurrent_writers_never_expose_a_torn_file() {
        let dir = scratch_dir("concurrent");
        let path = dir.join("history.bin");
        let payloads: [Vec<u8>; 3] = [vec![b'a'; 4096], vec![b'b'; 65536], vec![b'c'; 200_000]];
        write_atomic(&path, &payloads[0]).expect("seed");

        let reads = AtomicU32::new(0);
        std::thread::scope(|s| {
            for payload in &payloads {
                s.spawn(|| {
                    for _ in 0..40 {
                        write_atomic(&path, payload).expect("concurrent write");
                    }
                });
            }
            // Reader runs against all three writers at once.
            s.spawn(|| {
                for _ in 0..600 {
                    let seen = std::fs::read(&path).expect("file always readable");
                    assert!(
                        payloads.contains(&seen),
                        "torn read: {} bytes, first byte {:?}",
                        seen.len(),
                        seen.first()
                    );
                    reads.fetch_add(1, Ordering::Relaxed);
                }
            });
        });

        assert_eq!(reads.load(Ordering::Relaxed), 600);
        // Every writer cleaned up after itself, so only the target remains.
        assert_eq!(siblings_of(&path), vec!["history.bin".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A failed replace must leave the previous file intact and no scratch file
    /// behind. A directory standing where the target should be makes the rename
    /// fail on every platform without needing to simulate a disk fault.
    #[test]
    fn failed_replace_leaves_no_scratch_file() {
        let dir = scratch_dir("failure");
        let path = dir.join("occupied");
        std::fs::create_dir_all(&path).expect("make the target a directory");

        write_atomic(&path, b"payload").expect_err("rename onto a directory must fail");

        assert_eq!(
            siblings_of(&path),
            vec!["occupied".to_string()],
            "scratch file left behind after a failed replace"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Documents the hazard this module exists for: unlike `std::sync::Mutex`,
    /// `parking_lot` hands the next caller a lock that was released mid-mutation
    /// by an unwinding panic, with no error to distinguish it from a clean one.
    /// Nothing but the degraded latch stands between that and the flush loop.
    #[test]
    fn parking_lot_does_not_poison_after_a_panic() {
        let guarded: Mutex<Vec<u8>> = Mutex::new(vec![1, 2, 3]);

        let torn = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut v = guarded.lock();
            v.clear(); // half of a "replace the contents" mutation
            panic!("interrupted mid-mutation");
        }));
        assert!(torn.is_err());

        assert!(!guarded.is_locked(), "guard released, as expected");
        assert!(
            guarded.lock().is_empty(),
            "the half-finished mutation is visible with no signal"
        );
    }
}
