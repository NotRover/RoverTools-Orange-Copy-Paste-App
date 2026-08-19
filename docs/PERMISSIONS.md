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
| Remove everything from cloud | Account screen | yes | **never reached** | `sync_unpush_all` builds from `owned_keys`; `spawn_delete_entry` refuses `OwnedOnly` |
| Share to a space | card menu, bulk bar | yes | **hidden** | push guard |
| Remove from a space | Spaces feed, bulk bar | yes (unshare) | owner only | backend `remove_entry_from_space` |
| Comment on it | Spaces detail panel | yes | yes | backend `_require_member` |
| Delete a comment | Spaces detail panel | yes (your own) | owner only | backend `delete_comment` |

**Local only** means the change lives on this device and is never pushed. Your
groups and pins are your filing system; they are not part of the entry as its
author published it.

**Hidden** means the row is not rendered at all, rather than shown disabled. A
control that cannot work should not be offered — the version of this that showed
it anyway reported "Removing 1 item from your account" and removed nothing.

**Never reached** is for account-wide actions, which have no per-item control to
hide. They are the dangerous shape: nobody picked the items, so nothing on
screen shows what is about to be touched, and a list built one field too wide
takes things away silently. Two rules, both required:

1. Build the list from `IdMap::owned_keys()` — never `entry_states()`, which
   records what this device pushed **and** what it pulled, so it includes items
   other members shared in.
2. Pass `RemovalScope::OwnedOnly`, so `spawn_delete_entry` refuses a received
   item even if the list is wrong. Rule 1 is the intent; rule 2 is what makes
   getting it wrong inert instead of destructive.

A removal must also survive the round trip. "Remove from cloud" keeps the local
copy, but the only wire shape a removal has is a tombstone - a push with
`deleted_at` set, the same message a real deletion sends - so it comes back on
the next pull as "this entry is deleted" and, applied, wipes the copy the action
promised to keep. The device records what it meant (`IdMap::mark_unpushed`) and
`merge_pulled` skips the local delete for those keys. Do not rely on echo
suppression by `device_id` for this: a row records the device that pushed it,
and an entry pushed under an earlier sign-in comes back wearing an id this
install no longer has.

This is written down because it has already gone wrong once: "Remove from
cloud" on the Account screen swept `entry_states()`, so it dropped the user's
copies of items other people had shared with them. The authors kept theirs — the
removal stayed local, as `spawn_delete_entry` intends for someone else's item —
so the damage was one-sided and invisible from the other end.

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
| Comment on any entry in the space | yes | yes |
| Delete their own comment | yes | yes |
| Delete anyone's comment | yes | no |
| Set per-space send filters | yes | yes (own client, own choice) |

## Who pays for what

Ownership decides cost the same way it decides editing: **an account is charged for
what it uploaded, and for nothing else.**

| Resource | Charged to | A member who received it |
|---|---|---|
| Image bytes in R2 (50 MB quota) | the uploader | costs them nothing - no `blobs` row exists |
| A `sync_entries` row (3,000 per account) | the author | costs them nothing - it is the author's row |
| Entry ciphertext (512 KB per entry) | the author | n/a |

A shared image is never copied. The reader gets a one-hour presigned GET on the
owner's key, granted only while a live entry carries that blob into a space they both
belong to. Two consequences follow, and both are intended:

- **The owner deleting the entry breaks it for everyone.** The blob is released, the
  hourly sweep removes the object, and a member who had not fetched it yet gets a 404.
- **Removing a member is not retroactive** for anything they already pulled. See
  "What the server does not enforce" below - the same limit applies to bytes.

Backend detail: `orange-copy-paste-clipboard-backend/docs/ARCHITECTURE.md` sections 2.4
and 6.3.

## Where each rule lives

Client, Rust — the enforcement that matters, since only Rust can push:

- `sync/mod.rs` — `is_remote_entry`, the early return in `spawn_push_note` /
  `spawn_push_clipboard_entry` (the "push guard" above), and the `is_remote`
  branch in `spawn_delete_entry` that keeps a removal local.
- `sync/mod.rs` — `row_is_authoritative` / `author_of`, the receiving half: a
  pulled row naming an account other than the entry's author is dropped whole.
  The push guards stop *this* device creating a rival row; this stops one that
  already exists taking an entry over.
- `sync/commands.rs` — `sync_push_entries` / `sync_unpush_entries` skip entries
  you did not write, and count only what they acted on.
- `sync/types.rs` — `RemovalScope`, and `sync/mod.rs` — the `OwnedOnly` refusal
  at the top of `spawn_delete_entry`. The scope travels with the call, so an
  account-wide action cannot reach another member's entry by forgetting to
  filter; `IdMap::owned_keys` is the list it should have been built from.
- `sync/commands.rs` — `sync_unpush_all`, the account-wide sweep, applies both.
- `sync/id_map.rs` — `mark_unpushed` / `is_unpushed`, and the guard at the top
  of the tombstone branch in `merge_pulled`. This is what makes "keep the local
  copy" true when the device's own tombstone comes back.
- `notes/commands.rs` — `update_note` refuses outright.

Client, React — hides what is not allowed, so nothing dead is on screen:

- `hooks/useSpaceShares.ts` — `useRemoteEntryKeys()` is the one source for
  "someone else wrote this".
- `ClipboardScreen.tsx`, `NotesScreen.tsx` — pass `undefined` for the cloud and
  share callbacks on others' entries; bulk actions filter to `selectedOwnIds`.
- `NoteEditor.tsx` — `readOnly` + `ownerName`.
- `SpacesScreen.tsx` — `canRemoveKey` (`is_owner || !remote`) gates both the
  feed's remove item and what bulk select will act on.
- `comments/CommentThread.tsx` — a comment's delete button is drawn on
  `is_mine || isOwner`. Commenting itself is ungated in the UI: everyone in the
  space may, so there is nothing to hide.

Backend — the only place a rule survives a modified client:

- `spaces/service.py` — `remove_entry_from_space` narrows to the caller's own
  rows for non-owners; owner-only checks on the rest of the space routes.
- `spaces/service.py` — `_require_member` is the whole gate for reading and
  writing comments: a space is a room, and everyone in it can talk.
  `delete_comment` is the narrower one, author or space owner.

## What the server does not enforce

Worth being honest about the shape of this. The server never sees plaintext, so
it cannot tell a good edit from a bad one. Everything above about pins, groups,
and read-only editing is client-side, and a modified client can ignore all of it.

**Authorship is the exception, and is enforced server-side.** A push that would
insert a row for a `client_id` another account already holds *in a space the
push targets* is refused with `not_your_entry`
(`sync/service.py:_belongs_to_someone_else`). That is a rule the server can
enforce without reading anything: it is about which account owns a key, not
about what the content says.

It is enforced there because the client half cannot be sufficient. Bug #8 (see
the client's `docs/BUGFIX_HISTORY.md`) was created by a client that pushed such
a row, and every member's client then had to defend against it on the way in.
Old builds keep running, so the write has to be refused at the only point every
client shares.

The overlap condition is deliberate: two accounts belonging to one person hold
the same `client_id`s by construction, and neither impersonates anyone. It is
only when both rows land in the same space that one of them is claiming to be
the other.

What the server still cannot do is tell whether the *author's own* edit is one
the author meant. Nobody can write into anyone else's row, and that is the
guarantee.

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
