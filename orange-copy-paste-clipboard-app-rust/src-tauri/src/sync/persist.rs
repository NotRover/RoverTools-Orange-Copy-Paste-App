//! Shared best-effort JSON persistence for the small sync state files
//! (`sync_state.json`, `id_map.json`, `sync_pending.json`).  All of them are
//! safe to lose — errors are silently ignored by design.

use serde::{de::DeserializeOwned, Serialize};
use std::path::Path;

/// Load `T` from a JSON file, falling back to `T::default()` on any error.
pub(crate) fn load_json<T: DeserializeOwned + Default>(path: &Path) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Write `value` as pretty JSON, creating parent directories as needed.
pub(crate) fn save_json<T: Serialize>(path: &Path, value: &T) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(value) {
        let _ = std::fs::write(path, json);
    }
}
