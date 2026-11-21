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

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};

/// How long after launch a row lands in the feed without a sound or a toast.
///
/// Startup replays the world: the pending queue is flushed, reminders are
/// swept, invites are reconciled. Everything that produces is news the user
/// was away for, and the unread badge is the right way to deliver it. A cue per
/// row is what made every launch open with a run of sounds.
const STARTUP_QUIET: Duration = Duration::from_secs(20);

/// How soon the same row may make a sound again.
///
/// A rolling summary moves once per item in a burst ("1 item", "2 items", ...)
/// and each move is a real change to the feed, but it is one event to a person.
/// The first move alerts; the rest only update the row.
const REPEAT_QUIET: Duration = Duration::from_secs(30);

/// Decides whether a row that just changed also gets a sound and a toast.
///
/// Only the alert is gated. The row itself always lands in the feed, unread, so
/// nothing is lost: the gate chooses between telling the user now and letting
/// the badge tell them.
struct AlertGate {
    started: Option<Instant>,
    last: HashMap<String, Instant>,
}

impl AlertGate {
    fn admits(&mut self, id: &str, now: Instant) -> bool {
        if let Some(started) = self.started {
            if now.duration_since(started) < STARTUP_QUIET {
                return false;
            }
        }
        if let Some(last) = self.last.get(id) {
            if now.duration_since(*last) < REPEAT_QUIET {
                return false;
            }
        }
        self.last.insert(id.to_string(), now);
        true
    }
}

fn gate() -> &'static Mutex<AlertGate> {
    static GATE: OnceLock<Mutex<AlertGate>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(AlertGate { started: None, last: HashMap::new() }))
}

/// Record the launch, so the first [`STARTUP_QUIET`] of alerts stay silent.
/// Called once from setup; a second call is ignored.
pub fn mark_started() {
    let mut gate = gate().lock().unwrap_or_else(|e| e.into_inner());
    if gate.started.is_none() {
        gate.started = Some(Instant::now());
    }
}

/// A sound worth making. Deliberately short of a cue per event: the point is a
/// family a user can learn, so two things that mean the same to a person share
/// one sound.
///
/// Sent to the frontend rather than played here - the webview can synthesize
/// these and is alive whenever the app is (closing either hides the window or
/// exits), so nothing is gained by linking an audio backend into the binary.
#[derive(Debug, Clone, Copy)]
pub enum Cue {
    /// Copied from inside the app. Never the clipboard watcher: capture fires
    /// on every copy anywhere in the OS, dozens a minute.
    Copy,
    /// Pasted from the quick-paste popup.
    Paste,
    /// Something arrived that the user did not do - a shared entry, an
    /// announcement, a reminder coming due.
    Arrived,
    /// Somebody wants something from you: an invite, a request to join.
    Knock,
    /// A door opened - a space became readable, a join was approved.
    Unlocked,
    /// Something was refused. Not an alarm; nothing here is urgent.
    Refused,
}

impl Cue {
    /// The name the frontend switches on. Kebab-case like every other event
    /// payload the app sends.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Copy => "copy",
            Self::Paste => "paste",
            Self::Arrived => "arrived",
            Self::Knock => "knock",
            Self::Unlocked => "unlocked",
            Self::Refused => "refused",
        }
    }

    /// What a kind sounds like when the raiser does not say otherwise.
    fn for_kind(kind: NotificationKind) -> Self {
        match kind {
            NotificationKind::SpaceInvite => Self::Knock,
            NotificationKind::SyncWarning => Self::Refused,
            NotificationKind::SpaceActivity
            | NotificationKind::Announcement
            | NotificationKind::Reminder => Self::Arrived,
        }
    }
}

/// The one event that makes a sound. Everything audible goes through it, so the
/// frontend has a single listener and the settings that mute it live in one place.
const CUE_EVENT: &str = "ui:cue";

/// Ask the frontend to play `cue`.
///
/// Fire-and-forget by design: a missed sound is not worth reporting, and the
/// thing it accompanied has already happened.
pub fn cue(app: &tauri::AppHandle, cue: Cue) {
    let _ = app.emit(CUE_EVENT, serde_json::json!({ "cue": cue.as_str() }));
}

/// Raise a notification from anywhere in the app.
///
/// Idempotent on the notification's id, so a source that can fire the same
/// event twice - a reconnect replaying it, a retry - does not stack rows.
pub fn raise(app: &tauri::AppHandle, notification: Notification) {
    raise_cued(app, notification, None);
}

