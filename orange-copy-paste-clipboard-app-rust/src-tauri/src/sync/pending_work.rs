//! Write-ahead record of sync work that has started and not finished.
//!
//! An entry is named here, on disk, before its upload or blob download starts,
//! and leaves, on disk, only when that work is done: the server accepted the
//! upload, the download landed and its id_map row is written, or the op was
//! settled or durably re-queued. The exit flush keeps every entry this file
//! names, so a quit, crash or forced shutdown in the middle of a transfer does
//! not let Keep history off drop the entry the transfer was for. The next
//! launch re-drives whatever is left over.
//!
//! Separate from `sync_pending.json` on purpose: queue ops carry ciphertext and
//! replay rules, and this file holds only keys and which way the work runs.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Which way the work runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WorkKind {
    Upload,
    Download,
}

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
struct WorkData {
    #[serde(default)]
    upload: BTreeSet<String>,
    #[serde(default)]
    download: BTreeSet<String>,
}

pub struct PendingWork {
    data: WorkData,
    path: PathBuf,
    /// Tasks running now, per key and kind. A key leaves the record when its
    /// count reaches zero.
    active: HashMap<(String, WorkKind), usize>,
    /// Set as the client shuts down: tasks the runtime drops from here on did
    /// not finish, so their records stay for the next launch.
    closed: bool,
    unreadable: bool,
}

impl PendingWork {
    pub fn load(path: PathBuf) -> Self {
        let (data, unreadable) = crate::sync::persist::load_json_checked(&path);
        Self { data, path, active: HashMap::new(), closed: false, unreadable }
    }

    /// Name or un-name `key`, and write the file at once: every change is on
    /// disk before the caller moves on, so the file never names finished work
    /// or misses started work.
    fn change(&mut self, key: &str, kind: WorkKind, named: bool) {
        let set = match kind {
            WorkKind::Upload => &mut self.data.upload,
            WorkKind::Download => &mut self.data.download,
        };
        let changed = if named { set.insert(key.to_string()) } else { set.remove(key) };
        if changed {
            crate::sync::persist::save_json(&self.path, &self.data);
        }
    }

    fn begin(&mut self, key: &str, kind: WorkKind) {
        *self.active.entry((key.to_string(), kind)).or_default() += 1;
        self.change(key, kind, true);
    }

    /// Record `key` with no task behind it: work that was due and did not
    /// start, because the app is quitting. The next launch runs it.
    pub fn defer(&mut self, key: &str, kind: WorkKind) {
        self.change(key, kind, true);
    }

    /// One task for `key` ended. Unless `keep`, the key leaves the record when
    /// no other task for it is running.
    fn finish(&mut self, key: &str, kind: WorkKind, keep: bool) {
        if self.closed {
            return;
        }
        let slot = (key.to_string(), kind);
        let left = self.active.get_mut(&slot).map_or(0, |n| {
            *n = n.saturating_sub(1);
            *n
        });
        if left == 0 {
            self.active.remove(&slot);
            if !keep {
                self.change(key, kind, false);
            }
        }
    }

    /// Drop a recovered record that needs no more work.
    pub fn forget(&mut self, key: &str, kind: WorkKind) {
        if !self.active.contains_key(&(key.to_string(), kind)) {
            self.change(key, kind, false);
        }
    }

    /// Records with no task behind them: left by the last run, or deferred by
    /// this one. What a launch re-drives.
    pub fn recovered(&self, kind: WorkKind) -> Vec<String> {
        let data = match kind {
            WorkKind::Upload => &self.data.upload,
            WorkKind::Download => &self.data.download,
        };
        data.iter().filter(|k| !self.active.contains_key(&((*k).clone(), kind))).cloned().collect()
    }

    /// Every key named, either way.
    pub fn keys(&self) -> HashSet<String> {
        self.data.upload.iter().chain(&self.data.download).cloned().collect()
    }

    /// Whether any task is running now.
    pub fn active(&self) -> bool {
        !self.active.is_empty()
    }

    pub fn unreadable(&self) -> bool {
        self.unreadable
    }

    /// Stop clearing records: the runtime is about to drop every task.
    pub fn close(&mut self) {
        self.closed = true;
    }

    /// Forget everything: the signed-in account changed, and the old
    /// account's work is not this account's to finish.
    pub fn reset(&mut self) {
        self.data = WorkData::default();
        self.active.clear();
        crate::sync::persist::save_json(&self.path, &self.data);
    }

