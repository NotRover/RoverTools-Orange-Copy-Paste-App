//! Offline operation queue, persisted to `{app_data}/sync_pending.json`.
//!
//! When the server is unreachable, operations are accumulated here and
//! flushed in order on the next successful reconnect.
//!
//! Losing the queue is *not* free, whatever an earlier version of this note
//! claimed. A lost `Push` or `Update` is recovered - the server deduplicates by
//! `client_id`, and the entry is still on this device to send again. A lost
//! `Delete` is not: the tombstone is the only record that the user deleted
//! anything, so dropping it leaves the row on the server and the next pull
//! hands the entry back. That is why a flush moves the ops through
//! `sync_pending.inflight.json` instead of simply clearing the file, and why
//! [`PendingQueue::load`] folds that file back in.

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
    /// Re-drive a local entry's push from scratch on the next flush.
    ///
    /// Unlike `Push`/`Update`, this carries no ciphertext - only the id of an
    /// entry still in the local store. It exists for the one push that cannot
    /// be pre-encrypted and parked: an image whose blob upload could not reach
    /// the server. The blob has to go up before the entry can, so there is
    /// nothing to serialize until connectivity is back; the flush re-reads the
    /// entry and runs the whole push (blob included) again.
    PushLocal {
        client_id: String,
        entry_type: String,
    },
}

pub struct PendingQueue {
    ops: Vec<PendingOp>,
    path: PathBuf,
}

impl PendingQueue {
    pub fn load(path: PathBuf) -> Self {
        let inflight_path = inflight_path(&path);
        // Ops taken for a flush that never finished go back at the front: they
        // were queued before anything still in the main file.
        let mut ops: Vec<PendingOp> = crate::sync::persist::load_json(&inflight_path);
        let recovered = ops.len();
        ops.extend(crate::sync::persist::load_json::<Vec<PendingOp>>(&path));
        let queue = Self { ops, path };
        if recovered > 0 {
            // Fold the recovered ops into the main file first, so a crash in
            // the next second does not lose them a second time.
            queue.persist();
            let _ = std::fs::remove_file(&inflight_path);
            crate::health::note(
                "sync: recovered a queue flush that did not finish",
                &format!("{recovered} operation(s) put back; a queued deletion would otherwise have been lost"),
            );
        }
        queue
    }

    fn persist(&self) {
        crate::sync::persist::save_json(&self.path, &self.ops);
    }

    /// Append an operation.  Immediately persisted to disk.
    pub fn push(&mut self, op: PendingOp) {
        self.ops.push(op);
        self.persist();
    }

    /// Remove and return all pending operations in FIFO order.
    ///
    /// The ops are written to the in-flight file *before* the queue is cleared,
    /// so at no point are they absent from disk. Every drain has to be closed by
    /// a [`Self::settle`], or the next launch will replay it.
    pub fn drain(&mut self) -> Vec<PendingOp> {
        let ops = std::mem::take(&mut self.ops);
        crate::sync::persist::save_json(&inflight_path(&self.path), &ops);
        self.persist();
        ops
    }

    /// Close the flush a [`Self::drain`] opened: requeue what did not get
    /// through, then drop the in-flight copy.
    ///
    /// `unsent` goes to the front rather than the back. Anything queued while
    /// the flush was in the air is newer, and a `Delete` that overtakes the
    /// `Push` it deletes is a tombstone for a row the server has not been told
    /// about yet.
    pub fn settle(&mut self, unsent: Vec<PendingOp>) {
        if !unsent.is_empty() {
            let mut ops = unsent;
            ops.append(&mut self.ops);
            self.ops = ops;
        }
        self.persist();
        // Last, and only now: until this the file is the only copy of anything
        // that got dropped along the way.
        let _ = std::fs::remove_file(inflight_path(&self.path));
    }

