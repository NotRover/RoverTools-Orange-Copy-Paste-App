//! Degraded mode, end to end through the real clipboard store.
//!
//! Lives in its own integration test — and holds a single `#[test]` — because
//! latching the process as degraded is one-way and process-global. Split across
//! two tests in one binary, whichever ran second would see the other's latch.

use notrover_smart_clipboard_app_rust_lib::clipboard::history::{ClipboardEntry, ClipboardHistory};
use notrover_smart_clipboard_app_rust_lib::health;

fn quarantine_of(path: &std::path::Path) -> std::path::PathBuf {
    let mut name = path.file_name().unwrap().to_os_string();
    name.push(".quarantine");
    path.with_file_name(name)
}

#[test]
fn a_panic_costs_nothing_across_the_restart() {
    let dir = std::env::temp_dir().join("rovertools-degraded-e2e");
    let _ = std::fs::remove_dir_all(&dir);
    let history_file = dir.join("history.bin");

    // Healthy: two entries captured and flushed, the way the 2-second loop does.
    let mut history = ClipboardHistory::new();
    history.push(ClipboardEntry::new_text("first".into()));
    history.push(ClipboardEntry::new_text("second".into()));
    history
        .save_all_to_file(&history_file)
        .expect("healthy flush");

    let good_bytes = std::fs::read(&history_file).expect("history written");
    assert!(!good_bytes.is_empty());

    // A panic on any thread latches the process. Simulating the hook's effect
    // rather than the panic itself: installing the real hook needs an AppHandle,
    // and what matters here is what every write does from this point on.
    health::mark_degraded("internal error at test:1");
    assert!(health::is_degraded());

    // The store keeps working — captures still land in memory, so the user's
    // session is not disrupted.
    history.push(ClipboardEntry::new_text("captured after the fault".into()));
    assert_eq!(history.all().len(), 3);

    // But the flush must fail rather than overwrite the good file.
    let flush = history.save_all_to_file(&history_file);
    assert!(flush.is_err(), "degraded flush reported success");
    assert_eq!(
        std::fs::read(&history_file).unwrap(),
        good_bytes,
        "degraded flush overwrote the pre-panic history"
    );

    // And that refusal must not read as the disk turning us away: the user already
    // has the degraded banner, with advice this one would contradict.
    assert!(
        !health::write_failure_pending(),
        "setting state aside was counted as a write failure"
    );

    // Nothing captured since the fault is lost: it is sitting in the quarantine
    // sibling, and it really is the newer, three-entry payload.
    let quarantined = std::fs::read(quarantine_of(&history_file)).expect("quarantine written");
    assert_ne!(quarantined, good_bytes);
    assert!(quarantined.len() > good_bytes.len());

    // The loop keeps ticking, and the quarantine tracks the newest payload — the
    // first snapshot is the least useful one to have kept, since every later one
    // holds the same suspect state plus whatever was captured since.
    history.push(ClipboardEntry::new_text("captured later still".into()));
    assert!(history.save_all_to_file(&history_file).is_err());
    let quarantined_later =
        std::fs::read(quarantine_of(&history_file)).expect("quarantine rewritten");
    assert!(
        quarantined_later.len() > quarantined.len(),
        "quarantine kept the older payload: {} bytes vs {}",
        quarantined_later.len(),
        quarantined.len()
    );
    assert_eq!(
        std::fs::read(&history_file).unwrap(),
        good_bytes,
        "the real file drifted across repeated degraded flushes"
    );

    // The pre-panic file is still loadable — which is what makes "restart to
    // recover" safe advice.
    let mut restored = ClipboardHistory::new();
    restored
        .load_all_from_file(&history_file)
        .expect("pre-panic history still parses");
    assert_eq!(restored.all().len(), 2);

    // ── What the restart the banner asks for actually does ──────────
    //
    // Holding the line above is only half the job: without this, everything
    // captured between the fault and the restart would sit in a file nothing
    // reads, which to the user is indistinguishable from losing it.
    assert!(
        health::recover_quarantined(&history_file, "clipboard history"),
        "quarantined captures were not adopted"
    );
    assert!(
        !quarantine_of(&history_file).exists(),
        "quarantine left in place — a second restart would adopt it again"
    );
    assert_eq!(
        health::recovery_notice().as_deref(),
        Some("clipboard history"),
        "recovery happened silently"
    );

    // All four captures are back: the two from before the fault and the two the
    // degraded session could not write.
    let mut after_restart = ClipboardHistory::new();
    after_restart
        .load_all_from_file(&history_file)
        .expect("adopted history parses");
    assert_eq!(after_restart.all().len(), 4);
    let contents: Vec<&str> = after_restart
        .all()
        .iter()
        .map(|e| e.content.as_str())
        .collect();
    assert!(contents.contains(&"captured after the fault"));
    assert!(contents.contains(&"captured later still"));

    // And the pre-fault copy is still there to fall back on, since adopting a
    // post-panic snapshot is a judgement call rather than a certainty.
    let pre = history_file.with_file_name("history.bin.pre-recovery");
    assert_eq!(std::fs::read(&pre).unwrap(), good_bytes);

    // Idempotent: the next launch has nothing left to adopt and must not touch
    // the file it just recovered.
    let now = std::fs::read(&history_file).unwrap();
    assert!(!health::recover_quarantined(
        &history_file,
        "clipboard history"
    ));
    assert_eq!(std::fs::read(&history_file).unwrap(), now);

    // Sync bookkeeping deliberately keeps persisting while degraded: it is
    // rebuilt from server state, and it carries the queued tombstones that must
    // survive the restart.
    let derived = dir.join("sync_pending.json");
    health::replace_atomic(&derived, b"[]").expect("derived data still persists");
    assert_eq!(std::fs::read(&derived).unwrap(), b"[]");

    let _ = std::fs::remove_dir_all(&dir);
}
