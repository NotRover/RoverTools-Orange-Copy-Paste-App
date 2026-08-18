import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePendingRemovals } from "./pendingRemoval";

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
/** Fired on the document when the Settings screen flips the badge preference,
 *  so open screens drop or restore their badges without a remount. */
export const SYNC_BADGE_SETTING_EVENT = "settings:sync-badges-changed";

/**
 * Whether the card badges are switched on.
 *
 * Kept apart from the states themselves: hiding the badge is a display choice,
 * and the menu's cloud actions and the sync filters still need to know what is
 * actually on the server. Folding the two together is what made the states
 * unavailable to anything but the badge.
 */
export function useSyncBadgesVisible(): boolean {
  const [show, setShow] = useState(true);

  useEffect(() => {
    invoke<boolean | null>("get_setting", { key: "show_sync_badges" })
      .then((v) => setShow(v !== false))
      .catch(() => setShow(true));
    // Settings hands us the new value on the event, so a toggle takes effect
    // without waiting on the write it just started.
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<boolean>).detail;
      if (typeof next === "boolean") setShow(next);
    };
    document.addEventListener(SYNC_BADGE_SETTING_EVENT, onChange);
    return () => document.removeEventListener(SYNC_BADGE_SETTING_EVENT, onChange);
  }, []);

  return show;
}

export function useEntrySyncStates(): Record<string, EntrySyncState> {
  const [states, setStates] = useState<Record<string, EntrySyncState>>({});
  // Items whose server copy is waiting out an Undo toast read as not on the
  // account, so the badge clears on the click rather than five seconds later.
  const pendingGone = usePendingRemovals();

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

  return useMemo(() => {
    if (pendingGone.size === 0) return states;
    const shown: Record<string, EntrySyncState> = {};
    for (const [key, state] of Object.entries(states))
      if (!pendingGone.has(`cloud:${key}`)) shown[key] = state;
    return shown;
  }, [states, pendingGone]);
}