    /// id_map-style keys (`"clipboard:{id}"` / `"note:{id}"`) for every queued
    /// op, so the UI can mark those entries as still waiting to upload.
    pub fn pending_keys(&self) -> Vec<String> {
        self.ops
            .iter()
            .filter_map(|op| match op {
                PendingOp::Push { entry_json, entry_type }
                | PendingOp::Update { entry_json, entry_type } => {
                    serde_json::from_str::<serde_json::Value>(entry_json)
                        .ok()
                        .and_then(|v| {
                            v.get("client_id")
                                .and_then(|c| c.as_str())
                                .map(str::to_string)
                        })
                        .map(|id| format!("{entry_type}:{id}"))
                }
                PendingOp::Delete { client_id, entry_type }
                | PendingOp::PushLocal { client_id, entry_type } => {
                    Some(format!("{entry_type}:{client_id}"))
                }
            })
            .collect()
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

/// Where a flush parks the ops it has taken but not yet accounted for.
fn inflight_path(queue_path: &Path) -> PathBuf {
    queue_path.with_extension("inflight.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test directory named after the calling test, so tests cannot collide.
    fn scratch_queue(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rovertools-queue-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        pending_queue_path(&dir)
    }

    fn delete_op(id: &str) -> PendingOp {
        PendingOp::Delete {
            client_id: id.to_string(),
            entry_type: "clipboard".to_string(),
        }
    }

    fn ids(queue: &PendingQueue) -> Vec<String> {
        queue
            .ops
            .iter()
            .map(|op| match op {
                PendingOp::Delete { client_id, .. } => client_id.clone(),
                _ => "?".to_string(),
            })
            .collect()
    }

    /// The case that costs a user a deletion: the process ends between the drain
    /// and the settle, so for that moment the ops are in neither the queue file
    /// nor the server. Without the in-flight copy the tombstone is simply gone,
    /// and the entry comes back on the next pull.
    #[test]
    fn a_flush_that_never_settled_is_replayed_on_the_next_launch() {
        let path = scratch_queue("interrupted");
        let mut queue = PendingQueue::load(path.clone());
        queue.push(delete_op("a"));
        queue.push(delete_op("b"));

        let taken = queue.drain();
        assert_eq!(taken.len(), 2);
        assert!(queue.is_empty(), "the live queue is emptied by a drain");

        // The process dies here - no settle.
        let recovered = PendingQueue::load(path);
        assert_eq!(ids(&recovered), vec!["a", "b"]);
    }

    #[test]
    fn settling_keeps_what_did_not_send_and_drops_the_rest() {
        let path = scratch_queue("settled");
        let mut queue = PendingQueue::load(path.clone());
        queue.push(delete_op("sent"));
        queue.push(delete_op("failed"));

        queue.drain();
        queue.settle(vec![delete_op("failed")]);

        let reloaded = PendingQueue::load(path);
        assert_eq!(ids(&reloaded), vec!["failed"]);
    }

    /// An op queued while the flush was in the air is newer than one the flush
    /// could not send, and a tombstone that overtakes its own push would be a
    /// deletion for a row the server has never heard of.
    #[test]
    fn an_unsent_op_goes_back_ahead_of_anything_queued_since() {
        let path = scratch_queue("ordering");
        let mut queue = PendingQueue::load(path.clone());
        queue.push(delete_op("old"));

        queue.drain();
        queue.push(delete_op("arrived-during-flush"));
        queue.settle(vec![delete_op("old")]);

        assert_eq!(ids(&queue), vec!["old", "arrived-during-flush"]);
        let reloaded = PendingQueue::load(path);
        assert_eq!(ids(&reloaded), vec!["old", "arrived-during-flush"]);
    }

    /// A `PushLocal` carries only an id, so its pending key comes straight from
    /// the two fields - and it has to survive a restart, since the image it
    /// stands for cannot go up until the network is back.
    #[test]
    fn a_push_local_op_keys_and_persists() {
        let path = scratch_queue("push-local");
        let mut queue = PendingQueue::load(path.clone());
        queue.push(PendingOp::PushLocal {
            client_id: "img-1".to_string(),
            entry_type: "clipboard".to_string(),
        });
        assert_eq!(queue.pending_keys(), vec!["clipboard:img-1"]);

        let reloaded = PendingQueue::load(path);
        assert_eq!(reloaded.pending_keys(), vec!["clipboard:img-1"]);
        assert_eq!(reloaded.len(), 1);
    }

    #[test]
    fn a_settled_flush_leaves_no_inflight_file_behind() {
        let path = scratch_queue("cleanup");
        let mut queue = PendingQueue::load(path.clone());
        queue.push(delete_op("a"));
        queue.drain();
        assert!(inflight_path(&path).exists(), "the drain writes it");
        queue.settle(Vec::new());
        assert!(!inflight_path(&path).exists(), "the settle removes it");
    }
}
