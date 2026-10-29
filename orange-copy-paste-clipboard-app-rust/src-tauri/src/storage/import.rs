//! One-time import of the file-based stores into `app.db`.
//!
//! Runs on the first launch of a build with the database, for each legacy file
//! still carrying its original name. The file is read the way the old build
//! wrote it, written into its table in one transaction, and only then renamed
//! to `<name>.migrated`, so a launch that dies halfway reads it again next
//! time and the row writes, keyed by id, land the same rows twice at worst.
//! Nothing is deleted: the renamed files are the user's own backup until a
//! later build removes them.
//!
//! The old build kept copies beside each file: `.bak` (the last good load),
//! `.quarantine` (a snapshot a session that had panicked would not write over
//! the file) and `.sealed.quarantine` (what a session captured while the file
//! would not read). The import reads the `.bak` when the file itself will not,
//! folds the two quarantines in by id, and retires every sibling with the file.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::clipboard::history::ClipboardHistory;
use crate::notes::NoteStore;
use crate::notifications::NotificationStore;
use crate::storage::Db;

/// Suffix a legacy file gets once its contents are in the database.
const MIGRATED: &str = ".migrated";

/// Every suffix the old build's read and write paths could leave beside a
/// store file. Retired with it; nothing reads them now.
const SIBLINGS: [&str; 8] = [
    ".bak",
    ".bak.prev",
    ".quarantine",
    ".sealed.quarantine",
    ".pre-recovery",
    ".pre-upgrade",
    ".folded",
    ".retired",
];

/// `path` with `suffix` appended to its full file name.
fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

fn retire(path: &Path) {
    if path.exists() {
        let _ = std::fs::rename(path, sibling(path, MIGRATED));
    }
}

/// Retire a legacy file and every sibling the old build kept beside it.
fn retire_with_siblings(file: &Path) {
    retire(file);
    for suffix in SIBLINGS {
        retire(&sibling(file, suffix));
    }
}

/// A MessagePack list the pre-SQLite build wrote: the file, else its `.bak`
/// copy, else nothing. A file that will not parse is left where it is.
pub(crate) fn read_legacy<T: serde::de::DeserializeOwned>(path: &Path) -> Vec<T> {
    for candidate in [path.to_path_buf(), sibling(path, ".bak")] {
        if let Ok(bytes) = std::fs::read(&candidate) {
            if let Ok(parsed) = rmp_serde::from_slice::<Vec<T>>(&bytes) {
                return parsed;
            }
        }
    }
    Vec::new()
}

