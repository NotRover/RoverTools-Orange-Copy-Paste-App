//! Persists the sync cursor and device identity, as one JSON value under the
//! `sync_state` key of the `kv` table. The cursor (last_server_ts) drives
//! delta pull on startup and reconnect.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::storage::Db;

/// The `kv` key the state is stored under.
const KV_KEY: &str = "sync_state";

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct SyncState {
    /// Server timestamp of the last successfully merged entry.  Used as the
    /// `after_ts` cursor for the next pull request.
    pub last_server_ts: Option<u64>,
    /// Stable per-device UUID assigned by the server on first login.
    pub device_id: String,
    /// User UUID — used to scope the keychain entry and id_map lookups.
    pub user_id: String,
    /// Spaces whose back catalogue this device has already gone back for.
    ///
    /// An owner opening a space's history is announced over the socket, which
    /// only reaches members who are running at that moment. This is the durable
    /// half: a space that allows earlier items and is not listed here still owes
    /// this device a backfill, whenever it next signs in.
    #[serde(default)]
    pub history_backfilled: Vec<String>,
    /// `created_at` of the newest server announcement this device has been
    /// handed. Only newer ones are asked for, so dismissing one sticks instead
    /// of being undone by the next refresh.
    #[serde(default)]
    pub announcements_cursor: u64,
    /// This machine's last measured error against the server's clock, in ms.
    ///
    /// Kept so a launch starts corrected. The watcher captures whatever is on
    /// the clipboard within a second of startup, long before the first API
    /// response could measure anything, and the last known offset is a far
    /// better guess for those entries than assuming this machine is right.
    #[serde(default)]
    pub clock_offset_ms: i64,
    /// Spaces this device has already said "you can read this now" about.
    ///
    /// The keyring itself lives only in memory, so every launch unwraps it from
    /// scratch and every launch looks like the moment access arrived. This is
    /// the durable half of that question: gaining access is news once, and a
    /// restart is not it. Ids only - nothing here is key material.
    #[serde(default)]
    pub spaces_announced: Vec<String>,
    /// Whether this install has rebuilt its record of who wrote what.
    ///
    /// False on every install that predates the fix for bug #8. Those records
    /// were last-write-wins and may name the wrong account; they are dropped and
    /// rebuilt from a full pull exactly once, then this stays true.
    #[serde(default)]
    pub authorship_repaired: bool,
    /// SHA-256 (hex) of each normalized address this install has signed into
    /// with the split credential, or whose envelope it has opened in the split
    /// format. Once an address is here the raw password is never offered to
    /// Supabase for it again; see `SyncClient::perform_login`.
    #[serde(default)]
    pub auth_v2_seen: Vec<String>,
    /// Whether this device owes itself a restore sweep: set by every sign-in,
    /// by a blob download from a pull or live row that did not land, and by a
    /// space row that arrived before its key. Cleared once a sweep finishes.
    #[serde(default)]
    pub restore_owed: bool,
    /// `(missing, gap)` as counted right after the last sweep. A later count
    /// above either one means something went missing since, and sweeps again;
    /// counts that never come down (rows that cannot return) do not.
    #[serde(default)]
    pub restore_mark: (usize, usize),
    /// The roaming settings as they stood after this device's last settings
    /// sync. A key whose local value differs from this was changed here since,
    /// and wins over the account's copy; any other key takes the account's.
    /// `None` until the first sync, which therefore takes the account's values.
    #[serde(default)]
    pub settings_base: Option<serde_json::Map<String, serde_json::Value>>,
}

