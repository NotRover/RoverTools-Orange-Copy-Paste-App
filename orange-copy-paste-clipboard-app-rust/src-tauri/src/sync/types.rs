//! Shared types for the cloud sync module.

use serde::{Deserialize, Serialize};

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
    /// Whether *this device* holds the Space Key, which is what decides whether
    /// anything can be written here: content is encrypted under that key, so
    /// without it a share would either be dropped or produce an entry nobody
    /// can read. Stamped from the live keyring on every read rather than stored,
    /// because the key can arrive at any moment - see `space:key-received`.
    /// Distinct from a member's `has_space_key`, which is the server's record of
    /// having handed a copy over and can be true while the unwrap here failed.
    #[serde(default)]
    pub has_key: bool,
    pub share_history: bool,
    pub member_count: u32,
    pub members: Vec<SpaceMember>,
    /// Present after create / for owners; used to share the space.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invite_expires_at: Option<u64>,
    /// The owner's approval policy: may any member let somebody in, or only the
    /// owner? The one control the space has, shown to the owner alone.
    #[serde(default)]
    pub members_can_approve: bool,
    /// Whether *we* may approve, decided by the server from the policy and our
    /// role. The UI shows the requests list on this and nothing else, so there
    /// is one definition of the rule and it is not here.
    #[serde(default)]
    pub i_can_approve: bool,
    /// People waiting to be let in. Zero unless we may act on them, so it is
    /// safe to add straight into a badge count.
    #[serde(default)]
    pub pending_join_requests: u32,
}

/// A space we have asked to join and are still waiting on. Not a member yet, so
/// the name is all there is to show - and showing it is the difference between
/// an honest wait and an empty screen.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingJoin {
    pub space_id: String,
    pub space_name: String,
    pub created_at: u64,
}

/// A pending request to join a space, as the UI sees it. The identity key rides
/// along because approving wraps the Space Key in the same action, and that is
/// what makes the approval hand over access rather than merely grant it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceJoinRequest {
    pub id: String,
    pub space_id: String,
    pub space_name: String,
    pub user_id: String,
    pub display_name: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
    pub created_at: u64,
    #[serde(default)]
    pub identity_pubkey: Option<String>,
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
    /// Row count against `max_entries_per_user`, and the per-entry size cap.
    /// Both are refusal reasons the user would otherwise only meet as an error,
    /// so the account screen shows them beside the storage bar. Zero means the
    /// server did not report one - the UI hides the figure rather than drawing
    /// a bar that reads as full.
    pub entry_count: u64,
    pub entry_limit: u64,
    pub max_entry_bytes: u64,
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
    /// True when this row was registered from the same physical machine as the
    /// current device, but is not the current device. Derived by comparing the
    /// server's opaque fingerprints, so it is a hint for the device list only -
    /// never a claim of identity, which only the device keypair can make.
    pub same_machine: bool,
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

/// What a removal is allowed to reach.
///
/// An entry belongs to whoever wrote it (see `docs/permissions.md`), and this
/// is how that rule is carried to the one function that performs a removal,
/// instead of each caller remembering to filter its own list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemovalScope {
    /// The user acted on this one item, whoever wrote it.
    ThisItem,
    /// A sweep over everything this account owns. Items other members shared
    /// in are not part of that set and are refused outright.
    OwnedOnly,
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


// ── Space comments ───────────────────────────────────────────────────

/// A comment on an entry shared into a space, as the UI sees it: decrypted.
///
/// The author is a bare user id rather than a name — the screen already has
/// the space's member list, and resolving there keeps one source for display
/// names and avatars instead of two that can disagree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceComment {
    pub id: String,
    pub space_id: String,
    pub client_id: String,
    pub entry_type: String,
    pub author_id: String,
    pub body: String,
    /// User ids named in the body. Resolved on this device from the ciphertext,
    /// so the server never learns who was tagged.
    #[serde(default)]
    pub mentions: Vec<String>,
    pub created_at: i64,
    /// Whether this account wrote it — what the UI needs to offer a delete.
    pub is_mine: bool,
}

/// One entry's comment tally, for the chips on the feed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceCommentCount {
    pub client_id: String,
    pub entry_type: String,
    pub count: i64,
    /// Newest comment's timestamp — compared against this device's last visit
    /// to decide whether the chip shows an unread marker.
    pub latest_at: i64,
}
