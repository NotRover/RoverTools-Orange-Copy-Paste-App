//! Notification centre - the one place the app tells the user something
//! happened, whoever raised it.
//!
//! The store is a durable record of *what the user was told*, not a second copy
//! of the thing itself. An invite lives on the server and can be answered from
//! another device; the notification only remembers that this device surfaced
//! it, and is reconciled against the server's list (see
//! [`commands::notifications_refresh`]) rather than trusted on its own.

pub mod commands;
pub mod store;

pub use store::{Notification, NotificationKind, NotificationStore};
