//! Cryptographic primitives for cloud sync.
//!
//! All raw key material is handled here and nowhere else.  Callers receive
//! opaque base64 strings or `Zeroizing<[u8; 32]>` values; they never see
//! intermediate key bytes.
//!
//! Algorithms used:
//!   - Argon2id  — User Master Key (UMK) derivation from password
//!   - AES-256-GCM — symmetric content encryption / group key wrapping
//!   - X25519 ECDH — multi-device key exchange and group key wrapping
//!
//! **Encryption invariant:** The UMK is passed in at call time; it is never
//! written to any file or log.  AAD (`aad`) binds each ciphertext to a
//! specific entry's `client_id`, preventing ciphertext transplanting attacks.

use aes_gcm::{
    aead::{rand_core::RngCore, Aead, AeadCore, KeyInit, OsRng, Payload},
    Aes256Gcm, Key, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use x25519_dalek::{PublicKey as X25519Public, StaticSecret};
use zeroize::Zeroizing;

// Argon2id parameters (OWASP recommendation for interactive logins)
const A2_MEMORY_KB: u32 = 65_536; // 64 MB
const A2_ITERATIONS: u32 = 3;
const A2_PARALLELISM: u32 = 4;

// GCM nonce is 96 bits / 12 bytes
const NONCE_LEN: usize = 12;

// ── Key derivation ──────────────────────────────────────────────────

/// Additional-authenticated-data tag binding a wrapped UMK to its purpose.
const UMK_WRAP_AAD: &str = "umk-envelope-v1";

/// Derive the 32-byte **key-wrapping key (KEK)** from the account password and
/// the per-account KDF salt.
///
/// The KEK never encrypts user data directly — it only wraps/unwraps the random
/// User Master Key (see [`wrap_umk`] / [`unwrap_umk`]).  Decoupling the two means
/// a password change only re-wraps the UMK instead of re-encrypting everything.
///
/// Returned in a `Zeroizing` wrapper so memory is scrubbed on drop.
pub fn derive_kek(password: &str, kdf_salt: &[u8]) -> Zeroizing<[u8; 32]> {
    let params =
        Params::new(A2_MEMORY_KB, A2_ITERATIONS, A2_PARALLELISM, Some(32))
            .expect("valid argon2 params");
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon2
        .hash_password_into(password.as_bytes(), kdf_salt, key.as_mut())
        .expect("argon2 hash");
    key
}

/// Wrap the random UMK under the password-derived `kek`.  Returns the base64
/// envelope blob stored server-side (`nonce || ciphertext || tag`).
pub fn wrap_umk(kek: &[u8; 32], umk: &[u8; 32]) -> Result<String, String> {
    Ok(B64.encode(encrypt_bytes(kek, umk, UMK_WRAP_AAD)?))
}

/// Unwrap the UMK from its base64 envelope using `kek`.  A GCM authentication
/// failure means the password was wrong, surfaced as a clear message.
pub fn unwrap_umk(kek: &[u8; 32], wrapped_b64: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let combined = B64
        .decode(wrapped_b64)
        .map_err(|e| format!("wrapped_umk base64: {e}"))?;
    let bytes = decrypt_bytes(kek, &combined, UMK_WRAP_AAD).map_err(|_| {
        "Incorrect password. It does not match the one this account was encrypted with."
            .to_string()
    })?;
    if bytes.len() != 32 {
        return Err("unwrapped UMK has an unexpected length".into());
    }
    let mut umk = Zeroizing::new([0u8; 32]);
    umk.copy_from_slice(&bytes);
    Ok(umk)
}

/// Generate a fresh random 32-byte symmetric key (used as a Live Share /
/// pool Group Key).  Returned in a `Zeroizing` wrapper.
pub fn random_key() -> Zeroizing<[u8; 32]> {
    let mut key = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(key.as_mut());
    key
}

// ── Symmetric encryption ────────────────────────────────────────────

/// Encrypt `plaintext` with AES-256-GCM using `key` and `aad` as additional
/// authenticated data.
///
/// Output format: `base64(nonce[12] || ciphertext_and_tag)`
pub fn encrypt(key: &[u8; 32], plaintext: &str, aad: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let payload = Payload {
        msg: plaintext.as_bytes(),
        aad: aad.as_bytes(),
    };
    let ciphertext = cipher
        .encrypt(&nonce, payload)
        .map_err(|e| format!("encrypt: {e}"))?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ciphertext);
    Ok(B64.encode(out))
}

/// Encrypt raw bytes (e.g. a blob body) with AES-256-GCM.  Returns the raw
/// `nonce[12] || ciphertext_and_tag` bytes (not base64) ready for blob upload.
pub fn encrypt_bytes(key: &[u8; 32], plaintext: &[u8], aad: &str) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, Payload { msg: plaintext, aad: aad.as_bytes() })
        .map_err(|e| format!("encrypt_bytes: {e}"))?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt raw bytes produced by [`encrypt_bytes`].
