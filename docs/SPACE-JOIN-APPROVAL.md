# Joining by code: ask, don't walk in

`docs/SPACE-ACCESS.md` closed with "Nothing changes about joining." This supersedes
that section. Everything else in that document stands.

## The correction worth making first

A Space Key has never gone to a mailbox. What the invite email carries is the
space's **invite code**, and keys are wrapped X25519-to-X25519 between two apps
that never touch the server in plaintext. The mail carries a way *in*, not a key.

That distinction does not rescue the design, though — it sharpens the actual
problem. `spaces.invite_code` is a **multi-use bearer capability**: 8 characters
from a 31-symbol alphabet (about 2^40), one per space, valid 72 hours, and there
is no route to rotate it. Anyone holding it is a member the moment they post it
to `POST /spaces/join`, and `join_space` calls `add_membership` with no gate of
any kind (`src/spaces/service.py:256`). A forwarded mail, a screenshot in a
group chat, a stale link in someone's history — each is a silent join. The owner
finds out by noticing a name in the member list.

So the code is the weak part, and it is weak because it is *both* the
introduction and the authorisation. Split those.

## The change

**A code or a link gets you to the door, not through it.** Redeeming one creates
a **join request**, not a membership. Somebody already inside decides.

An **addressed invite is unaffected**: the owner named a person by email, which
*is* the approval, and that path already pre-wraps the key (`PUT /invites/{id}/key`).
Approval is only for the anonymous path, because that is the only path where
nobody chose the joiner.

One control, on the space, chosen by the owner: **who may approve.** Owner only,
or the owner and any member. Default owner-only for a new space. That is the
whole of it — no second switch, no per-invite settings, nothing to explain.

The existing `role` column is already `'owner' | 'member'`
(`src/spaces/models.py:81`), so this needs no third role. Approving is not
renaming, deleting, or removing members — those stay the owner's, and removing a
member triggers a rekey, which is not a capability to hand out casually.

## Why this is also faster

This is the part that matters, and it is counter-intuitive: **the joiner already
waits today.** Joining by code makes you a member instantly and leaves you
unable to read anything until somebody's app wraps the key for you. Membership
arrives in milliseconds; readability arrives whenever it arrives. The
instantaneous part was never the useful part.

Turning that wait into an explicit approval costs no perceived latency and buys
two things:

- **The key rides along with the decision.** Whoever approves is, by definition,
  online and holding the ring at that instant — they are the one clicking. So
  the approval writes `wrapped_space_keys` in the same breath, exactly like the
  invite-accept path. The joiner goes from *pending* straight to *readable*, with
  no second wait. Today they land in a space they can see the name of and nothing
  else.
- **The wait now says something true.** "Waiting for approval" is a state a
  person understands and can chase. "You are a member of a space with no content
  in it" is not.

## Data model

Four additions. Nothing existing changes shape.

| Where | Column / table | Why |
|---|---|---|
| `spaces` | `members_can_approve` boolean, default `false` | The one control. Owner-only until the owner says otherwise. |
| `space_join_requests` | new table | A request is requester-initiated: no inviter, no invitee_email, no email delivery. Overloading `space_invites` would mean half its columns are null and every query needs a discriminator. |
| `space_join_requests` | unique `(space_id, user_id)` | The abuse cap. A leaked code now lets strangers *knock*, and a knock must not be stackable. |
| `space_join_requests` | `wrapped_space_keys` text, nullable | The approver's wrap, handed to `add_membership` the way the invite path already does. |

`space_join_requests`: `id`, `space_id`, `user_id`, `status`
(`pending` | `approved` | `declined`), `wrapped_space_keys`, `wrapped_by`,
`created_at`, `decided_at`, `decided_by`.

A declined row is kept, not deleted — it is what stops the same person knocking
again on a code they still hold, and it is the only record the owner has that
somebody tried.

## Wire changes

- `POST /spaces/join` returns `{"status": "pending", "space_name": ...}` instead
  of a `JoinResponse` with a space in it. The space name is the only thing
  leaked, and the requester needed it to know what they asked for.
- `GET /spaces/{id}/join-requests` — pending rows, for anyone who may approve.
- `POST /spaces/{id}/join-requests/{rid}/approve` — body carries the wrapped
  ring, same shape as `AttachKeyRequest`. Calls `add_membership` with it.
- `POST /spaces/{id}/join-requests/{rid}/decline`.
- `PATCH /spaces/{id}` gains `members_can_approve`, owner only.
- `SpaceOut` gains `members_can_approve` and `i_can_approve` (derived: owner, or
  member and the flag is on), so the client never re-derives the rule.
- Fan-out: `space:join_requested` to everyone who may approve;
  `space:join_decided` to the requester. Both go through the existing space and
  user channels in `realtime.py` — no new channel.

`GET /join/{code}` — the web page — **does not change.** It hands the code to
the app, and the app's join call does the rest.

## Notifications

Two rows, using the `note_*` pattern in `sync/mod.rs` built for the key work:

| Kind | Row |
|---|---|
| `SpaceInvite` | Somebody asked to join a space you can approve. Keyed on the request id, so a reconnect replaying the event cannot double-report. Raised only if `i_can_approve`. |
| `SpaceActivity` | Your request was approved. Keyed on the space. A decline raises nothing loud — the request row flips to declined and the app stops showing it as pending. |

## UI

Approvals live where invites already live: the **Invites** popover at the foot of
the spaces panel (`SpacesScreen.tsx:3575`), which becomes two lists under one
trigger. Its count (`sp-invites-count`) sums received invites, sent invites, and
pending requests, and the Account nav badge in `App.tsx:607` picks up requests
the same way it picks up invites.

A request row is one line: who, which space, Approve / Decline. Approving is a
single click, because the wrap happens in Rust with a ring the approver already
holds — there is nothing to ask them.

The requester's own side is a row in their spaces list: the space name, greyed,
with "Waiting for someone in this space to let you in." No feed, no controls. It
is the state they are already in today, finally labelled.

## Considered and dropped

- **A third `admin` role.** The user's phrasing was admin-or-member, but a role
  brings rename, delete, and remove-member with it by convention, and
  remove-member forces a rekey. A boolean on the space grants exactly the one
  capability asked for.
- **Rotating the invite code on approval.** Tempting, and wrong: the code is
  printed on links and sitting in mails, and rotating it silently breaks every
  one of them. Approval already neutralises a leaked code, which is what
  rotation was for.
- **Auto-approving anyone with a matching addressed invite.** Already covered —
  that person accepts the invite and never touches the code path.
- **A settings ladder** (off / members / owner-only / expiring codes). Rejected
  earlier in this work for the same reason: it moves the decision onto the user
  and makes the feature something you have to read about.
- **Deleting declined rows.** Then the same code gets the same stranger a fresh
  knock every time.

## What stays true

- The server still never sees a Space Key, a plaintext entry, or the UMK. An
  approval moves an opaque wrapped blob it cannot read.
- One code per space, 72 hours, no per-invite tokens, no link variants. The code
  itself is untouched — only what redeeming it *does* changes.
- Minting a Space Key stays the owner's alone. Any keyholder may hand one over,
  which is what makes approve-and-wrap work for a member approver.
- Addressed invites keep their pre-wrap and their instant read.
- `share_history` still resolves at join time, which is now approval time — a
  pending request is not a membership and gets no `history_from_ts`.
