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
    /// Provider avatar URL (Google), or `None` — the UI falls back to initials.
    /// Defaulted so a payload written before this field existed still loads.
    #[serde(default)]
    pub avatar_url: Option<String>,
}

// ── Groups (pool) ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncGroupMember {
    pub user_id: String,
    pub display_name: String,
    /// Provider avatar URL (Google), or `None` — the UI falls back to initials.
    /// Defaulted so a payload written before this field existed still loads.
    #[serde(default)]
    pub avatar_url: Option<String>,
    pub role: String,
    /// False until the owner has wrapped the Group Key for this member —
    /// the UI shows "waiting for key" instead of silent decrypt failures.
    pub has_group_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncGroup {
    pub id: String,
    pub name: String,
    pub owner_id: String,
    /// True when the current user owns this group (may invite/remove/delete).
    pub is_owner: bool,
    pub share_history: bool,
    pub member_count: u32,
    pub members: Vec<SyncGroupMember>,
    /// Present after create / for owners; used to share the group.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_expires_at: Option<u64>,
}

// ── Blob quota ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncQuota {
    pub used_bytes: u64,
    pub quota_bytes: u64,
}

// ── Devices (presence UI) ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncDevice {
    pub id: String,
    pub device_name: String,
    pub platform: String,
    pub app_version: String,
    pub last_seen_at: u64,
    /// Presence snapshot from the server; the UI keeps it fresh via WS events.
    pub online: bool,
    /// True when this row is the device the app is running on.
    pub is_current: bool,
}

// ── Sync status info ────────────────────────────────────────────────

/// One entry sync refused to send, and why.  The count alone told the user
/// something was wrong without telling them what, so every skip records the
/// entry it happened to and a reason short enough to show verbatim.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkippedEntry {
    pub client_id: String,
    /// Short label for the entry ("Screenshot", a text preview, a file name).
    pub label: String,
    /// User-facing explanation, e.g. "File is 12.4 MB - the limit is 5 MB".
    pub reason: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(Default)]
pub struct SyncStatusInfo {
    pub connected: bool,
    pub last_synced_at: Option<u64>,
    pub pending_count: usize,
    pub skipped_count: usize,
    /// Most recent skips, newest first (capped — see `SKIPPED_HISTORY_LIMIT`).
    #[serde(default)]
    pub skipped: Vec<SkippedEntry>,
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
    /// Parse the wire string ("clipboard" | "notes" | "both").
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "clipboard" => Some(Self::Clipboard),
            "notes" => Some(Self::Notes),
            "both" => Some(Self::Both),
            _ => None,
        }
    }

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
    /// Provider avatar URL (Google), or `None` — the UI falls back to initials.
    /// Defaulted so a payload written before this field existed still loads.
    #[serde(default)]
    pub avatar_url: Option<String>,
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
