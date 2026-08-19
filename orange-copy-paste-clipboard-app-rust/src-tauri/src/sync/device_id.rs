//! A stable per-machine fingerprint, for telling this install's device rows
//! apart from other machines on the same account.
//!
//! What this is **not**: proof of identity. The device's identity is its X25519
//! keypair, whose private half is in the OS keychain and is the only thing that
//! can decrypt that device's wrapped UMK. A fingerprint only nominates a
//! candidate row; reuse still requires the key. That distinction is what keeps
//! machines imaged from one base - which share a machine id, and therefore a
//! fingerprint - from claiming each other's registrations.
//!
//! Privacy: the raw machine id never leaves the device. What is sent is
//! `SHA256(DOMAIN || machine_id || user_id)`, so the id is not recoverable from
//! it and the same machine under two accounts produces two unrelated values.

use crate::sync::crypto;

/// Domain separator, versioned so the derivation can change without a stale
/// value from an older build colliding with a new one.
const DOMAIN: &str = "rovertools-device-v1";

/// This machine's fingerprint for `user_id`, as 64 lowercase hex characters.
///
/// Never fails: a machine with no readable id falls back to a random seed kept
/// in the keychain, which is stable for this install and survives the loss of
/// `sync_state.json`. Registration must not be blocked by a fingerprint, since
/// it is only ever a hint.
pub async fn fingerprint(user_id: &str) -> String {
    let machine = match machine_id() {
        Some(id) if !id.trim().is_empty() => id.trim().to_string(),
        _ => crypto::machine_seed().await,
    };
    derive(&machine, user_id)
}

/// The hash itself, split out so it can be tested without a keychain or a
/// runtime.
fn derive(machine: &str, user_id: &str) -> String {
    let mut material = Vec::with_capacity(DOMAIN.len() + machine.len() + user_id.len() + 2);
    // Length-free concatenation would let a different (machine, user) split of
    // the same bytes produce the same hash; the separators rule that out.
    material.extend_from_slice(DOMAIN.as_bytes());
    material.push(0);
    material.extend_from_slice(machine.as_bytes());
    material.push(0);
    material.extend_from_slice(user_id.as_bytes());
    crypto::sha256_hex(&material)
}

/// The OS's own machine identifier, if it has one this user can read.
#[cfg(windows)]
fn machine_id() -> Option<String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;

    // Explicitly the 64-bit view: a 32-bit build would otherwise be redirected
    // to Wow6432Node and read a different (or absent) value on the same box.
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(
            r"SOFTWARE\Microsoft\Cryptography",
            KEY_READ | KEY_WOW64_64KEY,
        )
        .and_then(|key| key.get_value::<String, _>("MachineGuid"))
        .ok()
}

/// `/etc/machine-id` is the systemd one; the dbus copy is the fallback on
/// systems that predate it or do not run systemd.
#[cfg(not(windows))]
fn machine_id() -> Option<String> {
    ["/etc/machine-id", "/var/lib/dbus/machine-id"]
        .iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The value that reaches the server must be a hash - not the machine id,
    /// and not something the id can be read back out of - and it has to fit the
    /// server's 64-character column.
    #[test]
    fn a_fingerprint_is_a_hash_not_the_machine_id() {
        let fp = derive("2f1c8a44-9d3e-4b21-8c7a-0e5f6d7a8b9c", "user-1");
        assert_eq!(fp.len(), 64);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
        assert!(!fp.contains("2f1c8a44"));
    }

    /// The per-user salt is what stops one machine being recognised across two
    /// accounts on the server.
    #[test]
    fn the_same_machine_looks_unrelated_under_two_accounts() {
        assert_ne!(derive("machine-a", "user-1"), derive("machine-a", "user-2"));
    }

    /// Same machine, same account, same answer - otherwise it would nominate a
    /// new row on every launch and defeat the point.
    #[test]
    fn it_is_stable_for_one_account() {
        assert_eq!(derive("machine-a", "user-1"), derive("machine-a", "user-1"));
    }

    /// Two machines are two devices. Without the separators, ("ab", "c") and
    /// ("a", "bc") would hash alike.
    #[test]
    fn the_split_between_machine_and_user_cannot_be_shifted() {
        assert_ne!(derive("ab", "c"), derive("a", "bc"));
    }
}