/// [`raise`], with the sound named rather than inferred.
///
/// Only for rows whose kind is too broad to sound right: "a space became
/// readable" and "you were let in" are both space activity, and both deserve the
/// door-opening sound rather than the generic arrival.
pub fn raise_cued(app: &tauri::AppHandle, notification: Notification, cue: Option<Cue>) {
    let alert = Alert::from(&notification, cue);
    let changed = app
        .state::<crate::state::AppState>()
        .notifications
        .lock()
        .upsert(notification);
    commands::commit(app, changed);
    alert.fire(app, changed);
}

/// What to do about a row *besides* putting it in the feed.
///
/// Captured before the store takes ownership, and acted on only if the store
/// says the row was new: reconcile re-reads the server's invites on every panel
/// open, and a sound or a toast per re-read would be unbearable.
struct Alert {
    id: String,
    title: String,
    body: String,
    cue: Cue,
    kind: NotificationKind,
    /// The space this row is about, for the os-notify "already looking at it"
    /// test. Only space rows carry it, and only they read it.
    space_id: Option<String>,
}

impl Alert {
    fn from(n: &Notification, cue: Option<Cue>) -> Self {
        Self {
            id: n.id.clone(),
            title: n.title.clone(),
            body: n.body.clone(),
            cue: cue.unwrap_or_else(|| Cue::for_kind(n.kind)),
            kind: n.kind,
            space_id: n.data.get("space_id").cloned(),
        }
    }

    fn fire(self, app: &tauri::AppHandle, changed: bool) {
        if !changed {
            return;
        }
        if !gate().lock().unwrap_or_else(|e| e.into_inner()).admits(&self.id, Instant::now()) {
            return;
        }
        cue(app, self.cue);
        crate::runtime::os_notify::show(
            app,
            &self.title,
            &self.body,
            self.kind,
            self.space_id.as_deref(),
        );
    }
}

/// Mark a notification as answered, from wherever the answer was given.
///
/// The row stays in the feed as history and drops its buttons. Called the
/// moment the server confirms rather than left to the next reconcile: until
/// this lands the row still offers Join and Decline for something that has
/// already been settled, and pressing one of them is how a decline reached an
/// invite that was accepted a second earlier.
///
/// A no-op when the row is not there, which is the case for an invite this
/// device was never told about.
pub fn resolve(app: &tauri::AppHandle, id: &str, outcome: &str) {
    let changed = app
        .state::<crate::state::AppState>()
        .notifications
        .lock()
        .resolve(id, outcome);
    commands::commit(app, changed);
}

/// [`raise_rolling`] without the sound or the desktop toast.
///
/// For an event that already interrupts the user some other way - a refused
/// copy shows the app's own toast, and a cue plus an OS notification on top of
/// that delivers one event three times. The row is still the record.
pub fn raise_rolling_quiet(app: &tauri::AppHandle, notification: Notification) {
    let changed = app
        .state::<crate::state::AppState>()
        .notifications
        .lock()
        .announce(notification);
    commands::commit(app, changed);
}

/// Raise a rolling summary, where new text means a new event. See
/// [`NotificationStore::announce`].
pub fn raise_rolling(app: &tauri::AppHandle, notification: Notification) {
    let alert = Alert::from(&notification, None);
    let changed = app
        .state::<crate::state::AppState>()
        .notifications
        .lock()
        .announce(notification);
    commands::commit(app, changed);
    alert.fire(app, changed);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate_started(ago: Duration) -> AlertGate {
        AlertGate { started: Some(Instant::now() - ago), last: HashMap::new() }
    }

    #[test]
    fn a_burst_on_one_row_alerts_once() {
        let mut gate = gate_started(Duration::from_secs(3600));
        let now = Instant::now();
        assert!(gate.admits("sync-skipped", now));
        for i in 1..10 {
            assert!(!gate.admits("sync-skipped", now + Duration::from_millis(200 * i)));
        }
        // Another row is another event.
        assert!(gate.admits("invite:1", now + Duration::from_millis(500)));
        // Once the window has passed the same row may speak again.
        assert!(gate.admits("sync-skipped", now + REPEAT_QUIET));
    }

    #[test]
    fn nothing_alerts_right_after_launch() {
        let mut gate = gate_started(Duration::ZERO);
        let now = Instant::now();
        assert!(!gate.admits("invite:1", now));
        assert!(gate.admits("invite:1", now + STARTUP_QUIET));
    }

    #[test]
    fn an_unmarked_start_does_not_mute() {
        let mut gate = AlertGate { started: None, last: HashMap::new() };
        assert!(gate.admits("invite:1", Instant::now()));
    }
}
