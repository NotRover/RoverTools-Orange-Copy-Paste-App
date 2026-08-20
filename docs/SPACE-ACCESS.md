# Space keys: never make the user wait

One problem: a member who joins a space cannot read or write it until the
**owner's app** hands over the Space Key, because the owner's app is the only
thing that distributes one. If the owner's app is closed, the member sits
blocked.

This document is the fix. It adds **no settings and no new controls.** Four
changes, three of them invisible.

**Implemented.** Commit `4d02341` was the groundwork: it made the blocked state
honest instead of letting a share fail silently. What follows makes that state
rare, and stops it blocking anything even when it happens. Migration `0017` is
written and reviewed but **not applied** - it reaches the database on the next
deploy.

The live behaviour is documented where it belongs: backend
`docs/ARCHITECTURE.md` sections 2.1, 4.6, 4.7, 5.5, 5.6 and 7.4; client
`docs/ARCHITECTURE.md` (Space keys); `docs/PERMISSIONS.md` (Spaces); and
`docs/BUGFIX_HISTORY.md` entries 13 and 14 for the two defects. This file is the
decision record, including what was dropped.

---

## 1. Any member hands out the key

Today: `sync/mod.rs:3726` gates distribution on `s.owner_id == me`, and
`spaces/service.py:308` enforces owner-only on the route.

Change: any member holding the keyring may wrap it for a member who lacks one. In
a space with more than one person somebody is nearly always online, so the wait
collapses from "whenever the owner opens the app" to seconds.

This gives up nothing. Every member already holds the key in memory and can pass
it on by other means, so owner-only was never a boundary against a member who
wanted to leak - only against one who never intended to.

Needs `space_memberships.wrapped_by` so the recipient knows whose public key to
compute the shared secret against (null = the owner, so old rows keep working),
plus the fingerprint check in section 3.3.

## 2. Attach the key to the invite

When the owner invites someone who **already has an account**, their identity
public key is already registered. The owner's app wraps the current keyring for it
right then and attaches it to the invite; the server moves that wrap into the
membership row when the invite is accepted.

The key is present the instant they join. Nobody has to be online, and no secret
goes into a link.

Needs `space_invites.wrapped_space_keys`.

## 3. Queue the share instead of refusing it

Today, and after commit `4d02341`, a share into a keyless space is refused: the
row is disabled and the toggle is off. That is correct, and it is still a
blockage.

Change: take the intent and hold it. Sharing into a space we cannot yet encrypt
for records the intent locally and flushes it when the key lands - what
`sync/pending_queue.rs` already does for a server that is unreachable. The entry
shows a pending chip instead of a check mark, the user is never stopped, and
nothing unreadable is ever pushed.

This is the only part with a visible surface, and it is one chip and one word.

The refusals from `4d02341` stay as the floor: if an intent ever reaches the
encrypt path without a key, it still refuses rather than pushing something nobody
can read.

## 4. Nothing changes about joining

> **Superseded.** Redeeming a code now raises a join request instead of granting
> membership outright. See `SPACE-JOIN-APPROVAL.md`. The rest of this document
> stands, including the invite pre-wrap, which the approval path reuses.

Codes and links stay exactly as they are: one code per space, the `/join/{code}`
page, the `orange://join?code=` deep link, the same field in the app. No
per-invite tokens, no temporary codes, no link variants, no policy switch.

---

## Fix first: three live defects

Invisible to the user. Unrelated to the four changes above, except that two of
them are load-bearing for it.

### 3.1 Identity pubkey is a blind overwrite

`auth/service.py:216` assigns `profile.identity_pubkey` unconditionally, so
anyone holding a valid access token - no password, no UMK - can replace it with
their own and receive every future key distribution. The keypair is derived from
the UMK and never legitimately changes: reject a change to a non-null value.

Load-bearing for section 2, which wraps a key for whatever is in that column.

### 3.2 A member leaving can destroy a space's history

