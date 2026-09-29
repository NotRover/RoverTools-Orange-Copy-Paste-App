//! Shared best-effort JSON persistence for the small sync state files
//! (`sync_state.json`, `id_map.json`, `sync_pending.json`,
//! `sync_pending_work.json`). Write errors are ignored by design; read errors
//! are not, for the files [`load_json_checked`] reads.

use serde::{de::DeserializeOwned, Serialize};
use std::path::{Path, PathBuf};

/// Load `T` from a JSON file, falling back to `T::default()` on any error.
///
/// Only for a file that is safe to lose: `sync_state.json`, which the server
/// rebuilds. The files that name entries go through [`load_json_checked`].
pub(crate) fn load_json<T: DeserializeOwned + Default>(path: &Path) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Paths [`load_json_checked`] found unreadable. [`save_json`] never writes
/// them, so the file keeps what it held for the next launch to read.
static UNREADABLE: parking_lot::Mutex<Vec<PathBuf>> = parking_lot::Mutex::new(Vec::new());

/// Load `T` from a JSON file that names entries this device must keep.
///
/// A missing file is `(T::default(), false)`. A file that is there and will not
/// read or parse is `(T::default(), true)`: the caller treats the store as
/// unknown, never as empty, and the file is left untouched for the rest of the
/// session, so an empty map in memory never replaces what it held.
pub(crate) fn load_json_checked<T: DeserializeOwned + Default>(path: &Path) -> (T, bool) {
    let failure = match crate::health::read_state(path) {
        Ok(None) => return (T::default(), false),
        Ok(Some(bytes)) => match serde_json::from_slice(&bytes) {
            Ok(value) => return (value, false),
            Err(e) => format!("did not parse: {e}"),
        },
        Err(e) => format!("did not read: {e}"),
    };
    UNREADABLE.lock().push(path.to_path_buf());
    crate::health::note(
        "sync: a sync record could not be read",
        &format!(
            "  file:   {}
  reason: {failure}
  effect: left untouched, every clipboard entry is kept this session
",
            path.display()
        ),
    );
    (T::default(), true)
}

/// Write `value` as pretty JSON, creating parent directories as needed.
///
/// Atomic, because a truncated `id_map.json` is worse than a missing one — it
/// reads back as a real mapping that has silently lost entries. Not flushed, and
/// not gated on process health: these files are rebuilt from server state, and
/// they are how a queued tombstone survives the restart that recovers from a
/// panic, so they must keep persisting even once degraded.
pub(crate) fn save_json<T: Serialize>(path: &Path, value: &T) {
    if UNREADABLE.lock().iter().any(|p| p == path) {
        return;
    }
    if let Ok(json) = serde_json::to_string_pretty(value) {
        let _ = crate::health::replace_atomic(path, json.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rovertools-persist-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir.join("record.json")
    }

    #[test]
    fn a_missing_file_is_empty_and_readable() {
        let path = scratch("missing");
        let (v, unreadable): (Vec<String>, bool) = load_json_checked(&path);
        assert!(v.is_empty());
        assert!(!unreadable);
    }

    /// The case the whole flag exists for: a torn file must not pass for an
    /// empty one, and no write may replace what it held.
    #[test]
    fn an_unreadable_file_is_flagged_and_never_overwritten() {
        let path = scratch("torn");
        std::fs::write(&path, b"[\"a\", \"b").unwrap();
        let (v, unreadable): (Vec<String>, bool) = load_json_checked(&path);
        assert!(v.is_empty());
        assert!(unreadable);
        save_json(&path, &Vec::<String>::new());
        assert_eq!(std::fs::read(&path).unwrap(), b"[\"a\", \"b");
    }
}
