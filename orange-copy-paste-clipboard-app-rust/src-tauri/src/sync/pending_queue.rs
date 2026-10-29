//! Offline operation queue, persisted in the `sync_queue` table.
//!
//! When the server is unreachable, operations are accumulated here and
//! flushed in order on the next successful reconnect.
//!
//! Losing the queue is *not* free, whatever an earlier version of this note
//! claimed. A lost `Push` or `Update` is recovered - the server deduplicates by
//! `client_id`, and the entry is still on this device to send again. A lost
//! `Delete` is not: the tombstone is the only record that the user deleted
//! anything, so dropping it leaves the row on the server and the next pull
//! hands the entry back. That is why a flush marks the ops it has taken as
//! in flight instead of simply deleting them, and why [`PendingQueue::load`]
//! puts in-flight rows back at the front.
//!
//! The table always holds exactly what memory does: the ops a flush has taken
//! and not settled (`inflight = 1`, oldest first), then the live queue. Every
//! write replaces the whole table in one transaction; the queue is small and
//! what matters is that no state between two writes can be observed.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::storage::Db;

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
    db: Arc<Db>,
    /// A landed Delete left memory but not yet the table.
    unwritten: bool,
    /// Ops a [`Self::drain`] handed out and no [`Self::settle`] has closed yet.
    /// Still named by [`Self::pending_keys`]: a flush in the air has not sent
    /// them, and the exit flush keeps entries by those keys.
    taken: Vec<PendingOp>,
}

/// Every op in the table: the in-flight ones first, each group oldest first.
fn read_ops(conn: &rusqlite::Connection) -> rusqlite::Result<(Vec<PendingOp>, Vec<PendingOp>)> {
    let mut st = conn.prepare("SELECT op, inflight FROM sync_queue ORDER BY seq")?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))?;
    let mut inflight = Vec::new();
    let mut live = Vec::new();
    for row in rows {
        let (json, was_inflight) = row?;
        let Ok(op) = serde_json::from_str::<PendingOp>(&json) else {
            continue;
        };
        if was_inflight {
            inflight.push(op);
        } else {
            live.push(op);
        }
    }
    Ok((inflight, live))
}

impl PendingQueue {
    pub fn load(db: Arc<Db>) -> Self {
        // Ops taken for a flush that never finished go back at the front: they
        // were queued before anything still in the live queue.
        let (mut ops, live) = db.read("load queue", read_ops).unwrap_or_default();
        let recovered = ops.len();
        ops.extend(live);
        let mut queue = Self { ops, db, unwritten: false, taken: Vec::new() };
        if recovered > 0 {
            // Fold the recovered ops into the live queue at once, so a crash in
            // the next second does not lose them a second time.
            queue.persist();
            crate::health::note(
                "sync: recovered a queue flush that did not finish",
                &format!("{recovered} operation(s) put back; a queued deletion would otherwise have been lost"),
            );
        }
        queue
    }

    /// Every key the table names, read without changing it. For the exit
    /// flush with sync off. `None` when the read failed.
    pub fn keys_in(db: &Db) -> Option<Vec<String>> {
        let (inflight, live) = db.read("read queue keys", read_ops)?;
        Some(inflight.iter().chain(&live).filter_map(op_key).collect())
    }

    /// Move the ops of the old `sync_pending.json` (and its in-flight file)
    /// into the table, once. Returns how many came across.
    pub fn import_files(db: &Db, queue_path: &std::path::Path) -> Result<usize, String> {
        let inflight_path = queue_path.with_extension("inflight.json");
        let mut ops: Vec<PendingOp> = Vec::new();
        for file in [&inflight_path, queue_path] {
            match std::fs::read(file) {
                Ok(bytes) => {
                    let parsed: Vec<PendingOp> =
                        serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", file.display()))?;
                    ops.extend(parsed);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("{}: {e}", file.display())),
            }
        }
        let count = ops.len();
        db.write("import queue", |tx| write_all(tx, &[], &ops))
            .ok_or_else(|| "queue rows did not land".to_string())?;
        Ok(count)
    }

