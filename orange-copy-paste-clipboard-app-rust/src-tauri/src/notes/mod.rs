//! Notes module – persistent note storage with group tagging.

pub mod commands;
pub mod store;

pub use store::{Note, NoteStore};
