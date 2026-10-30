//! Sync configuration — reads the device-local sync settings from
//! `settings.json`.  These values are device-specific and are therefore never
//! included in the encrypted settings blob:
//!
//!   - `sync_enabled`         feature flag
//!   - `sync_server_url`      our FastAPI backend base URL
//!   - `supabase_url`         Supabase project URL (GoTrue auth lives here)
//!   - `supabase_anon_key`    Supabase anon/public API key
//!   - `reset_page_url`       where a password-reset mail lands
//!   - `allow_private_http`   plain http is also fine to private-network hosts
//!   - `server_cert_sha256`   pin: hex SHA-256 of the sync server's certificate
//!   - `update_feed_url`      a custom update feed (overrides both channels)
//!   - `update_pubkey`        the minisign public key that feed's bundles carry
//!   - `developer_mode`       whether Settings shows the Developer section
//!
//! Endpoints come from the `DEFAULT_*` constants below, optionally overridden
//! per-install by `settings.json`.
//!
//! When both are empty the app is *unconfigured*: [`SyncConfig::is_configured`]
//! returns false and the sign-in screen says so, rather than silently pointing
//! the app at a host nobody owns.

use tauri::Manager;

const KEY_ENABLED: &str = "sync_enabled";
const KEY_SERVER_URL: &str = "sync_server_url";
const KEY_SUPABASE_URL: &str = "supabase_url";
const KEY_SUPABASE_ANON_KEY: &str = "supabase_anon_key";
const KEY_RESET_PAGE_URL: &str = "reset_page_url";
pub(crate) const KEY_ALLOW_PRIVATE_HTTP: &str = "allow_private_http";
pub(crate) const KEY_SERVER_CERT_SHA256: &str = "server_cert_sha256";
pub(crate) const KEY_UPDATE_FEED_URL: &str = "update_feed_url";
pub(crate) const KEY_UPDATE_PUBKEY: &str = "update_pubkey";
pub(crate) const KEY_DEVELOPER_MODE: &str = "developer_mode";

/// The host part of an `http(s)://` URL, without port, path or brackets.
fn host_of(url: &str) -> Option<&str> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split('/').next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    if let Some(v6) = authority.strip_prefix('[') {
        return v6.split(']').next();
    }
    authority.split(':').next()
}

/// Whether `host` can only be reached from inside a private network: a
/// loopback, RFC 1918, link-local, CGNAT (Tailscale lives there) or
/// unique-local address, or a name that public DNS never resolves.
pub(crate) fn is_private_host(host: &str) -> bool {
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => {
                let [a, b, _, _] = v4.octets();
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || (a == 100 && (64..=127).contains(&b))
            }
            std::net::IpAddr::V6(v6) => {
                let first = v6.segments()[0];
                v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
            }
        };
    }
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || !host.contains('.')
        || [".local", ".lan", ".home", ".internal", ".home.arpa", ".localhost"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
}

/// `https://` anywhere; plain `http://` only to the local machine, or to a
/// private-network host once the user has allowed that in Developer options.
pub(crate) fn is_trusted_endpoint(url: &str, allow_private_http: bool) -> bool {
    if url.starts_with("https://") {
        return true;
    }
    if !url.starts_with("http://") {
        return false;
    }
    let host = host_of(url).unwrap_or("");
    if matches!(host, "localhost" | "127.0.0.1" | "::1") {
        return true;
    }
    allow_private_http && is_private_host(host)
}

/// A certificate pin as the user typed it: 64 hex digits, with any `:` or
/// whitespace between pairs allowed, as `openssl x509 -fingerprint -sha256`
/// prints it. Returns the 32 bytes, or why it is not a fingerprint.
pub(crate) fn parse_cert_pin(text: &str) -> Result<Option<[u8; 32]>, String> {
    let digits: String = text
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ':')
        .collect();
    if digits.is_empty() {
        return Ok(None);
    }
    if digits.len() != 64 || !digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("the certificate fingerprint must be 64 hex digits (SHA-256)".into());
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&digits[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(Some(out))
}

/// The pin in the form the UI shows and the user pastes: lowercase hex.
pub(crate) fn format_cert_pin(pin: &[u8; 32]) -> String {
    pin.iter().map(|b| format!("{b:02x}")).collect()
}

