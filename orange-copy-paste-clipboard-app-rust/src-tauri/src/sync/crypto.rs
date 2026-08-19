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
/// via section 7.3 wrapping), so is this keypair — no cross-device distribution and no
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

/// The one place a `keyring::Entry` is constructed, so the service/user naming
/// cannot drift between the read, write and delete paths - a mismatch there
/// reads as "you were never signed in".
fn entry_for(purpose: &str, user_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("{purpose}:{user_id}")).map_err(|e| e.to_string())
}

/// Attempts for a keychain write, and the pause between them.
///
/// The credential store is not always ready the instant the app is: an in-app
/// update relaunches immediately, and an autostart entry runs while the user
/// profile is still coming up. A write that is dropped here is not a cosmetic
/// failure - it leaves a rotated refresh token spent with nothing on disk, which
/// signs the user out on the next launch.
/// Roughly 40ms, then doubling, for a total of about 2.5s across six tries.
/// Three tries at a flat 40ms only spanned ~120ms, which covers a store that is
/// a moment behind the app but not one held by an antivirus scanner or a user
/// profile still coming up. The cost of losing one of these writes is the whole
/// session, and a couple of seconds inside a sign-in is not felt.
const KEYCHAIN_WRITE_BACKOFF_MS: [u64; 5] = [40, 80, 200, 600, 1500];

/// Read one secret, telling "there is no such entry" apart from "the store would
/// not answer".
///
/// The distinction is the whole point: an absent entry means the user really has
/// to sign in, while an unreachable store on a launch that raced the OS is worth
/// retrying a few seconds later. Collapsing both into an error is what turns a
/// working login into what looks like a logout.
fn read_secret(purpose: &str, user_id: &str) -> Result<Option<String>, String> {
    match entry_for(purpose, user_id)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Write one secret, retrying a store that is briefly unavailable.
///
/// Async because every caller is, and the retry parks its thread: the sync
/// runtime has two workers, so parking one (usually with the refresh lock held)
/// stalls every other sync task for the duration. `spawn_blocking` belongs here
/// rather than at each call site, so no writer can forget it.
async fn write_secret(purpose: &'static str, user_id: &str, secret: &str) -> Result<(), String> {
    let user_id = user_id.to_string();
    let secret = secret.to_string();
    tokio::task::spawn_blocking(move || {
        let mut last = String::new();
        // A leading zero so the first attempt runs immediately and the schedule
        // describes only the waits after it.
        for delay in std::iter::once(0).chain(KEYCHAIN_WRITE_BACKOFF_MS) {
            if delay > 0 {
                std::thread::sleep(std::time::Duration::from_millis(delay));
            }
            match entry_for(purpose, &user_id)
                .and_then(|entry| entry.set_password(&secret).map_err(|e| e.to_string()))
            {
                Ok(()) => return Ok(()),
                Err(e) => last = e,
            }
        }
        Err(last)
    })
    .await
    .unwrap_or_else(|e| Err(format!("keychain task: {e}")))
}

/// Delete one secret. Absent is success - the caller wanted it gone.
fn delete_secret(purpose: &str, user_id: &str) {
    if let Ok(entry) = entry_for(purpose, user_id) {
        let _ = entry.delete_password();
    }
}

/// Store the device private key in the OS keychain for `user_id`.
pub async fn store_device_private_key(user_id: &str, privkey: &[u8; 32]) -> Result<(), String> {
    write_secret("device_key", user_id, &B64.encode(privkey)).await
}

/// Retrieve the device private key from the OS keychain for `user_id`.
///
/// `Ok(None)` means there is no stored key; `Err` means the store would not
/// answer, which is worth retrying (see [`read_secret`]).
pub fn load_device_private_key(user_id: &str) -> Result<Option<Zeroizing<[u8; 32]>>, String> {
    let Some(encoded) = read_secret("device_key", user_id)? else {
        return Ok(None);
    };
    let bytes = B64.decode(&encoded).map_err(|e| format!("base64: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("expected 32-byte key, got {} bytes", bytes.len()));
    }
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&bytes);
    Ok(Some(key))
}

/// Store the refresh token in the OS keychain.
pub async fn store_refresh_token(user_id: &str, token: &str) -> Result<(), String> {
    write_secret("refresh_token", user_id, token).await
}

/// Load the refresh token from the OS keychain.
///
/// `Ok(None)` means there is nothing stored; `Err` means the store would not
/// answer (see [`read_secret`]).
pub fn load_refresh_token(user_id: &str) -> Result<Option<String>, String> {
    read_secret("refresh_token", user_id)
}

/// Delete the refresh token and device key from the OS keychain.
pub fn delete_keychain_entries(user_id: &str) {
    delete_secret("refresh_token", user_id);
    delete_secret("device_key", user_id);
}

/// The account slot for secrets that belong to the install rather than to any
/// one user. Not a user id, and cannot collide with one: user ids are UUIDs.
const INSTALL_SCOPE: &str = "_install";

/// A random per-install value standing in for a machine id the OS will not give
/// us (a container, a blank registry, a hardened host).
///
/// Generated once and kept in the keychain rather than a file, so it outlives a
/// reset of the app data directory - which is exactly the case the fingerprint
/// exists to survive. A write failure is not fatal: the caller gets a usable
/// value for this run, and the worst case is a fingerprint that changes next
/// launch, which costs a duplicate device row and nothing more.
pub async fn machine_seed() -> String {
    if let Ok(Some(seed)) = read_secret("fp_seed", INSTALL_SCOPE) {
        if !seed.is_empty() {
            return seed;
        }
    }
    let seed = B64.encode(random_key().as_slice());
    if let Err(e) = write_secret("fp_seed", INSTALL_SCOPE, &seed).await {
        eprintln!("[sync] fingerprint seed not stored: {e}");
    }
    seed
}

/// Remember which account and device this install last signed in as.
///
/// A mirror of the same two fields in `sync_state.json`. That file is app data:
/// an uninstall, a reset, or a health quarantine takes it, and with it the only
/// pointer to the credentials sitting untouched in the keychain - so a launch
/// with everything intact still asks for a password. Keeping a copy beside the
/// credentials themselves closes that.
///
/// Deliberately not a secret; it lives here for the storage lifetime, not for
/// the protection.
pub async fn store_session_pointer(user_id: &str, device_id: &str) -> Result<(), String> {
    write_secret("session", INSTALL_SCOPE, &format!("{user_id}:{device_id}")).await
}

/// The `(user_id, device_id)` of the last sign-in on this install.
pub fn load_session_pointer() -> Option<(String, String)> {
    let raw = read_secret("session", INSTALL_SCOPE).ok().flatten()?;
    let (user, device) = raw.split_once(':')?;
    if user.is_empty() || device.is_empty() {
        return None;
    }
    Some((user.to_string(), device.to_string()))
}

/// Forget the last sign-in. Called on an explicit sign-out, so the next launch
/// does not try to restore an account the user deliberately left.
pub fn clear_session_pointer() {
    delete_secret("session", INSTALL_SCOPE);
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
