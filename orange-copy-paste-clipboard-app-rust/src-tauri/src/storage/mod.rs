//! The local store: one SQLite database, `{app_data}/app.db`.
//!
//! Every durable thing the app owns that is not a blob on disk lives here -
//! clipboard history, notes, the notification feed and the sync engine's
//! bookkeeping. Each in-memory store keeps its own shape and writes its rows
//! through as it mutates, so the database is never behind memory by more than
//! the statement in flight, and a crash loses nothing that was acknowledged.
//!
//! Plain SQL on purpose: nothing here depends on a feature another SQLite-
//! compatible engine lacks, so the engine is a dependency swap.

pub mod db;
pub mod import;
pub mod schema;

pub use db::Db;

/// File name of the database inside app_data.
pub const DB_FILE: &str = "app.db";
