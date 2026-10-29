//! The one connection to `app.db`, and the three ways to use it.
//!
//! One connection per process, behind a mutex. SQLite serialises writers
//! anyway, and a single connection means the page cache is shared and WAL
//! checkpoints never contend with a second handle. Every store takes its own
//! lock first and this one second, briefly, for the statements of one
//! mutation; nothing holds this lock while taking a store's.
//!
//! Failures are reported, never raised: a store method that cannot write still
//! updates memory, so the app keeps working with what it has, and the health
//! layer tells the user that saving has stopped once that lasts. That is the
//! same contract the file writes had, with one difference in what a failure
//! costs - a row, not the file.

use parking_lot::Mutex;
use rusqlite::{Connection, OpenFlags, Transaction};
use std::path::Path;
use std::sync::Arc;

pub struct Db {
    conn: Mutex<Connection>,
}

impl std::fmt::Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Db")
    }
}

impl Db {
    /// Open or create the database at `path` and bring its schema up to date.
    ///
    /// WAL so a write is an append and readers never wait on it; `synchronous`
    /// FULL so a committed transaction is on the platter, which is what the file
    /// stores promised before; `temp_store` MEMORY so a sort or a temp table
    /// never spills plaintext beside an encrypted file.
    pub fn open(path: &Path) -> Result<Arc<Self>, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(path, flags).map_err(|e| e.to_string())?;
        Self::init(conn)
    }

    /// A private, empty database. For tests, and for the session-only fallback
    /// when the file will not open.
    pub fn open_in_memory() -> Arc<Self> {
        Self::init(Connection::open_in_memory().expect("in-memory sqlite")).expect("schema")
    }

    /// [`Self::open_in_memory`] for a value that only needs a database to
    /// exist, never to hold anything. Same thing, named for the one use.
    pub fn open_in_memory_unchecked() -> Self {
        Arc::try_unwrap(Self::open_in_memory()).unwrap_or_else(|_| unreachable!("fresh Arc"))
    }

    fn init(conn: Connection) -> Result<Arc<Self>, String> {
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA foreign_keys = ON;
             PRAGMA temp_store = MEMORY;",
        )
        .map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        super::schema::migrate(&tx).map_err(|e| format!("schema: {e}"))?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(Arc::new(Self { conn: Mutex::new(conn) }))
    }

    /// Rebuild the file from its live rows and truncate the WAL, so pages that
    /// held rows since rewritten (the plaintext from before encryption at rest
    /// was turned on) are gone from disk. Best effort; a failure is logged.
    pub fn compact(&self) {
        let conn = self.conn.lock();
        if let Err(e) = conn.execute_batch("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);") {
            log::warn!(target: "storage", "compact: {e}");
        }
    }

    /// Run a read. `None` when it failed; the failure is logged.
    pub fn read<T>(&self, what: &str, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Option<T> {
        let conn = self.conn.lock();
        match f(&conn) {
            Ok(v) => Some(v),
            Err(e) => {
                crate::health::note("storage read failed", &format!("  {what}: {e}"));
                None
            }
        }
    }

    /// Run one or more statements as a single write. Wrapped in a transaction,
    /// so a mutation that touches two tables lands whole or not at all. The
    /// outcome feeds the health layer's write notice either way.
    pub fn write<T>(&self, what: &str, f: impl FnOnce(&Transaction) -> rusqlite::Result<T>) -> Option<T> {
        let mut conn = self.conn.lock();
        let result = conn.transaction().and_then(|tx| {
            let v = f(&tx)?;
            tx.commit()?;
            Ok(v)
        });
        match result {
            Ok(v) => {
                crate::health::note_store_write_ok();
                Some(v)
            }
            Err(e) => {
                crate::health::note_store_write_failed(what, &e.to_string());
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_write_rolls_back_whole() {
        let db = Db::open_in_memory();
        let r = db.write("two inserts, second bad", |tx| {
            tx.execute("INSERT INTO kv (key, value) VALUES ('a', '1')", [])?;
            tx.execute("INSERT INTO kv (key, value) VALUES ('a', '2')", [])?;
            Ok(())
        });
        assert!(r.is_none());
        let n: i64 = db
            .read("count", |c| c.query_row("SELECT count(*) FROM kv", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn a_file_database_reopens_at_the_same_version() {
        let dir = std::env::temp_dir().join(format!("ocp-db-{}", uuid::Uuid::new_v4()));
        let path = dir.join("app.db");
        {
            let db = Db::open(&path).unwrap();
            db.write("seed", |tx| tx.execute("INSERT INTO kv VALUES ('k', 'v')", []).map(|_| ()));
        }
        let db = Db::open(&path).unwrap();
        let v: String = db
            .read("get", |c| c.query_row("SELECT value FROM kv WHERE key = 'k'", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(v, "v");
    }
}
