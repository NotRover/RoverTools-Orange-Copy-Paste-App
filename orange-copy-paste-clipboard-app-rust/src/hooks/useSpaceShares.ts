import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { showToast, toastError } from "../components/app/toast/toastBus";
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
  /** Of those, the ones still waiting for their space's key: the item is
   *  recorded as shared there and goes out when the key arrives. */
  waitingNamesFor: (kind: ShareKind, id: string) => string[];
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
  // A key arriving flips has_key, which is what tells a waiting share from a
  // delivered one.
  "space:key-received",
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

  // Items whose share command has not come back yet. A push emits merge events
  // of its own, so a refresh can land on a snapshot taken before the click and
  // uncheck what the user just checked; these values stay on top until the
  // command settles.
  const pending = useRef(new Map<string, string[]>());

  const overlayPending = useCallback((map: Record<string, string[]>) => {
    if (pending.current.size === 0) return map;
    const next = { ...map };
    for (const [key, ids] of pending.current) {
      if (ids.length === 0) delete next[key];
      else next[key] = ids;
    }
    return next;
  }, []);

  const refresh = useCallback(() => {
    invoke<Record<string, string[]>>("sync_get_entry_shares")
      .then((map) => setShares(overlayPending(map)))
      .catch(() => setShares({}));
    invoke<Space[]>("spaces_cached")
      .then(setSpaces)
      .catch(() => setSpaces([]));
    invoke<{ user_id: string } | null>("sync_get_user")
      .then((u) => setSignedIn(!!u))
      .catch(() => setSignedIn(false));
  }, [overlayPending]);

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
  // a failed command puts the old set back and says so.
  const apply = useCallback(
    (kind: ShareKind, id: string, spaceIds: string[]) => {
      const key = `${kind}:${id}`;
      const previous = shares[key];
      pending.current.set(key, spaceIds);
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
      })
        .catch((e) => {
          setShares((prev) => {
            const next = { ...prev };
            if (previous) next[key] = previous;
            else delete next[key];
            return next;
          });
          toastError("Could not change sharing", e);
        })
        .finally(() => {
          pending.current.delete(key);
        });
    },
    [shares],
  );

  const spaceName = useCallback(
    (spaceId: string) => spaces.find((s) => s.id === spaceId)?.name ?? "space",
    [spaces],
  );

  const toggle = useCallback(
    (kind: ShareKind, id: string, spaceId: string) => {
      const current = shares[`${kind}:${id}`] ?? [];
      const sharing = !current.includes(spaceId);
      apply(
        kind,
        id,
        sharing ? [...current, spaceId] : current.filter((s) => s !== spaceId),
      );
      // A space we hold no key for takes the choice and holds it: nothing is
      // refused, and nothing unreadable is pushed. Say which of the two happened
      // rather than reporting a share that has not gone anywhere yet.
      const keyed = spaces.find((s) => s.id === spaceId)?.has_key ?? true;
      showToast(
        sharing
          ? keyed
            ? `Shared in ${spaceName(spaceId)}`
            : `Will go to ${spaceName(spaceId)} when its key arrives`
          : `Removed from ${spaceName(spaceId)}`,
        "info",
        { key: "space-share" },
      );
    },
    [shares, apply, spaceName, spaces],
  );

  const bulkToggle = useCallback(
    (kind: ShareKind, ids: string[], spaceId: string, share: boolean) => {
      let changed = 0;
      for (const id of ids) {
        const current = shares[`${kind}:${id}`] ?? [];
        if (share) {
          if (!current.includes(spaceId)) {
            apply(kind, id, [...current, spaceId]);
            changed += 1;
          }
        } else if (current.includes(spaceId)) {
          apply(
            kind,
            id,
            current.filter((s) => s !== spaceId),
          );
          changed += 1;
        }
      }
      // A bulk action that changed nothing (every item was already there) is
      // worth saying out loud - silence reads as a failure.
      const name = spaceName(spaceId);
      showToast(
        changed === 0
          ? share
            ? `Already shared in ${name}`
            : `Not shared in ${name}`
          : share
            ? `${changed} shared in ${name}`
            : `${changed} removed from ${name}`,
        "info",
        { key: "space-share" },
      );
    },
    [shares, apply, spaceName],
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

  const waitingNamesFor = useCallback(
    (kind: ShareKind, id: string) => {
      const ids = shares[`${kind}:${id}`] ?? [];
      return ids
        .map((sid) => spaces.find((s) => s.id === sid))
        .filter((s) => s && !s.has_key)
        .map((s) => s!.name);
    },
    [shares, spaces],
  );

  return {
    spaces,
    signedIn,
    shares,
    namesFor,
    waitingNamesFor,
    toggle,
    bulkToggle,
  };
}
