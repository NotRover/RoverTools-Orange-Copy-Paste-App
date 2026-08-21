This release is about staying signed in. The app no longer shows the sign-in screen while
it is still reconnecting your account, and closing or relaunching it while it renews your
session no longer throws that session away.

### Fixed
- The app no longer shows the sign-in screen while it is still reconnecting. You see a
  reconnecting message instead, so you do not sign in again over a session that was
  coming back on its own.
- Quitting from the tray, closing the window, or launching the app again while the first
  copy is still running no longer signs you out. Each of those waits a moment for a
  session renewal in progress to finish.
- Installing an update no longer loses the last few seconds of what you copied.
- Passive sync mode works from the moment the app starts. Items arrive on their own
  schedule, and reminders about a Manual queue waiting to upload or storage running low
  appear again, without you needing to open the Account screen first.
- An item you delete while offline stays deleted. The pending deletion could be dropped
  if the app closed part way through a sync, which brought the item back.
- Release notes in the Settings update card show their headings and lists instead of raw
  markdown.

### Internal
- Client: one construction site for the sync client, so startup begins the same
  background loops the commands do. Flush and pull is serialised on its own lock, and the
  pending queue keeps a write-ahead copy across a flush so an interrupted one replays.
- Client: a rotation guard marks the window where a refresh token has been spent but its
  replacement is not yet stored. Every exit path drains it, and a relaunch waits on a
  marker file before force-killing the instance it replaces.
- Backend: the Redis pool health-checks and retries, since building it from a URL
  inherited zero retries and no health check. Presence lookups degrade to offline instead
  of failing a request and are batched into two round trips per space, publishes are
  best-effort with a dropped-event gauge, and the pub/sub listener reconnects instead of
  stopping silently.
- Backend: an unreachable JWKS endpoint answers 503 with a retry hint rather than 401,
  and token decoding allows 30 seconds of clock skew.
- Docs: bugfix history entries 18 and 19, a shutdown and rotation window section in the
  client architecture doc, the presence hint contract in the backend architecture doc,
  and a correction to the migration claim in CLAUDE.md.
- Website submodule updated with the landing page bento and hero mockup work.
