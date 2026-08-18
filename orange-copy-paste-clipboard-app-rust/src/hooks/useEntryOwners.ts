import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Space } from "../types";

/** Who an entry came from, resolved to something showable on a card. */
export interface EntryOwner {
  user_id: string;
  display_name: string;
  avatar_url?: string | null;
}

/** Events after which an entry's origin, or the member list naming it, may
 *  have changed. */
const REFRESH_ON = [
  "sync:history-merged",
  "sync:notes-merged",
  "sync:status-changed",
  "sync:session-restored",
  "sync:signed-out",
];

/**
 * Who sent each entry, keyed `"clipboard:{id}"` / `"note:{id}"`.
 *
 * Only entries received from another member appear - your own are absent, which
 * is what makes a present value mean "this came from someone else". The Spaces
 * feed had this all along; the clipboard and notes screens showed the same
 * items with no hint of where they came from, so an entry you never copied
 * looked like one of your own.
 *
 * The id is resolved here rather than in the card: names and avatars live on
 * the space member lists, and a card has no idea which space an entry arrived
 * through - it may have arrived through several.
 */
export function useEntryOwners(): Record<string, EntryOwner> {
  const [owners, setOwners] = useState<Record<string, EntryOwner>>({});

  const refresh = useCallback(() => {
    Promise.all([
      invoke<Record<string, string>>("sync_get_entry_owners"),
      invoke<Space[]>("spaces_list"),
      invoke<string[]>("sync_get_remote_entries"),
    ])
      .then(([byEntry, spaces, remoteKeys]) => {
        // One directory across every space: the same person can be in more than
        // one, and the first name found is as good as any.
        const directory = new Map<string, EntryOwner>();
        for (const space of spaces) {
          for (const m of space.members) {
            if (!directory.has(m.user_id)) {
              directory.set(m.user_id, {
                user_id: m.user_id,
                display_name: m.display_name?.trim() || "A member",
                avatar_url: m.avatar_url,
              });
            }
          }
        }
        const next: Record<string, EntryOwner> = {};
        // Start from every entry known to have come from someone else, named or
        // not. Which account wrote one can be missing where the fact that it is
        // not ours is certain: a sender who has since left, or an entry whose
        // recorded author was released as wrong. "Not yours, name unknown" is
        // the honest answer there, and showing no chip would say the opposite.
        for (const key of remoteKeys) {
          next[key] = { user_id: "", display_name: "A member", avatar_url: null };
        }
        for (const [key, userId] of Object.entries(byEntry)) {
          next[key] = directory.get(userId) ?? {
            user_id: userId,
            // Someone who has since left, or whose space is no longer listed.
            // Still worth saying it was not you.
            display_name: "A member",
            avatar_url: null,
          };
        }
        setOwners(next);
      })
      .catch(() => {
        // Sync disabled or signed out: nothing arrived from anyone else.
        setOwners({});
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

  return owners;
}