// ── Deployment endpoints ──────────────────────────────────────────────
//
// Fill these in to hardcode the deployment this app ships against, so a plain
// `git clone && bun run tauri build` yields a working binary with no setup.
//
// These are PUBLIC values by design: the project URL and publishable key are the
// same pair any Supabase web app serves in its JS bundle, and on their own they
// grant nothing beyond the ability to *attempt* a sign-in. Real protection comes
// from the JWT check, the backend's per-user scoping, and end-to-end encryption.
//
// NEVER put a `service_role` / `sb_secret_…` key here — that is full admin
// access to the project, and anyone can read strings out of a shipped binary.
//
// Leave a value empty to build an app that reports itself as unconfigured.
const DEFAULT_SERVER_URL: &str = "https://api.orangecp.rovertools.ctx.cl";
const DEFAULT_SUPABASE_URL: &str = "https://dmtdusebizngdjtuhzzm.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY: &str = "sb_publishable_ZNs6Q9HfOdUBe8bEBEdPEg_z__qKE8e";

// Where the password-reset mail lands, and so also the `redirect_to` Supabase is
// asked for. The whole URL, not a base: it is the one thing this value is for,
// and building a path onto it here would only hide a mismatch with the
// allow-list entry it has to equal.
//
// The public site rather than the API: this page needs nothing from a server -
// it reads a code out of the query and hands it to the app - and hosting it
// away from the API means a reset no longer breaks when the API changes
// hostname. That is not hypothetical; it is what happened when the backend left
// Render and the new `/reset` was never added to Supabase's allow-list.
const DEFAULT_RESET_PAGE_URL: &str = "https://orange-copy-paste-app.pages.dev/reset";

#[derive(Debug, Clone)]
pub struct SyncConfig {
    pub enabled: bool,
    /// Whether `enabled` is what the file said, rather than what we fell back to.
    ///
    /// False when `settings.json` could not be read or parsed. `enabled` is
    /// `false` in that case because there is nothing else it could be, but the
    /// two are not the same claim: one is "the user turned sync off", the other
    /// is "we could not find out". Acting on the second as though it were the
    /// first puts the sign-in screen in front of a signed-in user, with the
    /// credentials still sitting untouched in the keychain, and nothing retries
    /// it for the life of the process.
    pub enabled_known: bool,
    pub server_url: String,
    pub supabase_url: String,
    pub supabase_anon_key: String,
    pub reset_page_url: String,
    /// Plain http to private-network hosts is accepted. Off by default.
    pub allow_private_http: bool,
    /// SHA-256 of the sync server's certificate, when the user pinned one. The
    /// pin is for `server_url` only; Supabase stays on the public roots.
    pub server_cert_sha256: Option<[u8; 32]>,
}

impl Default for SyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            enabled_known: true,
            server_url: DEFAULT_SERVER_URL.to_string(),
            supabase_url: DEFAULT_SUPABASE_URL.to_string(),
            supabase_anon_key: DEFAULT_SUPABASE_ANON_KEY.to_string(),
            reset_page_url: DEFAULT_RESET_PAGE_URL.to_string(),
            allow_private_http: false,
            server_cert_sha256: None,
        }
    }
}

impl SyncConfig {
    pub fn load(app: &tauri::AppHandle) -> Self {
        let defaults = Self::default();
        let Some(path) = app
            .path()
            .app_data_dir()
            .ok()
            .map(|d| d.join("settings.json"))
        else {
            return defaults;
        };
        // A read that fails is not "sync is off". `enabled` still has to be
        // something, and `false` is the only safe default - but `enabled_known`
        // carries the difference forward so the startup path can try a restore
        // anyway instead of drawing a sign-in screen over live credentials.
        let unknown = || Self {
            enabled_known: false,
            ..Self::default()
        };
        let map = match crate::settings_file::read_map(&path) {
            Ok(map) => map,
            Err(crate::settings_file::ReadError::Absent) => return defaults,
            Err(crate::settings_file::ReadError::Malformed(e)) => {
                crate::health::note("sync config: settings.json unparseable", &e);
                return unknown();
            }
            Err(crate::settings_file::ReadError::Unreadable(e)) => {
                crate::health::note(
                    "sync config: settings.json unreadable",
                    &format!("{e} - falling back to the stored session"),
                );
                return unknown();
            }
        };

        let str_or = |key: &str, fallback: &str| -> String {
            map.get(key)
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(fallback)
                .to_string()
        };

        let allow_private_http = map
            .get(KEY_ALLOW_PRIVATE_HTTP)
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        // An endpoint that is not https is ignored in favour of the default.
        // Every credential the app holds travels to these two hosts, so a
        // plain-http override - however it got into the file - would hand
        // them to whatever is on the path. Loopback is the one exception, for
        // a developer running the stack locally; private-network hosts join
        // it only once the user has said so in Developer options.
        let https_or = |key: &str, fallback: &str| -> String {
            let value = str_or(key, fallback);
            if is_trusted_endpoint(&value, allow_private_http) {
                value
            } else {
                crate::health::note(
                    "sync config: endpoint override ignored",
                    &format!("{key} is not https, using the built-in value"),
                );
                fallback.to_string()
            }
        };

        Self {
            enabled: map
                .get(KEY_ENABLED)
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            enabled_known: true,
            server_url: https_or(KEY_SERVER_URL, &defaults.server_url),
            supabase_url: https_or(KEY_SUPABASE_URL, &defaults.supabase_url),
            supabase_anon_key: str_or(KEY_SUPABASE_ANON_KEY, &defaults.supabase_anon_key),
            reset_page_url: str_or(KEY_RESET_PAGE_URL, &defaults.reset_page_url),
            allow_private_http,
            server_cert_sha256: map
                .get(KEY_SERVER_CERT_SHA256)
                .and_then(|v| v.as_str())
                .and_then(|s| match parse_cert_pin(s) {
                    Ok(pin) => pin,
                    Err(e) => {
                        crate::health::note("sync config: certificate pin ignored", &e);
                        None
                    }
                }),
        }
    }

