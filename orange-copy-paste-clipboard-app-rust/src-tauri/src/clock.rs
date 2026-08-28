//! One clock for the whole product.
//!
//! Every timestamp the app writes - when an entry was copied, when a note was
//! last edited, when something was taken out of a space - is read from the
//! machine the app happens to be running on, and two machines rarely agree.
//! Nothing downstream reconciles them, so the disagreement is carried into the
//! data: a device thirty seconds slow stamps everything thirty seconds early,
//! and every other device then shows those items thirty seconds too old, sorts
//! them thirty seconds too far down the list, and compares them against its own
//! with the same error. What the user sees is an item that has just arrived
//! claiming to be half a minute old.
//!
//! The fix is to stop treating the local clock as the unit of record. There is
//! already a clock every device shares - the server's - so this module measures
//! how far this machine is from it and hands out corrected time. Everything
//! that stamps calls [`now_ms`] rather than reading `SystemTime` itself, so
//! every timestamp in the system is in one frame no matter whose machine
//! produced it, and comparing two of them means something.
//!
//! The measurement comes from the `Date` header the API already returns on
//! every response, so it costs no extra request and no change to the wire.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::OnceLock;

/// This machine's error against the server, in ms. Added to every reading.
static OFFSET_MS: AtomicI64 = AtomicI64::new(0);
/// Whether the offset has been measured, or is still the assumed zero.
static MEASURED: AtomicBool = AtomicBool::new(false);

/// A sample whose round trip took longer than this says too little about where
/// in the exchange the server read its clock to be worth folding in.
const MAX_SAMPLE_RTT_MS: u64 = 3_000;

/// A move larger than this is a clock being set rather than drifting, and is
/// taken whole instead of eased into - the point is to be right now.
const JUMP_THRESHOLD_MS: i64 = 5_000;

/// Weight of a new sample once an offset is established. `Date` carries one
/// second of resolution, so consecutive samples disagree by up to a second on
/// their own; easing stops a label flickering between two values while still
/// following a real change within a few requests.
const SMOOTHING: f64 = 0.35;

/// What to do when the offset moves: persist it, and tell the windows so the
/// "x ago" labels stop reading against an uncorrected `Date.now()`.
///
/// A callback rather than a direct call, because this module has to stay a leaf
/// - the clipboard store and the notes store both stamp through it, and neither
/// should have to know that sync or a window exists.
type OnChange = Box<dyn Fn(i64) + Send + Sync>;
static ON_CHANGE: OnceLock<OnChange> = OnceLock::new();

/// Register the sink. First caller wins; later ones are ignored.
pub fn on_change(f: impl Fn(i64) + Send + Sync + 'static) {
    let _ = ON_CHANGE.set(Box::new(f));
}

/// Report a moved offset to whoever registered. Silent before startup has run.
pub fn announce(offset: i64) {
    if let Some(f) = ON_CHANGE.get() {
        f(offset);
    }
}

/// This machine's own clock, uncorrected. For measuring durations and stamping
/// log lines, where the answer is about this machine and nobody else has to
/// agree with it.
pub fn local_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// The current time in the shared frame. Everything that records *when
/// something happened* calls this.
pub fn now_ms() -> u64 {
    let corrected = local_ms() as i64 + OFFSET_MS.load(Ordering::Relaxed);
    corrected.max(0) as u64
}

/// Move a reading already taken from the local clock into the shared frame, for
/// the few places handed a raw local timestamp by the platform.
pub fn to_shared(local: u64) -> u64 {
    (local as i64 + OFFSET_MS.load(Ordering::Relaxed)).max(0) as u64
}

pub fn offset_ms() -> i64 {
    OFFSET_MS.load(Ordering::Relaxed)
}

/// Seed the offset from the last measurement, before any request has been made.
///
/// A launch stamps things straight away - the watcher captures whatever is on
/// the clipboard - and the first API response is seconds off at best and never
/// coming at worst. The last measurement is a far better guess than assuming
/// the machine is right, which is the assumption that caused the problem. Never
/// overrides a live measurement.
pub fn seed(offset: i64) {
    if !MEASURED.load(Ordering::Relaxed) {
        OFFSET_MS.store(offset, Ordering::Relaxed);
    }
}