fn modified(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Fold in what an older build's session set aside beside `file`.
/// `.sealed.quarantine` holds only what was captured while the file would not
/// read, so it always folds. `.quarantine` is a whole snapshot, folded only
/// when it is newer than the file, since an older one could put back what the
/// user has since deleted.
fn fold_quarantines(file: &Path, mut merge: impl FnMut(&[u8]) -> Option<usize>) {
    for (suffix, always) in [(".sealed.quarantine", true), (".quarantine", false)] {
        let copy = sibling(file, suffix);
        let newer = match (modified(&copy), modified(file)) {
            (Some(c), Some(f)) => c > f,
            (Some(_), None) => true,
            _ => false,
        };
        if !always && !newer {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&copy) {
            merge(&bytes);
        }
    }
}

/// Load the clipboard history from `history.bin` (and the pre-upgrade
/// `pinned_entries.bin`, folded once) into `history`, write it to the
/// database, and retire the files. `legacy_keep` is what the old build did with
/// `history.bin` (see `ClipboardHistory::load_legacy`).
///
/// Returns whether an import ran. With no legacy file there is nothing to do
/// and the caller loads from the database instead.
pub fn history(
    app_data: &Path,
    history: &mut ClipboardHistory,
    db: &Arc<Db>,
    legacy_keep: bool,
) -> bool {
    let history_file = app_data.join("history.bin");
    let saved_file = app_data.join("pinned_entries.bin");
    if !history_file.exists() && !saved_file.exists() {
        return false;
    }
    // Read with no database attached, so the loader's own writes are no-ops
    // and everything lands in one transaction below.
    history.load_legacy(&history_file, &saved_file, legacy_keep);
    for file in [&history_file, &saved_file] {
        fold_quarantines(file, |bytes| history.merge_leftover(bytes));
    }
    history.attach_db(Arc::clone(db));
    let count = history.all().len();
    if !history.persist_all() {
        crate::health::note(
            "import: clipboard history did not reach the database",
            "  the files are left in place and the import runs again next launch",
        );
        return true;
    }
    for file in [&history_file, &saved_file] {
        retire_with_siblings(file);
    }
    crate::health::note(
        "import: clipboard history moved to app.db",
        &format!("  {count} entries; history.bin kept as history.bin.migrated"),
    );
    true
}

/// The sync engine's four record files into their tables, once each, before
/// the engine is built. A file that will not import is left in place and
/// noted; the engine then starts from whatever its table holds, which for a
/// first launch is nothing, and a restore sweep brings the account back.
pub fn sync_records(app_data: &Path, db: &Arc<Db>) {
    use crate::sync::{id_map::IdMap, pending_queue::PendingQueue, pending_work::PendingWork, sync_state::SyncStateStore};

    let id_map = app_data.join("id_map.json");
    if id_map.exists() {
        match IdMap::import_file(db, &id_map) {
            Ok(n) => {
                retire(&id_map);
                crate::health::note("import: id map moved to app.db", &format!("  {n} keys"));
            }
            Err(e) => crate::health::note("import: id_map.json did not import", &format!("  {e}")),
        }
    }
    let queue = app_data.join("sync_pending.json");
    let inflight = queue.with_extension("inflight.json");
    if queue.exists() || inflight.exists() {
        match PendingQueue::import_files(db, &queue) {
            Ok(n) => {
                retire(&queue);
                retire(&inflight);
                crate::health::note("import: sync queue moved to app.db", &format!("  {n} operations"));
            }
            Err(e) => crate::health::note("import: sync_pending.json did not import", &format!("  {e}")),
        }
    }
    let work = app_data.join("sync_pending_work.json");
    if work.exists() {
        match PendingWork::import_file(db, &work) {
            Ok(n) => {
                retire(&work);
                crate::health::note("import: pending work moved to app.db", &format!("  {n} keys"));
            }
            Err(e) => crate::health::note("import: sync_pending_work.json did not import", &format!("  {e}")),
        }
    }
    let state = app_data.join("sync_state.json");
    if state.exists() {
        match SyncStateStore::import_file(db, &state) {
            Ok(_) => {
                retire(&state);
                crate::health::note("import: sync state moved to app.db", "");
            }
            Err(e) => crate::health::note("import: sync_state.json did not import", &format!("  {e}")),
        }
    }
}

/// `notes.bin` into the `notes` table, once. Same shape as [`history`].
pub fn notes(app_data: &Path, store: &mut NoteStore, db: &Arc<Db>) -> bool {
    let file = app_data.join("notes.bin");
    if !file.exists() {
        return false;
    }
    store.load_legacy(&file);
    fold_quarantines(&file, |bytes| store.merge_leftover(bytes));
    store.attach_db(Arc::clone(db));
    let count = store.all().len();
    if !store.persist_all() {
        crate::health::note(
            "import: notes did not reach the database",
            "  the file is left in place and the import runs again next launch",
        );
        return true;
    }
    retire_with_siblings(&file);
    crate::health::note(
        "import: notes moved to app.db",
        &format!("  {count} notes; notes.bin kept as notes.bin.migrated"),
    );
    true
}

/// `notifications.bin` into the `notifications` table, once. Same shape as [`history`].
pub fn notifications(app_data: &Path, store: &mut NotificationStore, db: &Arc<Db>) -> bool {
    let file = app_data.join("notifications.bin");
    if !file.exists() {
        return false;
    }
    store.load_legacy(&file);
    fold_quarantines(&file, |bytes| store.merge_leftover(bytes));
    store.attach_db(Arc::clone(db));
    let count = store.all().len();
    if !store.persist_all() {
        crate::health::note(
            "import: notifications did not reach the database",
            "  the file is left in place and the import runs again next launch",
        );
        return true;
    }
    retire_with_siblings(&file);
    crate::health::note(
        "import: notifications moved to app.db",
        &format!("  {count} notifications; notifications.bin kept as notifications.bin.migrated"),
    );
    true
}