pub fn decrypt_bytes(key: &[u8; 32], combined: &[u8], aad: &str) -> Result<Vec<u8>, String> {
    if combined.len() < NONCE_LEN {
        return Err("ciphertext too short".into());
    }
    let (nonce_bytes, payload_bytes) = combined.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(
            Nonce::from_slice(nonce_bytes),
            Payload { msg: payload_bytes, aad: aad.as_bytes() },
        )
        .map_err(|e| format!("decrypt_bytes: {e}"))
}

/// Lowercase hex SHA-256 of `data` — the checksum the blob upload contract wants.
pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(data);
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Generate a PKCE `(code_verifier, code_challenge)` pair for the OAuth 2.0
/// authorization-code flow (RFC 7636, S256 method).
///
/// The verifier is 32 bytes of CSPRNG output, base64url-encoded (43 chars,
/// unreserved set).  The challenge is `BASE64URL(SHA256(ASCII(verifier)))`.
/// The verifier is held only in memory until the token exchange completes.
pub fn pkce_pair() -> (String, String) {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
    use sha2::{Digest, Sha256};

    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    let verifier = B64URL.encode(raw);
    let challenge = B64URL.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// Decrypt a base64-encoded blob produced by [`encrypt`].
pub fn decrypt(key: &[u8; 32], ciphertext_b64: &str, aad: &str) -> Result<String, String> {
    let combined = B64
        .decode(ciphertext_b64)
        .map_err(|e| format!("base64 decode: {e}"))?;
    if combined.len() < NONCE_LEN {
        return Err("ciphertext too short".into());
    }
    let (nonce_bytes, payload_bytes) = combined.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plaintext_bytes = cipher
        .decrypt(
            Nonce::from_slice(nonce_bytes),
            Payload {
                msg: payload_bytes,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|e| format!("decrypt: {e}"))?;
    String::from_utf8(plaintext_bytes).map_err(|e| format!("utf-8: {e}"))
}

// ── X25519 ECDH ─────────────────────────────────────────────────────

/// Generate a fresh X25519 device keypair.
///
/// Returns `(private_key_bytes, public_key_bytes)`.  The private key is
/// wrapped in `Zeroizing` — callers must store it in the OS keychain and
/// clear the in-memory copy as soon as possible.
pub fn generate_device_keypair() -> (Zeroizing<[u8; 32]>, [u8; 32]) {
    let private = StaticSecret::random_from_rng(OsRng);
    let public = X25519Public::from(&private);
    (Zeroizing::new(private.to_bytes()), public.to_bytes())
}

/// Public half of an X25519 private key — used when reusing a stored device
/// key instead of registering a fresh device on every login.
pub fn device_public_key(privkey: &[u8; 32]) -> [u8; 32] {
    X25519Public::from(&StaticSecret::from(*privkey)).to_bytes()
}

/// Derive the per-user **identity** X25519 keypair deterministically from the
/// UMK.  Because the UMK is identical on every one of a user's devices (shared
/// via §7.3 wrapping), so is this keypair — no cross-device distribution and no
/// server-side storage of the private half are needed.  Only the public key is
/// registered (`POST /auth/keys/register`) so peers can wrap Group Keys for us.
///
/// The UMK is already a uniformly-random 256-bit key, so a memory-hard KDF is
/// unnecessary here; we use Argon2id with minimal parameters purely for domain
/// separation from the content-encryption use of the UMK.
pub fn derive_identity_keypair(umk: &[u8; 32]) -> (Zeroizing<[u8; 32]>, [u8; 32]) {
    const IDENTITY_SALT: &[u8] = b"orange-clipboard-identity-key-v1";
    let params = Params::new(8, 1, 1, Some(32)).expect("valid argon2 params");
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut seed = Zeroizing::new([0u8; 32]);
    argon2
        .hash_password_into(umk, IDENTITY_SALT, seed.as_mut())
        .expect("argon2 identity derive");
    let secret = StaticSecret::from(*seed);
    let public = X25519Public::from(&secret);
    (Zeroizing::new(secret.to_bytes()), public.to_bytes())
}

/// Compute the X25519 shared secret for ECDH key exchange.  Used for
/// wrapping space keys when distributing them to members.
pub fn x25519_shared_secret(
    privkey_bytes: &[u8; 32],
    peer_pubkey_bytes: &[u8; 32],
) -> Zeroizing<[u8; 32]> {
    let private = StaticSecret::from(*privkey_bytes);
    let peer_public = X25519Public::from(*peer_pubkey_bytes);
    let shared = private.diffie_hellman(&peer_public);
    Zeroizing::new(*shared.as_bytes())
}

// ── Key wrapping ────────────────────────────────────────────────────

/// Wrap a 32-byte key with AES-256-GCM under `wrapping_key`.
///
/// Used for distributing Group Keys during Live Share session setup.  The
/// output is safe to store in `id_map.json` or transmit to the server.
pub fn wrap_key(wrapping_key: &[u8; 32], key_to_wrap: &[u8; 32]) -> Result<String, String> {
    let inner_b64 = B64.encode(key_to_wrap);
    encrypt(wrapping_key, &inner_b64, "key-wrap")
}

/// Unwrap a key produced by [`wrap_key`].
pub fn unwrap_key(
    wrapping_key: &[u8; 32],
    wrapped_b64: &str,
) -> Result<Zeroizing<[u8; 32]>, String> {
    let inner_b64 = decrypt(wrapping_key, wrapped_b64, "key-wrap")?;
    let bytes = B64
        .decode(&inner_b64)
        .map_err(|e| format!("inner base64 decode: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("expected 32-byte key, got {} bytes", bytes.len()));
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&bytes);
    Ok(key)
}

// ── Device key persistence helpers ──────────────────────────────────

const KEYRING_SERVICE: &str = "orange-clipboard";

fn keyring_user_for(purpose: &str, user_id: &str) -> String {
    format!("{purpose}:{user_id}")
}

/// Store the device private key in the OS keychain for `user_id`.
pub fn store_device_private_key(user_id: &str, privkey: &[u8; 32]) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &keyring_user_for("device_key", user_id))
        .map_err(|e| e.to_string())?;
    let encoded = B64.encode(privkey);
    entry.set_password(&encoded).map_err(|e| e.to_string())
}

/// Retrieve the device private key from the OS keychain for `user_id`.
pub fn load_device_private_key(user_id: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &keyring_user_for("device_key", user_id))
        .map_err(|e| e.to_string())?;
    let encoded = entry.get_password().map_err(|e| e.to_string())?;
    let bytes = B64.decode(&encoded).map_err(|e| format!("base64: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("expected 32-byte key, got {} bytes", bytes.len()));
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&bytes);
    Ok(key)
}

/// Store the refresh token in the OS keychain.
pub fn store_refresh_token(user_id: &str, token: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &keyring_user_for("refresh_token", user_id))
        .map_err(|e| e.to_string())?;
    entry.set_password(token).map_err(|e| e.to_string())
}

