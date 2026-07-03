import { useEffect, useState } from "react";
import { timeAgo } from "../types";

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

/** Live "x ago" label for `timestamp`, refreshed on a shared timer. */
export function useRelativeTime(timestamp: number): string {
  const [label, setLabel] = useState(() => timeAgo(timestamp));
  useEffect(() => {
    setLabel(timeAgo(timestamp));
    return subscribe(() => setLabel(timeAgo(timestamp)));
  }, [timestamp]);
  return label;
}