/// Fold one observation of the server's clock into the offset. Returns the new
/// value when it moved enough to be worth persisting and announcing.
///
/// `server_ms` is the server's `Date`, truncated to the second, so the true
/// reading is somewhere in the second that follows and the midpoint of that
/// span is the honest estimate. The server read its clock somewhere between the
/// request leaving and the response landing; with nothing better to go on, the
/// midpoint of the round trip is the matching estimate on this side.
pub fn observe(sent_local_ms: u64, server_ms: u64, received_local_ms: u64) -> Option<i64> {
    let rtt = received_local_ms.saturating_sub(sent_local_ms);
    if rtt > MAX_SAMPLE_RTT_MS {
        return None;
    }
    let local_midpoint = sent_local_ms + rtt / 2;
    let sample = (server_ms + 500) as i64 - local_midpoint as i64;

    let previous = OFFSET_MS.load(Ordering::Relaxed);
    let measured = MEASURED.load(Ordering::Relaxed);
    let next = if !measured || (sample - previous).abs() > JUMP_THRESHOLD_MS {
        sample
    } else {
        (previous as f64 + (sample - previous) as f64 * SMOOTHING).round() as i64
    };
    MEASURED.store(true, Ordering::Relaxed);
    OFFSET_MS.store(next, Ordering::Relaxed);

    // Sub-second movement is noise in a one-second-resolution measurement.
    if !measured || (next - previous).abs() >= 1_000 {
        Some(next)
    } else {
        None
    }
}

/// Parse an HTTP `Date` header into ms since the epoch.
///
/// RFC 9110 fixes the preferred form ("Sun, 06 Nov 1994 08:49:37 GMT") down to
/// the character, which is why this reads the fields by position rather than
/// taking on a date-parsing crate for one header.
pub fn parse_http_date(value: &str) -> Option<u64> {
    // "Sun, 06 Nov 1994 08:49:37 GMT"
    let rest = value.trim().split_once(", ")?.1;
    let mut parts = rest.split(' ');
    let day: i64 = parts.next()?.parse().ok()?;
    let month = match parts.next()? {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: i64 = parts.next()?.parse().ok()?;
    let mut hms = parts.next()?.split(':');
    let hour: i64 = hms.next()?.parse().ok()?;
    let min: i64 = hms.next()?.parse().ok()?;
    let sec: i64 = hms.next()?.parse().ok()?;
    if !(1..=31).contains(&day)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&min)
        // A leap second is legal in the grammar and lands on the next minute.
        || !(0..=60).contains(&sec)
    {
        return None;
    }
    let secs = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + min * 60 + sec;
    if secs < 0 {
        return None;
    }
    Some(secs as u64 * 1_000)
}

/// Days since 1970-01-01 for a proleptic Gregorian date. Howard Hinnant's
/// `days_from_civil`, exact for every date the header can carry.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_form_the_rfc_fixes() {
        assert_eq!(
            parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT"),
            Some(784_111_777_000)
        );
        assert_eq!(parse_http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0));
    }

    #[test]
    fn a_leap_day_is_not_off_by_one() {
        assert_eq!(
            parse_http_date("Sat, 29 Feb 2020 00:00:00 GMT"),
            Some(1_582_934_400_000)
        );
    }

    #[test]
    fn refuses_anything_it_does_not_recognise() {
        // A header this device cannot read must leave the offset alone rather
        // than resolve to some default date and move every clock in the app.
        for bad in [
            "",
            "not a date",
            "Sun, 06 Xxx 1994 08:49:37 GMT",
            "Sun, 06 Nov 1994 99:49:37 GMT",
            "Sun, 06 Nov 1994 08:49 GMT",
            "Sun 06 Nov 1994 08:49:37 GMT",
        ] {
            assert_eq!(parse_http_date(bad), None, "accepted {bad:?}");
        }
    }

    #[test]
    fn a_slow_machine_measures_a_positive_offset() {
        // Local clock reads 30s behind the server; the round trip took 200ms.
        let sent = 1_000_000_u64;
        let received = sent + 200;
        // The server's Date, truncated to the second, at the midpoint.
        let server = ((sent + 100 + 30_000) / 1_000) * 1_000;
        let offset = observe(sent, server, received).expect("a first sample reports");
        assert!(
            (offset - 30_000).abs() <= 1_000,
            "offset was {offset}, wanted about 30000"
        );
    }

    #[test]
    fn a_slow_round_trip_says_nothing_and_is_dropped() {
        let sent = 2_000_000_u64;
        assert_eq!(observe(sent, sent, sent + MAX_SAMPLE_RTT_MS + 1), None);
    }
}
