/**
 * Progress for the Account screen's bulk Upload / Remove from cloud actions.
 *
 * The work itself runs in Rust and keeps going whether or not the screen is
 * mounted, so the progress cannot live in component state: switching screens
 * and coming back would show the idle card again and read as "it stopped".
 * This module owns the polling loop and the last result, and the screen just
 * subscribes to it.
 */
import { invoke } from "@tauri-apps/api/core";

export type BulkProgress = {
  mode: "upload" | "remove";
  done: number;
  total: number;
};

export type BulkState = {
  progress: BulkProgress | null;
  /** Sentence shown once a run finishes, or when there was nothing to do. */
  result: string | null;
};

type Listener = (state: BulkState) => void;

let state: BulkState = { progress: null, result: null };
const listeners = new Set<Listener>();

/** Bumped to abandon the running loop when a new action starts. */
let runId = 0;

function emit(next: BulkState) {
  state = next;
  for (const fn of listeners) fn(state);
}

export function getBulkState(): BulkState {
  return state;
}

export function subscribeBulk(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setBulkResult(result: string | null) {
  runId += 1;
  emit({ progress: null, result });
}

/** True while a run is in flight, so the screen can keep its buttons disabled. */
export function bulkRunning(): boolean {
  return state.progress !== null;
}

/**
 * Follow a bulk action to completion.
 *
 * Both actions fan out into one background task per item and return right
 * away, so there is no completion to await. Progress is read back from how
 * many items the server has acknowledged: an upload counts up to the total, a
 * removal counts the same number down. It ends when everything has either
 * landed or been refused, or when the push queue has been idle for a while.
 */
export async function trackBulk(keys: string[], mode: "upload" | "remove") {
  const run = (runId += 1);
  const total = keys.length;
  emit({ progress: { mode, done: 0, total }, result: null });

  let last = -1;
  let quietTicks = 0;
  let done = 0;
  let failed = 0;

  while (runId === run) {
    await new Promise((r) => setTimeout(r, 700));
    if (runId !== run) return;
    let p: { settled: number; failed: number; in_flight: number };
    try {
      p = await invoke<typeof p>("sync_bulk_progress", { keys });
    } catch {
      break;
    }
    done = mode === "upload" ? p.settled : total - p.settled;
    failed = p.failed;
    emit({ progress: { mode, done, total }, result: null });
    if (done + failed >= total) break;

    // Only count quiet time while nothing is actually being pushed. A batch of
    // large images can run for minutes without a single one landing, and
    // calling that finished reported "0 of 332 uploaded" for an upload that
    // went on to succeed.
    if (p.in_flight > 0 || done !== last) {
      quietTicks = 0;
    } else {
      quietTicks += 1;
    }
    last = done;
    if (quietTicks >= 20) break; // ~14s idle with nothing in flight
  }
  if (runId !== run) return;

  const left = total - done;
  emit({
    progress: null,
    result:
      mode === "upload"
        ? left <= 0
          ? `Uploaded ${total} item${total === 1 ? "" : "s"}.`
          : `Uploaded ${done} of ${total}. ${left} did not go through - check the skipped list above.`
        : left <= 0
          ? `Removed ${total} item${total === 1 ? "" : "s"} from the server. They stay on this device.`
          : `Removed ${done} of ${total}. ${left} are still on the server; try again.`,
  });
}
