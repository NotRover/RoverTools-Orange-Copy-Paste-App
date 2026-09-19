import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * The webview's half of the shared clock.
 *
 * Rust corrects every timestamp it writes by this machine's measured error
 * against the server, so that an entry copied here and one copied on another
 * machine can be compared at all (see `src-tauri/src/clock.rs`). A window that
 * then subtracted a raw `Date.now()` from one of those would put the error
 * straight back in - by exactly the amount the correction removed - so
 * everything on this side that compares against a stored time reads the clock
 * through here instead.
 *
 * Zero until the first API response has been measured, which is the same as the
 * behaviour before any of this existed. It is not a reason to wait: a device
 * whose clock is right, which is most of them, measures zero anyway.
 */
let offsetMs = 0;

/** Now, in the frame every device shares. */
export function sharedNow(): number {
  return Date.now() + offsetMs;
}

/**
 * Read the offset and follow it. Called once per window at startup.
 *
 * Every window needs it, including the popups: they draw "x ago" too, and a
 * popup showing a different age from the main window for the same entry is
 * worse than both being wrong the same way.
 */
export function startClock(): void {
  invoke<number>("clock_offset_ms")
    .then((ms) => {
      offsetMs = ms;
    })
    .catch(() => {
      // No sync in this build or the command is unavailable: uncorrected, which
      // is what every version before this one did.
    });
  listen<number>("clock:offset-changed", (e) => {
    offsetMs = e.payload;
  });
}
