//! Client-to-server ID mapping, persisted to `{app_data}/id_map.json`.
//!
//! Maps `"clipboard:{client_id}"` → `server_uuid` and
//!      `"note:{client_id}"`      → `server_uuid`.
//!
//! Losing this file is safe — the server deduplicates by `client_id` on the
//! next push, so nothing is lost permanently.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

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
}

fn yes() -> bool {
    true
}

/// How long a removal stays in the Spaces feed: 30 days.
const PLACEHOLDER_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;

pub struct IdMap {
    data: IdMapData,
    path: PathBuf,
}

impl IdMap {
    pub fn load(path: PathBuf) -> Self {
        let data = crate::sync::persist::load_json(&path);
        let mut map = Self { data, path };
        // Also on startup, not only when the next removal arrives: an install
        // that stops removing things would otherwise keep its last batch for
        // good.
        let before = map.data.deleted_markers.len();
        map.prune_deleted(crate::sync::now_ms());
        if map.data.deleted_markers.len() != before {
            map.persist();
        }
        map
    }

    fn persist(&self) {
        crate::sync::persist::save_json(&self.path, &self.data);
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
        self.persist();
    }

    // ── Clipboard / Note entries ──────────────────────────────────

    pub fn set_entry(&mut self, client_id: &str, server_id: &str) {
        self.data
            .entries
            .insert(client_id.to_string(), server_id.to_string());
        // Back on the server, so a tombstone for it is a real deletion again.
        self.data.unpushed.remove(client_id);
        self.persist();
    }

    pub fn get_server_id(&self, client_id: &str) -> Option<&str> {
        self.data.entries.get(client_id).map(String::as_str)
    }

    /// Keys of every entry the server has acknowledged.
    pub fn entry_keys(&self) -> Vec<String> {
        self.data.entries.keys().cloned().collect()
    }

    pub fn get_client_id_by_server(&self, server_id: &str) -> Option<String> {
        self.data
            .entries
            .iter()
            .find(|(_, v)| v.as_str() == server_id)
            .map(|(k, _)| k.clone())
    }

    pub fn remove_entry(&mut self, client_id: &str) {
        self.data.entries.remove(client_id);
        self.data.entry_shares.remove(client_id);
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
        self.data.entries.remove(client_id);
        self.data.entry_shares.remove(client_id);
        self.persist();
    }

    // ── Direction ─────────────────────────────────────────────────

    /// Record that `client_id` arrived from another member. Idempotent: only a
    /// first mark writes the file, so re-merging the same entry costs nothing.
    pub fn mark_entry_remote(&mut self, client_id: &str) {
        if self.data.remote_entries.insert(client_id.to_string()) {
            self.persist();
        }
    }

    // ── Removed from the cloud, kept here ─────────────────────────

    /// Record that the user took this entry off the server on purpose and
    /// wants the local copy. Survives [`Self::remove_entry`], which runs on the
    /// same action to drop the now-meaningless server id.
    pub fn mark_unpushed(&mut self, client_id: &str) {
        if self.data.unpushed.insert(client_id.to_string()) {
            self.persist();
        }
    }

    /// Forget that, because the entry is being deleted for real or has been
    /// uploaded again.
    pub fn clear_unpushed(&mut self, client_id: &str) {
        if self.data.unpushed.remove(client_id) {
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
            self.data.entry_owners.clear();
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
            self.persist();
        }
    }

    /// Owner account id per entry key, for the Spaces feed to resolve against
    /// the space's member list.
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
        self.data
            .deleted_markers
            .retain(|_, m| m.local_only || m.deleted_at >= cutoff);
    }

    /// Whether this item was taken away here, as opposed to merely leaving a
    /// space. Only the first blocks a re-merge.
    pub fn is_deleted(&self, client_id: &str) -> bool {
        self.data
            .deleted_markers
            .get(client_id)
            .is_some_and(|m| m.content_gone)
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
        self.data.deleted_markers.retain(|_, m| {
            if !m.space_ids.iter().any(|s| s == space_id) {
                return true;
            }
            removed += 1;
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
            return; // every push would otherwise rewrite the file for nothing
        }
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

    pub fn remove_entry_by_server_id(&mut self, server_id: &str) -> Option<String> {
        let key = self
            .data
            .entries
            .iter()
            .find(|(_, v)| v.as_str() == server_id)
            .map(|(k, _)| k.clone())?;
        self.data.entries.remove(&key);
        self.data.entry_shares.remove(&key);
        self.data.remote_entries.remove(&key);
        self.data.entry_owners.remove(&key);
        self.persist();
        Some(key)
    }
}

/// Derive the path for id_map.json given an app_data directory.
pub fn id_map_path(app_data: &Path) -> PathBuf {
    app_data.join("id_map.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A map backed by a path in a temp dir, so `persist` is exercised rather
    /// than stubbed.
    fn map() -> IdMap {
        let dir = std::env::temp_dir().join(format!("id_map_test_{}", crate::sync::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        IdMap::load(dir.join("id_map.json"))
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
