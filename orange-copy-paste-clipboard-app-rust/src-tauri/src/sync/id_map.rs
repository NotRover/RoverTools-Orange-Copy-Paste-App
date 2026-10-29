//! Client-to-server ID mapping, persisted in the `sync_entries` table, one
//! row per entry key.
//!
//! Maps `"clipboard:{client_id}"` → `server_uuid` and
//!      `"note:{client_id}"`      → `server_uuid`.
//!
//! It is also this device's record of which clipboard entries are in the
//! cloud or a space, which is what keeps them across a restart with Keep
//! history off.
//!
//! Memory holds the maps below, keyed alike; the table holds the same facts
//! as one row per key. A mutation marks the keys it touched and
//! [`IdMap::persist`] writes those rows, so a method that changes several
//! keys still costs one transaction.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::storage::Db;

#[derive(Debug, Default, Serialize, Deserialize)]
struct IdMapData {
    #[serde(default)]
    entries: HashMap<String, String>,
    /// Space ids each entry is shared into, keyed like `entries`.
    /// Which space an entry belongs to is sync bookkeeping, not a user tag, so
    /// it lives here next to the server ids rather than in the entry model —
    /// history.bin is a compact (positional) MessagePack array, and it also
    /// keeps machine ids out of the group chips the user sees.
    #[serde(default)]
    entry_shares: HashMap<String, Vec<String>>,
    /// Entries another member wrote, keyed like `entries`. Set when the entry's
    /// content key could only be unwrapped through a space keyring — our own
    /// entries always carry a "personal" wrap, so they never land here. This is
    /// what lets a space row say whether an item came in or went out.
    #[serde(default)]
    remote_entries: HashSet<String>,
    /// Who wrote each entry, keyed like `entries`. Only recorded for entries
    /// that arrived from someone else — our own are implied by their absence,
    /// so this stays empty for a single-user account.
    #[serde(default)]
    entry_owners: HashMap<String, String>,
    /// When this device first saw each entry that arrived over the socket, by
    /// this machine's clock. Keyed like `entries`.
    ///
    /// Every timestamp on an entry is the wall clock of the device that wrote
    /// it, and nothing in the pipeline reconciles two machines' clocks. A
    /// sender running thirty seconds slow therefore produces an item that reads
    /// "30s ago" the instant it lands, and keeps reading thirty seconds older
    /// than it is forever after. This is the one time in the exchange that is
    /// certainly right, because it was read here.
    ///
    /// It cannot go on the entry itself: a note's `updated_at` decides
    /// last-write-wins, so moving it forward would make this device reject the
    /// sender's next edit. It is a display correction and it stays out of the
    /// fields the merge compares.
    #[serde(default)]
    entry_arrivals: HashMap<String, u64>,
    /// Entries this device deliberately took off the server while keeping the
    /// local copy - "Remove from cloud". Keyed like `entries`.
    ///
    /// A removal and a deletion look identical on the wire: both are a push
    /// with `deleted_at` set, because the server has no delete route. So the
    /// tombstone this device just pushed comes back on the next pull as an
    /// ordinary "this entry is deleted", and applying it wipes the local copy
    /// the action promised to keep. Echo suppression by `device_id` was meant
    /// to prevent that and cannot be relied on: the server records the device
    /// that *created* a row and never updates it, so any entry pushed before
    /// the current sign-in comes back wearing an older device's id. This set is
    /// the device's own record of what it meant, and it does not depend on the
    /// server agreeing.
    #[serde(default)]
    unpushed: HashSet<String>,
    /// Items removed from a space, keyed like `entries`.
    ///
    /// Two jobs. It is what the Spaces feed renders as a placeholder, so a
    /// removal reads as "this was taken down" rather than a row silently
    /// vanishing. And it suppresses re-merge: a member who removes an item they
    /// received never pushes a tombstone (that would delete it for everyone),
    /// so without a local record the next pull would hand it straight back.
    #[serde(default)]
    deleted_markers: HashMap<String, DeletedMarker>,
}