    /// Every key the file on disk names, read without changing it. For the
    /// exit flush with sync off. `Err` when the file is there and will not read.
    pub fn try_keys(path: &Path) -> Result<HashSet<String>, String> {
        let Some(bytes) = crate::health::read_state(path)? else {
            return Ok(HashSet::new());
        };
        let data: WorkData = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        Ok(data.upload.into_iter().chain(data.download).collect())
    }
}

/// Clears one begun record when dropped: a task that ends by any path,
/// including a panic, finishes its record. A task the runtime drops at
/// shutdown does not, because the store is closed first.
pub struct WorkGuard {
    work: std::sync::Arc<parking_lot::Mutex<PendingWork>>,
    key: String,
    kind: WorkKind,
    keep: bool,
}

impl WorkGuard {
    /// Name `key` on disk and return the guard that clears it.
    pub fn begin(work: &std::sync::Arc<parking_lot::Mutex<PendingWork>>, key: String, kind: WorkKind) -> Self {
        work.lock().begin(&key, kind);
        Self { work: work.clone(), key, kind, keep: false }
    }

    /// End the task without doing the work: the record stays for the next
    /// launch.
    pub fn defer(mut self) {
        self.keep = true;
    }
}

impl Drop for WorkGuard {
    fn drop(&mut self) {
        self.work.lock().finish(&self.key, self.kind, self.keep);
    }
}

/// Derive the path for sync_pending_work.json given an app_data directory.
pub fn pending_work_path(app_data: &Path) -> PathBuf {
    app_data.join("sync_pending_work.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn shared(name: &str) -> (PathBuf, Arc<parking_lot::Mutex<PendingWork>>) {
        let dir = std::env::temp_dir().join(format!("rovertools-work-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let path = pending_work_path(&dir);
        (path.clone(), Arc::new(parking_lot::Mutex::new(PendingWork::load(path))))
    }

    /// Both ends are on disk at once: a crash right after the work ends must
    /// not leave a record the next launch would run again.
    #[test]
    fn the_record_is_on_disk_while_the_work_runs_and_gone_the_moment_it_ends() {
        let (path, work) = shared("run");
        let guard = WorkGuard::begin(&work, "clipboard:a".into(), WorkKind::Upload);
        assert!(PendingWork::try_keys(&path).unwrap().contains("clipboard:a"));
        drop(guard);
        assert!(PendingWork::try_keys(&path).unwrap().is_empty());
    }

    #[test]
    fn two_tasks_for_one_key_clear_it_only_when_both_end() {
        let (_, work) = shared("twice");
        let first = WorkGuard::begin(&work, "clipboard:a".into(), WorkKind::Upload);
        let second = WorkGuard::begin(&work, "clipboard:a".into(), WorkKind::Upload);
        drop(first);
        assert!(work.lock().keys().contains("clipboard:a"));
        drop(second);
        assert!(work.lock().keys().is_empty());
    }

    /// The runtime drops unfinished tasks at shutdown, and a task that stops
    /// for a quit defers: neither may clear what it never finished.
    #[test]
    fn closed_or_deferred_work_stays_for_the_next_launch() {
        let (path, work) = shared("closed");
        let dropped = WorkGuard::begin(&work, "clipboard:a".into(), WorkKind::Download);
        WorkGuard::begin(&work, "clipboard:b".into(), WorkKind::Upload).defer();
        work.lock().close();
        drop(dropped);
        let next = PendingWork::load(path);
        assert_eq!(next.recovered(WorkKind::Download), vec!["clipboard:a"]);
        assert_eq!(next.recovered(WorkKind::Upload), vec!["clipboard:b"]);
    }

    #[test]
    fn deferred_work_is_recovered_and_can_be_forgotten() {
        let (_, work) = shared("defer");
        work.lock().defer("note:n", WorkKind::Upload);
        let _running = WorkGuard::begin(&work, "clipboard:b".into(), WorkKind::Upload);
        let mut w = work.lock();
        assert_eq!(w.recovered(WorkKind::Upload), vec!["note:n"]);
        w.forget("note:n", WorkKind::Upload);
        w.forget("clipboard:b", WorkKind::Upload);
        assert_eq!(w.keys(), HashSet::from(["clipboard:b".to_string()]), "running work is never forgotten");
    }

    #[test]
    fn an_unreadable_record_is_flagged() {
        let (path, _) = shared("torn");
        std::fs::write(&path, b"{\"upload\": [").unwrap();
        assert!(PendingWork::load(path.clone()).unreadable());
        assert!(PendingWork::try_keys(&path).is_err());
    }
}
