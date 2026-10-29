//! One-time import of the file-based stores into `app.db`.
//!
//! Runs on the first launch of a build with the database, for each legacy file
//! still carrying its original name. The file is read the way the old build
//! wrote it, written into its table in one transaction, and only then renamed
//! to `<name>.migrated`, so a launch that dies halfway reads it again next
//! time and the row writes, keyed by id, land the same rows twice at worst.
//! Nothing is deleted on that launch: the renamed files are the user's backup
//! until the next launch opens the database and loads from it, when
//! [`remove_retired`] deletes them along with the files older builds left.
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
///
/// Returns whether any of the files was there.
pub fn sync_records(app_data: &Path, db: &Arc<Db>) -> bool {
    use crate::sync::{id_map::IdMap, pending_queue::PendingQueue, pending_work::PendingWork, sync_state::SyncStateStore};

    let mut found = false;
    let id_map = app_data.join("id_map.json");
    if id_map.exists() {
        found = true;
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
        found = true;
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
        found = true;
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
        found = true;
        match SyncStateStore::import_file(db, &state) {
            Ok(_) => {
                retire(&state);
                crate::health::note("import: sync state moved to app.db", "");
            }
            Err(e) => crate::health::note("import: sync_state.json did not import", &format!("  {e}")),
        }
    }
    found
}

/// Files and folders older builds wrote that nothing reads now. Deleted on
/// sight; none holds anything the database or the folders below do not.
const DEAD: [&str; 6] = [
    // The JSON stores from before MessagePack.
    "history.json",
    "pinned_entries.json",
    // Note images before they moved under note-attachments/.
    "note-images",
    // The per-boot marker and the local sync settings copy.
    "boot_id.txt",
    "sync_settings_local.json",
    // The fault log before logs/app.log.
    "crash.log",
];

/// Delete what the import left behind, once a later launch has opened the
/// database and loaded from it: every `*.migrated` file, and the files older
/// builds wrote that nothing reads. Runs only when the database is the file on
/// disk and this launch imported nothing, so the retired copies outlive the
/// launch that made them by one successful start. Anything else in the
/// folder, a user's own file included, is left alone.
pub fn remove_retired(app_data: &Path) {
    let mut removed = Vec::new();
    for name in DEAD {
        let path = app_data.join(name);
        let gone = if path.is_dir() {
            std::fs::remove_dir_all(&path).is_ok()
        } else {
            std::fs::remove_file(&path).is_ok()
        };
        if gone {
            removed.push(name.to_string());
        }
    }
    if let Ok(entries) = std::fs::read_dir(app_data) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(MIGRATED) && std::fs::remove_file(entry.path()).is_ok() {
                removed.push(name);
            }
        }
    }
    if !removed.is_empty() {
        log::info!(target: "storage", "removed files older builds left: {}", removed.join(", "));
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The retired copies and the dead files go; a file the app does not know
    /// stays, and so does everything the folder is meant to keep.
    #[test]
    fn remove_retired_deletes_only_what_older_builds_left() {
        let dir = std::env::temp_dir().join(format!("rovertools-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("note-images")).unwrap();
        std::fs::create_dir_all(dir.join("images")).unwrap();
        for name in [
            "history.bin.migrated",
            "id_map.json.migrated",
            "crash.log",
            "boot_id.txt",
            "notes.bin.pre-showcase",
            "settings.json",
            "app.db",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }

        remove_retired(&dir);

        for gone in ["history.bin.migrated", "id_map.json.migrated", "crash.log", "boot_id.txt", "note-images"] {
            assert!(!dir.join(gone).exists(), "{gone} kept");
        }
        for kept in ["notes.bin.pre-showcase", "settings.json", "app.db", "images"] {
            assert!(dir.join(kept).exists(), "{kept} deleted");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
