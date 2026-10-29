//! Tauri commands for the local database: encryption at rest (section 7.1).

use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{Emitter, Manager, State};

use super::cipher::Cipher;
use crate::clipboard::history::ClipboardHistory;
use crate::notes::NoteStore;
use crate::state::app_state::AppState;
use crate::sync::crypto;

/// The `settings.json` key. Per PC; it never roams.
pub const SETTING_KEY: &str = "encrypt_at_rest";
/// Emitted with the new state once every row has been rewritten.
pub const CHANGED_EVENT: &str = "storage:encryption-changed";

/// Turn encryption at rest on or off, rewriting every entry and note. Off the
/// main thread: the rewrite holds each store's lock for as long as its rows
/// take, and a keychain write may retry for a couple of seconds.
#[tauri::command]
pub async fn storage_set_encrypt_at_rest(
    enabled: bool,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let history = Arc::clone(&state.history);
    let notes = Arc::clone(&state.notes);
    tauri::async_runtime::spawn_blocking(move || set_encrypt_at_rest(&app, &history, &notes, enabled))
        .await
        .map_err(|e| format!("encryption task: {e}"))?
}

/// Whether rows written now are encrypted. Differs from the setting only when
/// the key could not be read at startup, which the Settings screen says.
#[tauri::command]
pub fn storage_encryption_active(state: State<'_, AppState>) -> bool {
    state.history.lock().cipher_active()
}

fn set_encrypt_at_rest(
    app: &tauri::AppHandle,
    history: &Mutex<ClipboardHistory>,
    notes: &Mutex<NoteStore>,
    enabled: bool,
) -> Result<(), String> {
    if enabled {
        // The key is stored before anything is sealed under it: a crash between
        // the two leaves a key nothing needs, never rows nothing can open.
        let cipher = match crypto::load_db_key()? {
            Some(key) => Cipher::new(key),
            None => {
                let cipher = Cipher::generate();
                crypto::store_db_key(cipher.key())?;
                cipher
            }
        };
        rewrite(history, notes, Some(Arc::new(cipher)))?;
        write_setting(app, true)?;
        // The pages that held the plaintext: VACUUM rebuilds the file from
        // the live rows, and the checkpoint truncates the WAL that carried them.
        if let Some(db) = app.state::<AppState>().db.get() {
            db.compact();
        }
        log::info!(target: "storage", "encryption at rest on");
    } else {
        rewrite(history, notes, None)?;
        write_setting(app, false)?;
        crypto::delete_db_key();
        log::info!(target: "storage", "encryption at rest off");
    }
    let _ = app.emit(CHANGED_EVENT, enabled);
    Ok(())
}

/// Rewrite every row under `cipher`, or in plain text. Store by store; a write
/// that fails leaves that store set to `cipher`, so the rows it touches from
/// now on agree with it, and the setting as it was, so the next launch retries.
fn rewrite(
    history: &Mutex<ClipboardHistory>,
    notes: &Mutex<NoteStore>,
    cipher: Option<Arc<Cipher>>,
) -> Result<(), String> {
    let mut hist = history.lock();
    hist.set_cipher(cipher.clone());
    if !hist.persist_all() {
        return Err("history could not be rewritten; see the log".into());
    }
    drop(hist);
    let mut notes = notes.lock();
    notes.set_cipher(cipher);
    if !notes.persist_all() {
        return Err("notes could not be rewritten; see the log".into());
    }
    Ok(())
}

fn write_setting(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let written = crate::sync::commands::update_settings(app, |m| {
        m.insert(SETTING_KEY.into(), enabled.into());
    });
    if written {
        Ok(())
    } else {
        Err("settings.json could not be written".into())
    }
}

/// A launch that found a key with the setting off (`cipher::at_startup`):
/// a turn-off that did not finish. Called once the stores have loaded under
/// that key.
pub fn finish_turning_off(history: &Mutex<ClipboardHistory>, notes: &Mutex<NoteStore>) {
    match rewrite(history, notes, None) {
        Ok(()) => {
            crypto::delete_db_key();
            log::info!(target: "storage", "encryption at rest off (finished at startup)");
        }
        Err(e) => log::error!(target: "storage", "turning encryption at rest off did not finish: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Db;

    /// The rewrite converts both stores' rows on disk and back.
    #[test]
    fn a_rewrite_seals_both_stores_and_a_second_one_opens_them() {
        let db = Db::open_in_memory();
        let history = Mutex::new(ClipboardHistory::new());
        history.lock().attach_db(Arc::clone(&db));
        history.lock().push(crate::clipboard::history::ClipboardEntry::new_text("secret".into()));
        let notes = Mutex::new(NoteStore::new());
        notes.lock().attach_db(Arc::clone(&db));
        let note = notes.lock().create();
        notes.lock().update(&note.id, "t".into(), "body".into());

        let sealed = |db: &Db| -> (i64, i64) {
            db.read("count", |c| {
                Ok((
                    c.query_row("SELECT sum(enc) FROM entries", [], |r| r.get(0))?,
                    c.query_row("SELECT sum(enc) FROM notes", [], |r| r.get(0))?,
                ))
            })
            .unwrap()
        };
        assert_eq!(sealed(&db), (0, 0));

        rewrite(&history, &notes, Some(Arc::new(Cipher::generate()))).unwrap();
        assert_eq!(sealed(&db), (1, 1));
        assert!(history.lock().all()[0].encrypted && notes.lock().all()[0].encrypted);

        rewrite(&history, &notes, None).unwrap();
        assert_eq!(sealed(&db), (0, 0));
        let plain: String = db
            .read("raw", |c| c.query_row("SELECT content FROM entries", [], |r| r.get(0)))
            .unwrap();
        assert_eq!(plain, "secret");
    }
}
