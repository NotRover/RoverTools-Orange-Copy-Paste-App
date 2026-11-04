//! Developer options: point this install at a self-hosted backend, test the
//! connection before committing to it, and look at what the sync engine is
//! doing. Every command here is behind the Settings toggle in the UI, but
//! none of them trusts that: the writes check for themselves that nobody is
//! signed in, and the values they accept pass the same transport rule as
//! `settings.json` does at startup.
//!
//! The endpoint values are public (see the `DEFAULT_*` comment in
//! `config.rs`), so reading them out to the UI is fine. Writing them is not a
//! preference and stays off the generic settings command.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;
use crate::sync::config::{
    self, format_cert_pin, is_trusted_endpoint, parse_cert_pin, SyncConfig,
    KEY_ALLOW_PRIVATE_HTTP, KEY_SERVER_CERT_SHA256, KEY_UPDATE_FEED_URL, KEY_UPDATE_PUBKEY,
};
use crate::sync::types::WsStats;

/// The API version this client speaks. The paths in `client.rs` are all
/// under it; a server that reports another one will not understand them.
const EXPECTED_API_VERSION: &str = "v1";

/// The discovery route the backend serves; see the backend's
/// `docs/architecture.md`, section 5.10.
const DISCOVERY_PATH: &str = "/.well-known/orange-copy-paste.json";

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

// -- Shapes ---------------------------------------------------------------

/// The four values that name a deployment, plus how to reach it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendProfile {
    pub server_url: String,
    pub supabase_url: String,
    pub supabase_anon_key: String,
    pub reset_page_url: String,
    #[serde(default)]
    pub allow_private_http: bool,
    /// Hex SHA-256 of the server certificate, empty for none.
    #[serde(default)]
    pub server_cert_sha256: String,
}

impl BackendProfile {
    fn from_config(c: &SyncConfig) -> Self {
        Self {
            server_url: c.server_url.clone(),
            supabase_url: c.supabase_url.clone(),
            supabase_anon_key: c.supabase_anon_key.clone(),
            reset_page_url: c.reset_page_url.clone(),
            allow_private_http: c.allow_private_http,
            server_cert_sha256: c.server_cert_sha256.map(|p| format_cert_pin(&p)).unwrap_or_default(),
        }
    }

    fn trimmed(mut self) -> Self {
        for field in [
            &mut self.server_url,
            &mut self.supabase_url,
            &mut self.supabase_anon_key,
            &mut self.reset_page_url,
            &mut self.server_cert_sha256,
        ] {
            *field = field.trim().trim_end_matches('/').to_string();
        }
        self
    }

    /// Everything that must hold before the profile is written or tested.
    fn validate(&self) -> Result<Option<[u8; 32]>, String> {
        if self.server_url.is_empty() {
            return Err("enter the server URL".into());
        }
        if !is_trusted_endpoint(&self.server_url, self.allow_private_http) {
            return Err(reject_reason("server URL", &self.server_url, self.allow_private_http));
        }
        if self.supabase_url.is_empty() {
            return Err("enter the Supabase URL, or use Discover to fetch it".into());
        }
        if !is_trusted_endpoint(&self.supabase_url, self.allow_private_http) {
            return Err(reject_reason(
                "Supabase URL",
                &self.supabase_url,
                self.allow_private_http,
            ));
        }
        if self.supabase_anon_key.is_empty() {
            return Err("enter the Supabase publishable key, or use Discover to fetch it".into());
        }
        if !self.reset_page_url.is_empty()
            && !self.reset_page_url.starts_with("https://")
            && !self.reset_page_url.starts_with("http://")
        {
            return Err("the reset page must be an http(s) URL".into());
        }
        parse_cert_pin(&self.server_cert_sha256)
    }
}

