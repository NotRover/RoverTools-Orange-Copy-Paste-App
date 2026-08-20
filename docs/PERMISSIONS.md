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
| Mint the space's key | yes | no |
| Hand the key to a member who lacks one | yes | yes (any keyholder) |
| Change the share-history policy | yes | no |
| Choose whether members may approve join requests | yes | no |
| Approve or decline a join request | yes | only if the owner turned it on |
| Remove a member | yes | no |
| Leave | n/a | yes |
| Take down any entry in the space | yes | no |
| Take down their own entry | yes | yes |
| Comment on any entry in the space | yes | yes |
| Delete their own comment | yes | yes |
| Delete anyone's comment | yes | no |
| Set per-space send filters | yes | yes (own client, own choice) |
| Share an entry into the space | yes | yes |

**Reading a space needs its Space Key.** Content is encrypted under it, so until a copy
arrives there is nothing to decrypt. This is a capability rather than a role: it applies to
an owner too, in the window between creating a space and minting its key.

Two things keep that window short. **Any member holding the key hands it over**, not only
the owner, so somebody is nearly always running; and an invite carries the key wrapped for
the invitee, so an invited member holds it the moment they accept. `Space.has_key` carries
the state to the UI, stamped from the live keyring on every read since the key can land at
any moment.

**Sharing into a space is never blocked on the key.** The choice is recorded, the push path
drops a space it holds no key for so nothing unreadable is ever pushed, and the entry is
pushed again when the key lands. The record in `id_map.json` is the queue, so it survives a
restart.

| Attempted while waiting for the key | What happens |
|---|---|
| Share an entry in (card menu, bulk bar) | allowed; the row says "waiting" and the entry's chip is dimmed until it goes out |
| Turn on "Share new items out" | allowed; matching items are held and sent when the key arrives |
| Comment on an entry | command refuses; nothing is readable to comment on anyway |
| Read the feed | empty - the entries cannot be decrypted yet |

**Who gets told.** Five notification rows come out of this, and all five are scoped by
the same ownership rule as the actions above: a space becoming readable (yours to know, you
are in it), a comment on an entry **you wrote** or one that **names you**, a refused
keyring, somebody knocking on a space **you may approve**, and the answer to a knock **you
made**. A comment between two other members on a third member's item raises nothing, and
neither does a join request on a space you are only a member of - the notification follows
who can act, not who is present.

**A key that does not match is refused, not retried.** Since any member may distribute, a
recipient checks the ring against `spaces.key_fingerprint` - written by the owner alone when
it mints - before adopting it. A correctly wrapped *wrong* key unwraps fine and then decrypts
nothing, which is the failure this catches. Nothing about waiting fixes it, so the client
reports it (`space:key-rejected`); the owner removing whoever sent it rekeys the space.

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
- `sync/mod.rs` — `has_space_key`, and the `space_comment_add` refusal built on
  it. Commenting needs something readable to comment on, so it is gated on the
  key. Sharing is not: `space_set_entry_shares` records the intent either way,
  `share_targets` drops a keyless space on the way out, and
  `flush_pending_shares` sends it when the key lands.
- `sync/mod.rs` — `stamp_keys`, which sets `Space::has_key` from the live
  keyring on every read. It is what the UI below draws from, and it is stamped
  rather than stored because the key can arrive at any moment.
- `sync/mod.rs` — `reconcile_spaces`, which decides who may hand a key over (any
  keyholder), who may mint one (the owner), and refuses a ring whose newest key
  does not match the space's published fingerprint.
- `sync/mod.rs` — `note_comment`, the one place that decides a comment is worth
  interrupting for: not ours, and either on an entry we wrote or naming us.
  `note_space_readable` and `note_space_key_rejected` are the other two rows.
- `sync/mod.rs` — `note_join_requested`, raised only for a space whose
  `i_can_approve` is set, and `note_join_approved` for the requester's own side.
  `wrap_ring_for` is the shared half: approving and pre-wrapping an invite are
  the same operation, handing a key to somebody who is not a member yet.

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
- `SpacesScreen.tsx`, `card-menu/CardMenu.tsx`,
  `clipboard-screen/bulk-actions/BulkActionsBar.tsx` — `space.has_key` marks a
  space still waiting on its key rather than disabling it: the share rows stay
  clickable and say "waiting", the space panel explains the wait once, and
  `useSpaceShares.waitingNamesFor` dims the entry's share chip until it goes out.

Backend — the only place a rule survives a modified client:

- `spaces/service.py` — `remove_entry_from_space` narrows to the caller's own
  rows for non-owners; owner-only checks on the rest of the space routes.
- `spaces/service.py` — `_require_member` is the whole gate for reading and
  writing comments: a space is a room, and everyone in it can talk.
  `delete_comment` is the narrower one, author or space owner.
- `spaces/service.py` — `may_approve` is the single definition of who may answer
  a join request (owner, or member with `members_can_approve`). It is what
  `join_requests._require_approver` gates on and what `SpaceOut.i_can_approve`
  is derived from, so the client renders the rule rather than restating it.
- `spaces/join_requests.py` — a code or a join link now raises a request instead
  of a membership. This is the one place a leaked code is stopped, and it covers
  links by construction: `/join/{code}` only hands the code to the app, which
  calls the same `POST /spaces/join`.

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

## Recovery code

Account-scoped, never space-scoped: a recovery code opens the account's own
encryption key and has nothing to do with membership of anything.

| Action | Who can do it | Enforced where |
| --- | --- | --- |
| Save a recovery code | the account holder, on a signed-in device | `sync_create_recovery_code` needs the UMK in memory; `PUT /auth/umk/recovery` needs the account's own JWT |
| Regenerate one | the same | the same route; storing replaces the envelope, so the previous code stops working |
| Use one | anyone holding the code, on any machine | client-side only - the server stores a blob it cannot open |
| Clear one | the account holder | `DELETE /auth/umk/recovery`, used when an account starts over with a new key |

There is deliberately no route that lets the server, an admin, or another member
recover somebody's key. That would end the end-to-end guarantee.
