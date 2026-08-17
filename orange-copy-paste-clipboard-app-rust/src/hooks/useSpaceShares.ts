import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Space } from "../types";

export type ShareKind = "clipboard" | "note";

export interface SpaceShares {
  /** Spaces this account belongs to (cached list, no network). */
  spaces: Space[];
  /** Whether a sync account is signed in, so sharing can say why it is off. */
  signedIn: boolean;
  /** Space ids per item, keyed `"clipboard:{id}"` / `"note:{id}"`. */
  shares: Record<string, string[]>;
  /** Space names for one item, for the card indicator's tooltip. */
  namesFor: (kind: ShareKind, id: string) => string[];
  /** Add or remove one space for one item. */
  toggle: (kind: ShareKind, id: string, spaceId: string) => void;
  /** Add or remove one space across several items, leaving their other
   *  spaces alone. */
  bulkToggle: (
    kind: ShareKind,
    ids: string[],
    spaceId: string,
    share: boolean,
  ) => void;
}

/** Events after which where an item went may have changed. */
const REFRESH_ON = [
  "sync:entry-synced",
  "sync:note-synced",
  "sync:history-merged",
  "sync:notes-merged",
  "space:membership-changed",
  "sync:status-changed",
];

/**
 * Entry keys another member wrote, as a set for membership tests.
 *
 * Same Rust-owned bookkeeping as the shares above; kept separate because most
 * screens want one or the other, not both.
 */
export function useRemoteEntryKeys(): Set<string> {
  const [keys, setKeys] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(() => {
    invoke<string[]>("sync_get_remote_entries")
      .then((list) => setKeys(new Set(list)))
      .catch(() => setKeys(new Set()));
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

  return keys;
}

/**
 * Which spaces each item is shared into, plus the space list the share menu
 * offers. Like sync state, this is Rust-owned bookkeeping (id_map.json) rather
 * than part of the item, so it is read through commands and refreshed on the
 * events that can change it.
 */
export function useSpaceShares(): SpaceShares {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [shares, setShares] = useState<Record<string, string[]>>({});
  const [signedIn, setSignedIn] = useState(false);

  const refresh = useCallback(() => {
    invoke<Record<string, string[]>>("sync_get_entry_shares")
      .then(setShares)
      .catch(() => setShares({}));
    invoke<Space[]>("spaces_cached")
      .then(setSpaces)
      .catch(() => setSpaces([]));
    invoke<{ user_id: string } | null>("sync_get_user")
      .then((u) => setSignedIn(!!u))
      .catch(() => setSignedIn(false));
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

  // Applied locally first so the chip and the checkmark move with the click;
  // a failed command puts the old set back.
  const apply = useCallback(
    (kind: ShareKind, id: string, spaceIds: string[]) => {
      const key = `${kind}:${id}`;
      const previous = shares[key];
      setShares((prev) => {
        const next = { ...prev };
        if (spaceIds.length === 0) delete next[key];
        else next[key] = spaceIds;
        return next;
      });
      invoke("space_set_entry_shares", {
        entryId: id,
        entryType: kind,
        spaceIds,
      }).catch(() => {
        setShares((prev) => {
          const next = { ...prev };
          if (previous) next[key] = previous;
          else delete next[key];
          return next;
        });
      });
    },
    [shares],
  );

  const toggle = useCallback(
    (kind: ShareKind, id: string, spaceId: string) => {
      const current = shares[`${kind}:${id}`] ?? [];
      apply(
        kind,
        id,
        current.includes(spaceId)
          ? current.filter((s) => s !== spaceId)
          : [...current, spaceId],
      );
    },
    [shares, apply],
  );

  const bulkToggle = useCallback(
    (kind: ShareKind, ids: string[], spaceId: string, share: boolean) => {
      for (const id of ids) {
        const current = shares[`${kind}:${id}`] ?? [];
        if (share) {
          if (!current.includes(spaceId)) apply(kind, id, [...current, spaceId]);
        } else if (current.includes(spaceId)) {
          apply(
            kind,
            id,
            current.filter((s) => s !== spaceId),
          );
        }
      }
    },
    [shares, apply],
  );

  const namesFor = useCallback(
    (kind: ShareKind, id: string) => {
      const ids = shares[`${kind}:${id}`] ?? [];
      return ids.map(
        (sid) => spaces.find((s) => s.id === sid)?.name ?? "a space",
      );
    },
    [shares, spaces],
  );

  return { spaces, signedIn, shares, namesFor, toggle, bulkToggle };
}
