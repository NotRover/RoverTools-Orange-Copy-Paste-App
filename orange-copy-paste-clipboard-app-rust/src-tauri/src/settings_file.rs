//! Reading `settings.json`.
//!
//! One reader, because the interesting case is the one every hand-rolled copy
//! gets wrong: a file that exists but will not open right now. On Windows a
//! scanner or the search indexer can hold a transient handle to a file that was
//! just atomically replaced - the same sharing violation the write path in
//! [`crate::health`] already retries around. Collapsing that into "no settings"
//! makes a signed-in user look signed out, and makes a read-modify-write erase
//! every preference in the file.

use std::path::Path;

/// Attempts at a read, and the pause between them.
const READ_ATTEMPTS: u32 = 3;
const READ_BACKOFF_MS: u64 = 40;

pub type Map = serde_json::Map<String, serde_json::Value>;

/// Why a read produced no map. The distinction is the point: `Absent` is a
/// normal empty state, the other two are faults a caller must not mistake for
/// one.
pub enum ReadError {
    /// No file yet - a clean install, or one where no setting was ever changed.
    Absent,
    /// The file is there and would not open. Retried already; still failing.
    Unreadable(String),
    /// The file opened and is not JSON. Retrying reads the same bytes.
    Malformed(String),
}

/// Read and parse `settings.json`, retrying a read that is briefly refused.
///
/// Blocking: call it off the async workers if you are on one.
pub fn read_map(path: &Path) -> Result<Map, ReadError> {
    let mut last = None;
    for attempt in 0..READ_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(READ_BACKOFF_MS));
        }
        match std::fs::read_to_string(path) {
            Ok(data) => {
                return serde_json::from_str(&data)
                    .map_err(|e| ReadError::Malformed(e.to_string()))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(ReadError::Absent),
            Err(e) => last = Some(e.to_string()),
        }
    }
    Err(ReadError::Unreadable(
        last.unwrap_or_else(|| "unknown".into()),
    ))
}