/// A removed item, kept after its content is gone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeletedMarker {
    /// Spaces the item was in when it went.
    pub space_ids: Vec<String>,
    /// Account that wrote it, when known.
    pub owner_id: Option<String>,
    /// When it was removed, ms since epoch.
    pub deleted_at: u64,
    /// True when its author removed it, false when a space owner took it down.
    pub by_author: bool,
    /// Whether the local copy went with it.
    ///
    /// A removal takes the item away and must never be merged back — the server
    /// still holds it, so every pull would offer it again. Leaving one space is
    /// not that: the item is still ours, still in other spaces, and still has
    /// to accept edits from our other devices. Both leave a placeholder in the
    /// feed; only this one blocks the merge.
    ///
    /// Defaults true so records written before the distinction existed keep
    /// their old meaning.
    #[serde(default = "yes")]
    pub content_gone: bool,
    /// True when this device dropped its own copy of someone else's item.
    ///
    /// Nothing happened in the space - the item is still there for everyone
    /// else, and its author still has it. Without this the placeholder read
    /// "taken down by a space owner", which is a different event entirely and
    /// not one that took place.
    #[serde(default)]
    pub local_only: bool,
    /// When the item itself was, ms since epoch.
    ///
    /// The feed places a row by its own timestamp, and a removal only ever had
    /// `deleted_at` - so a placeholder appeared under the day it was taken
    /// down rather than the day the item sat on, in a date group of its own
    /// with nothing around it to explain what it referred to. This is the
    /// item's own time, captured while the copy is still here to read it from.
    ///
    /// `None` on records written before it was kept; the feed falls back to
    /// `deleted_at` for those.
    #[serde(default)]
    pub entry_ts: Option<u64>,
    /// Account that removed it, when the removal said so.
    ///
    /// `by_author` is a relation between two ids computed elsewhere - on the
    /// wire, from a payload that may be missing a field, or from a server row
    /// whose author id came off an arbitrary matching row. Getting it wrong
    /// tells the reader a space owner moderated something they took down
    /// themselves. An id can be compared against our own, which is the one
    /// question the wording actually turns on.
    #[serde(default)]
    pub removed_by: Option<String>,
}

fn yes() -> bool {
    true
}

/// How long a removal stays in the Spaces feed: 30 days.
const PLACEHOLDER_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;

pub struct IdMap {
    data: IdMapData,
    db: Arc<Db>,
    /// Keys changed since the last [`Self::persist`].
    dirty: HashSet<String>,
}

/// Read every row into the maps.
fn read_all(conn: &rusqlite::Connection) -> rusqlite::Result<IdMapData> {
    let mut st = conn.prepare(
        "SELECT key, server_id, shares, remote, owner, arrival, unpushed, deleted_marker FROM sync_entries",
    )?;
    let mut data = IdMapData::default();
    let rows = st.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, bool>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, bool>(6)?,
            r.get::<_, Option<String>>(7)?,
        ))
    })?;
    for row in rows {
        let (key, server_id, shares, remote, owner, arrival, unpushed, marker) = row?;
        if let Some(id) = server_id {
            data.entries.insert(key.clone(), id);
        }
        if let Some(shares) = shares.and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok()) {
            if !shares.is_empty() {
                data.entry_shares.insert(key.clone(), shares);
            }
        }
        if remote {
            data.remote_entries.insert(key.clone());
        }
        if let Some(owner) = owner {
            data.entry_owners.insert(key.clone(), owner);
        }
        if let Some(at) = arrival {
            data.entry_arrivals.insert(key.clone(), at as u64);
        }
        if unpushed {
            data.unpushed.insert(key.clone());
        }
        if let Some(marker) = marker.and_then(|m| serde_json::from_str(&m).ok()) {
            data.deleted_markers.insert(key, marker);
        }
    }
    Ok(data)
}

/// Write the rows for `keys` from `data`: a key every map lacks loses its row.
fn write_keys<'a>(
    tx: &rusqlite::Transaction<'_>,
    data: &IdMapData,
    keys: impl Iterator<Item = &'a String>,
) -> rusqlite::Result<()> {
    let mut upsert = tx.prepare(
        "INSERT INTO sync_entries (key, server_id, shares, remote, owner, arrival, unpushed, deleted_marker)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(key) DO UPDATE SET server_id = excluded.server_id, shares = excluded.shares,
             remote = excluded.remote, owner = excluded.owner, arrival = excluded.arrival,
             unpushed = excluded.unpushed, deleted_marker = excluded.deleted_marker",
    )?;
    let mut delete = tx.prepare("DELETE FROM sync_entries WHERE key = ?1")?;
    for key in keys {
        let server_id = data.entries.get(key);
        let shares = data.entry_shares.get(key).filter(|s| !s.is_empty());
        let remote = data.remote_entries.contains(key);
        let owner = data.entry_owners.get(key);
        let arrival = data.entry_arrivals.get(key).map(|a| *a as i64);
        let unpushed = data.unpushed.contains(key);
        let marker = data.deleted_markers.get(key);
        let empty = server_id.is_none()
            && shares.is_none()
            && !remote
            && owner.is_none()
            && arrival.is_none()
            && !unpushed
            && marker.is_none();
        if empty {
            delete.execute([key])?;
            continue;
        }
        let shares_json = shares.and_then(|s| serde_json::to_string(s).ok());
        let marker_json = marker.and_then(|m| serde_json::to_string(m).ok());
        upsert.execute(params![key, server_id, shares_json, remote, owner, arrival, unpushed, marker_json])?;
    }
    Ok(())
}

