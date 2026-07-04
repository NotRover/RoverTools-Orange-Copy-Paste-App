//! Shared types for the cloud sync module.

use serde::{Deserialize, Serialize};

// ── Sync status per entry ───────────────────────────────────────────

/// Tracks whether a clipboard entry or note has been pushed to the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum SyncStatus {
    /// Pushed and confirmed by the server (server_id is set).
    Synced,
    /// Queued in sync_pending.json, waiting for connectivity.
    Pending,
    /// Sync disabled or entry predates sync enrollment.
    #[default]
    LocalOnly,
}


// ── User & auth ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncUser {
    pub user_id: String,
    pub email: String,
    pub display_name: String,
}

// ── Groups (pool) ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncGroup {
    pub id: String,
    pub name: String,
    pub member_count: u32,
}

// ── Sync status info ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(Default)]
pub struct SyncStatusInfo {
    pub connected: bool,
    pub last_synced_at: Option<u64>,
    pub pending_count: usize,
    pub skipped_count: usize,
}


// ── Live Share (real-time cross-user sharing) ────────────────────────

/// What a user contributes to a Live Share group.
/// The sender's scope determines which entries flow through the group —
/// the receiver gets whatever the sender contributes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShareScope {
    Clipboard,
    Notes,
    Both,
}

impl ShareScope {
    pub fn includes_clipboard(self) -> bool {
        matches!(self, Self::Clipboard | Self::Both)
    }

    pub fn includes_notes(self) -> bool {
        matches!(self, Self::Notes | Self::Both)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Clipboard => "clipboard",
            Self::Notes => "notes",
            Self::Both => "both",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMember {
    pub user_id: String,
    pub display_name: String,
    pub email: String,
    pub scope: ShareScope,
    pub online: bool,
}

/// An active Live Share session (group_type = 'live_share', max 5 members).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharingSession {
    pub share_group_id: String,
    pub name: String,
    pub my_scope: ShareScope,
    pub members: Vec<SessionMember>,
    /// 32-byte Group Key for this session. Never serialized to disk.
    #[serde(skip)]
    pub group_key: Option<[u8; 32]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharingInvite {
    pub invite_code: String,
    pub share_group_id: String,
    /// Unix ms when this invite expires.
    pub expires_at: u64,
}

// ── Entry type discriminator ─────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryType {
    Clipboard,
    Notes,
}

impl EntryType {
    /// Backend wire discriminator — `"clipboard"` or `"note"` (singular).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Clipboard => "clipboard",
            Self::Notes => "note",
        }
    }
}
