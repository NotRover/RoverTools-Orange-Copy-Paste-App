# Space keys: never make the user wait

**Decision record.** Shipped, so the specification that used to be here has moved to the
docs that own it. What is left is the part they deliberately do not carry: why it was built
this way, and what was rejected.

## The problem it solved

A member who joined a space could not read or write it until the **owner's app** handed
over the Space Key, because the owner's app was the only thing that distributed one. Owner
offline meant member blocked, indefinitely, with nothing on screen explaining it.

The fix added **no settings and no new controls** - four changes, three of them invisible:
any member holding the key hands it out, an invite carries the key wrapped for the invitee,
a share into a keyless space is queued instead of refused, and joining was left alone. Two
live defects were fixed first, since they would have corrupted the thing being built: a
blind identity-pubkey overwrite, and a departing member wiping a space's history.

Migration `0017` and commit `4d02341` were the groundwork.

## Where the behaviour is documented

| What | Where |
|------|-------|
| Routes, DDL, key-distribution contract | backend `docs/ARCHITECTURE.md` — sections 2.1, 4.6, 4.7, 5.5, 5.6, 7.4 |
| Client keyring handling, queued shares | client `docs/ARCHITECTURE.md` — Space keys |
| Who may mint, who may hand over | `PERMISSIONS.md` — Spaces |
| The two defects fixed on the way | client `docs/BUGFIX_HISTORY.md` — entries 13 and 14 |
| The resulting UI, with before/after diagrams | `space-key-handover.html` — dated walkthrough, not maintained |

## Considered and dropped

Kept so nobody re-proposes them.

- **A join policy switch** (invite only / invite link / anyone with the code) and a **key
  handover switch** (any member / owner only). Both were real controls with real security
  meaning, and both were the wrong answer to "make this frictionless": every position
  needed explaining, and one of them existed only to describe a state being removed. If
  invite-only is ever wanted it is one checkbox, not a ladder.
- **Per-invite tokens and single-use codes.** They close a genuine hole - the space code is
  one multi-use bearer capability for 72 hours - at the cost of a second code format, a
  second link shape, expiry copy and a "wrong address" refusal. Not worth it while the goal
  was fewer blockages. The hole was closed later by approval instead, without a second code
  format: see `SPACE-JOIN-APPROVAL.md`.
- **The Space Key inside the invite link.** Needed a 128-bit link secret (the 8-character
  code is about 2^40, too weak to be key material), would leak through mail click tracking,
  and revoking it means removing a member rather than just rekeying.

## What stays true

- The server never holds a Space Key, only opaque wraps.
- A rekey is forward-looking: anything a member already pulled stays readable to them.
- Spaces are end-to-end encrypted against a **passive** server. A recipient computes its
  shared secret against a public key the server returned, unpinned, so an active malicious
  server could substitute one it owns. Out of scope here, but it bounds what any of this
  can promise.
- **Superseded:** this document deliberately left joining alone, so a leaked code still
  admitted strangers. `SPACE-JOIN-APPROVAL.md` is the decision that changed it.
