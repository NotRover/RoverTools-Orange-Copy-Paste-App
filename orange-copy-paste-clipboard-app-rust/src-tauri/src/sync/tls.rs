//! TLS for the sync server: the public roots, or a pinned certificate.
//!
//! A self-hosted backend on a home network often has no certificate a public
//! root would sign. Rather than let the user switch verification off, the
//! Developer section lets them pin the SHA-256 of the server's certificate:
//! a leaf whose digest equals the pin is accepted as it is, and any other
//! chain still has to pass the WebPKI roots. The pin applies to `server_url`
//! only; Supabase and blob storage keep the default verification.
//!
//! Both transports go through here, so the HTTP client and the WebSocket
//! cannot disagree about which server they trust.

use std::sync::Arc;

use parking_lot::Mutex;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error, RootCertStore, SignatureScheme};
use sha2::{Digest, Sha256};

/// What a handshake showed about the server's certificate. Filled in by a
/// client built with [`observed_client`], so a connection test can tell the
/// user the fingerprint they would be pinning, and whether the public roots
/// would have accepted it.
#[derive(Debug, Default, Clone)]
pub struct Observed {
    pub leaf_sha256: Option<[u8; 32]>,
    pub trusted_by_roots: Option<bool>,
    pub matched_pin: bool,
}

#[derive(Debug)]
struct PinVerifier {
    pin: Option<[u8; 32]>,
    roots: Arc<WebPkiServerVerifier>,
    observed: Option<Arc<Mutex<Observed>>>,
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let digest: [u8; 32] = Sha256::digest(end_entity.as_ref()).into();
        let matched = self.pin.is_some_and(|pin| pin == digest);
        let by_roots = self
            .roots
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now);
        if let Some(observed) = &self.observed {
            let mut o = observed.lock();
            o.leaf_sha256 = Some(digest);
            o.trusted_by_roots = Some(by_roots.is_ok());
            o.matched_pin = matched;
        }
        if matched {
            return Ok(ServerCertVerified::assertion());
        }
        by_roots
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.roots.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.roots.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.roots.supported_verify_schemes()
    }
}

fn config_with(
    pin: Option<[u8; 32]>,
    observed: Option<Arc<Mutex<Observed>>>,
) -> Arc<ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut store = RootCertStore::empty();
    store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let roots = WebPkiServerVerifier::builder_with_provider(Arc::new(store), Arc::clone(&provider))
        .build()
        .expect("webpki roots");
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("rustls protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinVerifier {
            pin,
            roots,
            observed,
        }))
        .with_no_client_auth();
    Arc::new(config)
}

/// A `reqwest` client for the sync server. Without a pin this is the stock
/// client; with one, the pinned certificate is accepted alongside the roots.
pub fn http_client(timeout: std::time::Duration, pin: Option<[u8; 32]>) -> reqwest::Client {
    let builder = reqwest::Client::builder().timeout(timeout);
    let builder = match pin {
        Some(_) => builder.use_preconfigured_tls((*config_with(pin, None)).clone()),
        None => builder,
    };
    builder.build().expect("reqwest client")
}

/// A client that also records what the server presented. Used by the
/// connection test only: the verification outcome is the same as
/// [`http_client`] would give, it is just reported as well as enforced.
pub fn observed_client(
    timeout: std::time::Duration,
    pin: Option<[u8; 32]>,
) -> (reqwest::Client, Arc<Mutex<Observed>>) {
    let observed = Arc::new(Mutex::new(Observed::default()));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .use_preconfigured_tls((*config_with(pin, Some(Arc::clone(&observed)))).clone())
        .build()
        .expect("reqwest client");
    (client, observed)
}

/// The WebSocket connector for the sync server, `None` meaning the library's
/// default. Plain `ws://` ignores it either way.
pub fn ws_connector(pin: Option<[u8; 32]>) -> Option<tokio_tungstenite::Connector> {
    pin.map(|_| tokio_tungstenite::Connector::Rustls(config_with(pin, None)))
}
