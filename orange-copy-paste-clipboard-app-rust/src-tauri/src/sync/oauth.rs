//! Desktop OAuth redirect capture over a loopback HTTP server.
//!
//! Supabase's OAuth (PKCE) flow needs a `redirect_to` URL that the browser
//! lands on after the user grants consent — carrying the `?code=` we exchange
//! for a session.  Desktop apps have no web origin, so we bind a short-lived
//! HTTP server on `127.0.0.1` and use it as the redirect target.
//!
//! The bound port is chosen from a small fixed list so the exact redirect URLs
//! can be added to the Supabase project's allow-list (Authentication → URL
//! Configuration → Redirect URLs):
//!
//! ```text
//! http://127.0.0.1:53170
//! http://127.0.0.1:53171
//! http://127.0.0.1:53172
//! ```

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Candidate loopback ports, tried in order.  Every one of these must be
/// registered as an allowed redirect URL in the Supabase dashboard.
const REDIRECT_PORTS: &[u16] = &[53170, 53171, 53172];

/// How long to wait for the browser redirect before giving up.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(300);

/// A bound loopback listener plus the redirect URI that addresses it.
pub struct Loopback {
    listener: TcpListener,
    pub redirect_uri: String,
}

/// Bind the first available candidate port on `127.0.0.1`.
pub fn bind() -> Result<Loopback, String> {
    for &port in REDIRECT_PORTS {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            return Ok(Loopback {
                listener,
                redirect_uri: format!("http://127.0.0.1:{port}"),
            });
        }
    }
    Err(format!(
        "could not bind an OAuth loopback port (tried {REDIRECT_PORTS:?}). Close whatever is using them and retry"
    ))
}

/// Open the system browser at `url`.
pub fn open_browser(url: &str) -> Result<(), String> {
    open::that(url).map_err(|e| format!("could not open browser: {e}"))
}

impl Loopback {
    /// Block until the browser hits the redirect, then return the `code` query
    /// parameter.  Runs the blocking accept loop with a deadline so a user who
    /// never completes consent doesn't hang the caller forever, and watches
    /// `cancel` so a fresh attempt (or a cancel from the UI) releases the port
    /// instead of holding it until the deadline.
    pub fn wait_for_code(self, cancel: Arc<AtomicBool>) -> Result<String, String> {
        self.listener
            .set_nonblocking(true)
            .map_err(|e| format!("loopback nonblocking: {e}"))?;
        let deadline = Instant::now() + CAPTURE_TIMEOUT;

        loop {
            match self.listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let target = read_request_target(&mut stream);
                    let result = target
                        .as_deref()
                        .map(parse_redirect)
                        .unwrap_or_else(|| Err("malformed OAuth redirect request".into()));
                    write_response(&mut stream, result.is_ok());
                    return result;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if cancel.load(Ordering::Relaxed) {
                        return Err("sign-in was cancelled".into());
                    }
                    if Instant::now() >= deadline {
                        return Err("timed out waiting for the browser sign-in to complete".into());
                    }
                    std::thread::sleep(Duration::from_millis(150));
                }
                Err(e) => return Err(format!("loopback accept: {e}")),
            }
        }
    }
}

/// Read the request line and return its target (e.g. `/?code=abc&state=…`).
fn read_request_target(stream: &mut std::net::TcpStream) -> Option<String> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    // "GET /?code=abc HTTP/1.1"
    line.split_whitespace().nth(1).map(str::to_string)
}

/// Parse the redirect target for the `code` (or surface an OAuth `error`).
fn parse_redirect(target: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|e| format!("parse redirect: {e}"))?;

    let mut code = None;
    let mut error = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "error_description" | "error" if error.is_none() => error = Some(v.into_owned()),
            _ => {}
        }
    }

    if let Some(code) = code {
        Ok(code)
    } else if let Some(error) = error {
        Err(format!("sign-in was cancelled or failed: {error}"))
    } else {
        Err("OAuth redirect carried no authorization code".into())
    }
}

/// The page the browser tab lands on once the handshake is done.
///
/// A real `.html` file rather than a string literal, so it can be opened, edited
/// and previewed as a page - see `oauth_result.html` for the styling and the
/// copy. `include_str!` bakes it into the binary at compile time, so a shipped
/// build still has no file to find at runtime.
///
/// It carries both outcomes and shows one of them from CSS. The only
/// substitution is `__STATE__`.
const RESULT_PAGE: &str = include_str!("oauth_result.html");

fn result_page(ok: bool) -> String {
    RESULT_PAGE.replace("__STATE__", if ok { "ok" } else { "fail" })
}

/// Send the result page so the browser tab shows where the user stands.
fn write_response(stream: &mut std::net::TcpStream, ok: bool) {
    let body = result_page(ok);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}
