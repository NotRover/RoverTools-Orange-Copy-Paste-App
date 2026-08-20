# Joining by code: ask, don't walk in

**Decision record.** Built, so the specification that used to be here has moved to the docs
that own it. What is left is why, and what was rejected.

## The problem it solved

A Space Key never went to a mailbox - the invite mail carries the space's **invite code**,
and keys are wrapped X25519-to-X25519 between two apps. That distinction sharpened the real
problem rather than excusing it: `spaces.invite_code` is a **multi-use bearer capability**,
8 characters from a 31-symbol alphabet (about 2^40), one per space, valid 72 hours, with no
route to rotate it. Anyone holding it became a member the moment they posted it. A forwarded
mail, a screenshot in a group chat, a stale link in someone's history - each was a silent
join, and the owner found out by noticing a name in the member list.

The code was weak because it was *both* the introduction and the authorisation. The change
splits those: redeeming a code raises a **join request**, and somebody already inside
decides.

**A join link is the code.** `/join/{code}` is a page whose only job is to hand the code to
the app as `orange://join?code=...`; the app strips the wrapper and calls the same
`POST /spaces/join`. There is no link-shaped route and no link-shaped token, so a link
cannot behave differently from the characters inside it, and one gate covers both by
construction.

## Why approval is also faster

The counter-intuitive part, and the reason this was worth doing. **The joiner already
waited.** Joining by code made you a member instantly and left you unable to read anything
until somebody's app wrapped the key for you: membership in milliseconds, readability
whenever. The instantaneous part was never the useful part.

Turning that wait into an explicit approval costs no perceived latency and buys two things:

- **The key rides along with the decision.** Whoever approves is by definition online and
  holding the ring at that instant - they are the one clicking - so the approval writes the
  wrap in the same call. The joiner goes from pending straight to readable.
- **The wait now says something true.** "Waiting for approval" is a state a person
  understands and can chase. "You are a member of a space with no content in it" is not.

One control, chosen by the owner: **who may approve** - owner only, or the owner and any
member. Default owner-only. Addressed invites are unaffected, because naming a person by
email *is* the approval.

## Where the behaviour is documented

| What | Where |
|------|-------|
| `space_join_requests`, the routes, the two socket events | backend `docs/ARCHITECTURE.md` — sections 4.6, 4.10, 5.5, 5.8 |
| Notification rows, the Requests tab, the Waiting group | client `docs/ARCHITECTURE.md` |
| Who may approve, and where it is enforced | `PERMISSIONS.md` — Spaces |
| Walkthrough with flow diagrams | `join-approval.html` — dated, not maintained |

Migration `0018` applies on the next deploy. `ruff`, `ty`, `cargo check`, `cargo test` and
`bun run build` passed; the eight new backend tests have never run, because the fixtures
need a Postgres this machine cannot reach, so CI executes them first.

## Considered and dropped

- **A third `admin` role.** The original phrasing was admin-or-member, but a role brings
  rename, delete and remove-member with it by convention, and remove-member forces a rekey.
  A boolean on the space grants exactly the one capability asked for, and `role` stays
  `owner | member`.
- **Rotating the invite code on approval.** Tempting and wrong: the code is printed on links
  and sitting in mailboxes, so rotating it silently breaks every one of them. Approval
  already neutralises a leaked code, which is what rotation was for.
- **Auto-approving anyone with a matching addressed invite.** Already covered - that person
  accepts the invite and never touches the code path.
- **A settings ladder** (off / members / owner-only / expiring codes). Rejected in
  `SPACE-ACCESS.md` for the same reason: it moves the decision onto the user and makes the
  feature something you have to read about.
- **Deleting declined rows.** Then the same code gets the same stranger a fresh knock every
  time. The row is also the only record anyone has that somebody tried.

## What stays true

- The server still never sees a Space Key, a plaintext entry, or the UMK. An approval moves
  an opaque wrapped blob it cannot read.
- One code per space, 72 hours, no per-invite tokens, no link variants. The code itself is
  untouched - only what redeeming it *does* changed.
- Minting a Space Key stays the owner's alone; any keyholder may hand one over, which is
  what makes approve-and-wrap work for a member approver.
- `share_history` still resolves at join time, which is now approval time - a pending
  request is not a membership and gets no `history_from_ts`.
- Revocation is still best-effort for entries a member already pulled.

## One case the design missed

An `approved` row whose membership is gone, because the member left afterwards. Refusing
there would lock them out of a code they still hold with no way back, so `request_join`
reopens the spent row instead of refusing or duplicating it.
