//! Encryption at rest: the text columns of `entries` and `notes` under one
//! AES-256-GCM key that lives in the OS keychain, never in the file.
//!
//! Done in the app rather than by a page cipher (SQLCipher, SQLite3 Multiple
//! Ciphers) on purpose. A page cipher needs OpenSSL built on every platform,
//! ties the file to one engine, and cannot say which rows are protected. This
//! way the engine stays a dependency swap, each row carries an `enc` flag the
//! UI can show, and the cost is one AEAD call per column read or written.
//!
//! What it covers: `entries.content`, `entries.label`, `notes.title` and
//! `notes.content`. What it does not: the columns the list is ordered and
//! grouped by (timestamps, kind, pinned, groups), the sync bookkeeping, and
//! the files on disk (`images/`, `received-files/`, `note-attachments/`). The
//! threat is a copied `app.db`, not a copied folder.
//!
//! The additional data of every seal names the table, row and column, so a
//! ciphertext edited into another row does not open there.

use std::sync::Arc;

use zeroize::Zeroizing;

use crate::sync::crypto;

/// The key, and the two operations the stores need from it.
pub struct Cipher {
    key: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for Cipher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Cipher")
    }
}

impl Cipher {
    pub fn new(key: Zeroizing<[u8; 32]>) -> Self {
        Self { key }
    }

    /// A fresh random key. Store it before sealing anything under it.
    pub fn generate() -> Self {
        Self { key: crypto::random_key() }
    }

    pub fn key(&self) -> &[u8; 32] {
        &self.key
    }

    /// Seal one column of one row. The result is base64, stored in place of
    /// the plaintext.
    pub fn seal(&self, table: &str, id: &str, column: &str, plaintext: &str) -> Result<String, String> {
        crypto::encrypt(&self.key, plaintext, &aad(table, id, column))
    }

    /// Open what [`Self::seal`] wrote for the same table, row and column.
    pub fn open(&self, table: &str, id: &str, column: &str, ciphertext: &str) -> Result<String, String> {
        crypto::decrypt(&self.key, ciphertext, &aad(table, id, column))
    }
}

fn aad(table: &str, id: &str, column: &str) -> String {
    format!("{table}:{id}:{column}")
}

/// What a launch starts with, from the setting and the keychain.
pub struct Startup {
    /// The cipher the stores load and write with, if any.
    pub cipher: Option<Arc<Cipher>>,
    /// A key was found with the setting off: a turn-off that did not finish.
    /// The caller rewrites the stores in plain text once they have loaded and
    /// then deletes the key (`commands::finish_turning_off`).
    pub finish_turning_off: bool,
}

/// Resolve the setting against the keychain. Every case is logged, since the
/// one that matters (the setting on, no key) is invisible otherwise.
pub fn at_startup(enabled: bool) -> Startup {
    let none = Startup { cipher: None, finish_turning_off: false };
    match (enabled, crypto::load_db_key()) {
        (true, Ok(Some(key))) => Startup { cipher: Some(Arc::new(Cipher::new(key))), finish_turning_off: false },
        (true, Ok(None)) => {
            // The setting outlived the key: the credential store was reset, or
            // lost it. Rows sealed under the old key cannot be opened by anyone
            // now; a new key keeps the promise for everything from here on.
            log::error!(
                target: "storage",
                "encryption at rest is on but the keychain holds no key: rows sealed before are skipped, a new key is made"
            );
            let cipher = Cipher::generate();
            match crypto::store_db_key(cipher.key()) {
                Ok(()) => Startup { cipher: Some(Arc::new(cipher)), finish_turning_off: false },
                Err(e) => {
                    log::error!(target: "storage", "new key not stored ({e}): nothing is encrypted this launch");
                    none
                }
            }
        }
        (true, Err(e)) => {
            log::error!(
                target: "storage",
                "encryption key not read ({e}): encrypted rows are skipped and new rows are written in plain text this launch"
            );
            none
        }
        (false, Ok(Some(key))) => {
            log::warn!(target: "storage", "a key is stored but encryption at rest is off: finishing turning it off");
            Startup { cipher: Some(Arc::new(Cipher::new(key))), finish_turning_off: true }
        }
        (false, Ok(None)) => none,
        (false, Err(e)) => {
            log::warn!(target: "storage", "keychain not read ({e}); encryption at rest is off");
            none
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sealed_column_opens_only_in_its_own_row_and_column() {
        let c = Cipher::generate();
        let sealed = c.seal("entries", "id-1", "content", "hello").unwrap();
        assert_ne!(sealed, "hello");
        assert_eq!(c.open("entries", "id-1", "content", &sealed).unwrap(), "hello");
        assert!(c.open("entries", "id-2", "content", &sealed).is_err());
        assert!(c.open("entries", "id-1", "label", &sealed).is_err());
        assert!(c.open("notes", "id-1", "content", &sealed).is_err());
        assert!(Cipher::generate().open("entries", "id-1", "content", &sealed).is_err());
    }
}
