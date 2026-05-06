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
use tauri::Emitter;
use tokio::task::JoinHandle;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use futures_util::{SinkExt, StreamExt};

use crate::sync::client::SyncHttpClient;

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

        let base = self
            .http
            .base_url
            // Strip http(s) scheme and replace with ws(s)
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        let url = format!("{}/ws?token={}", base.trim_end_matches('/'), token);

        let (ws_stream, _) = connect_async(&url)
            .await
            .map_err(|e| format!("ws connect: {e}"))?;

        eprintln!("[sync:ws] connected to {url}");
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

    async fn dispatch<S>(
        &self,
        raw: &str,
        _write: &mut S,
    ) where
        S: SinkExt<Message> + Unpin,
        <S as futures_util::Sink<Message>>::Error: std::fmt::Display,
    {
        let Ok(msg) = serde_json::from_str::<WsMessage>(raw) else {
            return;
        };

        match msg.event.as_str() {
            "sync:entry" => {
                // Entry pushed by another device. Emit to frontend for merge.
                // The frontend invokes a Rust command to decrypt & insert.
                let _ = self.app.emit("sync:remote-entry", &msg.payload);
            }
            "sync:delete" => {
                let _ = self.app.emit("sync:remote-delete", &msg.payload);
            }
            "settings:updated" => {
                // Another device changed settings — pull and apply.
                let _ = self.app.emit("sync:settings-updated", &msg.payload);
            }
            "device:online" | "device:offline" => {
                let _ = self.app.emit("sync:device-presence", &msg.payload);
            }
            "group:rekey" => {
                let _ = self.app.emit("sync:group-rekey", &msg.payload);
            }
            "sharing:invite" => {
                let _ = self.app.emit("sharing:invite-received", &msg.payload);
            }
            "sharing:accepted" => {
                let _ = self.app.emit("sharing:accepted", &msg.payload);
            }
            "sharing:ended" => {
                let _ = self.app.emit("sharing:ended", &msg.payload);
            }
            "sharing:member_left" => {
                let _ = self.app.emit("sharing:member-left", &msg.payload);
            }
            "sharing:scope_changed" => {
                let _ = self.app.emit("sharing:scope-changed", &msg.payload);
            }
            "ping" => {
                // Server keepalive — pong is handled at the Message::Ping level above.
                // Some servers also send text "ping".
            }
            other => {
                eprintln!("[sync:ws] unknown event: {other}");
            }
        }
    }
}