    /// Write the queue as it stands in memory.
    pub fn persist(&mut self) {
        let (taken, ops) = (&self.taken, &self.ops);
        self.db.write("write queue", |tx| write_all(tx, taken, ops));
        self.unwritten = false;
    }

    /// Append an operation.  Immediately persisted.
    pub fn push(&mut self, op: PendingOp) {
        self.push_many(vec![op]);
    }

    /// Append several operations in order, with one write.
    pub fn push_many(&mut self, ops: Vec<PendingOp>) {
        self.ops.extend(ops);
        self.persist();
    }

    /// Drop the queued `Delete` for one entry, once its tombstone has landed.
    ///
    /// Memory only. The next write of the queue carries it, and the delete
    /// fan-out writes once when its last tombstone is answered. Persisting on
    /// every landed delete made a large Clear all quadratic in writes. A
    /// stale op replays as a repeat tombstone, harmless unless the entry was
    /// uploaded again meanwhile, which [`Self::supersede_delete`] covers.
    pub fn remove_delete(&mut self, entry_type: &str, client_id: &str) -> bool {
        let before = self.ops.len();
        self.ops.retain(|op| {
            !matches!(op, PendingOp::Delete { client_id: c, entry_type: t }
                if c == client_id && t == entry_type)
        });
        let removed = self.ops.len() != before;
        self.unwritten |= removed;
        removed
    }

    /// A push for this entry was accepted, so a Delete still queued for it is
    /// older than the upload (Remove from cloud, then Upload) and must not
    /// replay over it. Written at once when one was dropped, or when a landed
    /// one (possibly this entry's) is still in the table.
    pub fn supersede_delete(&mut self, entry_type: &str, client_id: &str) {
        if self.remove_delete(entry_type, client_id) || self.unwritten {
            self.persist();
        }
    }

    /// Remove and return all pending operations in FIFO order.
    ///
    /// The ops are marked in flight in the same write that empties the live
    /// queue, so at no point are they absent from the table. Every drain has
    /// to be closed by a [`Self::settle`], or the next launch will replay it.
    pub fn drain(&mut self) -> Vec<PendingOp> {
        let ops = std::mem::take(&mut self.ops);
        self.taken.extend(ops.iter().cloned());
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
        self.taken.clear();
        self.persist();
    }

    /// id_map-style keys (`"clipboard:{id}"` / `"note:{id}"`) for every queued
    /// op, so the UI can mark those entries as still waiting to upload.
    ///
    /// Ops taken by a flush that has not settled count too: until the settle
    /// they are neither sent nor back in the queue.
    pub fn pending_keys(&self) -> Vec<String> {
        self.ops.iter().chain(&self.taken).filter_map(op_key).collect()
    }

    pub fn len(&self) -> usize {
        self.ops.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }
}

/// Replace the table with `taken` (in flight) followed by `ops`.
fn write_all(
    tx: &rusqlite::Transaction<'_>,
    taken: &[PendingOp],
    ops: &[PendingOp],
) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM sync_queue", [])?;
    let mut st = tx.prepare("INSERT INTO sync_queue (op, inflight) VALUES (?1, ?2)")?;
    for (op, inflight) in taken.iter().map(|o| (o, true)).chain(ops.iter().map(|o| (o, false))) {
        let json = serde_json::to_string(op)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        st.execute(rusqlite::params![json, inflight])?;
    }
    Ok(())
}