Leaving is a self-action (`spaces/service.py:264`) and clears every remaining
keyring so the owner rotates the key. The owner's ring lives only in memory
(`sync/mod.rs:3741`): if their app restarts before redistributing, the old keys
are gone and every entry ever shared in that space is undecryptable for everyone,
permanently. Persist the owner's ring wrapped under their own identity key and
recover from it before deciding to mint.

### 3.3 A distributed key cannot be verified

`spaces/service.py:311` stores whatever wrapped keyring it is handed. Under
owner-only that is survivable; once any member can distribute, a member could
overwrite a newcomer's ring with a random key - the unwrap succeeds, so the
victim silently decrypts nothing. Add `spaces.key_fingerprint` (truncated hash of
the newest key, written by the owner at mint) and verify a received ring against
it before adopting. Self-writes need no check.

Load-bearing for section 1.

---

## Data model

Additive only, no destructive migration:

| Column | Type | For |
|---|---|---|
| `space_memberships.wrapped_by` | uuid, nullable | section 1 |
| `space_invites.wrapped_space_keys` | text, nullable | section 2 |
| `spaces.key_fingerprint` | text, nullable | section 3.3 |
| `profiles.identity_pubkey` | existing, gains a guard | section 3.1 |

## Phases

All four landed together.

- **P0** - the three defects. No UI. The identity key is write-once (409 on a
  change); a departure keeps the owner's wrap and stamps `rekey_requested_at`;
  `spaces.key_fingerprint` is minted with the key and checked on receipt.
- **P1** - any keyholder distributes, minting stays the owner's, the recipient
  verifies. No UI.
- **P2** - the key rides along with the invite (`PUT /invites/{id}/key`), moved
  onto the membership on accept. No UI.
- **P3** - a share into a keyless space is queued rather than refused. The record
  in `id_map.json` is the queue, and `flush_pending_shares` drains it on
  `space:key-received`. The UI is a "waiting" row in the share menus, a dimmed
  share chip on the entry, a reworded space notice, and a toast when the key
  lands.

Three things fell out of building it that are worth keeping:

- Nothing told the user a key had arrived except a notice quietly disappearing, and
  nothing told them about a comment unless the thread panel happened to be open.
  Both now raise a durable notification, along with a refused keyring. See the
  notification table in the client's `docs/ARCHITECTURE.md`.

- A rekey drops any key already wrapped onto a pending invite. It is the previous
  key by then, and a joiner adopting it would fail the fingerprint check the owner
  is about to publish.
- The waiting notice names whichever member is online and holds the key, and falls
  back to the owner only when nobody does - minting is still theirs alone.

A rendered walkthrough of the resulting UI, with before-and-after flow diagrams,
is kept alongside this file as `space-key-handover.html`.

## Considered and dropped

Kept so nobody re-proposes them.

- **A join policy switch** (invite only / invite link / anyone with the code) and
  a **key handover switch** (any member / owner only). Both were real controls
  with real security meaning, and both were the wrong answer to "make this
  frictionless": every position needed explaining, and one of them existed only to
  describe a state we are removing. If invite-only is ever wanted it is one
  checkbox, not a ladder.
- **Per-invite tokens and single-use codes.** They close a genuine hole - the
  space code is one multi-use bearer capability for 72 hours - at the cost of a
  second code format, a second link shape, expiry copy and a "wrong address"
  refusal. Not worth it while the goal is fewer blockages.
- **The Space Key inside the invite link.** Needed a 128-bit link secret (the
  8-character code is about 2^40, too weak to be key material), would leak
  through mail click tracking, and revoking it means removing a member rather
  than just rekeying.

## What stays true

- The server never holds a Space Key, only opaque wraps.
- A rekey is forward-looking: anything a member already pulled stays readable to
  them.
- Spaces are end-to-end encrypted against a **passive** server. A recipient
  computes its shared secret against a public key the server returned
  (`sync/mod.rs:3697`), unpinned, so an active malicious server can substitute one
  it owns. Out of scope here, but it bounds what any of this can promise.
- The multi-use space code stays the way in, so a leaked code still admits
  strangers. That is today's behaviour unchanged, and section 4 is a deliberate
  decision not to touch it now.