fn reject_reason(what: &str, url: &str, allow_private_http: bool) -> String {
    if url.starts_with("http://") {
        if allow_private_http {
            format!("the {what} uses plain http to a public host; use https there")
        } else {
            format!(
                "the {what} uses plain http; allow plain http on private networks below, or use https"
            )
        }
    } else {
        format!("the {what} must start with https:// or http://")
    }
}

#[derive(Debug, Serialize)]
pub struct DevConfig {
    pub developer_mode: bool,
    pub profile: BackendProfile,
    pub official: BackendProfile,
    pub is_official: bool,
    /// A profile change is refused while this is true.
    pub signed_in: bool,
    pub update_feed_url: String,
    pub update_pubkey: String,
    pub expected_api_version: String,
}

/// What the discovery route returned.
#[derive(Debug, Serialize, Deserialize)]
pub struct Discovered {
    pub api_version: String,
    pub service_version: String,
    pub supabase_url: String,
    pub supabase_anon_key: String,
    pub reset_page_url: String,
}

#[derive(Debug, Serialize)]
pub struct CertReport {
    pub sha256: String,
    pub trusted_by_roots: bool,
    pub matched_pin: bool,
}

#[derive(Debug, Serialize)]
pub struct TestStep {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Default, Serialize)]
pub struct TestReport {
    pub ok: bool,
    pub steps: Vec<TestStep>,
    pub api_version: Option<String>,
    pub service_version: Option<String>,
    pub rtt_ms: Option<u64>,
    pub cert: Option<CertReport>,
}

impl TestReport {
    fn step(&mut self, name: &str, result: Result<String, String>) -> bool {
        let ok = result.is_ok();
        let detail = match result {
            Ok(s) | Err(s) => s,
        };
        self.steps.push(TestStep {
            name: name.to_string(),
            ok,
            detail,
        });
        ok
    }
}

#[derive(Debug, Serialize)]
pub struct Probe {
    pub ok: bool,
    pub rtt_ms: Option<u64>,
    pub service_version: Option<String>,
    pub api_version: Option<String>,
    pub db: Option<bool>,
    pub redis: Option<bool>,
    pub error: Option<String>,
}

/// The round trips of a short burst of health requests, in order. A failed
/// request is counted, not timed, so the samples are all successes.
#[derive(Debug, Serialize)]
pub struct PingReport {
    pub samples_ms: Vec<u64>,
    pub failed: u32,
}

#[derive(Debug, Serialize)]
pub struct ConnectionStatus {
    pub server_url: String,
    pub supabase_url: String,
    pub pinned: bool,
    pub expected_api_version: String,
    /// False when no sync client exists (sync off or never started).
    pub engine_running: bool,
    pub signed_in: bool,
    pub ws_connected: bool,
    pub ws: WsStats,
    pub device_id: Option<String>,
    pub cursor: Option<u64>,
    pub last_synced_at: Option<u64>,
    pub pending_count: usize,
    pub in_flight: usize,
    pub pending_work: usize,
    pub probe: Probe,
}

// -- Helpers --------------------------------------------------------------

fn signed_in(state: &State<'_, AppState>) -> bool {
    let sync = state.sync_client.lock().clone();
    sync.is_some_and(|s| s.current_user().is_some() || s.has_stored_session())
}

