//! Cryptographic primitives for cloud sync.
//!
//! All raw key material is handled here and nowhere else.  Callers receive
//! opaque base64 strings or `Zeroizing<[u8; 32]>` values; they never see
//! intermediate key bytes.
//!
//! Algorithms used:
//!   - Argon2id  — stretches the account password (and the recovery code)
//!   - HKDF-SHA256 — splits the stretched password into an auth key and a KEK
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
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey as X25519Public, StaticSecret};
use zeroize::Zeroizing;

// Argon2id parameters (OWASP recommendation for interactive logins)
const A2_MEMORY_KB: u32 = 65_536; // 64 MB
const A2_ITERATIONS: u32 = 3;
const A2_PARALLELISM: u32 = 4;

// GCM nonce is 96 bits / 12 bytes
const NONCE_LEN: usize = 12;

// ── Key derivation ──────────────────────────────────────────────────

/// Additional-authenticated-data tag of the current password envelope: the UMK
/// wrapped under the HKDF-split KEK of [`derive_kek`].
const UMK_WRAP_AAD: &str = "umk-envelope-v2";

/// AAD of the envelope format before the split, when the KEK was
/// `Argon2id(password, kdf_salt)` directly. Still opened by
/// [`unwrap_umk_legacy`] so an account can be migrated on its next sign-in;
/// never written any more.
const UMK_WRAP_AAD_LEGACY: &str = "umk-envelope-v1";

/// Domain tag mixed into the salt the password is stretched under.
const AUTH_SALT_INFO: &str = "orange-copy-paste/auth-salt/v2:";
/// HKDF info of the half that is sent to Supabase as the account password.
const AUTH_KEY_INFO: &[u8] = b"orange-copy-paste/auth-key/v2";
/// HKDF info of the half that wraps the UMK and never leaves the device.
const KEK_INFO: &[u8] = b"orange-copy-paste/kek/v2";
/// HKDF info of the proof-of-possession the server asks for before it lets a
/// caller replace or delete a copy of the UMK.
const UMK_PROOF_INFO: &[u8] = b"orange-copy-paste/umk-proof/v1";

/// A value only a holder of the UMK can produce, sent as `X-Umk-Proof` on the
/// routes that overwrite or delete an envelope or a device wrap.
///
/// A bearer token alone used to be enough to blank every copy of the master
/// key - password envelope, recovery envelope, each device wrap - which turned a
/// stolen access token into permanent data loss. The server keeps only the
/// SHA-256 of this value, so a database read does not yield it, and the value
/// itself is one-way from the UMK.
pub fn umk_proof(umk: &[u8; 32]) -> Zeroizing<String> {
    let hk = Hkdf::<Sha256>::new(None, umk);
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(UMK_PROOF_INFO, out.as_mut())
        .expect("32 bytes is a valid HKDF output length");
    Zeroizing::new(B64.encode(out.as_ref()))
}

/// The account password after one Argon2id pass, before it is split.
///
/// Nothing derived from this may be used for two purposes: the split in
/// [`derive_auth_key`] and [`derive_kek`] exists so that the value Supabase Auth
/// stores a hash of - and the value an attacker with our database can guess at
/// bcrypt speed - reveals nothing about the key that opens the data. Before the
/// split the raw password was sent to Supabase and also derived the KEK, so a
/// bcrypt-speed guess against `auth.users` bypassed the memory-hard KDF entirely.
///
/// The salt is the address, not a server-issued value, because the master has to
/// exist *before* sign-in (it produces the credential) and the only thing known
/// about the account at that point is what the user typed. Normalized, so a
/// capitalized address on one machine still opens the account on another.
pub fn derive_master(password: &str, email: &str) -> Zeroizing<[u8; 32]> {
    let mut hasher = Sha256::new();
    hasher.update(AUTH_SALT_INFO.as_bytes());
    hasher.update(normalize_email(email).as_bytes());
    let salt = hasher.finalize();
    argon2id_32(password.as_bytes(), &salt)
}