impl IdMap {
    /// Load the map from the table.
    pub fn load(db: Arc<Db>) -> Self {
        let data = db.read("load id map", read_all).unwrap_or_default();
        let mut map = Self { data, db, dirty: HashSet::new() };
        // Also on startup, not only when the next removal arrives: an install
        // that stops removing things would otherwise keep its last batch for
        // good.
        map.prune_deleted(crate::sync::now_ms());
        if !map.dirty.is_empty() {
            map.persist();
        }
        map
    }

    /// The keep set read straight from the table, for the exit flush with sync
    /// off. `None` when the read failed, which keeps everything.
    pub fn keep_keys_in(db: &Db) -> Option<HashSet<String>> {
        let data = db.read("read id map keys", read_all)?;
        Some(Self { data, db: Arc::new(Db::open_in_memory_unchecked()), dirty: HashSet::new() }.keep_keys())
    }

    /// Move the old `id_map.json` into the table, once. Returns how many keys.
    pub fn import_file(db: &Db, path: &std::path::Path) -> Result<usize, String> {
        let data: IdMapData = match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e.to_string()),
        };
        let keys: HashSet<String> = data
            .entries
            .keys()
            .chain(data.entry_shares.keys())
            .chain(data.remote_entries.iter())
            .chain(data.entry_owners.keys())
            .chain(data.entry_arrivals.keys())
            .chain(data.unpushed.iter())
            .chain(data.deleted_markers.keys())
            .cloned()
            .collect();
        let count = keys.len();
        db.write("import id map", |tx| write_keys(tx, &data, keys.iter()))
            .ok_or_else(|| "id map rows did not land".to_string())?;
        Ok(count)
    }

    /// Mark a key as changed, for the next [`Self::persist`].
    fn touch(&mut self, key: &str) {
        self.dirty.insert(key.to_string());
    }

    /// Write the rows of every key changed since the last write.
    pub(crate) fn persist(&mut self) {
        if self.dirty.is_empty() {
            return;
        }
        let (data, dirty) = (&self.data, &self.dirty);
        if self.db.write("write id map", |tx| write_keys(tx, data, dirty.iter())).is_some() {
            self.dirty.clear();
        }
    }

    /// Drop everything. Every field here describes one account's view of the
    /// server — server ids, who wrote what, which spaces an entry is in, what
    /// was removed — and none of it survives a change of account. Carried over,
    /// it locks the new account out of its own entries: anything the previous
    /// account received stayed marked as someone else's, so it could not be
    /// edited, pushed or shared, and it wore a name from a person the new
    /// account has never met.
    pub fn reset(&mut self) {
        self.data = IdMapData::default();
        self.dirty.clear();
        self.db.write("reset id map", |tx| tx.execute("DELETE FROM sync_entries", []).map(|_| ()));
    }

    // ── Clipboard / Note entries ──────────────────────────────────

    pub fn set_entry(&mut self, client_id: &str, server_id: &str) {
        self.data
            .entries
            .insert(client_id.to_string(), server_id.to_string());
        // Back on the server, so a tombstone for it is a real deletion again.
        self.data.unpushed.remove(client_id);
        self.touch(client_id);
        self.persist();
    }

    pub fn get_server_id(&self, client_id: &str) -> Option<&str> {
        self.data.entries.get(client_id).map(String::as_str)
    }

    /// Keys of every entry the server has acknowledged.
    pub fn entry_keys(&self) -> Vec<String> {
        self.data.entries.keys().cloned().collect()
    }

    /// Keys of every entry any part of this record names: acknowledged by the
    /// server, shared into a space (a share still waiting for its space key has
    /// no server row yet), or received from another member. What the exit flush
    /// keeps with Keep history off. A received item from a space the user has
    /// since left is on no server this device can reach any more, so every
    /// field that names it counts, not only the server id.
    pub fn keep_keys(&self) -> HashSet<String> {
        self.data
            .entries
            .keys()
            .chain(self.data.entry_shares.keys())
            .chain(self.data.remote_entries.iter())
            .cloned()
            .collect()
    }

    pub fn remove_entry(&mut self, client_id: &str) {
        self.drop_copy(client_id);
        self.data.remote_entries.remove(client_id);
        self.data.entry_owners.remove(client_id);
        self.persist();
    }

    /// Drop this device's copy of an entry another member wrote, while keeping
    /// the record that they wrote it.
    ///
    /// [`Self::remove_entry`] is for an entry that is going away entirely, so
    /// it clears authorship too. Doing that here would make the item look like
    /// an ordinary local one that sync has never seen - which is exactly what
    /// "Upload" looks for, so the next bulk upload would publish someone else's
    /// item under this account and hand every member a rival copy.
    pub fn forget_received_copy(&mut self, client_id: &str) {
        self.drop_copy(client_id);
        self.persist();
    }

    /// What both removals above drop: the server id and this device's view of
    /// the copy. Authorship is left to the caller.
    fn drop_copy(&mut self, client_id: &str) {
        self.data.entries.remove(client_id);
        self.data.entry_shares.remove(client_id);
        self.data.entry_arrivals.remove(client_id);
        self.touch(client_id);
    }

    /// Record a delete made while sync is off, so the row does not come back
    /// when sync returns.
    ///
    /// No tombstone is ever sent for it: queued with no client, it would
    /// replay under whichever account signs in next. So the item stays on the
    /// server and on other devices, and this marker is what keeps it off this
    /// one. `local_only` exempts it from pruning, since the server keeps
    /// offering the row for good. An item this device has no record of in the
    /// cloud changes nothing.
    ///
    /// Memory only, so a Clear all writes once: returns whether the map
    /// changed, and the caller persists.
    pub fn mark_removed_offline(&mut self, key: &str, entry_ts: Option<u64>, queued: bool) -> bool {
        let remote = self.data.remote_entries.contains(key);
        if !(self.data.entries.contains_key(key) || remote || queued) {
            return false;
        }
        let marker = DeletedMarker {
            space_ids: self.shares_for(key),
            owner_id: self.owner_of(key),
            deleted_at: crate::sync::now_ms(),
            by_author: !remote,
            content_gone: true,
            local_only: true,
            entry_ts,
            removed_by: None,
        };
        self.data.deleted_markers.insert(key.to_string(), marker);
        // Like `forget_received_copy` for a received item, which keeps who
        // wrote it, and like `remove_entry` otherwise.
        self.drop_copy(key);
        if !remote {
            self.data.entry_owners.remove(key);
        }
        true
    }

    // ── Direction ─────────────────────────────────────────────────

    /// Record that `client_id` arrived from another member. Idempotent: only a
    /// first mark writes the file, so re-merging the same entry costs nothing.
    pub fn mark_entry_remote(&mut self, client_id: &str) {
        if self.data.remote_entries.insert(client_id.to_string()) {
            self.touch(client_id);
            self.persist();
        }
    }

    // ── Removed from the cloud, kept here ─────────────────────────

    /// Record that the user took this entry off the server on purpose and
    /// wants the local copy. Survives [`Self::remove_entry`], which runs on the
    /// same action to drop the now-meaningless server id.
    pub fn mark_unpushed(&mut self, client_id: &str) {
        if self.data.unpushed.insert(client_id.to_string()) {
            self.touch(client_id);
            self.persist();
        }
    }

    /// Forget that, because the entry is being deleted for real or has been
    /// uploaded again.
    pub fn clear_unpushed(&mut self, client_id: &str) {
        if self.data.unpushed.remove(client_id) {
            self.touch(client_id);
            self.persist();
        }
    }

    /// Whether a tombstone for this entry must leave the local copy alone.
    pub fn is_unpushed(&self, client_id: &str) -> bool {
        self.data.unpushed.contains(client_id)
    }

    /// Keys of every entry that came from another member.
    pub fn remote_entries(&self) -> Vec<String> {
        self.data.remote_entries.iter().cloned().collect()
    }

    /// Whether another member wrote this one.
    pub fn is_remote(&self, client_id: &str) -> bool {
        self.data.remote_entries.contains(client_id)
    }

    /// Keys of every entry this account wrote, of the ones this device knows
    /// about.
    ///
    /// The list any account-wide action must be built from. The obvious
    /// alternative - every key in `entries` - is wrong, because this map
    /// records what the device pushed *or pulled*, so it includes items other
    /// members shared into a space. Sweeping those took away the user's copy of
    /// someone else's item in an action that only promised to clear the server.
    pub fn owned_keys(&self) -> Vec<String> {
        self.data
            .entries
            .keys()
            .filter(|k| !self.data.remote_entries.contains(*k))
            .cloned()
            .collect()
    }

    /// Spaces one entry is shared into, without cloning the whole map.
    pub fn shares_for(&self, client_id: &str) -> Vec<String> {
        self.data
            .entry_shares
            .get(client_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Who wrote one entry, if it came from someone else.
    pub fn owner_of(&self, client_id: &str) -> Option<String> {
        self.data.entry_owners.get(client_id).cloned()
    }

    /// Record which account wrote `client_id`. Idempotent, for the same reason
    /// as `mark_entry_remote`: a re-merge must not rewrite the file.
    ///
    /// Sticky, unlike an ordinary map insert: once an author is on record, a
    /// later row naming somebody else does not get to replace them. An entry has
    /// exactly one author, and this used to be last-write-wins - so a second row
    /// carrying the same `client_id` under a different account (the shape a
    /// stray push leaves behind) would rename the entry to whoever pushed last,
    /// and pull order decided whose name a member saw.
    ///
    /// Returns whether the record now names `user_id`, so a caller can tell
    /// "agreed" from "refused".
    pub fn set_entry_owner(&mut self, client_id: &str, user_id: &str) -> bool {
        match self.data.entry_owners.get(client_id).map(String::as_str) {
            Some(existing) if existing == user_id => return true,
            Some(_) => return false,
            None => {}
        }
        self.data
            .entry_owners
            .insert(client_id.to_string(), user_id.to_string());
        self.touch(client_id);
        self.persist();
        true
    }

    /// Forget every recorded author, returning how many went.
    ///
    /// Run once per install, against records written before authorship was
    /// decided properly (see `SyncState::authorship_repaired`). Those were
    /// last-write-wins, so any of them may name whoever pushed last rather than
    /// whoever wrote the entry - and keeping a wrong one would now be worse than
    /// before, because the record is sticky: it would refuse the real author's
    /// next update as if *they* were the impostor.
    ///
    /// Nothing here can tell a good record from a bad one, so all of them go and
    /// the server re-establishes them on the backfill that follows.
    pub fn clear_all_entry_owners(&mut self) -> usize {
        let count = self.data.entry_owners.len();
        if count > 0 {
            let keys: Vec<String> = self.data.entry_owners.keys().cloned().collect();
            self.data.entry_owners.clear();
            self.dirty.extend(keys);
            self.persist();
        }
        count
    }

    /// Drop a recorded author, so the next row to arrive can establish one.
    ///
    /// Only used to undo the one state that cannot be true: this account named
    /// as the author of an entry that is also flagged as arriving from someone
    /// else. See `SyncClient::author_of`.
    pub fn clear_entry_owner(&mut self, client_id: &str) {
        if self.data.entry_owners.remove(client_id).is_some() {
            self.touch(client_id);
            self.persist();
        }
    }

    /// Owner account id per entry key, for the Spaces feed to resolve against
    /// the space's member list.
    /// Note the moment `client_id` reached this device, if it has not already
    /// been noted. Only a first arrival writes the file: an entry re-merged on
    /// every pull would otherwise keep resetting its own age to now.
    pub fn record_arrival(&mut self, client_id: &str, at: u64) {
        if !self.data.entry_arrivals.contains_key(client_id) {
            self.data.entry_arrivals.insert(client_id.to_string(), at);
            self.touch(client_id);
            self.persist();
        }
    }

    pub fn entry_arrivals(&self) -> HashMap<String, u64> {
        self.data.entry_arrivals.clone()
    }

    pub fn entry_owners(&self) -> HashMap<String, String> {
        self.data.entry_owners.clone()
    }

    // ── Removals ──────────────────────────────────────────────────

    /// Record that an item is gone, keeping enough to show a placeholder and to
    /// recognise it if the server offers it again.
    pub fn mark_deleted(&mut self, client_id: &str, marker: DeletedMarker) {
        let now = marker.deleted_at;
        self.data
            .deleted_markers
            .insert(client_id.to_string(), marker);
        self.touch(client_id);
        self.prune_deleted(now);
        self.persist();
    }

    /// Drop placeholders old enough that nobody is still asking what happened.
    ///
    /// Nothing else removed these, so a long-lived install accumulated one per
    /// item ever taken out of a space, forever. Age is the only fair measure —
    /// the feed shows them newest first and a months-old removal is history, not
    /// news.
    ///
    /// `local_only` records are exempt, and not for tidiness: they are the only
    /// ones still doing work. The item they name is still in the space, so pull
    /// keeps offering it, and the record is the sole reason it does not come
    /// back. The rest describe rows the server has already stopped handing us.
    fn prune_deleted(&mut self, now: u64) {
        let cutoff = now.saturating_sub(PLACEHOLDER_TTL_MS);
        let dirty = &mut self.dirty;
        self.data.deleted_markers.retain(|key, m| {
            let keep = m.local_only || m.deleted_at >= cutoff;
            if !keep {
                dirty.insert(key.clone());
            }
            keep
        });
    }

    /// One removal record, without cloning the whole map.
    pub fn deleted_marker(&self, client_id: &str) -> Option<DeletedMarker> {
        self.data.deleted_markers.get(client_id).cloned()
    }

    /// Every removal, for the Spaces feed's placeholders.
    pub fn deleted_markers(&self) -> HashMap<String, DeletedMarker> {
        self.data.deleted_markers.clone()
    }

    /// Drop a removal record. Used when the user clears the placeholders, and
    /// when the same item is deliberately captured again locally.
    pub fn clear_deleted(&mut self, client_id: &str) {
        if self.data.deleted_markers.remove(client_id).is_some() {
            self.touch(client_id);
            self.persist();
        }
    }

    /// Forget every removal in a space, for "clear removed items".
    ///
    /// One marker can name several spaces — an entry shared into three and then
    /// deleted leaves a placeholder in each. Clearing one space drops only that
    /// space's mention, so the other feeds keep theirs; the record goes when the
    /// last one does.
    pub fn clear_deleted_in_space(&mut self, space_id: &str) -> usize {
        let mut removed = 0usize;
        let dirty = &mut self.dirty;
        self.data.deleted_markers.retain(|key, m| {
            if !m.space_ids.iter().any(|s| s == space_id) {
                return true;
            }
            removed += 1;
            dirty.insert(key.clone());
            m.space_ids.retain(|s| s != space_id);
            !m.space_ids.is_empty()
        });
        if removed > 0 {
            self.persist();
        }
        removed
    }

    // ── Share membership ──────────────────────────────────────────

    /// Record which spaces an entry is shared into. An empty list drops the
    /// key, so an entry that stops being shared leaves nothing behind.
    pub fn set_entry_shares(&mut self, client_id: &str, space_ids: &[String]) {
        let changed = match self.data.entry_shares.get(client_id) {
            Some(existing) => existing.as_slice() != space_ids,
            None => !space_ids.is_empty(),
        };
        if !changed {
            return; // every push would otherwise write a row for nothing
        }
        self.touch(client_id);
        if space_ids.is_empty() {
            self.data.entry_shares.remove(client_id);
        } else {
            self.data
                .entry_shares
                .insert(client_id.to_string(), space_ids.to_vec());
        }
        // A marker records that this entry left a space. Putting it back into
        // one of those spaces is that removal being undone, so the placeholder
        // has to go — otherwise the feed shows the live row and "stopped
        // sharing this here" side by side, describing the same entry two ways.
        // A copy this device dropped on its own (`local_only`) is not that: the
        // entry never left the space, so nothing about it was undone.
        let stale = self
            .data
            .deleted_markers
            .get(client_id)
            .is_some_and(|m| !m.local_only && space_ids.iter().any(|s| m.space_ids.contains(s)));
        if stale {
            self.data.deleted_markers.remove(client_id);
        }
        self.persist();
    }

    /// The whole share map, for the Sync screen to match its feed against.
    pub fn entry_shares(&self) -> HashMap<String, Vec<String>> {
        self.data.entry_shares.clone()
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    /// A map backed by a private database, so `persist` is exercised rather
    /// than stubbed.
    fn map() -> IdMap {
        IdMap::load(Db::open_in_memory())
    }

    /// The same map read back through the table.
    fn reload(m: &IdMap) -> IdMap {
        IdMap::load(Arc::clone(&m.db))
    }

    /// Every field round-trips through its row, and a key with nothing left
    /// loses its row.
    #[test]
    fn rows_round_trip_every_field() {
        let mut m = map();
        m.set_entry("clipboard:a", "srv-1");
        m.set_entry_shares("clipboard:a", &["space-1".to_string()]);
        m.mark_entry_remote("clipboard:a");
        m.set_entry_owner("clipboard:a", "hasan");
        m.record_arrival("clipboard:a", 99);
        m.mark_unpushed("clipboard:b");
        let r = reload(&m);
        assert_eq!(r.get_server_id("clipboard:a"), Some("srv-1"));
        assert_eq!(r.shares_for("clipboard:a"), vec!["space-1"]);
        assert!(r.is_remote("clipboard:a"));
        assert_eq!(r.owner_of("clipboard:a").as_deref(), Some("hasan"));
        assert_eq!(r.entry_arrivals().get("clipboard:a"), Some(&99));
        assert!(r.is_unpushed("clipboard:b"));

        m.clear_unpushed("clipboard:b");
        let rows: i64 = m
            .db
            .read("count", |c| c.query_row("SELECT count(*) FROM sync_entries", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(rows, 1, "a key with nothing left has no row");
    }

    /// A share into a space whose key has not arrived has no server row, and a
    /// received item may have lost its row: both still name the entry.
    #[test]
    fn keep_keys_cover_shares_and_received_items() {
        let mut m = map();
        m.set_entry("clipboard:a", "srv-1");
        m.set_entry_shares("clipboard:b", &["space-1".to_string()]);
        m.mark_entry_remote("clipboard:c");
        let keys = m.keep_keys();
        for k in ["clipboard:a", "clipboard:b", "clipboard:c"] {
            assert!(keys.contains(k), "{k}");
        }
    }

    #[test]
    fn the_legacy_file_imports_every_map() {
        let db = Db::open_in_memory();
        let dir = std::env::temp_dir().join(format!("id_map_test_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("id_map.json");
        std::fs::write(
            &path,
            br#"{"entries":{"clipboard:a":"srv-1"},"remote_entries":["clipboard:b"],
                "unpushed":["clipboard:c"],"entry_owners":{"clipboard:b":"hasan"}}"#,
        )
        .unwrap();
        assert_eq!(IdMap::import_file(&db, &path).unwrap(), 3);
        let m = IdMap::load(db);
        assert_eq!(m.get_server_id("clipboard:a"), Some("srv-1"));
        assert!(m.is_remote("clipboard:b"));
        assert_eq!(m.owner_of("clipboard:b").as_deref(), Some("hasan"));
        assert!(m.is_unpushed("clipboard:c"));
    }

    /// A delete made with sync off: the row is forgotten and a marker that is
    /// never pruned blocks the server copy from merging back.
    #[test]
    fn an_offline_delete_blocks_the_row_coming_back() {
        let mut m = map();
        m.set_entry("clipboard:a", "srv-1");
        m.set_entry_shares("clipboard:a", &["space-1".to_string()]);

        assert!(m.mark_removed_offline("clipboard:a", Some(42), false));
        m.persist();

        assert!(m.get_server_id("clipboard:a").is_none());
        assert!(m.shares_for("clipboard:a").is_empty());
        let marker = m.deleted_marker("clipboard:a").expect("marker written");
        assert!(marker.local_only && marker.content_gone && marker.by_author);
        assert_eq!(marker.space_ids, vec!["space-1".to_string()]);
        assert_eq!(marker.entry_ts, Some(42));
        let reloaded = reload(&m);
        assert!(reloaded.deleted_marker("clipboard:a").is_some());
        assert!(reloaded.get_server_id("clipboard:a").is_none());
    }

    #[test]
    fn an_offline_delete_of_a_received_item_keeps_its_author() {
        let mut m = map();
        m.set_entry("clipboard:theirs", "srv-1");
        m.mark_entry_remote("clipboard:theirs");
        m.set_entry_owner("clipboard:theirs", "hasan");

        assert!(m.mark_removed_offline("clipboard:theirs", None, false));

        assert!(m.get_server_id("clipboard:theirs").is_none());
        assert!(m.is_remote("clipboard:theirs"));
        assert_eq!(m.owner_of("clipboard:theirs").as_deref(), Some("hasan"));
        let marker = m.deleted_marker("clipboard:theirs").expect("marker written");
        assert!(!marker.by_author);
        assert_eq!(marker.owner_id.as_deref(), Some("hasan"));
    }

    #[test]
    fn an_offline_delete_of_an_unknown_item_writes_nothing() {
        let mut m = map();
        assert!(
            !m.mark_removed_offline("clipboard:never-synced", Some(1), false),
            "nothing changed, so the caller writes nothing for it"
        );
        assert!(m.deleted_marker("clipboard:never-synced").is_none());
        assert!(m.dirty.is_empty());
    }

    /// Queued for upload but not acknowledged yet: the push still goes out when
    /// sync returns, so the marker has to be there to keep it off this device.
    #[test]
    fn an_offline_delete_of_a_queued_only_item_is_remembered() {
        let mut m = map();
        assert!(m.mark_removed_offline("note:queued", None, true));
        assert!(m.deleted_marker("note:queued").is_some_and(|d| d.local_only));
    }

    #[test]
    fn an_offline_marker_survives_pruning() {
        let mut m = map();
        m.set_entry("clipboard:a", "srv-1");
        m.mark_removed_offline("clipboard:a", None, false);

        // A removal far in the future makes every ordinary marker expire.
        let far = crate::sync::now_ms() + 10 * PLACEHOLDER_TTL_MS;
        m.mark_deleted(
            "clipboard:b",
            DeletedMarker {
                space_ids: vec!["space-1".to_string()],
                owner_id: None,
                deleted_at: far,
                by_author: true,
                content_gone: true,
                local_only: false,
                entry_ts: None,
                removed_by: None,
            },
        );

        assert!(m.deleted_marker("clipboard:a").is_some());
    }

    /// The rule an account-wide sweep depends on. `entries` holds what this
    /// device pushed *and* what it pulled, so the received ones have to come
    /// back out or a "remove everything of mine" action reaches them.
    #[test]
    fn owned_keys_leaves_out_what_other_members_wrote() {
        let mut m = map();
        m.set_entry("clipboard:mine", "srv-1");
        m.set_entry("clipboard:theirs", "srv-2");
        m.mark_entry_remote("clipboard:theirs");

        let owned = m.owned_keys();
        assert_eq!(owned, vec!["clipboard:mine".to_string()]);
    }

    /// An account with nothing of its own sweeps nothing, rather than falling
    /// back to "everything".
    #[test]
    fn owned_keys_is_empty_when_every_entry_was_received() {
        let mut m = map();
        m.set_entry("note:theirs", "srv-1");
        m.mark_entry_remote("note:theirs");
        assert!(m.owned_keys().is_empty());
    }

    /// Dropping our copy of someone else's item must not make it look like an
    /// unsynced local one, or the next bulk upload publishes it as ours.
    #[test]
    fn dropping_a_received_copy_keeps_the_author_on_record() {
        let mut m = map();
        m.set_entry("clipboard:theirs", "srv-1");
        m.mark_entry_remote("clipboard:theirs");
        m.set_entry_owner("clipboard:theirs", "hasan");

        m.forget_received_copy("clipboard:theirs");

        assert!(m.get_server_id("clipboard:theirs").is_none());
        assert!(m.is_remote("clipboard:theirs"));
        assert_eq!(m.owner_of("clipboard:theirs").as_deref(), Some("hasan"));
        assert!(m.owned_keys().is_empty());
    }

    /// The invariant behind "Remove from cloud keeps your copy". The action
    /// drops the server id on the same pass, so the record of what the user
    /// meant has to outlive that.
    #[test]
    fn removing_from_the_cloud_is_remembered_after_the_server_id_goes() {
        let mut m = map();
        m.set_entry("clipboard:a", "srv-1");
        m.mark_unpushed("clipboard:a");
        m.remove_entry("clipboard:a");
        assert!(m.is_unpushed("clipboard:a"));
    }

    /// Uploading it again puts it back under the ordinary rules: a tombstone
    /// after that is a real deletion and must be applied.
    #[test]
    fn uploading_again_makes_the_entry_deletable_again() {
        let mut m = map();
        m.mark_unpushed("clipboard:a");
        m.set_entry("clipboard:a", "srv-2");
        assert!(!m.is_unpushed("clipboard:a"));
    }

    /// And so does deleting it for real, which is what `clear_unpushed` is
    /// called for on the `ThisItem` path.
    #[test]
    fn deleting_for_real_clears_the_keep_it_here_record() {
        let mut m = map();
        m.mark_unpushed("note:a");
        m.clear_unpushed("note:a");
        assert!(!m.is_unpushed("note:a"));
    }

    #[test]
    fn the_first_author_on_record_keeps_the_entry() {
        let mut m = map();
        assert!(m.set_entry_owner("note:a", "hasan"));
        // A second account claiming the same entry is a rival row, not a
        // correction: the entry stays Hasan's and the caller is told it was
        // refused.
        assert!(!m.set_entry_owner("note:a", "spec"));
        assert_eq!(m.owner_of("note:a").as_deref(), Some("hasan"));
        // Repeating the real author is agreement, not a change.
        assert!(m.set_entry_owner("note:a", "hasan"));
    }

    #[test]
    fn clearing_an_author_lets_the_next_row_establish_one() {
        let mut m = map();
        m.set_entry_owner("note:a", "spec");
        m.clear_entry_owner("note:a");
        assert_eq!(m.owner_of("note:a"), None);
        assert!(m.set_entry_owner("note:a", "hasan"));
        assert_eq!(m.owner_of("note:a").as_deref(), Some("hasan"));
    }

    #[test]
    fn the_one_shot_rebuild_drops_every_recorded_author() {
        let mut m = map();
        m.set_entry_owner("note:a", "hasan");
        m.set_entry_owner("note:b", "spec");
        m.mark_entry_remote("note:a");
        assert_eq!(m.clear_all_entry_owners(), 2);
        assert_eq!(m.owner_of("note:a"), None);
        // The remote flag is not authorship and stays: it is the half that was
        // never wrong, and it is what keeps the permission guards honest while
        // the names are being rebuilt.
        assert!(m.is_remote("note:a"));
        // Whoever arrives first now establishes the author again.
        assert!(m.set_entry_owner("note:a", "hasan"));
    }

    #[test]
    fn removing_an_entry_forgets_who_wrote_it() {
        let mut m = map();
        m.set_entry("note:a", "srv-1");
        m.mark_entry_remote("note:a");
        m.set_entry_owner("note:a", "hasan");
        m.remove_entry("note:a");
        assert_eq!(m.owner_of("note:a"), None);
        assert!(!m.is_remote("note:a"));
    }
}
