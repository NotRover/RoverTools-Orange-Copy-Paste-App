import { useSyncExternalStore } from "react";

/**
 * Keys whose removal is waiting out an Undo toast.
 *
 * A deferred destructive action sends nothing to Rust or the server until the
 * toast runs out, so anything that reads them for its state would keep drawing
 * the row for another five seconds - the click would look like it did nothing.
 * This is the shared "treat it as already gone" hint: `deferDestructive` marks
 * the keys, the lists subtract them, and a refresh landing mid-toast cannot put
 * the row back because the hint never lived in the map being refreshed.
 *
 * One store rather than per-screen state because the writer and the reader are
 * not always the same component: taking an item off the account happens in a
 * shared helper, and the badge it hides is drawn by a hook two screens use.
 *
 * Keys are namespaced by what they name, e.g. `space:{id}`,
 * `member:{spaceId}:{userId}`, `device:{id}`, `cloud:clipboard:{clientId}`.
 */
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit(next: ReadonlySet<string>): void {
  snapshot = next;
  for (const fn of listeners) fn();
}

/** Mark keys as gone. The returned function puts them back. */
export function markPending(keys: string[]): () => void {
  if (keys.length === 0) return () => {};
  const added = new Set(snapshot);
  for (const key of keys) added.add(key);
  emit(added);
  return () => {
    const removed = new Set(snapshot);
    let changed = false;
    for (const key of keys) changed = removed.delete(key) || changed;
    if (changed) emit(removed);
  };
}

/**
 * Drop keys from the store regardless of who marked them.
 *
 * For the one hint that outlives its toast: an item taken off the account stays
 * hidden after the call lands, because the badge is drawn from Rust state that
 * only catches up when the tombstone finishes syncing - which on a manual or
 * offline device is not soon. Putting it back is the job of the action that
 * makes it true again, uploading the item.
 */
export function clearPending(keys: string[]): void {
  const next = new Set(snapshot);
  let changed = false;
  for (const key of keys) changed = next.delete(key) || changed;
  if (changed) emit(next);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function read(): ReadonlySet<string> {
  return snapshot;
}

/** The keys to treat as already removed while their toasts are up. */
export function usePendingRemovals(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, read, read);
}
