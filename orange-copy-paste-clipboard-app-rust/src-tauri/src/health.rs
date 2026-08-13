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
//!
//! A deadlock produces no panic and so latches nothing — see the liveness
//! section below for the separate, self-clearing signal that covers it.

use parking_lot::Mutex;
use std::collections::BTreeSet;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::Instant;

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

/// Append a diagnostic to `crash.log`. Both callers are last-resort paths — a
/// thread already unwinding, or a watchdog reporting one that stopped — so every
/// failure in here is swallowed. There is nothing better to fall back to.
fn record(app_data: Option<&Path>, headline: &str, detail: &str) {
    let Some(dir) = app_data else {
        return;
    };
    let _ = std::fs::create_dir_all(dir);
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("crash.log"))
    {
        let _ = f.write_all(format!("── {headline} @ epoch {secs}s\n{detail}\n").as_bytes());
    }
}

// ── Recovery ────────────────────────────────────────────────────────

/// Stores that had a quarantined payload adopted at startup, for a one-time
/// notice. A set, because history and saved-entries both report as one thing.
static RECOVERED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// Adopt a payload a degraded session had to set aside, so what the user
/// captured after the fault is not stranded in a file nothing reads.
///
/// The held-back snapshot is `rmp_serde` output like any other, so it always
/// parses — the reason it was withheld is that a panic *may* have left one entry
/// logically half-updated, not that the file is unreadable. Against losing
/// everything captured in that window, adopting it is the better trade. The
/// displaced copy is kept as `.pre-recovery` so the choice stays reversible.
///
/// A swap rather than a second load path: the store then reads the file it
/// always did, so nothing downstream needs to know this happened.
pub fn recover_quarantined(path: &Path, label: &str) -> bool {
    let quarantine = sibling(path, ".quarantine");
    if !quarantine.exists() {
        return false;
    }

    // A quarantine older than the live file belongs to a session that already
    // recovered, and the live file supersedes it. Left in place rather than
    // deleted: it is only litter, and deleting is the one step nothing undoes.
    let stale = match (modified(&quarantine), modified(path)) {
        (Some(q), Some(target)) => q <= target,
        _ => false,
    };
    if stale {
        return false;
    }

    // Copy, not rename: if the swap below fails, the live file must still be
    // there. A rename here would leave the app with neither file.
    let _ = std::fs::copy(path, sibling(path, ".pre-recovery"));

    if std::fs::rename(&quarantine, path).is_err() {
        return false;
    }
    RECOVERED.lock().insert(label.to_string());
    record(
        path.parent(),
        "recovered",
        &format!(
            "  adopted {} after a degraded session\n  displaced copy kept alongside it as \
             .pre-recovery\n",
            quarantine.display()
        ),
    );
    true
}

