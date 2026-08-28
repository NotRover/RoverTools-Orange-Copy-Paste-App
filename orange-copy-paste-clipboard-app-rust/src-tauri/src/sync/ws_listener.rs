//! WebSocket listener — maintains a persistent `wss://` connection and
//! dispatches server-pushed events to the Tauri event bus.
//!
//! Connection lifecycle:
//!   1. `connect()` is called after a successful login / token refresh.
//!   2. On disconnect, reconnects with exponential backoff (5s → 10s → …max 60s).
//!      A server-side close is a disconnect like any other — backend restarts,
//!      idle proxy timeouts and load-balancer recycles all arrive that way, so
//!      only `disconnect()` ends the loop.
//!   3. `disconnect()` aborts the running task.
//!
//! Invariant: this module must never touch the clipboard history or note store
//! directly.  It emits Tauri events; the frontend (or other command handlers)
//! acts on them.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::{Emitter, Manager};
use tokio::task::JoinHandle;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures_util::{SinkExt, StreamExt};

use crate::state::AppState;
use crate::sync::client::{PulledEntry, SyncHttpClient};

const INITIAL_BACKOFF_SECS: u64 = 5;
const MAX_BACKOFF_SECS: u64 = 60;

/// A half-open socket - laptop sleep, NAT recycle, a dropped link - never
/// resolves its read future, so without a deadline the listener waits forever
/// while the UI still shows "Live". The server pings every 25s of silence, so
/// three missed pings is a dead connection worth replacing.
const WS_IDLE_TIMEOUT: Duration = Duration::from_secs(70);

// ── WS event payloads from server ────────────────────────────────────

#[derive(Debug, serde::Deserialize)]
struct WsMessage {
    event: String,
    #[serde(default)]
    payload: serde_json::Value,
}

// ── Listener ─────────────────────────────────────────────────────────