/// The address as it enters the salt: surrounding whitespace off, lower case.
fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

/// The credential presented to Supabase Auth in place of the password:
/// sign-in, sign-up and every `PUT /user`. Base64 so it survives as a JSON
/// string and clears any length-based password rule.
///
/// One-way from the master and independent of [`derive_kek`]: capturing it in
/// transit, or cracking its bcrypt hash out of `auth.users`, yields the ability
/// to sign in and nothing else.
pub fn derive_auth_key(master: &[u8; 32]) -> Zeroizing<String> {
    let hk = Hkdf::<Sha256>::new(None, master);
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(AUTH_KEY_INFO, out.as_mut())
        .expect("32 bytes is a valid HKDF output length");
    Zeroizing::new(B64.encode(out.as_ref()))
}

/// The 32-byte **key-wrapping key (KEK)**: the other half of the split, bound
/// to the account's server-issued `kdf_salt`.
///
/// The KEK never encrypts user data directly — it only wraps/unwraps the random
/// User Master Key (see [`wrap_umk`] / [`unwrap_umk`]).  Decoupling the two means
/// a password change only re-wraps the UMK instead of re-encrypting everything.
///
/// Returned in a `Zeroizing` wrapper so memory is scrubbed on drop.
pub fn derive_kek(master: &[u8; 32], kdf_salt: &[u8]) -> Zeroizing<[u8; 32]> {
    let hk = Hkdf::<Sha256>::new(Some(kdf_salt), master);
    let mut key = Zeroizing::new([0u8; 32]);
    hk.expand(KEK_INFO, key.as_mut())
        .expect("32 bytes is a valid HKDF output length");
    key
}

/// The KEK of the format before the split: Argon2id over the raw password and
/// `kdf_salt`. Only for opening an envelope written by an older client, so it
/// can be re-wrapped under [`derive_kek`].
pub fn derive_legacy_kek(password: &str, kdf_salt: &[u8]) -> Zeroizing<[u8; 32]> {
    argon2id_32(password.as_bytes(), kdf_salt)
}

/// Argon2id, 64 MB / 3 passes / 4 lanes, to 32 bytes. The one memory-hard step;
/// everything the password or the recovery code derives goes through it.
fn argon2id_32(secret: &[u8], salt: &[u8]) -> Zeroizing<[u8; 32]> {
    let params =
        Params::new(A2_MEMORY_KB, A2_ITERATIONS, A2_PARALLELISM, Some(32))
            .expect("valid argon2 params");
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon2
        .hash_password_into(secret, salt, key.as_mut())
        .expect("argon2 hash");
    key
}

/// Wrap the random UMK under the `kek` of [`derive_kek`].  Returns the base64
/// envelope blob stored server-side (`nonce || ciphertext || tag`).
pub fn wrap_umk(kek: &[u8; 32], umk: &[u8; 32]) -> Result<String, String> {
    Ok(B64.encode(encrypt_bytes(kek, umk, UMK_WRAP_AAD)?))
}

/// Unwrap the UMK from its base64 envelope using `kek`.  A GCM authentication
/// failure means the password was wrong, surfaced as a clear message.
pub fn unwrap_umk(kek: &[u8; 32], wrapped_b64: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    unwrap_umk_with(kek, wrapped_b64, UMK_WRAP_AAD)
}

/// Unwrap an envelope written before the split, with the KEK of
/// [`derive_legacy_kek`]. The caller re-wraps the result under [`wrap_umk`].
pub fn unwrap_umk_legacy(
    kek: &[u8; 32],
    wrapped_b64: &str,
) -> Result<Zeroizing<[u8; 32]>, String> {
    unwrap_umk_with(kek, wrapped_b64, UMK_WRAP_AAD_LEGACY)
}