fn modified(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// What was adopted at startup, phrased for the user, or `None` if nothing was.
pub fn recovery_notice() -> Option<String> {
    let items = RECOVERED.lock();
    if items.is_empty() {
        return None;
    }
    Some(items.iter().cloned().collect::<Vec<_>>().join(" and "))
}

// ── Liveness ────────────────────────────────────────────────────────
//
// The latch above only fires on a panic, and a deadlock never produces one.
// `parking_lot` locks are not reentrant, so a thread that takes one twice — or
// two threads that take a pair in opposite orders — simply stops, still holding
// it, and everything that wants that lock stops behind them. No panic, nothing
// logged, and the window often keeps painting as if all were well.
//
// The flush loop makes a good probe: it wakes every couple of seconds and it
// touches every state mutex there is, so a completed pass proves none of them
// are wedged. It reports each pass with [`beat`]; the watchdog notices when the
// reports stop and says so, instead of leaving the user with an app that has
// quietly stopped saving.

/// Monotonic origin for liveness timing. `Instant` cannot be a `const`, and a
/// wall clock would let an NTP correction or a timezone change read as a stall.
static START: LazyLock<Instant> = LazyLock::new(Instant::now);
/// Uptime in ms at the flush loop's last completed pass. 0 = no pass yet.
static LAST_BEAT_MS: AtomicU64 = AtomicU64::new(0);
/// Set while the flush loop looks wedged. Unlike [`DEGRADED`] this clears itself:
/// a stall is an inference about a thread that is still alive, not a proven
/// fault, and a wrong guess must not permanently stop the app from saving.
static STALL_REASON: Mutex<Option<String>> = Mutex::new(None);

const WATCHDOG_INTERVAL_MS: u64 = 2_000;
/// How stale the last completed pass may get before the user is told. Generous
/// on purpose — a few missed ticks are a slow disk, not a hang. Must stay several
/// multiples of the flush loop's own `FLUSH_INTERVAL_MS` (2 s): raising that
/// without raising this would report a loop that is keeping up as wedged.
const STALL_AFTER_MS: u64 = 15_000;

fn uptime_ms() -> u64 {
    START.elapsed().as_millis() as u64
}

/// Report that the state-flush loop completed a pass. Cheap enough to call every
/// tick: one clock read and one relaxed store.
pub fn beat() {
    // `max(1)` keeps 0 meaning "no pass yet" during the first millisecond.
    LAST_BEAT_MS.store(uptime_ms().max(1), Ordering::Relaxed);
}

/// How the flush loop is doing, or `None` while it is keeping up.
pub fn stall_reason() -> Option<String> {
    STALL_REASON.lock().clone()
}

/// One watchdog round's verdict. `None` means this round proves nothing;
/// `Some(true)` means the flush loop looks wedged.
///
/// Split out from the loop so the policy can be tested without waiting on real
/// clocks — the thresholds are tens of seconds apart.
fn stall_verdict(slept_ms: u64, age_ms: u64, first_pass_done: bool) -> Option<bool> {
    // Our own sleep overshooting means the whole process was frozen — suspend,
    // hibernate, a swap storm — in which case every thread's last beat looks
    // stale through no fault of its own, and blaming the flush loop would put a
    // warning on the screen of a laptop that just woke up working fine.
    if slept_ms > WATCHDOG_INTERVAL_MS * 3 {
        return None;
    }
    if !first_pass_done {
        return None;
    }
    Some(age_ms >= STALL_AFTER_MS)
}

/// What one round changed, so a stall that persists is reported once rather than
/// every two seconds for as long as it lasts.
#[derive(Debug, PartialEq, Eq)]
enum StallChange {
    Began(String),
    Ended,
    Unchanged,
}

/// Fold this round's verdict into [`STALL_REASON`].
fn apply_stall(stalled: bool, age_ms: u64) -> StallChange {
    let mut guard = STALL_REASON.lock();
    match (stalled, guard.is_some()) {
        (true, false) => {
            let reason = format!("saving has not completed a pass in {}s", age_ms / 1000);
            *guard = Some(reason.clone());
            StallChange::Began(reason)
        }
        (false, true) => {
            *guard = None;
            StallChange::Ended
        }
        _ => StallChange::Unchanged,
    }
}

/// Watch the flush loop and surface a stall. Deliberately does **not** latch
/// [`mark_degraded`]: a hang is not evidence that memory was torn, and refusing
/// writes forever over a transient stall would cost more than it saves.
pub fn start_stall_watchdog(app_data: Option<PathBuf>, app: tauri::AppHandle) {
    use tauri::Emitter;

    std::thread::spawn(move || {
        loop {
            let before = uptime_ms();
            std::thread::sleep(std::time::Duration::from_millis(WATCHDOG_INTERVAL_MS));
            let now = uptime_ms();

            let last = LAST_BEAT_MS.load(Ordering::Relaxed);
            let age = now.saturating_sub(last);
            let Some(stalled) = stall_verdict(now.saturating_sub(before), age, last != 0) else {
                continue;
            };

            // `apply_stall` takes and releases the lock; everything below runs
            // without it, because a Tauri emit re-enters the event machinery and
            // that is not somewhere to be holding one of our own mutexes.
            match apply_stall(stalled, age) {
                StallChange::Began(reason) => {
                    eprintln!("[health] {reason} — likely a deadlock");
                    record(
                        app_data.as_deref(),
                        "stall",
                        &format!(
                            "  {reason}\n  most likely a lock taken twice on one thread, or two \
                             locks taken in opposite orders on two\n"
                        ),
                    );
                    let _ = app.emit("health:stalled", Some(reason));
                }
                StallChange::Ended => {
                    eprintln!("[health] saving recovered");
                    let _ = app.emit("health:stalled", None::<String>);
                }
                StallChange::Unchanged => {}
            }
        }
    });
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
        let thread = std::thread::current()
            .name()
            .unwrap_or("unnamed")
            .to_string();
        record(
            app_data.as_deref(),
            "panic",
            &format!("  thread:   {thread}\n  location: {location}\n  message:  {info}\n"),
        );

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

/// Stall reason, or `None` while the flush loop is keeping up. Polled for the
/// same reason as [`health_degraded_reason`], and additionally because a stall
/// can begin long after any window finished loading.
#[tauri::command]
pub fn health_stall_reason() -> Option<String> {
    stall_reason()
}

/// What a degraded previous session left behind and this one adopted, so the app
/// can say so once. Decided long before any window exists, hence a poll rather
/// than an event.
#[tauri::command]
pub fn health_recovery_notice() -> Option<String> {
    recovery_notice()
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

    /// The watchdog policy, without waiting out the real thresholds. A wrong
    /// verdict here is expensive in both directions: a missed stall leaves the
    /// user with an app that silently stopped saving, and a false one puts a
    /// scary banner on a laptop that just woke from sleep working fine.
    #[test]
    fn stall_verdict_blames_the_flush_loop_only_when_it_is_at_fault() {
        let slept = WATCHDOG_INTERVAL_MS;

        // Keeping up: a pass finished within the last interval.
        assert_eq!(stall_verdict(slept, 500, true), Some(false));
        // Late but not yet late enough — a slow disk gets the benefit of doubt.
        assert_eq!(stall_verdict(slept, STALL_AFTER_MS - 1, true), Some(false));
        // Wedged.
        assert_eq!(stall_verdict(slept, STALL_AFTER_MS, true), Some(true));
        assert_eq!(stall_verdict(slept, 600_000, true), Some(true));

        // Frozen process: our own 2 s sleep took 10 minutes, so a stale beat
        // says nothing about the flush loop. No verdict either way.
        assert_eq!(stall_verdict(600_000, 600_000, true), None);
        // Boundary: an overshoot up to 3× is still ordinary scheduling jitter.
        assert_eq!(
            stall_verdict(WATCHDOG_INTERVAL_MS * 3, STALL_AFTER_MS, true),
            Some(true)
        );
        assert_eq!(
            stall_verdict(WATCHDOG_INTERVAL_MS * 3 + 1, STALL_AFTER_MS, true),
            None
        );

        // Startup: the loop sleeps before its first pass, so an unset beat must
        // not read as a stall — the watchdog outlives the app's first seconds.
        assert_eq!(stall_verdict(slept, u64::MAX, false), None);
    }

    /// A stall lasting a minute is 30 watchdog rounds. The user should hear about
    /// it once, and hear about the recovery once.
    ///
    /// Leaves `STALL_REASON` cleared: unlike `DEGRADED` it is not a latch, so
    /// restoring it keeps this test from leaking into the shared test binary.
    #[test]
    fn apply_stall_reports_each_transition_once() {
        assert_eq!(stall_reason(), None, "started dirty");

        assert_eq!(
            apply_stall(true, 20_000),
            StallChange::Began("saving has not completed a pass in 20s".into())
        );
        assert_eq!(
            stall_reason().as_deref(),
            Some("saving has not completed a pass in 20s")
        );

        // Still stalled, and now for longer: no second report, and the original
        // reason stands rather than being rewritten every round.
        assert_eq!(apply_stall(true, 40_000), StallChange::Unchanged);
        assert_eq!(apply_stall(true, 60_000), StallChange::Unchanged);
        assert_eq!(
            stall_reason().as_deref(),
            Some("saving has not completed a pass in 20s")
        );

        // Recovered — announced once, then quiet.
        assert_eq!(apply_stall(false, 500), StallChange::Ended);
        assert_eq!(stall_reason(), None);
        assert_eq!(apply_stall(false, 500), StallChange::Unchanged);
        assert_eq!(apply_stall(false, 500), StallChange::Unchanged);
    }

    /// The cases `tests/degraded_mode.rs` does not reach, since it only exercises
    /// the happy path of a quarantine written moments ago.
    ///
    /// Touches process-global `RECOVERED`, so it uses labels no other test
    /// asserts on. Nothing here may assert that the notice is *empty*.
    #[test]
    fn recovery_adopts_only_a_quarantine_newer_than_the_file_it_replaces() {
        let dir = scratch_dir("recover");
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("history.bin");

        // Nothing set aside: the overwhelmingly common case, and it must not
        // disturb the live file.
        std::fs::write(&target, b"live").unwrap();
        assert!(!recover_quarantined(&target, "unit-none"));
        assert_eq!(std::fs::read(&target).unwrap(), b"live");

        // A quarantine older than the live file is from a session that already
        // recovered. Adopting it would roll the user back onto a stale snapshot,
        // losing everything written since — the opposite of the point.
        std::fs::write(sibling(&target, ".quarantine"), b"stale").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&target, b"newer live").unwrap();
        assert!(!recover_quarantined(&target, "unit-stale"));
        assert_eq!(std::fs::read(&target).unwrap(), b"newer live");
        assert!(
            sibling(&target, ".quarantine").exists(),
            "a stale quarantine was deleted — the one step nothing undoes"
        );

        // Newer quarantine: adopted, and the displaced copy kept.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(sibling(&target, ".quarantine"), b"fresh").unwrap();
        assert!(recover_quarantined(&target, "unit-fresh"));
        assert_eq!(std::fs::read(&target).unwrap(), b"fresh");
        assert_eq!(
            std::fs::read(sibling(&target, ".pre-recovery")).unwrap(),
            b"newer live"
        );

        // No live file at all — a fault before the first flush ever landed. There
        // is nothing to compare against and nothing to displace, and the captures
        // still have to survive.
        let virgin = dir.join("notes.bin");
        std::fs::write(sibling(&virgin, ".quarantine"), b"only copy").unwrap();
        assert!(recover_quarantined(&virgin, "unit-virgin"));
        assert_eq!(std::fs::read(&virgin).unwrap(), b"only copy");

        assert_eq!(
            recovery_notice().as_deref(),
            Some("unit-fresh and unit-virgin"),
            "the notice should name each store once, in stable order"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The watchdog's whole value in the frozen-UI case is the file it leaves
    /// behind, since a wedged app cannot render a banner to explain itself.
    #[test]
    fn record_appends_diagnostics_to_the_crash_log() {
        let dir = scratch_dir("record");
        let log = dir.join("crash.log");

        // Nested path the app has not created yet — the real app-data dir on a
        // first run — must not stop the diagnostic from landing.
        record(
            Some(&dir),
            "stall",
            "  saving has not completed a pass in 20s\n",
        );
        record(Some(&dir), "panic", "  location: src/lib.rs:1\n");

        let text = std::fs::read_to_string(&log).expect("crash.log written");
        assert!(
            text.contains("── stall @ epoch"),
            "missing stall entry: {text}"
        );
        assert!(
            text.contains("── panic @ epoch"),
            "second entry overwrote the first"
        );
        assert!(text.contains("saving has not completed a pass in 20s"));

        // No app-data dir resolved (portable/unwritable install): a no-op, not a
        // panic on the path that exists to report panics.
        record(None, "stall", "  dropped\n");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
