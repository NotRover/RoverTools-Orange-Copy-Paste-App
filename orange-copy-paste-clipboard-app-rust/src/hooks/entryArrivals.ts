import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * When each received entry reached this device, keyed `"clipboard:{id}"` /
 * `"note:{id}"`.
 *
 * Every timestamp on an entry is the wall clock of the machine that wrote it,
 * and nothing in sync reconciles two machines' clocks. A sender running thirty
 * seconds slow therefore hands over an item that reads "30s ago" the moment it
 * lands, and it stays thirty seconds too old for good. The one time in the
 * exchange that is certainly right is the moment it arrived here, because this
 * machine read its own clock for it.
 *
 * Used as a floor rather than a replacement: an item never reads as older than
 * its own arrival, and is otherwise left alone. A sender whose clock runs fast
 * therefore keeps the behaviour it already had, and genuinely old items keep
 * their real age - Rust records an arrival only for a live delivery, and only
 * when the claimed age is small enough to be a clock rather than a backlog
 * (`ARRIVAL_SKEW_GRACE_MS`).
 *
 * A module-level store rather than a prop: the label is drawn in eleven places
 * across three screens, and threading a map through all of them to adjust one
 * number would cost more than it explains.
 */
let arrivals: Record<string, number> = {};
const subscribers = new Set<() => void>();
let started = false;

/** The time to show for `key`: its own, or its arrival if that is later. */
export function arrivalFloor(ts: number, key?: string): number {
  if (!key) return ts;
  const at = arrivals[key];
  return at !== undefined && at > ts ? at : ts;
}

/** Events after which a new entry may have arrived. */
const REFRESH_ON = [
  "sync:history-merged",
  "sync:notes-merged",
  "sync:signed-out",
];

function refresh(): void {
  invoke<Record<string, number>>("sync_get_entry_arrivals")
    .then((next) => {
      arrivals = next;
      for (const fn of subscribers) fn();
    })
    .catch(() => {
      // Sync disabled or signed out: nothing arrived from anywhere.
      arrivals = {};
    });
}

/** Load once, then follow the merges. Started by the first subscriber rather
 *  than at import, so a window that shows no timestamps pays nothing. */
function start(): void {
  if (started) return;
  started = true;
  refresh();
  for (const event of REFRESH_ON) listen(event, refresh);
}

export function subscribeArrivals(cb: () => void): () => void {
  start();
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
