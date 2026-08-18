# Who Can Do What

Every action a person can take on an entry, and the scope it is allowed in. The
rule underneath all of it:

> **An entry belongs to whoever wrote it.** Everyone else has a copy. You can do
> anything to your copy and nothing to theirs.

Server rows are keyed `(user_id, client_id)`, so this is not only policy — a
write against someone else's entry *cannot* reach their row. It would insert a
second row under the same `client_id` and hand every member a rival copy. That
is why the blocks below exist: not to be strict, but because the alternative is
silent duplication.

Keep this table current when you add an action. If a new control is not in it,
its scope has not been decided.

---

## Entries

"Yours" means you wrote it. "Theirs" means it arrived from another member of a
space (`id_map.is_remote`, surfaced to the UI as `useRemoteEntryKeys`).

| Action | Where | Yours | Theirs | Enforced by |
|---|---|---|---|---|
| Copy | card menu, Spaces feed | yes | yes | — |
| Expand / open | card, editor | yes | yes | — |
| Pin | card menu, editor | yes | yes, local only | push guard |
| Save | card menu | yes | yes, local only | push guard |
| Assign groups | card menu, editor | yes | yes, local only | push guard |
| Edit note title / body | note editor | yes | **no** | read-only editor + `update_note` |
| Delete locally | card menu, bulk bar | yes | yes, local only | `spawn_delete_entry` skips the tombstone |
| Upload to cloud | card menu, bulk bar | yes | **hidden** | `sync_push_entries` skips |
| Remove from cloud | card menu, bulk bar | yes | **hidden** | `sync_unpush_entries` skips |
| Share to a space | card menu, bulk bar | yes | **hidden** | push guard |
| Remove from a space | Spaces feed | yes (unshare) | owner only | backend `remove_entry_from_space` |

**Local only** means the change lives on this device and is never pushed. Your
groups and pins are your filing system; they are not part of the entry as its
author published it.

**Hidden** means the row is not rendered at all, rather than shown disabled. A
control that cannot work should not be offered — the version of this that showed
it anyway reported "Removing 1 item from your account" and removed nothing.

## Spaces

| Action | Space owner | Member |
|---|---|---|
| Rename, delete the space | yes | no |
| Invite by email, rotate the invite code | yes | no |
| Change the share-history policy | yes | no |
| Remove a member | yes | no |
| Leave | n/a | yes |
| Take down any entry in the space | yes | no |
| Take down their own entry | yes | yes |
| Set per-space send filters | yes | yes (own client, own choice) |

## Where each rule lives

Client, Rust — the enforcement that matters, since only Rust can push:

- `sync/mod.rs` — `is_remote_entry`, the early return in `spawn_push_note` /
  `spawn_push_clipboard_entry` (the "push guard" above), and the `is_remote`
  branch in `spawn_delete_entry` that keeps a removal local.
- `sync/commands.rs` — `sync_push_entries` / `sync_unpush_entries` skip entries
  you did not write, and count only what they acted on.
- `notes/commands.rs` — `update_note` refuses outright.

Client, React — hides what is not allowed, so nothing dead is on screen:

- `hooks/useSpaceShares.ts` — `useRemoteEntryKeys()` is the one source for
  "someone else wrote this".
- `ClipboardScreen.tsx`, `NotesScreen.tsx` — pass `undefined` for the cloud and
  share callbacks on others' entries; bulk actions filter to `selectedOwnIds`.
- `NoteEditor.tsx` — `readOnly` + `ownerName`.
- `SpacesScreen.tsx` — the feed's remove item, gated `is_owner || !remote`.

Backend — the only place a rule survives a modified client:

- `spaces/service.py` — `remove_entry_from_space` narrows to the caller's own
  rows for non-owners; owner-only checks on the rest of the space routes.

## What the server does not enforce

Worth being honest about the shape of this. The server cannot tell a legitimate
edit from an impersonation attempt, because it never sees plaintext and rows are
per-user. What it *does* guarantee is that nobody can write into anyone else's
row. Everything above about pins, groups, and read-only editing is client-side:
a modified client could push a rival copy of an entry into a space it belongs
to. It still could not alter the author's row, and members would see two entries
rather than a changed one.

If that ever needs closing, the fix is server-side: reject a push whose
`client_id` already exists in the space under a different `user_id`.

## Open

- **Removing your copy of a shared entry.** Handled by local delete. There is no
  separate "stop showing me this" — deleting locally is that, and it leaves a
  `local_only` placeholder in the Spaces feed.
- **Getting an entry back after unsharing it.** Works. A removal takes the space
  id off the row, and pull only matches rows still carrying one of your spaces -
  so a row arriving with a space it was removed from is the author sharing it
  again, and the merge clears the marker rather than blocking on it. A copy you
  dropped yourself (`local_only`) keeps blocking, since nothing about the space
  changed.
