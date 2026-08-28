import { useEffect, useState } from "react";
import { timeAgo } from "../types";
import { arrivalFloor, subscribeArrivals } from "./entryArrivals";

// Relative-time labels only need coarse updates. A single shared interval ticks
// every subscriber instead of each list card owning its own setInterval — with
// large histories that's one timer instead of hundreds.
const REFRESH_MS = 15_000;
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  if (timer === null) {
    timer = setInterval(() => {
      for (const fn of subscribers) fn();
    }, REFRESH_MS);
  }
  return () => {
    subscribers.delete(cb);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Live "x ago" label for `timestamp`, refreshed on a shared timer.
 *
 *  Pass `key` ("clipboard:{id}" / "note:{id}") for anything that may have come
 *  from another device: the label then never reads older than the moment the
 *  item arrived here, so a sender with a slow clock cannot make something that
 *  just appeared claim to be minutes old. See `entryArrivals`. */
export function useRelativeTime(timestamp: number, key?: string): string {
  const label_ = () => timeAgo(arrivalFloor(timestamp, key));
  const [label, setLabel] = useState(label_);
  useEffect(() => {
    const tick = () => setLabel(timeAgo(arrivalFloor(timestamp, key)));
    tick();
    const untick = subscribe(tick);
    // The arrival map loads after the first paint, so the label has to be
    // recomputed when it lands rather than waiting out the 15s tick.
    const unsub = key ? subscribeArrivals(tick) : undefined;
    return () => {
      untick();
      unsub?.();
    };
  }, [timestamp, key]);
  return label;
}

/** The one-shot form, for a label that is not on the shared timer. Same
 *  arrival floor as [`useRelativeTime`]. */
export function timeAgoFor(timestamp: number, key?: string): string {
  return timeAgo(arrivalFloor(timestamp, key));
}