fn read_str(app: &tauri::AppHandle, key: &str) -> String {
    crate::clipboard::commands::get_setting(key.to_string(), app.clone())
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn dev_config(app: &tauri::AppHandle, signed_in: bool) -> DevConfig {
    let config = SyncConfig::load(app);
    DevConfig {
        developer_mode: crate::clipboard::commands::get_setting(
            config::KEY_DEVELOPER_MODE.to_string(),
            app.clone(),
        )
        .and_then(|v| v.as_bool())
        .unwrap_or(false),
        is_official: config.is_official(),
        profile: BackendProfile::from_config(&config),
        official: BackendProfile::from_config(&SyncConfig::default()),
        signed_in,
        update_feed_url: read_str(app, KEY_UPDATE_FEED_URL),
        update_pubkey: read_str(app, KEY_UPDATE_PUBKEY),
        expected_api_version: EXPECTED_API_VERSION.to_string(),
    }
}

/// `GET {server_url}{path}` with the profile's trust, returning the response,
/// the round trip and what the handshake showed about the certificate.
async fn probe_get(
    server_url: &str,
    path: &str,
    pin: Option<[u8; 32]>,
) -> (Result<reqwest::Response, String>, u64, Option<CertReport>) {
    let (client, observed) = crate::sync::tls::observed_client(PROBE_TIMEOUT, pin);
    let url = format!("{}{}", server_url.trim_end_matches('/'), path);
    let started = Instant::now();
    let result = client
        .get(&url)
        .send()
        .await
        .map_err(|e| crate::sync::client::transport_detail(&e));
    let rtt = started.elapsed().as_millis() as u64;
    let seen = observed.lock().clone();
    let cert = seen.leaf_sha256.map(|leaf| CertReport {
        sha256: format_cert_pin(&leaf),
        trusted_by_roots: seen.trusted_by_roots.unwrap_or(false),
        matched_pin: seen.matched_pin,
    });
    (result, rtt, cert)
}

fn header(resp: &reqwest::Response, name: &str) -> Option<String> {
    resp.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

async fn fetch_discovery(
    server_url: &str,
    pin: Option<[u8; 32]>,
) -> (Result<Discovered, String>, u64, Option<CertReport>) {
    let (result, rtt, cert) = probe_get(server_url, DISCOVERY_PATH, pin).await;
    let parsed = match result {
        Ok(resp) if resp.status().is_success() => resp
            .json::<Discovered>()
            .await
            .map_err(|e| format!("the discovery route answered with something else: {e}")),
        Ok(resp) => Err(format!(
            "the discovery route answered {}; the server may run a version without it",
            resp.status()
        )),
        Err(e) => Err(e),
    };
    (parsed, rtt, cert)
}

// -- Commands -------------------------------------------------------------

#[tauri::command]
pub async fn dev_get_config(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<DevConfig, String> {
    let signed_in = signed_in(&state);
    Ok(dev_config(&app, signed_in))
}

/// Ask a server for the rest of its profile. The returned Supabase values
/// are only as trustworthy as the server URL the user typed, which is the
/// point: that one URL is what they are choosing to trust.
#[tauri::command]
pub async fn dev_discover(
    server_url: String,
    allow_private_http: bool,
    server_cert_sha256: String,
) -> Result<Discovered, String> {
    let server_url = server_url.trim().trim_end_matches('/').to_string();
    if server_url.is_empty() {
        return Err("enter the server URL".into());
    }
    if !is_trusted_endpoint(&server_url, allow_private_http) {
        return Err(reject_reason("server URL", &server_url, allow_private_http));
    }
    let pin = parse_cert_pin(&server_cert_sha256)?;
    let (result, _, cert) = fetch_discovery(&server_url, pin).await;
    result.map_err(|e| match cert {
        Some(c) if !c.trusted_by_roots && !c.matched_pin => format!(
            "{e}. The certificate is not trusted; its SHA-256 is {}. Pin it below if this is your server.",
            c.sha256
        ),
        _ => e,
    })
}

/// Try a profile without saving it: health, API version, one WebSocket
/// handshake, and that Supabase answers for the key.
#[tauri::command]
pub async fn dev_test_backend(profile: BackendProfile) -> Result<TestReport, String> {
    let profile = profile.trimmed();
    let pin = profile.validate()?;
    let mut report = TestReport::default();

    // 1. Health, which also carries the API version and the certificate.
    let (result, rtt, cert) = probe_get(&profile.server_url, "/internal/healthz", pin).await;
    report.cert = cert;
    let health_ok = match result {
        Ok(resp) => {
            report.rtt_ms = Some(rtt);
            report.api_version = header(&resp, "x-api-version");
            let status = resp.status();
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            let db = dep_ok(body.get("db"));
            let redis = dep_ok(body.get("redis"));
            let parts = format!(
                "{status}, {rtt} ms, database {}, redis {}",
                yes_no(db),
                yes_no(redis)
            );
            if status.is_success() && db == Some(true) && redis == Some(true) {
                report.step("Health", Ok(parts))
            } else {
                report.step("Health", Err(parts))
            }
        }
        Err(e) => {
            let detail = match &report.cert {
                Some(c) if !c.trusted_by_roots && !c.matched_pin => format!(
                    "{e}. The certificate is not trusted; its SHA-256 is {}",
                    c.sha256
                ),
                _ => e,
            };
            report.step("Health", Err(detail))
        }
    };
    if !health_ok {
        report.ok = false;
        return Ok(report);
    }

    // 2. API version.
    match report.api_version.as_deref() {
        Some(v) if v == EXPECTED_API_VERSION => {
            report.step("API version", Ok(format!("{v}, as this app expects")));
        }
        Some(v) => {
            report.step(
                "API version",
                Err(format!("server speaks {v}, this app expects {EXPECTED_API_VERSION}")),
            );
        }
        None => {
            report.step(
                "API version",
                Err("no X-API-Version header; is this the sync server?".into()),
            );
        }
    }

    // 3. Discovery, for the service version. Optional: an older server
    //    without the route still works.
    let (discovered, _, _) = fetch_discovery(&profile.server_url, pin).await;
    match discovered {
        Ok(d) => {
            report.service_version = Some(d.service_version.clone());
            let mut notes = vec![format!("server version {}", d.service_version)];
            if !d.supabase_url.is_empty() && d.supabase_url.trim_end_matches('/') != profile.supabase_url {
                notes.push("its Supabase URL differs from the one entered".into());
            }
            report.step("Discovery", Ok(notes.join("; ")));
        }
        Err(e) => {
            report.step("Discovery", Ok(format!("not available ({e})")));
        }
    }

    // 4. One WebSocket handshake. The server expects an auth frame next; we
    //    hang up instead, so this proves only that the socket route is
    //    reachable through whatever proxy sits in front.
    let ws_url = format!(
        "{}/ws",
        profile
            .server_url
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1)
    );
    let connector = crate::sync::tls::ws_connector(pin);
    let ws = tokio::time::timeout(
        PROBE_TIMEOUT,
        tokio_tungstenite::connect_async_tls_with_config(&ws_url, None, false, connector),
    )
    .await;
    match ws {
        Ok(Ok((mut stream, _))) => {
            let _ = stream.close(None).await;
            report.step("WebSocket", Ok("handshake completed".into()));
        }
        Ok(Err(e)) => {
            report.step("WebSocket", Err(format!("{e}")));
        }
        Err(_) => {
            report.step("WebSocket", Err("no answer within 10 seconds".into()));
        }
    }

    // 5. Supabase answers for this key. GoTrue's settings route is public
    //    but still wants the apikey header, so a wrong key fails here.
    let client = crate::sync::tls::http_client(PROBE_TIMEOUT, None);
    let settings_url = format!("{}/auth/v1/settings", profile.supabase_url);
    match client
        .get(&settings_url)
        .header("apikey", &profile.supabase_anon_key)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            report.step("Supabase", Ok("answered for this key".into()));
        }
        Ok(resp) => {
            report.step(
                "Supabase",
                Err(format!("{} from the auth service; check the URL and key", resp.status())),
            );
        }
        Err(e) => {
            report.step(
                "Supabase",
                Err(crate::sync::client::transport_detail(&e)),
            );
        }
    }

    report.ok = report.steps.iter().all(|s| s.ok);
    Ok(report)
}