/// The id_map-style key one op is for.
fn op_key(op: &PendingOp) -> Option<String> {
    match op {
        PendingOp::Push { entry_json, entry_type } | PendingOp::Update { entry_json, entry_type } => {
            serde_json::from_str::<serde_json::Value>(entry_json)
                .ok()
                .and_then(|v| v.get("client_id").and_then(|c| c.as_str()).map(str::to_string))
                .map(|id| format!("{entry_type}:{id}"))
        }
        PendingOp::Delete { client_id, entry_type } | PendingOp::PushLocal { client_id, entry_type } => {
            Some(format!("{entry_type}:{client_id}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    /// and the settle, so for that moment the ops are in neither the live queue
    /// nor the server. Without the in-flight rows the tombstone is simply gone,
    /// and the entry comes back on the next pull.
    #[test]
    fn a_flush_that_never_settled_is_replayed_on_the_next_launch() {
        let db = Db::open_in_memory();
        let mut queue = PendingQueue::load(Arc::clone(&db));
        queue.push(delete_op("a"));
        queue.push(delete_op("b"));

        let taken = queue.drain();
        assert_eq!(taken.len(), 2);
        assert!(queue.is_empty(), "the live queue is emptied by a drain");

        // The process dies here - no settle.
        let recovered = PendingQueue::load(db);
        assert_eq!(ids(&recovered), vec!["a", "b"]);
    }

    /// Remove from cloud, then Upload: the unpush tombstone still queued must
    /// leave the table too, or the next launch replays it over the upload.
    #[test]
    fn an_accepted_push_supersedes_a_queued_delete_on_disk() {
        let db = Db::open_in_memory();
        let mut queue = PendingQueue::load(Arc::clone(&db));
        queue.push(delete_op("a"));
        queue.push(delete_op("b"));

        queue.supersede_delete("clipboard", "a");

        assert_eq!(ids(&PendingQueue::load(db)), vec!["b"]);
    }

    /// Its tombstone landed (memory only) while the rest of the batch is still
    /// out, then it was uploaded again: the table must lose that Delete now.
    #[test]
    fn a_push_after_a_landed_delete_writes_it_out() {
        let db = Db::open_in_memory();
        let mut queue = PendingQueue::load(Arc::clone(&db));
        queue.push_many(vec![delete_op("a"), delete_op("b")]);
        queue.remove_delete("clipboard", "a");

        queue.supersede_delete("clipboard", "a");

        assert_eq!(ids(&PendingQueue::load(db)), vec!["b"]);
    }

    #[test]
    fn settling_keeps_what_did_not_send_and_drops_the_rest() {
        let db = Db::open_in_memory();
        let mut queue = PendingQueue::load(Arc::clone(&db));
        queue.push(delete_op("sent"));
        queue.push(delete_op("failed"));

        queue.drain();
        queue.settle(vec![delete_op("failed")]);

        let reloaded = PendingQueue::load(db);
        assert_eq!(ids(&reloaded), vec!["failed"]);
    }

    /// An op queued while the flush was in the air is newer than one the flush
    /// could not send, and a tombstone that overtakes its own push would be a
    /// deletion for a row the server has never heard of.
    #[test]
    fn an_unsent_op_goes_back_ahead_of_anything_queued_since() {
        let db = Db::open_in_memory();
        let mut queue = PendingQueue::load(Arc::clone(&db));
        queue.push(delete_op("old"));

        queue.drain();
        queue.push(delete_op("arrived-during-flush"));
        queue.settle(vec![delete_op("old")]);

        assert_eq!(ids(&queue), vec!["old", "arrived-during-flush"]);
        let reloaded = PendingQueue::load(db);
        assert_eq!(ids(&reloaded), vec!["old", "arrived-during-flush"]);
    }

    /// A `PushLocal` carries only an id, so its pending key comes straight from
    /// the two fields - and it has to survive a restart, since the image it
    /// stands for cannot go up until the network is back.
    #[test]
    fn a_push_local_op_keys_and_persists() {
        let db = Db::open_in_memory();
        let mut queue = PendingQueue::load(Arc::clone(&db));
        queue.push(PendingOp::PushLocal {
            client_id: "img-1".to_string(),
            entry_type: "clipboard".to_string(),
        });
        assert_eq!(queue.pending_keys(), vec!["clipboard:img-1"]);

        let reloaded = PendingQueue::load(db);
        assert_eq!(reloaded.pending_keys(), vec!["clipboard:img-1"]);
        assert_eq!(reloaded.len(), 1);
    }

    /// A Clear all queues every tombstone before the first one leaves, so a
    /// quit in the middle of the fan-out replays the rest instead of letting
    /// those rows read as missing and come back in a restore.
    #[test]
    fn a_write_ahead_delete_survives_a_restart() {
        let db = Db::open_in_memory();
        let mut queue = PendingQueue::load(Arc::clone(&db));
        queue.push_many(vec![delete_op("a"), delete_op("b")]);

        let reloaded = PendingQueue::load(db);
        assert_eq!(ids(&reloaded), vec!["a", "b"]);
    }

    #[test]
    fn a_landed_delete_drops_only_its_own_op() {
        let mut queue = PendingQueue::load(Db::open_in_memory());
        queue.push_many(vec![
            PendingOp::Push {
                entry_json: r#"{"client_id":"a"}"#.to_string(),
                entry_type: "clipboard".to_string(),
            },
            delete_op("a"),
            delete_op("b"),
            PendingOp::Delete {
                client_id: "a".to_string(),
                entry_type: "note".to_string(),
            },
        ]);

        queue.remove_delete("clipboard", "a");

        assert_eq!(
            queue.pending_keys(),
            vec!["clipboard:a", "clipboard:b", "note:a"]
        );
    }

    #[test]
    fn push_many_keeps_order() {
        let mut queue = PendingQueue::load(Db::open_in_memory());
        queue.push(delete_op("first"));
        queue.push_many(vec![delete_op("second"), delete_op("third")]);
        assert_eq!(ids(&queue), vec!["first", "second", "third"]);
    }

    /// A flush takes every op out of memory before it sends them. Until the
    /// settle those keys must still read as queued, or the exit flush drops the
    /// entries they stand for.
    #[test]
    fn drained_ops_stay_pending_until_the_settle() {
        let mut queue = PendingQueue::load(Db::open_in_memory());
        queue.push(PendingOp::PushLocal {
            client_id: "img-1".to_string(),
            entry_type: "clipboard".to_string(),
        });
        queue.drain();
        assert!(queue.is_empty());
        assert_eq!(queue.pending_keys(), vec!["clipboard:img-1"]);
        queue.settle(Vec::new());
        assert!(queue.pending_keys().is_empty());
    }

    #[test]
    fn keys_in_reads_in_flight_and_live_rows_without_changing_them() {
        let db = Db::open_in_memory();
        let mut queue = PendingQueue::load(Arc::clone(&db));
        queue.push(delete_op("a"));
        queue.drain();
        queue.push(delete_op("b"));
        let mut keys = PendingQueue::keys_in(&db).unwrap();
        keys.sort();
        assert_eq!(keys, vec!["clipboard:a", "clipboard:b"]);
        let reloaded = PendingQueue::load(db);
        assert_eq!(ids(&reloaded), vec!["a", "b"], "in-flight first, then live");
    }

    #[test]
    fn a_settled_flush_leaves_no_inflight_rows_behind() {
        let db = Db::open_in_memory();
        let mut queue = PendingQueue::load(Arc::clone(&db));
        queue.push(delete_op("a"));
        queue.drain();
        let inflight = |db: &Db| -> i64 {
            db.read("count", |c| {
                c.query_row("SELECT count(*) FROM sync_queue WHERE inflight = 1", [], |r| r.get(0))
            })
            .unwrap()
        };
        assert_eq!(inflight(&db), 1, "the drain marks it");
        queue.settle(Vec::new());
        assert_eq!(inflight(&db), 0, "the settle removes it");
    }

    #[test]
    fn legacy_queue_files_import_in_flight_first() {
        let db = Db::open_in_memory();
        let dir = std::env::temp_dir().join(format!("rovertools-queue-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sync_pending.json");
        std::fs::write(&path, serde_json::to_vec(&[delete_op("live")]).unwrap()).unwrap();
        std::fs::write(
            path.with_extension("inflight.json"),
            serde_json::to_vec(&[delete_op("taken")]).unwrap(),
        )
        .unwrap();
        assert_eq!(PendingQueue::import_files(&db, &path).unwrap(), 2);
        assert_eq!(ids(&PendingQueue::load(db)), vec!["taken", "live"]);
    }
}