    /// Whether `key` is one of the endpoint, trust or update-feed settings
    /// that only the developer commands may set. The generic settings command
    /// refuses them, so a script running in the webview cannot repoint the app
    /// at another server, loosen the transport rule, or feed it other bundles.
    pub fn is_endpoint_key(key: &str) -> bool {
        matches!(
            key,
            KEY_SERVER_URL
                | KEY_SUPABASE_URL
                | KEY_SUPABASE_ANON_KEY
                | KEY_RESET_PAGE_URL
                | KEY_ALLOW_PRIVATE_HTTP
                | KEY_SERVER_CERT_SHA256
                | KEY_UPDATE_FEED_URL
                | KEY_UPDATE_PUBKEY
        )
    }

    /// True when every endpoint is the compiled-in one.
    pub fn is_official(&self) -> bool {
        let d = Self::default();
        self.server_url == d.server_url
            && self.supabase_url == d.supabase_url
            && self.supabase_anon_key == d.supabase_anon_key
            && self.reset_page_url == d.reset_page_url
    }

    /// True once every endpoint needed to reach a deployment is present.
    /// Sign-in cannot succeed without all three, so the UI gates on this.
    pub fn is_configured(&self) -> bool {
        !self.server_url.is_empty()
            && !self.supabase_url.is_empty()
            && !self.supabase_anon_key.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_is_always_trusted() {
        assert!(is_trusted_endpoint("https://api.example.com", false));
    }

    #[test]
    fn plain_http_only_to_loopback_by_default() {
        assert!(is_trusted_endpoint("http://localhost:8000", false));
        assert!(is_trusted_endpoint("http://127.0.0.1:8000/", false));
        assert!(is_trusted_endpoint("http://[::1]:8000", false));
        assert!(!is_trusted_endpoint("http://192.168.1.20:8000", false));
        assert!(!is_trusted_endpoint("http://api.example.com", false));
        assert!(!is_trusted_endpoint("ftp://localhost", false));
    }

    #[test]
    fn private_http_once_allowed() {
        assert!(is_trusted_endpoint("http://192.168.1.20:8000", true));
        assert!(is_trusted_endpoint("http://10.0.0.5", true));
        assert!(is_trusted_endpoint("http://172.16.4.4:8000/", true));
        assert!(is_trusted_endpoint("http://100.101.102.103:8000", true));
        assert!(is_trusted_endpoint("http://nas.local:8000", true));
        assert!(is_trusted_endpoint("http://nas", true));
        assert!(is_trusted_endpoint("http://[fd12::1]:8000", true));
        assert!(!is_trusted_endpoint("http://api.example.com", true));
        assert!(!is_trusted_endpoint("http://8.8.8.8", true));
        assert!(!is_trusted_endpoint("http://172.32.0.1", true));
    }

    #[test]
    fn cert_pin_parses_openssl_and_bare_forms() {
        let bare = "ab".repeat(32);
        let colons = (0..32).map(|_| "AB").collect::<Vec<_>>().join(":");
        assert_eq!(parse_cert_pin(&bare).unwrap(), Some([0xab; 32]));
        assert_eq!(parse_cert_pin(&colons).unwrap(), Some([0xab; 32]));
        assert_eq!(parse_cert_pin("  ").unwrap(), None);
        assert!(parse_cert_pin("abcd").is_err());
        assert!(parse_cert_pin(&"zz".repeat(32)).is_err());
        assert_eq!(format_cert_pin(&[0xab; 32]), bare);
    }
}
