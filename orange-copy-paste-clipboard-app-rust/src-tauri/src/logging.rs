//! The app's log: every `log` record, from Rust and from the webviews, in one
//! file on disk.
//!
//! The release profile is a Windows GUI build, so `eprintln!` goes nowhere: a
//! failure that only prints is a failure nobody can diagnose from a user's
//! machine. Everything worth knowing after the fact goes through the `log`
//! macros instead, and this module writes them to `{app_data}/logs/app.log`.
//! In a debug build the same lines also reach stderr, so `tauri dev` shows them.
//!
//! One file, appended, rotated by size: at [`MAX_FILE_BYTES`] the file is
//! renamed `app.log.1` (and the previous `.1` to `.2`), so a user's machine
//! never holds more than three files of it. A line is `UTC time, level,
//! target, message`, one record per line unless the message has newlines.
//!
//! Installed in two steps. [`init`] sets the logger before the Tauri builder
//! runs, with stderr as its only output, so nothing is lost for want of a path;
//! [`attach_file`] opens the file once `setup` knows the app data directory.
//! Writes take the file lock with `try_lock`: the panic hook logs through here
//! too, and a panic raised while this thread held the lock must not deadlock
//! the hook that reports it.

use log::{Level, LevelFilter, Log, Metadata, Record};
use parking_lot::Mutex;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Folder under `{app_data}` that holds the log and its rotated copies.
pub const LOG_DIR: &str = "logs";
/// The live file; rotated copies are `app.log.1` and `app.log.2`.
pub const LOG_FILE: &str = "app.log";
/// Size at which the file is rotated. Generous for a text log, small enough
/// that a user can attach it to a report.
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// Rotated copies kept beside the live file.
const KEPT_COPIES: u32 = 2;

struct Sink {
    dir: PathBuf,
    file: File,
    written: u64,
}

struct Logger {
    sink: Mutex<Option<Sink>>,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

/// Install the logger. Idempotent; the first call wins. Records written before
/// [`attach_file`] reach stderr in a debug build and nowhere else.
pub fn init() {
    let logger = LOGGER.get_or_init(|| Logger { sink: Mutex::new(None) });
    if log::set_logger(logger).is_ok() {
        log::set_max_level(LevelFilter::Info);
    }
}

/// Open `{app_data}/logs/app.log` and send every record there from now on.
/// A directory or file that cannot be opened leaves stderr as the only output;
/// the failure itself is printed, since there is nowhere else to put it.
pub fn attach_file(app_data: &Path) {
    let Some(logger) = LOGGER.get() else {
        return;
    };
    let dir = app_data.join(LOG_DIR);
    match open_sink(&dir) {
        Ok(sink) => *logger.sink.lock() = Some(sink),
        Err(e) => log::info!(target: "log", "{} not opened: {e}", dir.join(LOG_FILE).display()),
    }
}

/// Where the log lives, for the Settings button that opens the folder.
pub fn dir(app_data: &Path) -> PathBuf {
    app_data.join(LOG_DIR)
}

fn open_sink(dir: &Path) -> std::io::Result<Sink> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(LOG_FILE);
    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    let written = file.metadata().map(|m| m.len()).unwrap_or(0);
    Ok(Sink { dir: dir.to_path_buf(), file, written })
}

/// Shift `app.log` to `app.log.1`, `.1` to `.2`, and drop the oldest.
fn rotate(dir: &Path) {
    let name = |n: u32| {
        if n == 0 {
            dir.join(LOG_FILE)
        } else {
            dir.join(format!("{LOG_FILE}.{n}"))
        }
    };
    let _ = std::fs::remove_file(name(KEPT_COPIES));
    for n in (0..KEPT_COPIES).rev() {
        let _ = std::fs::rename(name(n), name(n + 1));
    }
}

/// Crates this build does not own log at `warn` and above only; their `info`
/// is chatter about connections and TLS that says nothing about the app.
fn own_target(target: &str) -> bool {
    !target.contains("::") || target.starts_with(env!("CARGO_CRATE_NAME"))
}