pub struct WsListener {
    app: tauri::AppHandle,
    http: Arc<SyncHttpClient>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl WsListener {
    pub fn new(app: tauri::AppHandle, http: Arc<SyncHttpClient>) -> Arc<Self> {
        Arc::new(Self {
            app,
            http,
            task: Mutex::new(None),
        })
    }

    /// Start the reconnect loop on the provided Tokio runtime handle.
    pub fn connect(self: Arc<Self>, handle: &tokio::runtime::Handle) {
        let listener = Arc::clone(&self);
        let task = handle.spawn(async move { listener.run_reconnect_loop().await });
        *self.task.lock() = Some(task);
    }

    /// Abort the WebSocket task (on logout / shutdown).
    pub fn disconnect(&self) {
        let task = self.task.lock().take();
        if let Some(task) = task {
            task.abort();
        }
    }

    async fn run_reconnect_loop(&self) {
        let mut backoff = INITIAL_BACKOFF_SECS;
        loop {
            // `established` says the socket came up before it dropped, which is
            // what the backoff is meant to measure — a live connection that the
            // server later closed should retry promptly, not inherit the delay
            // built up while the backend was unreachable.
            let (established, err) = self.connect_once().await;
            if established {
                backoff = INITIAL_BACKOFF_SECS;
            }
            self.set_connected(false);
            eprintln!("[sync:ws] disconnected: {err}; reconnecting in {backoff}s");
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            if !established {
                backoff = (backoff * 2).min(MAX_BACKOFF_SECS);
            }
        }
    }

    /// Run one connection to completion. Returns whether the socket was ever
    /// established, plus why it ended — it never succeeds permanently, since
    /// the only way out of the loop is `disconnect()` aborting the task.
    async fn connect_once(&self) -> (bool, String) {
        match self.run_connection().await {
            Ok(reason) => (true, reason),
            Err(e) => (false, e),
        }
    }

    /// `Ok(reason)` means the socket connected and later ended for `reason`;
    /// `Err` means it never came up.
    async fn run_connection(&self) -> Result<String, String> {
        // The handshake carries the JWT, and this loop can be reconnecting
        // after the app sat idle past the token's lifetime. Without this the
        // reconnect would keep failing on an expired token, since nothing else
        // refreshes it while no HTTP request is going out.
        self.http.ensure_fresh_access_token().await;
        let token = self
            .http
            .current_access_token()
            .ok_or("no access token")?;
        let device_id = self.http.device_id().ok_or("no device id")?;

        let base = self
            .http
            .base_url
            // Strip http(s) scheme and replace with ws(s)
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        let endpoint = format!("{}/ws", base.trim_end_matches('/'));
        // The token has to travel in the query string — that is the wire contract
        // — but it must never be logged with it.
        let url = format!("{endpoint}?token={token}&device_id={device_id}");

        let (ws_stream, _) = connect_async(&url)
            .await
            .map_err(|e| format!("ws connect: {e}"))?;

        // Endpoint and device only: the token is a live bearer credential, and
        // stdout here is a log file that outlives the session.
        eprintln!("[sync:ws] connected to {endpoint} as device {device_id}");
        self.set_connected(true);

        // Anything that happened while the socket was down was never delivered
        // - including the membership change that tells an owner to hand a new
        // member their Space Key. Reconcile once on connect so a reconnect
        // catches up instead of waiting for the next event.
        if let Some(sync) = self.sync_client() {
            tokio::runtime::Handle::current().spawn(async move {
                sync.reconcile_spaces().await;
            });
        }

        let (mut write, mut read) = ws_stream.split();

        loop {
            let next = match tokio::time::timeout(WS_IDLE_TIMEOUT, read.next()).await {
                Ok(Some(msg)) => msg,
                Ok(None) => break,
                Err(_) => {
                    return Ok(format!(
                        "no traffic for {}s",
                        WS_IDLE_TIMEOUT.as_secs()
                    ));
                }
            };
            match next {
                Ok(Message::Text(text)) => {
                    self.dispatch(&text, &mut write).await;
                }
                Ok(Message::Ping(data)) => {
                    let _ = write.send(Message::Pong(data)).await;
                }
                Ok(Message::Close(_)) => {
                    return Ok("server closed the socket".into());
                }
                Err(e) => {
                    return Ok(format!("ws read: {e}"));
                }
                _ => {}
            }
        }

        Ok("ws stream ended".into())
    }

    /// Publish connection state to both the status snapshot (`sync_get_status`)
    /// and the UI event bus, so neither can claim "Synced" while the socket is
    /// down.
    fn set_connected(&self, connected: bool) {
        let Some(sync) = self.sync_client() else {
            return;
        };
        // `disconnect()` aborts this task, and an abort only lands at the next
        // await - so a listener that just finished its handshake can still run
        // this line after a sign-out, republishing "connected" over it and
        // leaving the sidebar green with no account behind it. The session is
        // already cleared by then, which is what makes it the reliable check.
        if connected && sync.current_user().is_none() {
            return;
        }
        sync.set_connected(connected);
        sync.apply_self_presence(connected);
        let _ = self
            .app
            .emit("sync:status-changed", serde_json::json!({ "connected": connected }));
    }

    /// Look up the live `SyncClient` from managed state (it owns the UMK and
    /// the merge path).  Returns `None` if sync was disabled meanwhile.
    fn sync_client(&self) -> Option<Arc<crate::sync::SyncClient>> {
        self.app.state::<AppState>().sync_client.lock().clone()
    }

    async fn dispatch<S>(
        &self,
        raw: &str,
        write: &mut S,
    ) where
        S: SinkExt<Message> + Unpin,
        <S as futures_util::Sink<Message>>::Error: std::fmt::Display,
    {
        let Ok(msg) = serde_json::from_str::<WsMessage>(raw) else {
            return;
        };

        match msg.event.as_str() {
            // Entry fan-out: only Rust holds the keys, so decrypt + merge here
            // (tombstones — deleted_at set — are handled inside merge_pulled).
            // `live = true`: this is the WS path, where passive mode and
            // auto-copy apply.
            "sync:entry" => {
                if let Ok(entry) = serde_json::from_value::<PulledEntry>(msg.payload.clone()) {
                    if let Some(sync) = self.sync_client() {
                        sync.merge_pulled(std::slice::from_ref(&entry), true);
                    }
                }
            }
            // Another device changed settings — ask the frontend to re-pull.
            "settings:updated" => {
                let _ = self.app.emit("sync:settings-updated", &msg.payload);
            }
            "device:online" => {
                let _ = self.app.emit(
                    "sync:device-presence",
                    &serde_json::json!({ "device_id": msg.payload.get("device_id"), "online": true }),
                );
            }
            // A member of one of our spaces came online or went fully
            // offline. Update the cached members so the presence dots
            // stop waiting on a manual refresh.
            "user:presence" => {
                let user_id = msg.payload.get("user_id").and_then(|v| v.as_str());
                let online = msg.payload.get("online").and_then(|v| v.as_bool());
                if let (Some(user_id), Some(online), Some(sync)) =
                    (user_id, online, self.sync_client())
                {
                    sync.apply_member_presence(user_id, online);
                }
            }
            "device:offline" => {
                let _ = self.app.emit(
                    "sync:device-presence",
                    &serde_json::json!({ "device_id": msg.payload.get("device_id"), "online": false }),
                );
            }
            // The owner persisted a fresh wrapped keyring for us — reconcile
            // recovers it (Rust owns the identity key), then tells the UI.
            "space:rekey" => {
                if let Some(sync) = self.sync_client() {
                    sync.handle_space_rekey();
                }
            }
            // The space owner took an entry down. Pull only matches rows that
            // still carry the space id, so this event is the only way a member
            // holding a copy hears about it.
            "space:entry_removed" => {
                if let Some(sync) = self.sync_client() {
                    let p = &msg.payload;
                    if let (Some(space_id), Some(client_id)) = (
                        p.get("space_id").and_then(|v| v.as_str()),
                        p.get("client_id").and_then(|v| v.as_str()),
                    ) {
                        let entry_type = p
                            .get("entry_type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("clipboard");
                        // Who did it decides what the placeholder says. Older
                        // servers omit `removed_by`; treating that as "not the
                        // author" keeps their behaviour unchanged.
                        let author_id = p.get("author_id").and_then(|v| v.as_str());
                        let removed_by = p.get("removed_by").and_then(|v| v.as_str());
                        let by_author = match (author_id, removed_by) {
                            (Some(a), Some(r)) => a == r,
                            _ => false,
                        };
                        sync.drop_space_entry(
                            space_id,
                            client_id,
                            entry_type,
                            by_author,
                            removed_by.map(str::to_string),
                        );
                    }
                }
            }
            // Somebody commented on an entry in a space, or took a comment
            // back down. The ciphertext rides along with the event, so an open
            // thread fills in without a round trip.
            "space:comment" => {
                if let Some(sync) = self.sync_client() {
                    let p = &msg.payload;
                    let action = p.get("action").and_then(|v| v.as_str()).unwrap_or("");
                    if action == "deleted" {
                        let _ = self.app.emit("space:comment-removed", p);
                    } else if let Ok(row) =
                        serde_json::from_value::<crate::sync::client::CommentOut>(p.clone())
                    {
                        // A comment we cannot open is one written under a key
                        // this member never received. Dropping it is the same
                        // outcome as never having been sent it.
                        if let Some(comment) = sync.decrypt_comment(&row) {
                            let _ = self.app.emit("space:comment-added", &comment);
                            // The event only fills a thread that is already
                            // open, so this is the only thing that reaches
                            // someone who is not looking at the space.
                            sync.note_comment(&comment);
                        }
                    }
                }
            }
            // Someone joined, left, was removed, or the space was deleted.
            "space:membership_changed" => {
                let _ = self.app.emit("space:membership-changed", &msg.payload);
                // Our own membership may have changed (we joined, or were
                // removed): ask the server to re-resolve this socket's channel
                // set so space fan-out starts/stops without a reconnect.
                let _ = write
                    .send(Message::Text(r#"{"event":"resubscribe"}"#.into()))
                    .await;
                // The owner's reconcile (re)wraps keyrings for the current
                // member list — including the rekey a removal leaves behind;
                // members just refresh their cached space list. It also owns
                // the notification, which has to wait for that refreshed list
                // to turn the ids in this payload into names.
                if let Some(sync) = self.sync_client() {
                    let p = &msg.payload;
                    let space_id = p.get("space_id").and_then(|v| v.as_str()).unwrap_or_default();
                    let action = p.get("action").and_then(|v| v.as_str()).unwrap_or_default();
                    let user_id = p.get("user_id").and_then(|v| v.as_str()).unwrap_or_default();
                    sync.handle_membership_changed(
                        space_id.to_string(),
                        action.to_string(),
                        user_id.to_string(),
                    );
                }
            }
            // The owner opened this space's back catalogue. Reconcile rather than
            // backfilling straight away: it refreshes the policy this space
            // reports and then owes itself the sweep, so the live path and the
            // one that catches up at sign-in stay a single mechanism.
            "space:history_opened" => {
                if let Some(sync) = self.sync_client() {
                    tokio::runtime::Handle::current().spawn(async move {
                        sync.reconcile_spaces().await;
                    });
                }
            }
            // Somebody redeemed this space's code and is waiting to be let in.
            // Published only to people who may approve, so anything arriving
            // here is ours to act on.
            "space:join_requested" => {
                let _ = self.app.emit("sync:join-requested", &msg.payload);
                if let Some(sync) = self.sync_client() {
                    let p = &msg.payload;
                    if let (Some(space_id), Some(request_id)) = (
                        p.get("space_id").and_then(|v| v.as_str()),
                        p.get("request_id").and_then(|v| v.as_str()),
                    ) {
                        let space_id = space_id.to_string();
                        let request_id = request_id.to_string();
                        let user_id = p
                            .get("user_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                        tokio::runtime::Handle::current().spawn(async move {
                            // Refresh first: the request carries a user id, and
                            // only the space list can turn that into a name.
                            let spaces = sync.reconcile_spaces().await;
                            let who = spaces
                                .iter()
                                .find(|sp| sp.id == space_id)
                                .and_then(|sp| {
                                    sp.members.iter().find(|m| m.user_id == user_id)
                                })
                                .map(|m| m.display_name.clone())
                                .unwrap_or_default();
                            sync.note_join_requested(&space_id, &request_id, &who);
                        });
                    }
                }
            }
            // Our own request was answered. An approval carries the Space Key
            // with it, so the reconcile that follows is what makes the space
            // readable - not a later one that happens to find a wrap.
            "space:join_decided" => {
                let _ = self.app.emit("sync:join-decided", &msg.payload);
                if let Some(sync) = self.sync_client() {
                    let p = &msg.payload;
                    if let (Some(space_id), Some(status)) = (
                        p.get("space_id").and_then(|v| v.as_str()),
                        p.get("status").and_then(|v| v.as_str()),
                    ) {
                        if status == "approved" {
                            let space_id = space_id.to_string();
                            tokio::runtime::Handle::current().spawn(async move {
                                let spaces = sync.reconcile_spaces().await;
                                let name = spaces
                                    .iter()
                                    .find(|sp| sp.id == space_id)
                                    .map(|sp| sp.name.clone())
                                    .unwrap_or_else(|| "a space".to_string());
                                sync.note_join_approved(&space_id, &name);
                                let _ = sync.flush_and_pull().await;
                            });
                        }
                    }
                }
            }
            // Addressed invites: surface to the UI (badge + pending list).
            "invite:received" => {
                let _ = self.app.emit("sync:invite-received", &msg.payload);
            }
            // Someone answered an invite. `accepted` and `declined` are
            // addressed to whoever sent it; `revoked` goes to the invitee and
            // is left to `notifications_refresh`, which retires their row from
            // the server's own answer rather than guessing from an event.
            "invite:updated" => {
                let _ = self.app.emit("sync:invite-updated", &msg.payload);
                if let Some(sync) = self.sync_client() {
                    let p = &msg.payload;
                    if let (Some(invite_id), Some(status), Some(space_id)) = (
                        p.get("invite_id").and_then(|v| v.as_str()),
                        p.get("status").and_then(|v| v.as_str()),
                        p.get("space_id").and_then(|v| v.as_str()),
                    ) {
                        sync.note_invite_answered(invite_id, status, space_id);
                    }
                }
            }
            // A message from the server itself. Raised straight away for anyone
            // connected; everyone else picks the same row up from
            // `pull_announcements` on their next refresh, and the shared
            // `announcement:<id>` key makes both paths landing a no-op.
            "announcement:new" => {
                let p = &msg.payload;
                if let (Some(id), Some(title)) = (
                    p.get("id").and_then(|v| v.as_str()),
                    p.get("title").and_then(|v| v.as_str()),
                ) {
                    let kind = p.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                    let mut n = crate::notifications::Notification::new(
                        format!("announcement:{id}"),
                        crate::notifications::NotificationKind::from_wire(kind),
                        title,
                    )
                    .with_body(p.get("body").and_then(|v| v.as_str()).unwrap_or(""));
                    if let Some(ts) = p.get("created_at").and_then(|v| v.as_u64()) {
                        n.created_at = ts;
                    }
                    if let Some(map) = p.get("data").and_then(|v| v.as_object()) {
                        for (k, v) in map {
                            if let Some(text) = v.as_str() {
                                n.data.insert(k.clone(), text.to_string());
                            }
                        }
                    }
                    crate::notifications::raise(&self.app, n);
                }
            }
            // Application-level keepalive — reply so the server refreshes our
            // presence TTL (otherwise we're marked offline after ~5 min).
            "ping" => {
                let _ = write
                    .send(Message::Text(r#"{"event":"pong"}"#.into()))
                    .await;
            }
            other => eprintln!("[sync:ws] unknown event: {other}"),
        }
    }
}
