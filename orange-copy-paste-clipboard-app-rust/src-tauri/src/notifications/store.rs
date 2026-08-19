//! Notification records and their MessagePack store.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

/// How long a read notification is kept before the store drops it.
///
/// The centre is a feed, not an archive: without a ceiling the file grows for
/// the life of the install and every launch pays to parse it. Unread items are
/// exempt at any age - the user has not seen them yet, so nothing here gets to
/// decide they no longer matter.
const READ_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// Hard cap on stored notifications, applied after the age sweep.
const MAX_STORED: usize = 500;

/// What raised the notification. Drives the icon, the filter chip it lands
/// under, and which actions the row offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationKind {
    /// Someone invited this user to a space.
    SpaceInvite,
    /// Something happened inside a space they are already in.
    SpaceActivity,
    /// Sync could not do something the user asked for.
    SyncWarning,
    /// A message written by the server: maintenance, an account notice.
    Announcement,
    /// A nudge about a state the user has left standing - a queue waiting on
    /// manual sync, storage filling up. Nothing happened; something is still
    /// true.
    Reminder,
}

impl NotificationKind {
    /// Map the server's `kind` string onto a variant.
    ///
    /// Unknown values become [`Self::Announcement`] rather than being dropped:
    /// the server may start naming a kind this build has never heard of, and
    /// showing the message under a general heading beats not showing it.
    pub fn from_wire(kind: &str) -> Self {
        match kind {
            "space_invite" => Self::SpaceInvite,
            "space_activity" => Self::SpaceActivity,
            "sync_warning" => Self::SyncWarning,
            "reminder" => Self::Reminder,
            _ => Self::Announcement,
        }
    }
}

/// One line in the notification centre.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    /// Stable and derived from the source (`invite:<invite_id>`), so ingesting
    /// the same server row twice updates one record instead of stacking copies.
    pub id: String,
    pub kind: NotificationKind,
    pub title: String,
    #[serde(default)]
    pub body: String,
    /// Unix epoch in milliseconds.
    pub created_at: u64,
    #[serde(default)]
    pub read: bool,
    /// Set once the notification can no longer be acted on, to the outcome in
    /// the user's words ("Joined", "Declined"). The row stays in the feed as
    /// history and drops its buttons.
    #[serde(default)]
    pub resolved: Option<String>,
    /// Kind-specific ids the UI needs to act (`invite_id`, `space_id`). Opaque
    /// to the store, which is what lets a new kind ship without touching it.
    #[serde(default)]
    pub data: BTreeMap<String, String>,
}

impl Notification {
    pub fn new(id: impl Into<String>, kind: NotificationKind, title: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            kind,
            title: title.into(),
            body: String::new(),
            created_at: crate::sync::now_ms(),
            read: false,
            resolved: None,
            data: BTreeMap::new(),
        }
    }

    pub fn with_body(mut self, body: impl Into<String>) -> Self {
        self.body = body.into();
        self
    }

    pub fn with_data(mut self, key: &str, value: impl Into<String>) -> Self {
        self.data.insert(key.to_string(), value.into());
        self
    }
}

/// In-memory feed, newest first, with MessagePack persistence.
#[derive(Debug, Default)]
pub struct NotificationStore {
    items: Vec<Notification>,
    /// Ids the user cleared by hand this session.
    ///
    /// Reconcile re-reads the server's invites on every panel open, so without
    /// this a cleared invite is put straight back and the clear looks like it
    /// did nothing. Not persisted: an invite still pending at the next launch
    /// is a question the user has yet to answer, so it is right to ask again.
    dismissed: HashSet<String>,
}