/// The address as it is recorded: hashed, so the state file names no account.
fn auth_v2_tag(email: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(email.trim().to_lowercase().as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

pub struct SyncStateStore {
    pub data: SyncState,
    db: Arc<Db>,
}

impl SyncStateStore {
    pub fn load(db: Arc<Db>) -> Self {
        let data = Self::read(&db).unwrap_or_default();
        Self { data, db }
    }

    fn read(db: &Db) -> Option<SyncState> {
        let json: Option<String> = db.read("load sync state", |c| {
            c.query_row("SELECT value FROM kv WHERE key = ?1", [KV_KEY], |r| r.get(0))
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other),
                })
        })?;
        json.and_then(|j| serde_json::from_str(&j).ok())
    }

    pub fn save(&self) {
        let Ok(json) = serde_json::to_string(&self.data) else {
            return;
        };
        self.db.write("write sync state", |tx| {
            tx.execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [KV_KEY, json.as_str()],
            )
            .map(|_| ())
        });
    }

    /// Move the old `sync_state.json` into the table, once.
    pub fn import_file(db: &Db, path: &std::path::Path) -> Result<bool, String> {
        let data: SyncState = match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(e) => return Err(e.to_string()),
        };
        let json = serde_json::to_string(&data).map_err(|e| e.to_string())?;
        db.write("import sync state", |tx| {
            tx.execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [KV_KEY, json.as_str()],
            )
            .map(|_| ())
        })
        .ok_or_else(|| "sync state did not land".to_string())?;
        Ok(true)
    }

    /// Advance the pull cursor and persist.
    pub fn set_last_server_ts(&mut self, ts: u64) {
        self.data.last_server_ts = Some(ts);
        self.save();
    }

    pub fn set_clock_offset_ms(&mut self, offset: i64) {
        if self.data.clock_offset_ms != offset {
            self.data.clock_offset_ms = offset;
            self.save();
        }
    }

    /// Rewind the pull cursor so the next sync re-reads the account from the
    /// start. Only for the one-shot authorship rebuild - ordinary syncing must
    /// never do this.
    pub fn rewind_for_authorship_repair(&mut self) {
        self.data.last_server_ts = None;
        self.data.authorship_repaired = true;
        self.save();
    }

    /// Advance the announcement watermark, keeping the highest seen.
    pub fn set_announcements_cursor(&mut self, ts: u64) {
        if ts <= self.data.announcements_cursor {
            return;
        }
        self.data.announcements_cursor = ts;
        self.save();
    }

    /// Record that the user has been told they can read a space. Returns false
    /// when they were already told, which is what suppresses the row on the next
    /// launch.
    /// Record that `email` is known to be on the split credential. Returns
    /// false when it already was.
    pub fn mark_auth_v2_seen(&mut self, email: &str) -> bool {
        let tag = auth_v2_tag(email);
        if self.data.auth_v2_seen.contains(&tag) {
            return false;
        }
        self.data.auth_v2_seen.push(tag);
        self.save();
        true
    }

    pub fn auth_v2_seen(&self, email: &str) -> bool {
        self.data.auth_v2_seen.contains(&auth_v2_tag(email))
    }

    pub fn mark_space_announced(&mut self, space_id: &str) -> bool {
        if self.data.spaces_announced.iter().any(|s| s == space_id) {
            return false;
        }
        self.data.spaces_announced.push(space_id.to_string());
        self.save();
        true
    }

    /// Record that this device has pulled a space's earlier items, so it does
    /// not sweep the whole account again on every launch. Returns false when the
    /// space was already recorded.
    pub fn mark_history_backfilled(&mut self, space_id: &str) -> bool {
        if self.data.history_backfilled.iter().any(|s| s == space_id) {
            return false;
        }
        self.data.history_backfilled.push(space_id.to_string());
        self.save();
        true
    }

    pub fn has_history_backfilled(&self, space_id: &str) -> bool {
        self.data.history_backfilled.iter().any(|s| s == space_id)
    }

    pub fn set_restore_owed(&mut self, owed: bool) {
        if self.data.restore_owed != owed {
            self.data.restore_owed = owed;
            self.save();
        }
    }

    pub fn set_restore_mark(&mut self, mark: (usize, usize)) {
        if self.data.restore_mark != mark {
            self.data.restore_mark = mark;
            self.save();
        }
    }

    pub fn set_settings_base(&mut self, base: serde_json::Map<String, serde_json::Value>) {
        if self.data.settings_base.as_ref() != Some(&base) {
            self.data.settings_base = Some(base);
            self.save();
        }
    }

    pub fn set_device_id(&mut self, id: &str) {
        self.data.device_id = id.to_string();
        self.save();
    }

    /// The account this device last signed in as, empty before the first one.
    pub fn user_id(&self) -> &str {
        &self.data.user_id
    }

    /// Forget everything that described the previous account's server state.
    ///
    /// The cursor is the dangerous one: it is a wall-clock server timestamp, so
    /// the account being signed into inherits a mark set roughly "now" and pulls
    /// only what is created from here on. Its whole back catalogue is older than
    /// that, so it silently never arrives. The backfill list is the same mistake
    /// in smaller form, and so is the restore mark: it counts the previous
    /// account's rows. The settings base is dropped too, so the new account's
    /// first settings sync takes its own blob instead of pushing this one's.
    ///
    /// `device_id` and `user_id` are left to the caller — it is about to write
    /// both for the account signing in.
    pub fn reset_for_new_account(&mut self) {
        self.data.last_server_ts = None;
        self.data.history_backfilled.clear();
        self.data.restore_mark = (0, 0);
        self.data.settings_base = None;
        self.save();
    }

    pub fn set_user_id(&mut self, id: &str) {
        self.data.user_id = id.to_string();
        self.save();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `sync_state.json` written by an older build still loads.
    ///
    /// `settings_updated_at` was dropped from this struct once nothing read it.
    /// Every installed copy still has the key on disk, and a loader that
    /// answers a parse failure with `Default::default()` *silently* would
    /// hand the account a blank `device_id`, a blank `user_id` and no cursor, so
    /// its whole back catalogue would never arrive. That failure is invisible at
    /// runtime, so it is pinned here instead.
    #[test]
    fn an_older_state_file_still_loads() {
        let old = r#"{
            "last_server_ts": 1723500000000,
            "device_id": "device-uuid",
            "user_id": "user-uuid",
            "settings_updated_at": 1723499999000,
            "history_backfilled": ["space-a"],
            "announcements_cursor": 7,
            "spaces_announced": ["space-b"],
            "authorship_repaired": true
        }"#;

        let state: SyncState = serde_json::from_str(old).expect("removed key must not fail parsing");

        assert_eq!(state.last_server_ts, Some(1723500000000));
        assert_eq!(state.device_id, "device-uuid");
        assert_eq!(state.user_id, "user-uuid");
        assert_eq!(state.history_backfilled, vec!["space-a".to_string()]);
        assert_eq!(state.announcements_cursor, 7);
        assert_eq!(state.spaces_announced, vec!["space-b".to_string()]);
        assert!(state.authorship_repaired);
        assert!(!state.restore_owed);
        assert_eq!(state.restore_mark, (0, 0));
        assert_eq!(state.settings_base, None);
    }

    /// The fields a fresh install has never written must also be optional, so a
    /// file predating them loads rather than resetting the identity above.
    #[test]
    fn a_state_file_missing_newer_fields_still_loads() {
        let ancient = r#"{"last_server_ts":null,"device_id":"d","user_id":"u"}"#;

        let state: SyncState = serde_json::from_str(ancient).expect("older shape must still parse");

        assert_eq!(state.device_id, "d");
        assert_eq!(state.user_id, "u");
        assert!(state.history_backfilled.is_empty());
        assert!(!state.authorship_repaired);
        assert!(!state.restore_owed);
        assert_eq!(state.restore_mark, (0, 0));
        assert_eq!(state.settings_base, None);
    }

    /// The mark counts one account's rows; carried into another it would hold
    /// back the sweep the new account's first gap should trigger.
    #[test]
    fn a_new_account_starts_with_a_clean_restore_mark() {
        let db = Db::open_in_memory();
        let mut store = SyncStateStore::load(Arc::clone(&db));
        store.set_restore_mark((12, 40));

        store.reset_for_new_account();

        assert_eq!(store.data.restore_mark, (0, 0));
        assert_eq!(SyncStateStore::load(db).data.restore_mark, (0, 0));
    }

    #[test]
    fn a_new_account_clears_the_settings_base() {
        let db = Db::open_in_memory();
        let mut store = SyncStateStore::load(Arc::clone(&db));
        let mut base = serde_json::Map::new();
        base.insert("theme".into(), serde_json::Value::from("dark"));
        store.set_settings_base(base);

        store.reset_for_new_account();

        assert_eq!(store.data.settings_base, None);
        assert_eq!(SyncStateStore::load(db).data.settings_base, None);
    }

    /// The cursor and identity survive a reopen through the table.
    #[test]
    fn state_round_trips_through_the_table() {
        let db = Db::open_in_memory();
        let mut store = SyncStateStore::load(Arc::clone(&db));
        store.set_user_id("u");
        store.set_device_id("d");
        store.set_last_server_ts(42);
        let again = SyncStateStore::load(db);
        assert_eq!(again.data.user_id, "u");
        assert_eq!(again.data.device_id, "d");
        assert_eq!(again.data.last_server_ts, Some(42));
    }

    #[test]
    fn the_legacy_state_file_imports() {
        let db = Db::open_in_memory();
        let dir = std::env::temp_dir().join(format!("rovertools-state-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sync_state.json");
        std::fs::write(&path, br#"{"last_server_ts":7,"device_id":"d","user_id":"u"}"#).unwrap();
        assert!(SyncStateStore::import_file(&db, &path).unwrap());
        assert_eq!(SyncStateStore::load(db).data.last_server_ts, Some(7));
    }
}
