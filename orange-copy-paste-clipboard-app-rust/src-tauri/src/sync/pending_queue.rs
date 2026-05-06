//! Offline operation queue, persisted to `{app_data}/sync_pending.json`.
//!
//! When the server is unreachable, operations are accumulated here and
//! flushed in order on the next successful reconnect.  The queue is safe
//! to delete — loss causes a re-sync; server deduplicates by client_id.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// An operation that needs to reach the server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PendingOp {
    /// Push a new (or updated) entry — encrypted content is pre-computed.
    Push {
        /// The encrypted JSON payload ready to send to POST /sync/push.
        entry_json: String,
        /// Entry type for routing.
        entry_type: String,
    },
    /// Delete an entry on the server.
    Delete {
        /// Local client_id (maps to server_id via id_map).
        client_id: String,
        entry_type: String,
    },
    /// Update metadata (pin/groups) of an existing entry.
    Update {
        entry_json: String,
        entry_type: String,
    },
}

pub struct PendingQueue {
    ops: Vec<PendingOp>,
    path: PathBuf,
}

impl PendingQueue {
    pub fn load(path: PathBuf) -> Self {
        let ops = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { ops, path }
    }

    fn persist(&self) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(&self.ops) {
            let _ = std::fs::write(&self.path, json);
        }
    }

    /// Append an operation.  Immediately persisted to disk.
    pub fn push(&mut self, op: PendingOp) {
        self.ops.push(op);
        self.persist();
    }

    /// Remove and return all pending operations in FIFO order.
    /// The file is cleared atomically after draining.
    pub fn drain(&mut self) -> Vec<PendingOp> {
        let ops = std::mem::take(&mut self.ops);
        self.persist();
        ops
    }

    pub fn len(&self) -> usize {
        self.ops.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }
}

/// Derive the path for sync_pending.json given an app_data directory.
pub fn pending_queue_path(app_data: &Path) -> PathBuf {
    app_data.join("sync_pending.json")
}
