import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type EntrySyncState = "synced" | "pending";

/** Events after which an entry's sync state may have changed. */
const REFRESH_ON = [
  "sync:entry-synced",
  "sync:note-synced",
  "sync:entry-queued",
  "sync:history-merged",
  "sync:notes-merged",
  "sync:status-changed",
];

/**
 * Per-entry sync state, keyed `"clipboard:{id}"` / `"note:{id}"`.
 *
 * This lives outside the entry model on purpose: it is sync bookkeeping owned
 * by Rust (id_map.json + the pending queue), not something persisted with the
 * entry. The card's cloud badge used to read `entry.sync_status`, which Rust
 * marks `#[serde(skip)]` — so it was always undefined and the badge never
 * rendered at all.
 */
export function useEntrySyncStates(): Record<string, EntrySyncState> {
  const [states, setStates] = useState<Record<string, EntrySyncState>>({});

  const refresh = useCallback(() => {
    invoke<Record<string, EntrySyncState>>("sync_get_entry_states")
      .then(setStates)
      .catch(() => {
        // Sync disabled or not signed in: no badges, which is correct.
        setStates({});
      });
  }, []);

  useEffect(() => {
    refresh();
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    for (const event of REFRESH_ON) {
      listen(event, refresh).then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      });
    }
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [refresh]);

  return states;
}