/// Load the refresh token from the OS keychain.
pub fn load_refresh_token(user_id: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &keyring_user_for("refresh_token", user_id))
        .map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| e.to_string())
}

/// Delete the refresh token and device key from the OS keychain.
pub fn delete_keychain_entries(user_id: &str) {
    if let Ok(rt) = keyring::Entry::new(KEYRING_SERVICE, &keyring_user_for("refresh_token", user_id)) {
        let _ = rt.delete_password();
    }
    if let Ok(dk) = keyring::Entry::new(KEYRING_SERVICE, &keyring_user_for("device_key", user_id)) {
        let _ = dk.delete_password();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Owner → member: the Group Key survives a wrap/unwrap round trip through an
    /// X25519 shared secret derived from opposite halves of the two keypairs.
    #[test]
    fn group_key_wrap_roundtrip_between_two_parties() {
        let owner_umk = random_key();
        let member_umk = random_key();
        let (owner_priv, owner_pub) = derive_identity_keypair(&owner_umk);
        let (member_priv, member_pub) = derive_identity_keypair(&member_umk);

        let group_key = random_key();

        let sending = x25519_shared_secret(&owner_priv, &member_pub);
        let wrapped = wrap_key(&sending, &group_key).expect("wrap");

        let receiving = x25519_shared_secret(&member_priv, &owner_pub);
        let unwrapped = unwrap_key(&receiving, &wrapped).expect("unwrap");

        assert_eq!(*unwrapped, *group_key);
    }

    /// Owner → owner: the same path must work when a member wraps for *itself*,
    /// which is how the group owner recovers its own key after a restart.
    #[test]
    fn group_key_self_wrap_roundtrip() {
        let umk = random_key();
        let (id_priv, id_pub) = derive_identity_keypair(&umk);
        let group_key = random_key();

        let shared = x25519_shared_secret(&id_priv, &id_pub);
        let wrapped = wrap_key(&shared, &group_key).expect("wrap");
        let unwrapped = unwrap_key(&shared, &wrapped).expect("unwrap");

        assert_eq!(*unwrapped, *group_key);
    }

    /// A member who was never wrapped for cannot unwrap someone else's blob.
    #[test]
    fn group_key_unwrap_fails_for_wrong_recipient() {
        let (owner_priv, _owner_pub) = derive_identity_keypair(&random_key());
        let (_m1_priv, m1_pub) = derive_identity_keypair(&random_key());
        let (outsider_priv, owner_pub) = (
            derive_identity_keypair(&random_key()).0,
            derive_identity_keypair(&random_key()).1,
        );

        let wrapped = wrap_key(&x25519_shared_secret(&owner_priv, &m1_pub), &random_key())
            .expect("wrap");
        let wrong = x25519_shared_secret(&outsider_priv, &owner_pub);
        assert!(unwrap_key(&wrong, &wrapped).is_err(), "AES-GCM must reject");
    }

    /// Identity keypairs are derived from the UMK, so every device of the same
    /// user reproduces them — the property group-key wrapping depends on.
    #[test]
    fn identity_keypair_is_deterministic_from_umk() {
        let umk = random_key();
        let (a_priv, a_pub) = derive_identity_keypair(&umk);
        let (b_priv, b_pub) = derive_identity_keypair(&umk);
        assert_eq!(*a_priv, *b_priv);
        assert_eq!(a_pub, b_pub);
    }
}