impl NotificationStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Everything currently in the feed, newest first.
    pub fn all(&self) -> &[Notification] {
        &self.items
    }

    pub fn unread_count(&self) -> usize {
        self.items.iter().filter(|n| !n.read).count()
    }

    /// Add a notification, or refresh the one already carrying that id.
    ///
    /// Re-ingesting is the normal case, not an error: the invite list is
    /// reconciled on every reconnect. An existing record keeps its `read` flag
    /// and its original `created_at` - the user was told when they were told,
    /// and a refresh must not push a row they have already seen back to the top
    /// of the feed as if it were new.
    ///
    /// Returns `true` when anything actually changed, so callers only persist
    /// and notify the UI on a real edit.
    pub fn upsert(&mut self, incoming: Notification) -> bool {
        if self.dismissed.contains(&incoming.id) {
            return false;
        }
        let Some(existing) = self.items.iter_mut().find(|n| n.id == incoming.id) else {
            self.items.push(incoming);
            self.sort_recent();
            return true;
        };
        // An outcome is final. Reconciling against the server re-ingests every
        // invite it still calls pending, and a list read a moment before the
        // answer landed says exactly that - so without this, accepting an
        // invite put its Join and Decline buttons straight back, and the one
        // that got pressed next reached an invite that was already answered.
        let resolved = incoming.resolved.or_else(|| existing.resolved.clone());
        if existing.title == incoming.title
            && existing.body == incoming.body
            && existing.resolved == resolved
            && existing.data == incoming.data
        {
            return false;
        }
        existing.title = incoming.title;
        existing.body = incoming.body;
        existing.resolved = resolved;
        existing.data = incoming.data;
        true
    }

    /// Upsert a rolling summary, where a change to the text *is* a new event.
    ///
    /// [`Self::upsert`] deliberately preserves `read` and `created_at`, which is
    /// right for a row that stands for one fixed thing. A summary that counts
    /// ("3 items were not sent") stands for a running total instead: once it
    /// moves, the user has not seen the new number, so the row goes back to
    /// unread and takes the time of the change.
    pub fn announce(&mut self, incoming: Notification) -> bool {
        let Some(existing) = self.items.iter_mut().find(|n| n.id == incoming.id) else {
            self.items.push(incoming);
            self.sort_recent();
            return true;
        };
        if existing.title == incoming.title && existing.body == incoming.body {
            return false;
        }
        existing.title = incoming.title;
        existing.body = incoming.body;
        existing.data = incoming.data;
        existing.created_at = incoming.created_at;
        existing.read = false;
        self.sort_recent();
        true
    }

    /// Retire a notification in place: it stops offering actions and reads as
    /// history. Used when an invite is answered, here or on another device.
    pub fn resolve(&mut self, id: &str, outcome: &str) -> bool {
        match self.items.iter_mut().find(|n| n.id == id) {
            Some(n) if n.resolved.as_deref() != Some(outcome) => {
                n.resolved = Some(outcome.to_string());
                true
            }
            _ => false,
        }
    }

    pub fn mark_read(&mut self, ids: &[String]) -> bool {
        let mut changed = false;
        for n in &mut self.items {
            if !n.read && ids.iter().any(|id| id == &n.id) {
                n.read = true;
                changed = true;
            }
        }
        changed
    }

    pub fn mark_all_read(&mut self) -> bool {
        let mut changed = false;
        for n in &mut self.items {
            if !n.read {
                n.read = true;
                changed = true;
            }
        }
        changed
    }

    /// Drop one notification for good.
    pub fn dismiss(&mut self, id: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|n| n.id != id);
        let removed = before != self.items.len();
        if removed {
            self.dismissed.insert(id.to_string());
        }
        removed
    }

    /// Drop everything the user has already read, leaving unread items alone.
    pub fn clear_read(&mut self) -> bool {
        let before = self.items.len();
        let (read, keep): (Vec<Notification>, Vec<Notification>) =
            std::mem::take(&mut self.items).into_iter().partition(|n| n.read);
        self.items = keep;
        for n in read {
            self.dismissed.insert(n.id);
        }
        before != self.items.len()
    }

    /// Forget the previous account's feed. Invites and space activity are
    /// addressed to a person, so signing in as someone else must not inherit
    /// them.
    pub fn reset(&mut self) {
        self.items.clear();
        self.dismissed.clear();
    }

    fn sort_recent(&mut self) {
        self.items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    }

    /// Age out read notifications and cap the total. Returns `true` if
    /// anything was removed.
    fn prune(&mut self, now: u64) -> bool {
        let before = self.items.len();
        let cutoff = now.saturating_sub(READ_TTL_MS);
        self.items.retain(|n| !n.read || n.created_at >= cutoff);
        if self.items.len() > MAX_STORED {
            // Newest first, so the tail is the oldest.
            self.items.truncate(MAX_STORED);
        }
        before != self.items.len()
    }

    /// Fold in notifications a sealed session captured while it could not read
    /// this file. Ids are stable and derived from the source, so "already
    /// there" means the same event, and the existing row wins.
    /// `None` means the bytes did not parse and the file is kept; `Some(0)`
    /// means it held nothing new and is safely redundant.
    pub fn merge_leftover(&mut self, bytes: &[u8]) -> Option<usize> {
        let Ok(items) = rmp_serde::from_slice::<Vec<Notification>>(bytes) else {
            return None;
        };
        let mut added = 0;
        for item in items {
            if self.dismissed.contains(&item.id) {
                continue;
            }
            if !self.items.iter().any(|n| n.id == item.id) {
                self.items.push(item);
                added += 1;
            }
        }
        if added > 0 {
            self.sort_recent();
            self.prune(crate::sync::now_ms());
        }
        Some(added)
    }

    // -- Persistence -------------------------------------------------

    /// Same shared read contract as the other stores: a missing file is an
    /// empty feed, a good load refreshes `.bak`, and a file that will not load
    /// is sealed with the backup shown instead.
    pub fn load_from_file(&mut self, path: &std::path::Path) -> Result<(), std::io::Error> {
        let parsed = crate::health::load_state(path, &|bytes| {
            rmp_serde::from_slice::<Vec<Notification>>(bytes).map_err(|e| e.to_string())
        })?;
        let Some(loaded) = parsed else {
            return Ok(());
        };
        self.items = loaded;
        self.sort_recent();
        self.prune(crate::sync::now_ms());
        Ok(())
    }

    pub fn save_to_file(&self, path: &std::path::Path) -> Result<(), std::io::Error> {
        let msgpack = rmp_serde::to_vec(&self.items).map_err(std::io::Error::other)?;
        crate::health::write_state(path, &msgpack)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cleared_invite_is_not_put_back_by_the_next_reconcile() {
        let mut store = NotificationStore::new();
        assert!(store.upsert(invite("1")));
        assert!(store.upsert(invite("2")));

        assert!(store.dismiss("invite:1"));

        // What a panel open does: re-read the server's still-pending invites.
        assert!(!store.upsert(invite("1")));
        assert!(!store.upsert(invite("2")));

        let ids: Vec<&str> = store.all().iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["invite:2"]);
    }

    fn invite(id: &str) -> Notification {
        Notification::new(
            format!("invite:{id}"),
            NotificationKind::SpaceInvite,
            "Design team",
        )
    }

    #[test]
    fn upsert_is_idempotent_and_keeps_read_state() {
        let mut store = NotificationStore::new();
        assert!(store.upsert(invite("a")));
        assert!(store.mark_all_read());
        // Re-ingesting the same server row must not resurrect it as unread.
        assert!(!store.upsert(invite("a")));
        assert_eq!(store.all().len(), 1);
        assert_eq!(store.unread_count(), 0);
    }

    #[test]
    fn resolve_retires_a_row_once() {
        let mut store = NotificationStore::new();
        store.upsert(invite("a"));
        assert!(store.resolve("invite:a", "Joined"));
        assert!(!store.resolve("invite:a", "Joined"));
    }

    #[test]
    fn an_answered_invite_stays_answered_when_the_server_still_calls_it_pending() {
        let mut store = NotificationStore::new();
        store.upsert(invite("a"));
        assert!(store.resolve("invite:a", "Joined"));
        // What a reconcile does with a list read just before the answer landed.
        assert!(!store.upsert(invite("a")));
        assert_eq!(store.all()[0].resolved.as_deref(), Some("Joined"));
    }

    #[test]
    fn announce_reopens_a_read_summary_only_when_its_text_moves() {
        let mut store = NotificationStore::new();
        let mut first = invite("s");
        first.body = "1 item".into();
        store.announce(first.clone());
        store.mark_all_read();

        assert!(!store.announce(first.clone()));
        assert_eq!(store.unread_count(), 0);

        let mut second = first;
        second.body = "2 items".into();
        second.created_at += 5;
        assert!(store.announce(second));
        assert_eq!(store.unread_count(), 1);
        assert_eq!(store.all()[0].body, "2 items");
    }

    #[test]
    fn prune_ages_out_read_items_but_never_unread_ones() {
        let mut store = NotificationStore::new();
        let now = 10 * READ_TTL_MS;
        for (id, read) in [("old-read", true), ("old-unread", false)] {
            let mut n = invite(id);
            n.created_at = now - READ_TTL_MS - 1;
            n.read = read;
            store.upsert(n);
        }
        assert!(store.prune(now));
        assert_eq!(store.all().len(), 1);
        assert_eq!(store.all()[0].id, "invite:old-unread");
    }
}
