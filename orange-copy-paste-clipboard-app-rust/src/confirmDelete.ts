// Shared logic for the "you're about to delete a synced item" confirmation.
//
// A synced entry has a copy in the cloud, so deleting it is not a local-only
// action: the removal travels to the user's other devices. That deserves a
// heads-up the first time, with a way to turn it off. Every delete surface (the
// history list, the notes list, and both quick popups) routes through here so
// the rule and the wording stay in one place.

import { invoke } from "@tauri-apps/api/core";
import type { Space } from "./types";

/** Persisted preference: ask before deleting a synced item. Absent = ask. */
export const CONFIRM_SYNC_DELETE_KEY = "confirm_sync_delete";

/** Whether the confirmation is still switched on (default true when unset). */
export async function syncDeleteConfirmEnabled(): Promise<boolean> {
  try {
    const v = await invoke<boolean | null>("get_setting", {
      key: CONFIRM_SYNC_DELETE_KEY,
    });
    return v !== false;
  } catch {
    return true;
  }
}

/** Turn the confirmation off (the "Don't ask again" checkbox). */
export async function disableSyncDeleteConfirm(): Promise<void> {
  try {
    await invoke("set_setting", { key: CONFIRM_SYNC_DELETE_KEY, value: false });
  } catch {
    /* a failed write just means the prompt shows again next time */
  }
}

/**
 * Whether any of these entry keys (`clipboard:{id}` / `note:{id}`) has a cloud
 * copy. Sync state is Rust-owned bookkeeping, not a field on the entry, so it is
 * read from `sync_get_entry_states`. Sync off / signed out yields an empty map,
 * i.e. nothing is synced and nothing needs confirming.
 */
export async function anyEntrySynced(keys: string[]): Promise<boolean> {
  try {
    const states = await invoke<Record<string, string>>("sync_get_entry_states");
    return keys.some((k) => !!states[k]);
  } catch {
    return false;
  }
}

/**
 * Decide whether a delete of these entries should be confirmed first: only when
 * the preference is on AND at least one target is synced. Both reads are cheap
 * and happen on the click, so no state has to be threaded through the UI.
 */
export async function shouldConfirmDelete(keys: string[]): Promise<boolean> {
  if (!(await syncDeleteConfirmEnabled())) return false;
  return anyEntrySynced(keys);
}

/**
 * Where the items being deleted came from, so the confirmation can say what the
 * delete actually does. The three cases the Rust delete path distinguishes:
 *
 *  - owned, no spaces: a personal-cloud copy. The tombstone removes it from
 *    your other synced devices.
 *  - owned, shared into spaces: the tombstone carries the space ids, so the
 *    item leaves every space for everyone, not just your devices.
 *  - received: another member's copy. Deleting pushes a self-scoped tombstone
 *    (no space ids), so it is removed from all your devices but stays in the
 *    space for everyone else.
 *
 * Counts (not just booleans) so a mixed selection can name how many of each,
 * rather than overclaiming that all are shared. All of it is Rust-owned
 * bookkeeping read on the click, mirroring how the Spaces feed resolves origin.
 */
export interface DeleteOrigin {
  /** How many targets came from another member (received copies). */
  receivedCount: number;
  /** How many owned targets are shared into at least one space. */
  sharedCount: number;
  /** Sender's name for a single received item, when it can be named. */
  fromMember: string | null;
  /** Spaces the received targets arrived through. */
  fromSpaceNames: string[];
  /** Spaces the owned targets are shared into. */
  sharedSpaceNames: string[];
}

export async function describeDelete(keys: string[]): Promise<DeleteOrigin> {
  try {
    const [remote, owners, shares, spaces] = await Promise.all([
      invoke<string[]>("sync_get_remote_entries"),
      invoke<Record<string, string>>("sync_get_entry_owners"),
      invoke<Record<string, string[]>>("sync_get_entry_shares"),
      invoke<Space[]>("spaces_cached"),
    ]);
    const remoteSet = new Set(remote);
    const nameOf = new Map(spaces.map((s) => [s.id, s.name] as const));
    const memberName = new Map<string, string>();
    for (const s of spaces) {
      for (const m of s.members) {
        if (!memberName.has(m.user_id) && m.display_name?.trim()) {
          memberName.set(m.user_id, m.display_name.trim());
        }
      }
    }

    let receivedCount = 0;
    let sharedCount = 0;
    const fromSpaceIds = new Set<string>();
    const sharedSpaceIds = new Set<string>();
    for (const k of keys) {
      const spaceIds = shares[k] ?? [];
      if (remoteSet.has(k)) {
        receivedCount += 1;
        for (const id of spaceIds) fromSpaceIds.add(id);
      } else if (spaceIds.length) {
        sharedCount += 1;
        for (const id of spaceIds) sharedSpaceIds.add(id);
      }
    }
    const namesOf = (ids: Set<string>) =>
      [...ids].map((id) => nameOf.get(id)).filter((n): n is string => !!n);

    // Only name a sender for a single received item; a mixed selection has no
    // one sender to point at.
    let fromMember: string | null = null;
    if (receivedCount === 1 && keys.length === 1) {
      const uid = owners[keys[0]];
      fromMember = (uid && memberName.get(uid)) || null;
    }

    return {
      receivedCount,
      sharedCount,
      fromMember,
      fromSpaceNames: namesOf(fromSpaceIds),
      sharedSpaceNames: namesOf(sharedSpaceIds),
    };
  } catch {
    // Sync off or signed out: treat as a plain local delete with no origin.
    return {
      receivedCount: 0,
      sharedCount: 0,
      fromMember: null,
      fromSpaceNames: [],
      sharedSpaceNames: [],
    };
  }
}

