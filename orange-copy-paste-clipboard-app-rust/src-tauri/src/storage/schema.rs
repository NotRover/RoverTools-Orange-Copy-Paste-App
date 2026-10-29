//! Schema versions. `PRAGMA user_version` names the one a file is at; each
//! step below takes it one version forward inside the caller's transaction.
//!
//! Rules: never edit a shipped step, add the next one. Columns are nullable or
//! defaulted so a step is one `ALTER TABLE ... ADD COLUMN` where it can be.

use rusqlite::Connection;

/// The version this build writes.
pub const CURRENT: u32 = 1;

const V1: &str = "
CREATE TABLE entries (
    id       TEXT PRIMARY KEY,
    kind     TEXT NOT NULL,
    content  TEXT NOT NULL,
    ts       INTEGER NOT NULL,
    pinned   INTEGER NOT NULL DEFAULT 0,
    label    TEXT,
    groups   TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX entries_ts ON entries (ts DESC);

CREATE TABLE notes (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    pinned     INTEGER NOT NULL DEFAULT 0,
    groups     TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE notifications (
    id         TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    read       INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL
);

CREATE TABLE sync_entries (
    key            TEXT PRIMARY KEY,
    server_id      TEXT,
    shares         TEXT,
    remote         INTEGER NOT NULL DEFAULT 0,
    owner          TEXT,
    arrival        INTEGER,
    unpushed       INTEGER NOT NULL DEFAULT 0,
    deleted_marker TEXT
);

CREATE TABLE sync_queue (
    seq      INTEGER PRIMARY KEY AUTOINCREMENT,
    op       TEXT NOT NULL,
    inflight INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_work (
    key  TEXT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (key, kind)
);

CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

/// Bring `conn` from whatever version it is at to [`CURRENT`]. Runs inside a
/// transaction the caller owns, so a step that fails leaves the file as it was.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let mut version: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version > CURRENT {
        return Err(rusqlite::Error::InvalidQuery);
    }
    while version < CURRENT {
        match version {
            0 => conn.execute_batch(V1)?,
            _ => unreachable!("every version below CURRENT has a step"),
        }
        version += 1;
        conn.pragma_update(None, "user_version", version)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_file_reaches_current_and_stays_there() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let v: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, CURRENT);
        migrate(&conn).unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM sqlite_master WHERE name = 'entries'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn a_newer_file_is_refused() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", CURRENT + 1).unwrap();
        assert!(migrate(&conn).is_err());
    }
}