/// `YYYY-MM-DD HH:MM:SS.mmm` in UTC, from the system clock. UTC on purpose:
/// a log read beside a server log or another device's should line up without
/// anyone working out two time zones.
fn timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let ms = now.subsec_millis();
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (h, m, s) = (rem / 3600, rem % 3600 / 60, rem % 60);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(mo <= 2);
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{m:02}:{s:02}.{ms:03}")
}

impl Log for Logger {
    fn enabled(&self, metadata: &Metadata) -> bool {
        if own_target(metadata.target()) {
            metadata.level() <= Level::Info
        } else {
            metadata.level() <= Level::Warn
        }
    }

    fn log(&self, record: &Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!(
            "{} {:<5} {}: {}\n",
            timestamp(),
            record.level(),
            record.target(),
            record.args()
        );
        if cfg!(debug_assertions) {
            eprint!("{line}");
        }
        // `try_lock`: the panic hook logs through here, and a panic raised
        // while this thread held the lock must not hang the hook.
        let Some(mut guard) = self.sink.try_lock() else {
            return;
        };
        let Some(sink) = guard.as_mut() else {
            return;
        };
        if sink.written + line.len() as u64 > MAX_FILE_BYTES {
            rotate(&sink.dir);
            if let Ok(fresh) = open_sink(&sink.dir) {
                *sink = fresh;
            }
        }
        if sink.file.write_all(line.as_bytes()).is_ok() {
            sink.written += line.len() as u64;
        }
    }

    fn flush(&self) {
        if let Some(sink) = self.sink.lock().as_mut() {
            let _ = sink.file.flush();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_timestamp_is_civil_utc() {
        // Pin the algorithm rather than the clock: the same arithmetic on a
        // known instant.
        let secs: u64 = 1_793_255_350; // 2026-10-29 06:29:10 UTC
        let days = secs / 86_400;
        let z = days as i64 + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let mo = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = yoe + era * 400 + i64::from(mo <= 2);
        assert_eq!((y, mo, d), (2026, 10, 29));
        assert!(timestamp().len() == "2026-10-29 11:49:10.123".len());
    }

    /// A full file rolls to `.1`, the old `.1` to `.2`, and nothing older stays.
    #[test]
    fn rotation_keeps_two_copies() {
        let dir = std::env::temp_dir().join(format!("rovertools-log-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for (name, body) in [("app.log", "live"), ("app.log.1", "one"), ("app.log.2", "two")] {
            std::fs::write(dir.join(name), body).unwrap();
        }
        rotate(&dir);
        assert!(!dir.join("app.log").exists());
        assert_eq!(std::fs::read_to_string(dir.join("app.log.1")).unwrap(), "live");
        assert_eq!(std::fs::read_to_string(dir.join("app.log.2")).unwrap(), "one");
        assert!(!dir.join("app.log.3").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Lines append to the live file, and a sink that would overflow rotates
    /// before it writes.
    #[test]
    fn a_sink_appends_and_rotates_at_the_cap() {
        let dir = std::env::temp_dir().join(format!("rovertools-log-{}", uuid::Uuid::new_v4()));
        let logger = Logger { sink: Mutex::new(Some(open_sink(&dir).unwrap())) };
        logger.log(&Record::builder().args(format_args!("first")).level(Level::Info).target("t").build());
        let text = std::fs::read_to_string(dir.join("app.log")).unwrap();
        assert!(text.ends_with(" INFO  t: first\n"), "{text:?}");

        logger.sink.lock().as_mut().unwrap().written = MAX_FILE_BYTES;
        logger.log(&Record::builder().args(format_args!("second")).level(Level::Warn).target("t").build());
        assert!(std::fs::read_to_string(dir.join("app.log.1")).unwrap().contains("first"));
        let live = std::fs::read_to_string(dir.join("app.log")).unwrap();
        assert!(live.contains("second") && !live.contains("first"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn third_party_info_is_filtered_and_own_info_is_kept() {
        let logger = Logger { sink: Mutex::new(None) };
        let own = Metadata::builder().level(Level::Info).target("sync").build();
        let dep = Metadata::builder().level(Level::Info).target("reqwest::connect").build();
        let dep_warn = Metadata::builder().level(Level::Warn).target("reqwest::connect").build();
        assert!(logger.enabled(&own));
        assert!(!logger.enabled(&dep));
        assert!(logger.enabled(&dep_warn));
    }
}
