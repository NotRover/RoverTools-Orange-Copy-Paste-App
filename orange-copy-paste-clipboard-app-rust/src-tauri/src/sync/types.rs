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

// ── Cloud sync mode ─────────────────────────────────────────────────

/// How personal entries from other devices are applied on this device.
/// Spaces are realtime regardless — this only governs the user's own backup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SyncMode {
    /// Apply WebSocket-delivered personal entries the moment they arrive.
    #[default]
    Realtime,
    /// Skip live application; a periodic pull (and Sync now) picks them up.
    /// Pushes still happen immediately — passive never risks the backup.
    Passive,
    /// Nothing personal moves on its own. Captures and edits queue instead of
    /// uploading, nothing is pulled on a timer, and Sync now is what sends and
    /// fetches. Spaces are unaffected: anything addressed to one still goes out
    /// live, and what other people share still arrives live.
    Manual,
}

impl SyncMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "realtime" => Some(Self::Realtime),
            "passive" => Some(Self::Passive),
            "manual" => Some(Self::Manual),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Realtime => "realtime",
            Self::Passive => "passive",
            Self::Manual => "manual",
        }
    }
}

// ── Spaces (the one shared primitive) ───────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceMember {
    pub user_id: String,
    pub display_name: String,
    /// Provider avatar URL (Google), or `None` — the UI falls back to initials.
    #[serde(default)]
    pub avatar_url: Option<String>,
    pub role: String,
    /// False until the owner has wrapped the Space Key for this member —
    /// the UI shows "waiting for key" instead of silent decrypt failures.
    pub has_space_key: bool,
    /// Presence snapshot from the server; the UI keeps it fresh via WS events.
    pub online: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Space {
    pub id: String,
    pub name: String,
    pub owner_id: String,
    /// True when the current user owns this space (may invite/remove/delete).
    pub is_owner: bool,
    pub share_history: bool,
    pub member_count: u32,
    pub members: Vec<SpaceMember>,
    /// Present after create / for owners; used to share the space.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_expires_at: Option<u64>,
}

/// Per-space send filter: which of the user's entries auto-flow into the
/// space. Lives in the encrypted settings blob (roams across devices; the
/// server never sees it — it names plaintext local groups). Disabled means
/// explicit shares only, the default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SendFilter {
    #[serde(default)]
    pub enabled: bool,
    /// Entry kinds that flow ("text", "image", "file", "html"...); empty = all.
    #[serde(default)]
    pub kinds: Vec<String>,
    /// Local group names that flow; empty = all.
    #[serde(default)]
    pub groups: Vec<String>,
    /// "clipboard" | "notes" | "both" — which content types flow.
    #[serde(default = "SendFilter::default_content")]
    pub content: String,
}

impl SendFilter {
    fn default_content() -> String {
        "both".to_string()
    }

    pub fn includes_clipboard(&self) -> bool {
        self.content == "clipboard" || self.content == "both"
    }

    pub fn includes_notes(&self) -> bool {
        self.content == "notes" || self.content == "both"
    }
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
