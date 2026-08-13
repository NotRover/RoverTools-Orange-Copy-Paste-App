//! WebSocket listener — maintains a persistent `wss://` connection and
//! dispatches server-pushed events to the Tauri event bus.
//!
//! Connection lifecycle:
//!   1. `connect()` is called after a successful login / token refresh.
//!   2. On disconnect, reconnects with exponential backoff (5s → 10s → …max 60s).
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
        if let Some(task) = self.task.lock().take() {
            task.abort();
        }
    }

    async fn run_reconnect_loop(&self) {
        let mut backoff = INITIAL_BACKOFF_SECS;
        loop {
            match self.connect_once().await {
                Ok(()) => {
                    // Clean disconnect — do not reconnect.
                    break;
                }
                Err(e) => {
                    eprintln!("[sync:ws] disconnected: {e}; reconnecting in {backoff}s");
                    tokio::time::sleep(Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF_SECS);
                }
            }
        }
    }

    async fn connect_once(&self) -> Result<(), String> {
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
        let _ = self.app.emit("sync:status-changed", serde_json::json!({ "connected": true }));

        let (mut write, mut read) = ws_stream.split();

        // Reset backoff on successful connection
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    self.dispatch(&text, &mut write).await;
                }
                Ok(Message::Ping(data)) => {
                    let _ = write.send(Message::Pong(data)).await;
                }
                Ok(Message::Close(_)) => {
                    return Ok(()); // Clean close — stop reconnecting
                }
                Err(e) => {
                    return Err(format!("ws read: {e}"));
                }
                _ => {}
            }
        }

        Err("ws stream ended unexpectedly".into())
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
            // Entry fan-out: only Rust holds the UMK, so decrypt + merge here
            // (tombstones — deleted_at set — are handled inside merge_pulled).
            "sync:entry" => {
                if let Ok(entry) = serde_json::from_value::<PulledEntry>(msg.payload.clone()) {
                    if let Some(sync) = self.sync_client() {
                        sync.merge_pulled(std::slice::from_ref(&entry));
                    }
                }
            }
            // Best-effort delete keyed only by server_id.
            "sync:delete" => {
                if let Some(server_id) = msg.payload.get("server_id").and_then(|v| v.as_str()) {
                    if let Some(sync) = self.sync_client() {
                        sync.apply_remote_delete(server_id);
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
            "device:offline" => {
                let _ = self.app.emit(
                    "sync:device-presence",
                    &serde_json::json!({ "device_id": msg.payload.get("device_id"), "online": false }),
                );
            }
            // Owner distributed a Group Key to us — unwrap + cache it (Rust owns
            // the identity key), then let the UI know.
            "group:rekey" => {
                if let Some(sync) = self.sync_client() {
                    sync.handle_group_rekey_arc(&msg.payload);
                }
            }
            "group:membership_changed" => {
                let _ = self.app.emit("sync:group-membership", &msg.payload);
                // Our own membership may have changed (we joined, or were
                // removed): ask the server to re-resolve this socket's channel
                // set so group fan-out starts/stops without a reconnect.
                let _ = write
                    .send(Message::Text(r#"{"event":"resubscribe"}"#.into()))
                    .await;
                // Someone joined or left: the owner (re)wraps Group Keys for
                // the current member list (pools and sessions); members no-op.
                if let Some(sync) = self.sync_client() {
                    let handle = tokio::runtime::Handle::current();
                    handle.spawn(async move {
                        sync.reconcile_group_keys().await;
                        sync.refresh_sharing_sessions().await;
                    });
                }
            }
            // Addressed invites: surface to the UI (badge + pending list).
            "invite:received" => {
                let _ = self.app.emit("sync:invite-received", &msg.payload);
            }
            "invite:updated" => {
                let _ = self.app.emit("sync:invite-updated", &msg.payload);
            }
            "sharing:invite" => {
                let _ = self.app.emit("sharing:invite-received", &msg.payload);
            }
            // A member accepted our invite — wrap the Group Key for them and
            // distribute it (owner-side handshake).
            "sharing:accepted" => {
                if let Some(sync) = self.sync_client() {
                    sync.handle_sharing_accepted(&msg.payload);
                }
                let _ = self.app.emit("sharing:accepted", &msg.payload);
            }
            "sharing:ended" => {
                let _ = self.app.emit("sharing:ended", &msg.payload);
            }
            "sharing:scope_changed" => {
                let _ = self.app.emit("sharing:scope-changed", &msg.payload);
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