fn unwrap_umk_with(
    kek: &[u8; 32],
    wrapped_b64: &str,
    aad: &str,
) -> Result<Zeroizing<[u8; 32]>, String> {
    let combined = B64
        .decode(wrapped_b64)
        .map_err(|e| format!("wrapped_umk base64: {e}"))?;
    let bytes = decrypt_bytes(kek, &combined, aad).map_err(|_| {
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

/// Alphabet for a recovery code. These get read off a screen, written on paper,
/// and typed back months later, so the look-alikes are gone: no `O` or `0`, no
/// `I` or `1`. `L` stays - with `1` and `I` both absent there is nothing left for
/// it to be confused with.
///
/// 24 letters plus 8 digits is exactly 32 symbols, so each character carries 5
/// bits with no modulo bias when sampling a random byte's low 5 bits.
const RECOVERY_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Groups of five, six groups: 30 characters, 150 bits of entropy.
const RECOVERY_GROUPS: usize = 6;
const RECOVERY_GROUP_LEN: usize = 5;

/// AAD binding the recovery envelope to its purpose, separate from
/// [`UMK_WRAP_AAD`].
///
/// Both envelopes hold the same UMK and share the account's `kdf_salt` - the
/// difference is only which secret derives the key. The distinct tag is what
/// makes feeding one envelope to the other's unwrap fail loudly instead of
/// looking like a wrong password.
const UMK_RECOVERY_AAD: &str = "umk-recovery-v1";

/// Mint a recovery code, in the dash-separated form the user is shown.
///
/// 150 bits from the OS RNG - not derived from anything, because a code derived
/// from the password would be lost with it, which is the whole point of having
/// one.
pub fn generate_recovery_code() -> Zeroizing<String> {
    let mut raw = Zeroizing::new([0u8; RECOVERY_GROUPS * RECOVERY_GROUP_LEN]);
    OsRng.fill_bytes(raw.as_mut());
    let mut out = String::with_capacity(RECOVERY_GROUPS * (RECOVERY_GROUP_LEN + 1));
    for (i, byte) in raw.iter().enumerate() {
        if i > 0 && i % RECOVERY_GROUP_LEN == 0 {
            out.push('-');
        }
        out.push(RECOVERY_ALPHABET[(byte & 0x1f) as usize] as char);
    }
    Zeroizing::new(out)
}

/// Canonical form of a code the user typed: dashes and spaces out, uppercased.
///
/// Whatever they paste - with the dashes, without them, in lower case, with a
/// stray space from a mail client - has to derive the same key, or a correct code
/// reads as a wrong one.
pub fn normalize_recovery_code(input: &str) -> Zeroizing<String> {
    Zeroizing::new(
        input
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .flat_map(char::to_uppercase)
            .collect(),
    )
}

/// Wrap the UMK under a key derived from `recovery_code`.
///
/// Same Argon2id step and same `kdf_salt` as the legacy password envelope; only
/// the secret and the AAD differ. The code is typed into the app and nowhere
/// else, so unlike the password it needs no split. The caller passes the code as typed - normalizing happens here, so no
/// call site can forget it.
pub fn wrap_umk_recovery(
    recovery_code: &str,
    kdf_salt: &[u8],
    umk: &[u8; 32],
) -> Result<String, String> {
    let key = argon2id_32(normalize_recovery_code(recovery_code).as_bytes(), kdf_salt);
    Ok(B64.encode(encrypt_bytes(&key, umk, UMK_RECOVERY_AAD)?))
}

/// Recover the UMK from the recovery envelope.
///
/// A GCM failure here means the code is wrong (or belongs to another account),
/// which is indistinguishable and is reported as one thing.
pub fn unwrap_umk_recovery(
    recovery_code: &str,
    kdf_salt: &[u8],
    wrapped_b64: &str,
) -> Result<Zeroizing<[u8; 32]>, String> {
    let key = argon2id_32(normalize_recovery_code(recovery_code).as_bytes(), kdf_salt);
    let combined = B64
        .decode(wrapped_b64)
        .map_err(|e| format!("recovery envelope base64: {e}"))?;
    let bytes = decrypt_bytes(&key, &combined, UMK_RECOVERY_AAD)
        .map_err(|_| "That recovery code does not match this account.".to_string())?;
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
    let digest = Sha256::digest(data);
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Fingerprint of a Space Key: the first 16 bytes of `SHA-256("space-key-v1" || key)`,
/// lowercase hex.
///
/// The owner publishes this when it mints a key, and a member checks a keyring it
/// was handed against it before adopting it. Without the check, another member
/// could hand a newcomer a key that is not this space's: an unwrap with the wrong
/// wrapping key fails, but a *correctly wrapped wrong key* unwraps fine, and the
/// victim would then silently decrypt nothing. A hash of 32 random bytes tells the
/// server that stores it nothing about the key, and the domain prefix keeps it from
/// ever colliding with another hash this app publishes.
pub fn space_key_fingerprint(key: &[u8; 32]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"space-key-v1");
    hasher.update(key);
    let digest = hasher.finalize();
    let mut s = String::with_capacity(32);
    for b in &digest[..16] {
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
///
/// Refuses a non-contributory result. A peer who registers a low-order public
/// key makes every keyholder wrap the ring under an all-zero secret, readable by
/// anyone; `Err` here is what stops that key ever being wrapped to.
pub fn x25519_shared_secret(
    privkey_bytes: &[u8; 32],
    peer_pubkey_bytes: &[u8; 32],
) -> Result<Zeroizing<[u8; 32]>, String> {
    let private = StaticSecret::from(*privkey_bytes);
    let peer_public = X25519Public::from(*peer_pubkey_bytes);
    let shared = private.diffie_hellman(&peer_public);
    if !shared.was_contributory() {
        return Err("peer public key is not a valid X25519 point".into());
    }
    Ok(Zeroizing::new(*shared.as_bytes()))
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
/// An empty value is reported as absent, not as a secret. Windows Credential
/// Manager answers a zero-length blob with `Ok("")` rather than `NoEntry`, and
/// the callers here all treat `Some` as "this is usable" - so an empty string
/// reached GoTrue as a refresh token and came back 400, which is a permanent
/// sign-out where "nothing is stored" was the truth.
fn read_secret(purpose: &str, user_id: &str) -> Result<Option<String>, String> {
    match entry_for(purpose, user_id)?.get_password() {
        Ok(secret) if secret.is_empty() => Ok(None),
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
///
/// `Ok(None)` means no sign-in was ever recorded here; `Err` means the store
/// would not answer, which is worth retrying (see [`read_secret`]). Collapsing
/// the two - which this used to do with `.ok().flatten()` - turned a credential
/// store that was busy for a moment into "you were never signed in", and that
/// verdict is not retried. The distinction only matters when `sync_state.json`
/// is also unreadable, but both faults have the same cause (contention at
/// logon), so they arrive together.
pub fn load_session_pointer() -> Result<Option<(String, String)>, String> {
    let Some(raw) = read_secret("session", INSTALL_SCOPE)? else {
        return Ok(None);
    };
    let Some((user, device)) = raw.split_once(':') else {
        return Ok(None);
    };
    if user.is_empty() || device.is_empty() {
        return Ok(None);
    }
    Ok(Some((user.to_string(), device.to_string())))
}

/// Forget the last sign-in. Called on an explicit sign-out, so the next launch
/// does not try to restore an account the user deliberately left.
pub fn clear_session_pointer() {
    delete_secret("session", INSTALL_SCOPE);
}

/// Keep the PKCE verifier for a password-reset link that has just been emailed.
///
/// The keychain rather than a field in memory, because the two halves of a reset
/// are separated by however long the user takes to open their mail - usually a
/// later run of the app, often after a restart. It is a capability, not a scratch
/// value: whoever holds it can redeem the code in that email, which is exactly
/// why it never leaves this machine and never goes in app data.
///
/// Install-scoped: a reset is requested while signed out, so there is no user id
/// to key it by. Only one reset can be in flight per install, which matches how
/// GoTrue treats the code anyway - a second request invalidates the first.
pub async fn store_reset_verifier(verifier: &str) -> Result<(), String> {
    write_secret("pkce_reset", INSTALL_SCOPE, verifier).await
}

/// The verifier for the reset link this install requested, if it requested one.
pub fn load_reset_verifier() -> Option<String> {
    read_secret("pkce_reset", INSTALL_SCOPE)
        .ok()
        .flatten()
        .filter(|v| !v.is_empty())
}

/// Spend the verifier. Called once the code has been exchanged, successfully or
/// not: the code is one-time either way, so keeping the verifier only leaves a
/// capability lying around for a link that can no longer be redeemed.
pub fn clear_reset_verifier() {
    delete_secret("pkce_reset", INSTALL_SCOPE);
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

        let sending = x25519_shared_secret(&owner_priv, &member_pub).unwrap();
        let wrapped = wrap_key(&sending, &group_key).expect("wrap");

        let receiving = x25519_shared_secret(&member_priv, &owner_pub).unwrap();
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

        let shared = x25519_shared_secret(&id_priv, &id_pub).unwrap();
        let wrapped = wrap_key(&shared, &group_key).expect("wrap");
        let unwrapped = unwrap_key(&shared, &wrapped).expect("unwrap");

        assert_eq!(*unwrapped, *group_key);
    }

    /// The two halves of the split share nothing an observer of one could use on
    /// the other, and the credential is a full 32 bytes of base64 - long enough
    /// for any length-based password rule, and never the password itself.
    #[test]
    fn password_split_yields_independent_halves() {
        let master = derive_master("correct horse battery staple", "user@example.com");
        let kdf_salt = random_key();
        let auth_key = derive_auth_key(&master);
        let kek = derive_kek(&master, kdf_salt.as_ref());

        let auth_bytes = B64.decode(auth_key.as_str()).expect("base64");
        assert_eq!(auth_bytes.len(), 32);
        assert_ne!(auth_bytes.as_slice(), kek.as_ref());
        assert_ne!(auth_bytes.as_slice(), master.as_ref());
        assert_ne!(auth_key.as_str(), "correct horse battery staple");
        // A different account salt yields a different KEK from the same master.
        assert_ne!(*derive_kek(&master, random_key().as_ref()), *kek);
    }

    /// The address is the salt, so however it is capitalized or padded on a
    /// second machine the same credential has to come out - and a different
    /// address must not.
    #[test]
    fn master_salt_normalizes_email_case_and_whitespace() {
        let a = derive_master("pw", "User@Example.com");
        let b = derive_master("pw", "  user@example.com ");
        let c = derive_master("pw", "other@example.com");
        assert_eq!(*a, *b);
        assert_ne!(*a, *c);
    }

    /// An envelope written before the split opens only through the legacy path,
    /// and one written now only through the current one: the AADs keep them apart
    /// so a migration can tell which it is holding.
    #[test]
    fn legacy_and_current_envelopes_do_not_cross_open() {
        let umk = random_key();
        let kdf_salt = random_key();
        let legacy_kek = derive_legacy_kek("pw", kdf_salt.as_ref());
        let legacy_envelope = B64.encode(
            encrypt_bytes(&legacy_kek, umk.as_ref(), UMK_WRAP_AAD_LEGACY).expect("wrap"),
        );
        assert_eq!(*unwrap_umk_legacy(&legacy_kek, &legacy_envelope).expect("legacy"), *umk);
        assert!(unwrap_umk(&legacy_kek, &legacy_envelope).is_err());

        let kek = derive_kek(&derive_master("pw", "a@b.c"), kdf_salt.as_ref());
        let envelope = wrap_umk(&kek, &umk).expect("wrap");
        assert_eq!(*unwrap_umk(&kek, &envelope).expect("current"), *umk);
        assert!(unwrap_umk_legacy(&kek, &envelope).is_err());
    }

    /// The shape the user is shown, and the entropy behind it.
    #[test]
    fn recovery_code_is_six_groups_of_five_from_the_safe_alphabet() {
        let code = generate_recovery_code();
        let groups: Vec<&str> = code.split('-').collect();
        assert_eq!(groups.len(), 6);
        assert!(groups.iter().all(|g| g.len() == 5));
        assert!(code
            .chars()
            .filter(|c| *c != '-')
            .all(|c| RECOVERY_ALPHABET.contains(&(c as u8))));
        // Two codes in a row must not match; a fixed code would be catastrophic.
        assert_ne!(*code, *generate_recovery_code());
    }

    /// However the user types it back, the same key has to come out.
    #[test]
    fn recovery_code_normalizes_dashes_spaces_and_case() {
        let canonical = normalize_recovery_code("ABCDE-FGHJK");
        assert_eq!(*canonical, "ABCDEFGHJK");
        assert_eq!(*normalize_recovery_code("abcde fghjk"), *canonical);
        assert_eq!(*normalize_recovery_code(" abcdefghjk "), *canonical);
    }

    /// The recovery envelope opens with the code, in any of its typed forms.
    #[test]
    fn recovery_envelope_roundtrips_however_the_code_was_typed() {
        let umk = random_key();
        let salt = b"account-kdf-salt";
        let code = generate_recovery_code();

        let wrapped = wrap_umk_recovery(&code, salt, &umk).expect("wrap");
        let recovered = unwrap_umk_recovery(&code, salt, &wrapped).expect("unwrap");
        assert_eq!(*recovered, *umk);

        let retyped = code.to_lowercase().replace('-', " ");
        let recovered = unwrap_umk_recovery(&retyped, salt, &wrapped).expect("unwrap retyped");
        assert_eq!(*recovered, *umk);
    }

    /// A wrong code fails, and so does the right code against another account's
    /// salt - the salt is part of what binds an envelope to its account.
    #[test]
    fn recovery_envelope_rejects_a_wrong_code_or_salt() {
        let umk = random_key();
        let salt = b"account-kdf-salt";
        let code = generate_recovery_code();
        let wrapped = wrap_umk_recovery(&code, salt, &umk).expect("wrap");

        assert!(unwrap_umk_recovery(&generate_recovery_code(), salt, &wrapped).is_err());
        assert!(unwrap_umk_recovery(&code, b"another-salt", &wrapped).is_err());
    }

    /// The legacy password envelope and the recovery envelope share the account
    /// salt and the KDF, so only the AAD keeps them apart. Feeding one to the
    /// other's unwrap must fail rather than half-work.
    #[test]
    fn password_and_recovery_envelopes_are_not_interchangeable() {
        let umk = random_key();
        let salt = b"account-kdf-salt";
        let secret = "the-same-string-as-both";

        let legacy_kek = derive_legacy_kek(secret, salt);
        let pw_envelope =
            B64.encode(encrypt_bytes(&legacy_kek, umk.as_ref(), UMK_WRAP_AAD_LEGACY).expect("wrap pw"));
        let rec_envelope = wrap_umk_recovery(secret, salt, &umk).expect("wrap recovery");

        assert!(unwrap_umk_recovery(secret, salt, &pw_envelope).is_err());
        assert!(unwrap_umk_legacy(&legacy_kek, &rec_envelope).is_err());
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

        let wrapped = wrap_key(&x25519_shared_secret(&owner_priv, &m1_pub).unwrap(), &random_key())
            .expect("wrap");
        let wrong = x25519_shared_secret(&outsider_priv, &owner_pub).unwrap();
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