/**
 * One run of the confirmation body. `hi` marks the specifics - names, counts,
 * space names - so the dialog can tint them apart from the muted prose.
 */
export interface MessagePart {
  t: string;
  hi?: boolean;
}

const plain = (t: string): MessagePart => ({ t });
const hi = (t: string): MessagePart => ({ t, hi: true });

/** Join space names for prose: "A", "A and B", or "N spaces". */
function joinSpaces(names: string[]): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} spaces`;
}

/** Name the spaces once ("in {A}"), highlighted; empty when none are known. */
function inSpaces(names: string[]): MessagePart[] {
  return names.length ? [plain(" in "), hi(joinSpaces(names))] : [];
}

/** Back-reference to the spaces: the name when there is one, else a plain
 *  "those spaces" that names nothing and so is not highlighted. */
function thoseSpaces(names: string[]): MessagePart {
  return names.length === 1 ? hi(names[0]) : plain("those spaces");
}

/**
 * The body copy for the confirmation as highlightable parts, matched to the
 * origin and count. Pure so it can be unit-tested and reused by every surface.
 */
export function deleteMessage(origin: DeleteOrigin, count: number): MessagePart[] {
  const { receivedCount: r, sharedCount: s } = origin;

  if (count === 1) {
    // Received: removed from all your devices, but stays in the space.
    if (r === 1) {
      const stays = origin.fromSpaceNames.length
        ? [plain("It stays in "), thoseSpaces(origin.fromSpaceNames), plain(" for everyone else.")]
        : [plain("It stays shared for everyone else.")];
      return [
        hi(origin.fromMember ?? "Someone"),
        plain(" shared this with you"),
        ...inSpaces(origin.fromSpaceNames),
        plain(". Deleting it removes it from all your devices. "),
        ...stays,
      ];
    }
    // Owned and shared: the tombstone carries the space ids.
    if (s === 1) {
      return [
        plain("This item is shared in "),
        hi(joinSpaces(origin.sharedSpaceNames)),
        plain(". Deleting it removes it from all your devices and from "),
        thoseSpaces(origin.sharedSpaceNames),
        plain(" for everyone."),
      ];
    }
    // Owned, personal cloud only.
    return [
      plain("This item is synced. Deleting it removes it from all your synced devices."),
    ];
  }

  // Plural. State each group once, count-qualified.
  if (r === 0) {
    if (s === 0) {
      return [
        plain("Deleting these "),
        hi(String(count)),
        plain(" items removes them from all your synced devices."),
      ];
    }
    return [
      plain("Deleting these "),
      hi(String(count)),
      plain(" items removes them from all your synced devices. "),
      hi(String(s)),
      plain(" are shared in "),
      hi(joinSpaces(origin.sharedSpaceNames)),
      plain(" and will be removed for everyone."),
    ];
  }

  if (r === count) {
    const stays = origin.fromSpaceNames.length
      ? [plain("They stay in "), thoseSpaces(origin.fromSpaceNames), plain(" for everyone else.")]
      : [plain("They stay shared for everyone else.")];
    return [
      plain("These "),
      hi(String(count)),
      plain(" items were shared with you"),
      ...inSpaces(origin.fromSpaceNames),
      plain(". Deleting them removes them from all your devices. "),
      ...stays,
    ];
  }

  // Mixed ownership: state each group once with its own count.
  const parts: MessagePart[] = [
    plain("Of these "),
    hi(String(count)),
    plain(" items, "),
    hi(String(count - r)),
    plain(" are yours and "),
    hi(String(r)),
    plain(" were shared with you by others. Deleting removes all of them from your synced devices; the "),
    hi(String(r)),
    plain(" shared items stay shared with everyone else."),
  ];
  if (s > 0) {
    parts.push(
      plain(" "),
      hi(String(s)),
      plain(" of your items are shared in "),
      hi(joinSpaces(origin.sharedSpaceNames)),
      plain(" and will be removed for everyone."),
    );
  }
  return parts;
}