/// One dependency's field from `/internal/healthz`. The backend writes it as
/// the string `"ok"` or `"error"` (`HealthResponse`); a bool is accepted too so
/// an older or third-party server is not read as "unknown".
fn dep_ok(v: Option<&serde_json::Value>) -> Option<bool> {
    match v {
        Some(serde_json::Value::Bool(b)) => Some(*b),
        Some(serde_json::Value::String(s)) => Some(s == "ok"),
        _ => None,
    }
}

fn yes_no(v: Option<bool>) -> &'static str {
    match v {
        Some(true) => "ok",
        Some(false) => "down",
        None => "unknown",
    }
}

/// Save a profile. Refused while signed in: the session, the device record
/// and the key material all belong to the current server, and a switch
/// underneath them would push this account's ciphertext to a server that has
/// never seen its keys. Sign out first.
#[tauri::command]
pub async fn dev_set_backend(
    profile: BackendProfile,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<DevConfig, String> {
    if signed_in(&state) {
        return Err("sign out before changing the server".into());
    }
    let profile = profile.trimmed();
    let pin = profile.validate()?;
    let written = crate::sync::commands::update_settings(&app, |m| {
        m.insert("sync_server_url".into(), profile.server_url.clone().into());
        m.insert("supabase_url".into(), profile.supabase_url.clone().into());
        m.insert("supabase_anon_key".into(), profile.supabase_anon_key.clone().into());
        if profile.reset_page_url.is_empty() {
            m.remove("reset_page_url");
        } else {
            m.insert("reset_page_url".into(), profile.reset_page_url.clone().into());
        }
        m.insert(KEY_ALLOW_PRIVATE_HTTP.into(), profile.allow_private_http.into());
        match pin {
            Some(p) => {
                m.insert(KEY_SERVER_CERT_SHA256.into(), format_cert_pin(&p).into());
            }
            None => {
                m.remove(KEY_SERVER_CERT_SHA256);
            }
        }
    });
    if !written {
        return Err("settings.json could not be written".into());
    }
    drop_client(&state);
    Ok(dev_config(&app, false))
}

/// Back to the compiled-in deployment. Removes the overrides rather than
/// writing the current defaults, so a later build's defaults apply.
#[tauri::command]
pub async fn dev_reset_backend(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<DevConfig, String> {
    if signed_in(&state) {
        return Err("sign out before changing the server".into());
    }
    let written = crate::sync::commands::update_settings(&app, |m| {
        for key in [
            "sync_server_url",
            "supabase_url",
            "supabase_anon_key",
            "reset_page_url",
            KEY_ALLOW_PRIVATE_HTTP,
            KEY_SERVER_CERT_SHA256,
        ] {
            m.remove(key);
        }
    });
    if !written {
        return Err("settings.json could not be written".into());
    }
    drop_client(&state);
    Ok(dev_config(&app, false))
}

/// The next sync client is built from the new settings. Nobody is signed in
/// (the callers checked), so there is no session to end; `logout` is still
/// called to clear a stale stored session that would otherwise be restored
/// against the new server.
fn drop_client(state: &State<'_, AppState>) {
    let previous = state.sync_client.lock().take();
    if let Some(sync) = previous {
        sync.logout();
    }
}

/// Point the updater at another feed, or back at the built-in ones with an
/// empty URL. The feed must be reachable under the same transport rule as the
/// sync server; bundles are signed, but a feed fetched over plain http from
/// the open internet is still a feed anyone on the path can rewrite.
#[tauri::command]
pub async fn dev_set_update_override(
    feed_url: String,
    pubkey: String,
    app: tauri::AppHandle,
) -> Result<DevConfig, String> {
    let feed_url = feed_url.trim().to_string();
    let pubkey = pubkey.trim().to_string();
    if !feed_url.is_empty() {
        let allow_private = SyncConfig::load(&app).allow_private_http;
        if !is_trusted_endpoint(&feed_url, allow_private) {
            return Err(reject_reason("update feed URL", &feed_url, allow_private));
        }
        feed_url
            .parse::<reqwest::Url>()
            .map_err(|e| format!("the update feed URL is invalid: {e}"))?;
    }
    if feed_url.is_empty() && !pubkey.is_empty() {
        return Err("a public key needs a feed URL to go with it".into());
    }
    let written = crate::sync::commands::update_settings(&app, |m| {
        for (key, value) in [(KEY_UPDATE_FEED_URL, &feed_url), (KEY_UPDATE_PUBKEY, &pubkey)] {
            if value.is_empty() {
                m.remove(key);
            } else {
                m.insert(key.into(), value.clone().into());
            }
        }
    });
    if !written {
        return Err("settings.json could not be written".into());
    }
    let signed_in = {
        let state: State<'_, AppState> = tauri::Manager::state(&app);
        signed_in(&state)
    };
    Ok(dev_config(&app, signed_in))
}

/// A snapshot of the engine plus one live round trip to the server.
#[tauri::command]
pub async fn dev_connection_status(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ConnectionStatus, String> {
    let config = SyncConfig::load(&app);
    let sync = state.sync_client.lock().clone();
    let (engine_running, signed_in, status, ws, device_id, cursor, in_flight, pending_work) =
        match &sync {
            Some(s) => (
                true,
                s.current_user().is_some(),
                s.status_info(),
                s.ws_stats(),
                s.device_id(),
                s.cursor(),
                s.in_flight_count(),
                s.pending_work_count(),
            ),
            None => (false, false, Default::default(), WsStats::default(), None, None, 0, 0),
        };
    let pin = sync
        .as_ref()
        .map(|s| s.cert_pin())
        .unwrap_or(config.server_cert_sha256);

    let (result, rtt, _) = probe_get(&config.server_url, "/internal/healthz", pin).await;
    let probe = match result {
        Ok(resp) => {
            let api_version = header(&resp, "x-api-version");
            let ok = resp.status().is_success();
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            Probe {
                ok,
                rtt_ms: Some(rtt),
                service_version: None,
                api_version,
                db: dep_ok(body.get("db")),
                redis: dep_ok(body.get("redis")),
                error: None,
            }
        }
        Err(e) => Probe {
            ok: false,
            rtt_ms: None,
            service_version: None,
            api_version: None,
            db: None,
            redis: None,
            error: Some(e),
        },
    };
    // The service version lives on the discovery route; one more round trip,
    // skipped when the server is down.
    let probe = if probe.ok {
        let (d, _, _) = fetch_discovery(&config.server_url, pin).await;
        Probe {
            service_version: d.ok().map(|d| d.service_version),
            ..probe
        }
    } else {
        probe
    };

    Ok(ConnectionStatus {
        server_url: config.server_url,
        supabase_url: config.supabase_url,
        pinned: pin.is_some(),
        expected_api_version: EXPECTED_API_VERSION.to_string(),
        engine_running,
        signed_in,
        ws_connected: status.connected,
        ws,
        device_id,
        cursor,
        last_synced_at: status.last_synced_at,
        pending_count: status.pending_count,
        in_flight,
        pending_work,
        probe,
    })
}

/// `count` health requests in a row to the configured server, under the same
/// trust as sync, so the number is the one sync pays. Sequential rather than
/// parallel: the point is the latency of one request, not the throughput.
#[tauri::command]
pub async fn dev_ping_server(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    count: u32,
) -> Result<PingReport, String> {
    let config = SyncConfig::load(&app);
    let pin = state
        .sync_client
        .lock()
        .as_ref()
        .map(|s| s.cert_pin())
        .unwrap_or(config.server_cert_sha256);
    let count = count.clamp(1, 10);
    let mut report = PingReport { samples_ms: Vec::with_capacity(count as usize), failed: 0 };
    for _ in 0..count {
        let (result, rtt, _) = probe_get(&config.server_url, "/internal/healthz", pin).await;
        match result {
            Ok(resp) if resp.status().is_success() => report.samples_ms.push(rtt),
            _ => report.failed += 1,
        }
    }
    Ok(report)
}
