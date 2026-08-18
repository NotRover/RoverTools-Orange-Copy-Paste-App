import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { SpaceCommentCount } from "../../../../types";

/** How a feed row is addressed here, matching the pair the commands take. */
export function commentKey(entryType: string, clientId: string): string {
  return `${entryType}:${clientId}`;
}

/** What a card needs to draw its chip. */
export interface CommentMark {
  count: number;
  /** A comment has arrived since this device last opened the entry. */
  unread: boolean;
}

const SEEN_STORAGE_KEY = "rovertools.space-comments-seen";

/** The newest comment this device has actually seen in each thread.
 *
 *  A server timestamp, not a local one. Storing `Date.now()` here compared this
 *  machine's clock against the server's, so a few seconds of skew either way
 *  left every thread permanently unread however many times it was opened.
 *
 *  Kept on the device rather than in the account: "have I read this" is about
 *  this screen in front of this person, and syncing it would make a thread read
 *  on a laptop look read on a phone that never showed it. */
function readSeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SEEN_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSeen(seen: Record<string, number>): void {
  try {
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(seen));
  } catch {
    // A full or blocked store costs the dot, not the comments.
  }
}

/**
 * Comment tallies for every entry in one space.
 *
 * One request per space rather than one per card, refreshed when a comment
 * lands anywhere in the space. Returns `null`-safe empty state while there is
 * no space selected, so a caller can use it unconditionally.
 */
export function useCommentCounts(spaceId: string | null) {
  const [counts, setCounts] = useState<Map<string, SpaceCommentCount>>(
    new Map(),
  );
  const [seen, setSeen] = useState<Record<string, number>>(readSeen);
  // Refreshes are driven by events, which can arrive faster than the request
  // they trigger. A ref keeps the callback stable so listeners are not rebound.
  const spaceRef = useRef(spaceId);
  spaceRef.current = spaceId;

  const refresh = useCallback(() => {
    const id = spaceRef.current;
    if (!id) {
      setCounts(new Map());
      return;
    }
    invoke<SpaceCommentCount[]>("space_comment_counts", { spaceId: id })
      .then((rows) => {
        // A late reply for a space the user has already left is not an answer
        // about the space they are looking at now.
        if (spaceRef.current !== id) return;
        setCounts(new Map(rows.map((r) => [commentKey(r.entry_type, r.client_id), r])));
      })
      .catch(() => {
        // Chips are decoration. A failed tally should not raise a toast on top
        // of whatever already went wrong with the connection.
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [spaceId, refresh]);

  useEffect(() => {
    const added = listen("space:comment-added", refresh);
    const removed = listen("space:comment-removed", refresh);
    return () => {
      void added.then((un) => un());
      void removed.then((un) => un());
    };
  }, [refresh]);

  const marks = useMemo(() => {
    const out = new Map<string, CommentMark>();
    for (const [key, row] of counts) {
      out.set(key, {
        count: row.count,
        unread: row.latest_at > (seen[`${spaceId}:${key}`] ?? 0),
      });
    }
    return out;
  }, [counts, seen, spaceId]);

  /** Everything up to `latestAt` in this thread has now been seen.
   *
   *  The caller passes the newest timestamp it drew, so what gets stored is a
   *  server value that can be compared with the next server value. */
  const markRead = useCallback(
    (entryType: string, clientId: string, latestAt: number) => {
      if (!spaceId) return;
      const key = `${spaceId}:${commentKey(entryType, clientId)}`;
      setSeen((prev) => {
        // Never walk the watermark backwards: a deletion lowers the thread's
        // newest timestamp, and that is not a reason to re-flag older
        // comments as unread.
        if ((prev[key] ?? 0) >= latestAt) return prev;
        return { ...prev, [key]: latestAt };
      });
    },
    [spaceId],
  );

  // Written from an effect rather than from inside the updater above: an
  // updater has to be pure, and React is free to run it more than once.
  useEffect(() => {
    writeSeen(seen);
  }, [seen]);

  return { marks, refresh, markRead };
}
