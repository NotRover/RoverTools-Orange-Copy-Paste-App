# Bug Fix History

> This is a durable record, not a changelog. Add to it; don't prune it.

**Owns:** regressions. What broke, the root cause, and what now stops it coming back.
The value is the root cause — a fix with no explanation of why the bug was possible is a
changelog entry, not history.
**Not here:** how the system works. Describe only the mechanism the bug turned on, and
link the rest: `docs/architecture.md` for client internals,
`orange-copy-paste-clipboard-backend/docs/architecture.md` for anything on the wire.

---

## #1 — Clipboard screen missing entries that paste popup shows

**Symptoms**:

- A copied entry never appeared in the main Clipboard Screen, but did show up in the Quick Paste popup
- After copying more items, the missing entry duplicated itself in the paste popup (appeared twice) and behaved erratically (auto-selected, couldn't be dismissed)

**Root Causes** (3 related issues):

### 1a. Hotkey handler and clipboard watcher race to push the same entry

**File**: `src-tauri/src/runtime/hotkeys.rs`  
When Ctrl+Shift+C was pressed, `handle_copy_shortcut` simulated Ctrl+C then read/pushed the entry. The clipboard watcher _also_ detected the same OS clipboard change and independently tried to push it. The `suppress_next_capture` flag (already used by `copy_entry`/`paste_entry` commands) was never wired into the hotkey handler, so both paths raced.

**Fix**: Threaded the `Arc<AtomicBool>` suppress flag into `register_copy_shortcut` → `handle_copy_shortcut`. The handler now sets `suppress = true` right before `simulate_copy()`, so the watcher skips this change. Only the hotkey handler pushes + emits.

### 1b. Clipboard watcher advances its sequence token before confirming the read succeeded

**File**: `src-tauri/src/runtime/clipboard_watcher.rs`  
The watcher updated `last_token = token` _before_ calling `capture_clipboard_change`. If the OS clipboard was locked (e.g. Explorer still writing CF_HDROP), `read_clipboard_entry()` returned `None` and the change was permanently lost — the entry existed in the OS clipboard but never made it into history.

**Fix**: `capture_clipboard_change` now returns `bool`. The watcher only advances `last_token` when `true` (handled/suppressed/deduplicated). On `false` (read failure), the old token is kept so the next 220ms poll retries the same change.

### 1c. Frontend `get_history` response overwrites event-received entries

**File**: `src/components/app/App.tsx`  
On startup, `get_history` replaced the entire React state. If a `clipboard:new-entry` event arrived before the async response, that entry was overwritten and lost. There was also no mechanism to recover from missed events later.

**Fix**: The `get_history` handler now _merges_ with existing state (preserves event-received entries not in the response). Added a `tauri://focus` listener that re-fetches history whenever the main window regains focus as a safety net against any future desync.

## #2 — Paste popup intercepts clicks / images fail to paste / popup unresponsive after paste

**Symptoms**:

- Pasting copied images (especially from Discord without downloading) via the paste popup would fail to paste.
- Pressing Ctrl+Shift+V would not spawn the popup for several seconds after a failed image paste.
- Clicking on the area where the popup previously existed would paste the entry that happened to be at that screen position.

**Root Causes** (3 related issues):

### 2a. Hidden popup window remains at cursor position — still intercepts clicks

**File**: `src-tauri/src/runtime/popup_windows.rs`  
`hide_popup` only called `win.hide()`. On some Windows/WRY configurations, transparent always-on-top windows can still receive hit-test events even when "hidden" — or there is a brief moment between the hide request and the OS actually removing the window from hit-testing. Since the window stayed at its original screen position (near the cursor), clicking in that area could hit the invisible window and fire a stale `paste_entry` event.
**Fix**: `hide_popup` now moves the window to `(-9999, -9999)` before calling `hide()`, matching the initial offscreen position used during window creation. This guarantees the window cannot intercept clicks regardless of the OS hide timing.

### 2b. Clipboard write fails silently due to contention with watcher / other apps

**File**: `src-tauri/src/clipboard/commands.rs`  
`write_entry_to_clipboard` called `Clipboard::new()` exactly once. On Windows, `OpenClipboard` fails if any other thread or process already has the clipboard open. The clipboard watcher polls every 220 ms and opens/closes the clipboard multiple times during each `read_clipboard_entry` cycle. Discord itself may also hold the clipboard briefly. A single failed open caused the entire paste to silently fail — no Ctrl+V was ever simulated.
**Fix**: Introduced `open_clipboard_with_retry()` which retries `Clipboard::new()` up to 6 times with 50 ms delays. This gives the watcher or external app time to release the clipboard.

### 2c. `simulate_paste` corrupts keyboard modifier state

**File**: `src-tauri/src/runtime/platform/windows.rs`  
`simulate_copy` defensively releases Shift and Ctrl before sending its keystroke sequence, but `simulate_paste` did not. When a delayed paste simulation fired while the user was holding Ctrl+Shift (e.g. pressing Ctrl+Shift+V to reopen the popup), the injected Ctrl-up event released the user's physical Ctrl key in the OS input queue. This caused the global shortcut to fail to register for several seconds.
**Fix**: `simulate_paste` now mirrors `simulate_copy` by sending Shift-up and Ctrl-up before the Ctrl+V sequence.

## #3 — Pasting large images from paste popup takes 5–15 seconds

**Symptoms**:

- Pasting a large screenshot or high-resolution image from the paste popup would freeze the app for 5–15 seconds before the paste completed.
- Small text entries pasted instantly; the delay scaled with image size.
- CPU usage spiked during the delay (zstd decompression + base64 decode + image pixel conversion).

**Root Causes** (2 related issues):

### 3a. Inline base64 image data inflated compressed history size

**Files**: `src-tauri/src/clipboard/history.rs`, `src-tauri/src/clipboard/commands.rs`
Clipboard images were stored as `data:image/png;base64,…` strings directly inside `ClipboardEntry.content`. The full history (including all inline image data) was serialized to MessagePack and compressed with zstd on every flush. A single 4K screenshot could add 10+ MB of base64 to the history. On paste, the entire compressed history had to be resident in memory, and the entry's multi-megabyte base64 string had to be decoded → image pixels → CF_DIB/PNG — all on the main thread before Ctrl+V could be simulated.

**Fix**: Redesigned image storage to be **file-backed**. On `push()`, images with inline data-URLs are immediately externalised to individual files in the `{app_data}/images/` directory (named `{id}_{label}.{ext}`). The entry's `content` field is replaced with the absolute file path. The history file (`history.bin`) now contains only the small file-path string, not megabytes of base64. Removed the `zstd` dependency entirely — plain MessagePack is fast enough without the overhead of compressing mostly-path-string metadata.

### 3b. Image paste decoded pixels unnecessarily when a file path was available

**File**: `src-tauri/src/clipboard/commands.rs`
`write_entry_to_clipboard` always decoded the image data-URL to RGBA pixels and wrote CF_DIB + PNG via Win32 APIs. This pixel conversion was the slowest step (several seconds for large images) and was entirely unnecessary when the image already existed as a file on disk.

**Fix**: `write_entry_to_clipboard` now checks whether the image entry's content is a file path or a data-URL. For file-backed images (the common case after the redesign), it writes **CF_HDROP** instead — the same clipboard format used for file entries. The paste target receives the file directly with zero image decoding, matching Explorer-copy performance. The Win32 pixel path is retained only as a fallback for legacy inline data-URLs.

## #4 — CardMenu (right-click context menu) appears at top-left on first open

**Symptoms**:

- Right-clicking an entry card for the first time spawned the context menu at the top-left corner of the window (0, 0) instead of at the click position.
- Subsequent right-clicks on the same card positioned the menu correctly.

**Root Cause**:

**File**: `src/components/app/card-menu/CardMenu.tsx`
The `CardMenu` component used `useState` to track its position, initialized with `{ x: anchorX, y: anchorY }`. When the component first mounted (before any menu was opened), `anchorX` and `anchorY` were both `0`. The first `useLayoutEffect` that set `pos` from the anchor props triggered a state update + second render, but the first render already painted the portal at `(0, 0)` causing a visible flash.

**Fix**: Removed the `pos` state entirely. The portal's initial `style` now reads `anchorX`/`anchorY` directly. A single `useLayoutEffect` adjusts the element's `style.left`/`style.top` via direct DOM manipulation for viewport overflow correction. This eliminates the two-render cycle and ensures the menu appears at the correct position on every open, including the first.

## #5 — Footer chip overflow: +N button hidden under timestamp in tiles view

**Symptoms**:

- On narrow card widths (tiles view, small window), the "+N" group overflow button and group chips would be clipped behind the timestamp.
- The new "In clipboard" chip exacerbated the issue by consuming extra horizontal space.
- With all base chips (type, pinned, saved, in-clipboard) present, group indicators were completely invisible.

**Root Causes** (2 related issues):

### 5a. Chip measurement did not account for the "In clipboard" chip

**File**: `src/components/app/clipboard-screen/entry-card/EntryCard.tsx`
The `measureVisibleGroupCount` callback measured widths for the type, pinned, and saved chips but did not include the new "In clipboard" chip width. This caused it to over-estimate available space for group chips.

**Fix**: Added a `clipboardMeasureRef` and included its width in the `baseChipWidths` calculation alongside type, pinned, and saved chip widths.

### 5b. Chip container used `overflow: hidden` causing hard clipping

**File**: `src/components/app/clipboard-screen/entry-card/EntryCard.css`
The `.card-chips` container had `overflow: hidden`, which silently clipped any chips that exceeded the single-row width. Even when the measurement correctly determined no group chips would fit, the +N overflow button was still rendered inside the clipped container and became invisible.

**Fix**: Replaced `overflow: hidden` with `flex-wrap: wrap` on `.card-chips`. Chips now gracefully wrap to a second row when the card is narrow instead of being invisibly clipped. Changed `.card-footer` from `align-items: center` to `align-items: flex-start` so the timestamp stays aligned with the first row of chips. Rewrote the measurement algorithm to:

1. First try fitting all groups without an overflow button.
2. If not all fit, reserve overflow button width before calculating how many groups fit.
3. If even the overflow button can't fit alongside base chips, show 0 groups with no overflow button (chips wrap naturally).

## #6 — Screenshots and image copies produce duplicate history entries

**Symptoms**:

- Taking a screenshot (Win+Shift+S, Snipping Tool) or copying an image from certain apps would add the same image entry to clipboard history twice.
- Both entries appeared identical in the UI, wasting space and confusing the user.

**Root Cause**:

**Files**: `src-tauri/src/clipboard/history.rs`, `src-tauri/src/runtime/clipboard_watcher.rs`
Some Windows apps (Snipping Tool, browsers) write to the clipboard in multiple passes, incrementing the clipboard sequence number more than once for a single copy operation. The clipboard watcher polls every 220ms using `GetClipboardSequenceNumber()` and captured each sequence-number change independently.

On the first capture, `push()` externalised the image from an inline data-URL (`data:image/png;base64,…`) to a file path (`C:\…\images\42_Image.png`), replacing the entry's `content` field. On the second capture (triggered by the second sequence-number increment), the watcher read the same image from the clipboard as a fresh data-URL. The deduplication check (`is_duplicate_top`) compared this data-URL string against the stored file path string — they didn't match, so the image was pushed as a new entry.

**Fix**: Added a `content_hash: Option<u64>` field to `ClipboardEntry`. When an image entry is created, a 64-bit hash of the data-URL string is computed (using Rust's `DefaultHasher`) and stored on the entry. This hash survives externalization — when `push()` replaces the data-URL with a file path, the hash remains unchanged. The `content_matches()` function and `is_duplicate_top()` now compare hashes for image entries instead of raw content strings. This is O(1) with zero I/O, zero base64 decoding, and zero file reads. The hash is session-only (`#[serde(skip)]`) since the dedup issue only occurs within a single 220ms window, not across restarts.

---

## #7 — "Remove from cloud" left rows behind, so storage stayed occupied after clearing the account

**Symptoms**:

- Account & Sync reported `1.1 MB of 50.0 MB` in use immediately after "Remove from cloud" said `Removed 10 items from the server`.
- Repeating the removal, and pressing Sync now in between, changed nothing. The bytes could not be reclaimed by any action available in the app.
- Only reproducible on an account with more than one device, which is why it survived earlier testing.

**Root Cause**:

**Files**: `src-tauri/src/sync/commands.rs` (`sync_unpush_all`), `src-tauri/src/sync/mod.rs` (`entry_states`)

`sync_unpush_all` built its work list from `sync.entry_states()`, which is derived from this device's `id_map.json` — the local record of what *this* device pushed or pulled. It is not, and never was, a view of the account.

So any row another device pushed and this device had never pulled (or had pulled and since forgotten, e.g. after a local clear wrote a deleted marker and dropped the id_map row) was invisible to the button. No tombstone was ever pushed for it, the row stayed live, and because the backend's quota sums *confirmed* blobs (`src/blobs/service.py:_used_bytes`), an image row went on charging the account forever. The client had no other route to those rows: pull is cursor-based and strictly `server_ts > after_ts`, so old entries never come back into view during normal sync.

Two smaller faults made the leak invisible rather than obvious:

- The storage bar only refetched on mount, session restore, sign-in and Sync now — never when a bulk Upload or Remove finished, so even a removal that *did* free bytes appeared to do nothing.
- The result sentence was computed from the local tally, so a removal that missed rows still reported a clean sweep.

**Fix**:

- New `SyncClient::server_entry_keys()` pages `/api/v1/sync/pull` from `after_ts = 0` and returns every live entry key the account owns. Rows owned by other space members are skipped deliberately: entries are keyed `(user_id, client_id, entry_type)`, so a tombstone of ours would not remove theirs — it would insert one of our own carrying the same `space_ids` and take the item down for every member of the space.
- `sync_unpush_all` is now async and tombstones the union of the local keys and the server keys, falling back to local-only when the server is unreachable.
- `sync_server_entry_count` is called after every removal run, and the result sentence reports what the *server* still holds rather than what the local tally believed. A future regression of this class surfaces as `Removed N, but M are still on the server` instead of silently leaking.
- Removal progress counts down `BulkProgressOut::present` (keys sync still knows about at all) instead of un-acknowledged keys. "Not acknowledged" also describes a tombstone that has not gone out yet, so a row with no local record read as already removed on the first poll. `spawn_delete_entry` now claims the key in `in_flight` before spawning its task and holds it through every exit path, so a removal is visible for its whole life.
- The quota is refetched whenever a bulk run finishes, and the bar is labelled "Image storage" with a note that text and notes take no space — the number not moving after clearing hundreds of text entries is correct behaviour, and used to read as a bug.

**Invariant to keep**: `entry_states()` / `id_map` answer "what does *this device* know about", never "what does the account have". Anything account-wide — removal, quota, reconciliation — must ask the server. The three remaining `entry_states()` callers (`sync_push_unsynced`, `sync_preview_unsynced`, `sync_bulk_progress`) are all correctly about local items; keep it that way.

---

## #8 — A shared entry showed the wrong author, and the name changed depending on where you looked

**Symptoms**:

- A note written by one member and shared into a space showed that member's name on one surface and the *viewer's* name on another, for the same note at the same moment.
- The account showing as the author was one that had been able to edit the note earlier.
- Which name appeared was not stable: it depended on the order rows came back from a pull.

**Root Cause**:

**Files**: `src-tauri/src/sync/mod.rs` (merge loop, `author_of`), `src-tauri/src/sync/id_map.rs` (`set_entry_owner`)

Entries are keyed server-side by `(user_id, client_id, entry_type)`. A device that pushes an entry it did not write therefore does **not** update the author's row — it inserts a *second* row carrying the same `client_id` under its own account, and both rows fan out to every member of the space.

The merge collapses both onto one local key (`note:<client_id>`), and two things then decided the outcome by arrival order:

- `set_entry_owner` was a plain map insert, so the last row merged named the author.
- The row's content was merged unconditionally, so the editor's text overwrote the author's on every device.

Pull is ordered `server_ts ASC` (`src/sync/service.py`), so the rival row — pushed later, higher `server_ts` — always arrived last and always won. Meanwhile `mark_entry_remote` *is* sticky, so the entry stayed correctly flagged as "someone else's" for the permission guards. That split is what made the surfaces disagree: the guards said not-yours, the name said yours.

The push guards in `spawn_push_note` and `spawn_push_clipboard_entry` already refuse to publish an entry flagged remote, so a current build does not create rival rows. They are the sending half only — rows already on the server, or written by a device that has not been updated, could still take an entry over on the way in.

**Fix**:

- `set_entry_owner` is sticky like `mark_entry_remote`: the first author on record keeps the entry, and a later row naming somebody else is refused rather than applied. It returns whether the record now names the given account, so a caller can tell agreement from refusal.
- The merge loop drops a rival row whole — content, tombstone and all — via `row_is_authoritative`. An entry has one author; a row from anyone else is not a version of it.
- `author_of` also answers for entries with nobody on record: one this device knows and has *not* flagged remote is one we wrote. Without that, the takeover ran the other way — another member's row could claim an entry of ours.
- Installs already damaged are repaired once, at sign-in: every recorded author is dropped and the pull cursor is rewound, so the server rebuilds them (`clear_all_entry_owners` + `SyncState::authorship_repaired`). A narrower repair — releasing only the impossible pairings — was rejected because a device that merely watched recorded a wrong name that is locally indistinguishable from the truth, so all records go and the rewind re-establishes each author from the `server_ts`-ordered pull (the original always precedes any rival copy). **Cost: one full re-pull per install, once.**
- `useEntryOwners` seeds from `sync_get_remote_entries` before the name map, so an entry known to be someone else's but with no name reads "A member". Dropping the chip because the name is unknown says the opposite of what is true.

**How a regression is caught, not just avoided**: the bug was silent, so the fix is tested at every layer. The rule is a pure function covered by `sync/mod.rs::ownership_tests`; stickiness is asserted at the store (`id_map.rs::tests`); the server itself refuses a rival write (`sync/service.py::_belongs_to_someone_else` returns `not_your_entry` — the layer that matters most, since old client builds keep running), covered in `tests/test_spaces_invites.py`; and a refusal reaches the notification centre (`push_entry_task` routes it through `record_skip`) instead of only stderr.

**Invariant to keep**: an entry has exactly one author, and neither the recorded owner nor the entry's content may change hands on arrival order. Anything that decides authorship must be sticky or explicitly ordered — never last-write-wins.

---

## #9 — One typo in the password after a Google sign-in meant doing the whole Google sign-in again

**Symptoms**:

- Sign in with Google, get to the account-password step, mistype the password. The error is correct: "Incorrect password. It does not match the one this account was encrypted with."
- The field stays live, so retyping it looks like the obvious next move. The second attempt answers **"no pending sign-in, start again"** no matter what is typed.
- The only way to get one more attempt is to go back and repeat the entire browser round trip through Google.
- Closing and reopening the app did not help either: the step could not be restored.

**Root Cause**:

**Files**: `src-tauri/src/sync/mod.rs` (`complete_oauth`), `src/components/app/account-screen/AccountScreen.tsx` (the password stage)

OAuth is two phases. `begin_oauth` finishes the provider handshake and stashes the resulting session in `pending_oauth`, because the session alone is not enough — the account password is the E2E secret and has to come from the user. `complete_oauth` is phase two.

It opened with `.take()` on the stash, *before* the password was validated. The session moved into a local binding, went into `finalize_session` by value, and was dropped when that returned `Err`. Nothing put it back. So the first wrong password did not just fail — it consumed the one session that could have been retried.

Two things then made it look like a bug in the password check rather than a lost session:

- The frontend only calls `resetOauth()` on success, so the stage stayed open with a live input. Correct on its own, and exactly what makes the dead end visible.
- `pending_oauth()` reads the same stash, so the mount-time `sync_oauth_pending` probe could not restore the step after a restart.

A second defect sat next to it. On a first-ever OAuth sign-in the flow also has to give the account a real password, and `update_password` ran *before* `finalize_session` wrote the envelope. A failure in between — a dropped connection on `set_wrapped_umk`, say — left the account with a new Supabase credential and no envelope wrapped under it: signable in, undecryptable. Worse, the next attempt with a *different* password would then be checked against the first one.

**Fix**:

- `PendingOAuth` derives `Clone`, and `complete_oauth` reads a clone. The stash is cleared only after the whole thing has succeeded, so a wrong password leaves the retry the UI is already offering actually working — and a restart can still restore the step.
- The order is reversed for a first sign-in: `finalize_session` writes the envelope first, then `update_password` sets the Supabase credential. A failed attempt now changes nothing server-side, which is what makes the retry safe.
- `update_password` failing is no longer fatal. Sign-in has already succeeded at that point, and returning an error would leave the app signed in while the UI still showed the password step. It logs, and the only thing lost is email-and-password login for that account; Google still works and the envelope matches what was typed either way.

**Invariant to keep**: nothing may be consumed or written server-side before the password that has to match it is verified. The stash outlives every failed attempt, and for a new account the envelope is written before the credential — never the other way round.

---

## #10 — After a Google sign-in the app stayed in the background

**Symptoms**: the browser tab said to return to the app, and the app was still behind everything else. The password step was waiting, unseen. A sign-in that *failed* was worse: the tab said so, the app said nothing, and nothing had focus.

**Root Cause**:

**Files**: `src-tauri/src/sync/mod.rs` (`begin_oauth`), `src-tauri/src/lib.rs` (`dispatch_deep_link`), `src-tauri/src/sync/oauth.rs` (the result page)

OAuth does not use the `orange://` deep link — it uses a short-lived loopback server on `127.0.0.1:53170-53172` as the redirect target. The deep-link path had always raised the window (`show` + `set_focus`); the loopback path never did, because it never went through the dispatcher. There was no `set_focus` anywhere in `sync/`.

The `sync:oauth-ready` event and the `sync_oauth_pending` probe exist to keep the *UI state* correct across the browser hop, and they worked. Neither of them brings a window forward.

**Fix**:

- `focus_main_window` in `sync/mod.rs`, called as soon as the loopback capture returns, on both the success and failure paths.
- `dispatch_deep_link` raises the window *before* parsing the URL, so a bare `orange://` is a usable "bring the app forward" link rather than a silent no-op.
- The loopback result page is rebuilt in the app's own visual language (the `App.css` tokens and the sign-in screen's accent badge) and links to `orange://` as a manual fallback for anyone whose window manager ignores a programmatic focus. It also no longer uses a Unicode check mark, which broke the ASCII-only copy rule — the tick and cross are drawn as inline SVG.

**Invariant to keep**: whenever a flow hands the user off to the browser and expects them back, the app raises itself when the browser half returns. Both outcomes, not just the happy one.

---

## #11 — The password-reset email linked to localhost, and resetting would have lost the data anyway

**Symptoms**: "Send reset link" reported success and the email arrived, pointing at `http://localhost:3000/...`. Nothing served that, so the link was dead on every machine. A user who forgot their password had no way back into their account.

**Root Cause**:

**Files**: `src-tauri/src/sync/supabase.rs` (`recover`), `src-tauri/src/sync/mod.rs` (`reset_password`), `src-tauri/src/lib.rs` (`parse_deep_link`)

Two independent causes, and the second only became visible once the first was fixed.

1. `recover()` sent `{ "email": ... }` and nothing else - no `redirect_to`. GoTrue falls back to the project's Site URL when no redirect is given, and that was a development localhost value. There was also nowhere for a link to land: the backend served no HTML at all.

2. Even with a working link, the reset would have been destructive. The password is only a wrapping key: the UMK is a random account-wide key kept in one envelope, `pw_wrapped_umk`. Setting a new password without re-wrapping that envelope produces an account you can sign into and cannot decrypt - and the old envelope is gone. The account screen said as much, in a note admitting data would be lost.

**Fix**:

- The backend serves `/reset` (and `/join/{code}`), so there is a real page to land on. `recover()` now sends `redirect_to = {server_url}/reset` plus an S256 PKCE challenge, with the verifier in the OS keychain - install-scoped, because the request happens while signed out and the two halves are usually separated by an app restart.
- PKCE rather than the implicit flow: the emailed link carries a one-time code in the query instead of a live access token in the fragment, and the code cannot be redeemed without the verifier, which never left the machine that asked for the reset.
- `parse_deep_link` replaces `parse_join_code` and distinguishes `orange://reset?code=` from `orange://join?code=`. Any other host carrying a code is still a join, because invite links already sent out rely on that.
- `complete_password_reset` re-wraps the **same** UMK, recovered from memory if signed in, otherwise from this machine's device wrap. Only if neither is available does it offer to start over with a new key, and it says plainly what that costs.
- Envelope first, password second. The reverse order can leave an account whose password opens nothing, which is exactly the failure bug #9 fixed in the OAuth path.
- `change_password` for a signed-in user is the same steps minus the code exchange, and cannot lose anything. It is what the account screen offers; the reset link is the fallback.

**Requires one deploy-config entry**: the reset redirect URL must be registered with the identity provider, or GoTrue ignores the redirect and mails the Site URL again. See `orange-copy-paste-clipboard-backend/docs/DEPLOY.md`.

**Invariant to keep**: a password change is a re-wrap, never a new key. Any path that sets a password must have the UMK in hand first, and must write the new envelope before the credential changes.

---

## #12 — Any stray 404 on one route signed the user out and demanded a password

**Symptoms**: reported as sessions ending around backend deploys. The app came back at the sign-in screen with credentials still in the keychain and nothing wrong with them.

**Root Cause**:

**Files**: `src-tauri/src/sync/client.rs` (`run`, `get_device_wrapped_umk`), `src-tauri/src/sync/mod.rs` (`try_restore_session`, `recover_umk_for_reset`), backend `src/auth/router.py`

Silent restore recovers the master key from `GET /api/v1/auth/umk/device`. The client called it through `run(tag, allow_404: true, ...)`, which collapsed a 404 into `Ok(None)` and dropped the response, and `try_restore_session` turned that `None` straight into `RestoreError::Terminal` - the one class that is never retried and always ends in a password prompt.

The backend does answer 404 there deliberately: it is how revoking a device cuts it off, so the terminal handling was right for that case. It was wrong for every other 404. Nothing in `Ok(None)` said which had happened, so a proxy answering for the service, a rewritten path, or a deployment older than the route all read as "this device was revoked".

The rest of the restore path was already careful about this distinction - transport errors, 429, and every 5xx classify as transient and retry unboundedly - which is why the cause was not the deploy itself. A redeploy cannot end a session on its own: the backend stores no session state, it only verifies Supabase JWTs.

**Fix**:

- The route stamps its own 404 with `X-Wrap-Absent: 1`, and the header is documented as part of the contract.
- `get_device_wrapped_umk` returns a three-state `DeviceWrap` instead of an `Option`. Only a 404 carrying that header is `Absent`; an unmarked 404, and a 200 without a wrap in it, come back as errors with no status, which `ApiError::is_transient` reads as retryable.
- `run` hands back the response on an allowed 404 rather than collapsing it to `Ok(None)`, so a caller can still see what it was told. `pull_settings` reads the status for the same answer it read from `None` before, and one `expect("404 not allowed here")` panic path disappeared with the `Option`.
- The header is a marker, not prose. Sniffing the detail string would have worked today and broken the next time the wording moved, which is the failure this repo already had once in the invite path.

**Invariant to keep**: ending a session is a terminal act and needs a positive answer from the server. Absence of a successful reply is never one - if the credentials in the keychain could still work, the restore retries instead of asking for a password.

---

## #13 - One member leaving could make a space unreadable for everyone, forever

**Symptom.** A space that had been working went permanently blank for every
member, owner included. Nothing in the app said why, and rejoining did nothing:
the entries were still on the server, and no key existed that could open them.

**Cause.** A departure was the rekey signal, and the signal was "the server
cleared every wrapped keyring" - the owner's included. A Space Key lives only in
client memory and in those wraps. So between the departure and the owner's next
distribution, the ring existed in exactly one place: the owner's running process.
If that process restarted in the window - a quit, a crash, a reboot, an update -
the previous keys were gone. Reconcile then found an empty ring, minted a *first*
key rather than prepending, and every entry ever shared in the space stayed
encrypted under keys that no longer existed anywhere.

Any member could trigger it, by leaving. Nothing about it needed bad intent, and
nothing about it was recoverable.

**Fix.** The signal moved out of band. `remove_member` clears the *non-owner*
wraps and stamps `spaces.rekey_requested_at`; the owner's wrap stays, so its ring
survives a restart and reconcile prepends to it instead of starting over. The
client reads `rekey_requested_at` rather than inferring a rekey from an empty
wrap, and distribution clears the flag once every member holds a copy.

**Why it is written down.** The old shape looks harmless in the diff - clearing
every wrap is the obvious way to say "everybody needs a new key". What it also
did was delete the only durable copy of the keys that still had to work. A wrap
is not a cache here; for the owner it is the backup.

---

## #14 - A valid token was enough to take over an account's future shared content

**Symptom.** None, which is the point. Nothing broke, and nothing looked wrong.

**Cause.** `POST /auth/keys/register` assigned `profiles.identity_pubkey`
unconditionally. Space Keys are wrapped to whatever sits in that column, so
anyone holding a valid access token - no password, no UMK - could replace it with
a key they owned and be handed every subsequent key distribution for every space
the account was in. The real device would go on failing to unwrap and quietly
retry.

**Fix.** The column is write-once. The identity keypair is derived from the UMK,
so every honest device of an account sends the same value forever; a *different*
value means the caller does not hold the UMK. A change is refused with 409 and
logged. Device keys stay writable - each only ever opens that device's own copy
of the UMK.

**Why it is written down.** It became load-bearing the moment invites started
carrying a pre-wrapped key: that wraps for whatever is in the column, on the
strength of the server's word about who owns it.

---

## #15 - Password reset was a dead end: the recovery code and "start over" could never be reached

**Symptom.** Open the emailed link on the machine that asked for it. The first
attempt answers "this device has never held your encryption key, so a new
password cannot unlock what you synced before" and reveals the two ways out - a
recovery code, or starting over with a new key. Taking *either* one answers "this
reset link was requested on another device or has already been used". Every
retry, and every fresh link, ends the same way. The account cannot be recovered
even by a user willing to abandon all of their synced data, and the old password
still works, which makes it look as though the reset silently did nothing.

**Cause.** Three faults in a chain, all in `complete_password_reset`.

1. It built a fresh `SyncHttpClient` and set the access token, refresh token and
   user id, but never `set_device_id`. `GET /api/v1/auth/umk/device` is
   device-scoped and the backend answers 400 without the header, so the *device
   wrap* - the source that is supposed to make a reset lossless on any machine
   that has signed in before - could never be read. `recover_umk_for_reset` maps
   every non-`Present` answer to `None`, so the honest "unreachable" became the
   very final-sounding "this device has never held your encryption key".
2. The PKCE verifier was cleared immediately after the exchange, whichever way the
   rest of the call went. But the UI only reveals the recovery field and the
   start-over button *after* the first attempt fails (`offerStartOver`), so
   finishing a reset is inherently a second attempt - and every second attempt
   died at `load_reset_verifier`.
3. Keeping the verifier would not have been enough. The emailed code is one-time
   at Supabase and the first attempt had already exchanged it successfully, so the
   retry had nothing left to redeem.

**Fix.** The exchanged session is held in `SyncClient::pending_reset` and reused
by later attempts instead of re-exchanging a spent code; it is dropped once the
reset completes, and by `sync_cancel_password_reset` when the panel closes, since
it is a live credential. The device id from `sync_state` is set on the client
before the wrap lookup. The verifier message now separates "already used" from
"requested from a different install", which are different problems with different
answers.

**Why it is written down.** Two lessons, and the second is the expensive one.
Sending a request without the header a route requires does not fail loudly; it
fails as an ordinary error that a `_ => None` arm turns into a confident, wrong
statement to the user. And a flow whose escape hatch only appears *after* a
failure is a multi-attempt flow whether or not it was designed as one - so
anything single-use it consumes on the first pass has to be preserved for the
second. This one made accounts unrecoverable, which is the worst outcome the
sync feature has.

---

## #16 - Every launch announced that your spaces were "ready", once per space

**Symptom.** Opening the app produced a row per space in the notification centre
- `"<space>" is ready`, `You can read it now.` - every single time, on an account
that had had those spaces for days. Three spaces meant three rows, three unread
badges, and a sound, at every launch.

**Root cause.** The space keyring is memory-only by design: it never touches
disk, so it is unwrapped from the server's key rows on every start.
`reconcile_spaces` treated "the in-memory map did not have this key and now does"
as "the user has just gained access", which is true exactly once per install and
false on every launch after it. Keying the row on `space-key:<id>` did not help;
`upsert` collapses repeats within one feed, but the announcement is genuinely
re-raised on a feed the user has since cleared.

**Fix.** `SyncState::spaces_announced` records the spaces the user has already
been told about, and `mark_space_announced` gates the row. Ids only, so nothing
about the key material moves to disk. The `space:key-received` event still fires
every time - the UI does need to know the feed is decryptable now.

**Why it is written down.** A durable claim cannot be answered from ephemeral
state. "Is this new?" asked of a map that is empty at every startup always
answers yes, and the answer looks correct in a dev session where you sign in once
and watch it happen for real. The general form: when a notification says
*something changed*, the thing it compares against has to outlive the process, or
the notification is really reporting that the process started.


---

## #17 - The app drew a sign-in form over a session it was busy restoring

**Symptom.** Users were signed out of cloud sync on app or machine restart,
repeatedly, for weeks, across six releases that each hardened some part of the
credential path.

**What the evidence said.** Nothing was ever rejected. Across the identity
provider and our own backend the records were clean:

- Every session's newest refresh token was unrevoked. No token family had ever
  been killed by reuse detection.
- No 4xx from GoTrue: every `/token` call returned 200.
- No 4xx from our own backend on `POST /auth/bootstrap` or
  `GET /auth/umk/device` across the retained logs. Successful restores were
  plainly visible in them - `bootstrap 200`, `umk/device 200`, socket accepted.
- Sessions were being *abandoned*, not revoked: a handful of rotations each, then
  silence, while the user started a new one.

Six rounds of fixes had gone at refresh-token durability. No refresh token had
ever failed.

**Root cause.** `sync_restore_session` awaited the whole restore, and the UI had
no way to know one was running.

`App.tsx` initialised `restoringSession` to `false` and only set it from the
command's reply. `AccountScreen` renders the "Reconnecting to your account" card
when `restoringSession` is true and the full "Welcome back" sign-in form when it
is false - so that card could only ever appear *after* an attempt had already
failed transiently. For the entire duration of the attempt the app showed a
password field.

That duration is not short. Between the refresh grant, the restore timeout, and
the transport retry ladder applied to both the bootstrap and the device-wrap
call, a restore can run to several minutes end to end, and reliably tens of
seconds whenever the backend had spun down while idle - exactly its state when
someone boots their machine in the morning.

So: the user restarts, opens the Account screen, is told to sign in, and does.
Google sign-in is two clicks. A second session is minted, the first is abandoned
with a valid refresh token that is never presented again - which is why the
server side of this bug is completely silent, and why every fix aimed at the
token missed.

**Fix.**

- `sync_restore_session` no longer awaits the restore. It answers whether a
  session is *coming back* - from `AppState.sync_client`, `SyncConfig`, and
  `SyncClient::has_stored_session`, none of which touch the network - and hands
  the attempt to `SyncClient::spawn_session_restore`. The outcome arrives on
  `sync:session-restored` / `sync:restore-gave-up`, which the UI already listened
  for, so the frontend needed no change: `restoring` is now true from the first
  instant and the reconnecting card is what users see.
- Six related credential-path defects, each of which could end a session on its
  own, were fixed in the same sweep. All shared one shape: an ambiguous or
  transient failure was treated as a terminal verdict about the credential. For
  example, `try_restore_session` aborted when a rotated refresh token failed to
  reach the keychain - destroying the account's only live credential - and now
  records the fault and carries on; a bare 401/403 on a restore call (the backend
  answers 401 when it cannot reach the JWKS endpoint, and `HTTPBearer` answers 403
  before a route is entered) was `Terminal` and is now `Unavailable`, retried under
  the existing cap; and Windows Credential Manager's zero-length `Ok("")` could be
  spent as a refresh token, so `read_secret` now reports empty as absent.
- Backend: `PyJWKClientConnectionError` now answers `503` with `Retry-After`
  instead of 401, and `jwt.decode` takes 30 s of leeway. See the token
  verification section of
  `orange-copy-paste-clipboard-backend/docs/architecture.md`.
- `try_restore_session` yields to a manual sign-in that landed while it was away,
  instead of tearing two sessions into one.

**Invariant to keep**: **a slow answer is not a negative answer, and the UI has to
be able to tell.** Any command the interface uses to decide "is this person signed
in" must be able to say "working on it" as its *first* answer, not only as a
report on something that already failed. The moment such a command can only speak
once it is finished, every second it spends is a second the app spends claiming
the user is signed out.

The corollary is a debugging one, and it cost weeks here: when a client reports a
sign-out and the identity provider and the resource server both show a clean
record, stop looking at credentials. Nothing rejected anything. Look at what the
app does while it is waiting.

## #18 - Relaunching the app could destroy the session the old copy was renewing

**Symptom.** The same complaint as #17 - signed out after a restart - from users
whose crash log showed a restore that had been working seconds earlier. Rarer
than #17 and, unlike it, entirely real: the credential genuinely was gone.

**Cause.** `kill_previous_instance` runs before the Tauri builder exists, so any
launch that is not a `--trigger` relaunch force-kills the running copy and takes
over. Force is the operative word: `taskkill /F` is a `TerminateProcess`, which
gives the victim no chance to finish anything.

Meanwhile the victim may be spending a refresh token. GoTrue revokes one the
instant it is presented, so between the request and the keychain write the
account's only live credential exists nowhere but that process's memory. Kill it
there and the keychain keeps the spent token; every later launch presents it,
Supabase reuse detection revokes the family, and the user needs a password. The
window is small - one HTTPS round trip plus a keychain write - but it is open
during startup, which is exactly when a second launch is most likely, and the
startup restore is itself a rotation.

Three other exits had the same hole with nobody to blame but us. `RunEvent::Exit`
flushed the stores but waited for nothing, so a tray quit landing mid-rotation
lost the token. `health_restart_app` and `updater_install` bypass the event loop
altogether. And `updater_install` had a second, separate defect: on Windows the
plugin hands off to the installer and ends the process from *inside*
`install()`, so the `flush_dirty_stores` written on the line below it had never
once run on the platform that matters - every update quietly dropped the last
few seconds of captures.

**Fix.** `sync::client::RotationGuard` marks the window, entered at both places a
token is spent - `refresh_access_token`, and the restore path in `sync/mod.rs`,
which bypasses `refresh_lock` and so is invisible to anything in `client.rs`. It
increments a process-wide count and writes a marker file naming this pid.

- The count is what the exit paths poll. `RunEvent::ExitRequested` prevents the
  exit once, drains on a worker thread and re-issues it; `health_restart_app` and
  `updater_install` drain inline, because a restart carries its own exit code and
  the runtime ignores an objection to it. The updater's flush moved above
  `install()` along with the drain, which fixes the capture loss too.
- The file is what a *relaunch* polls, because the victim never learns it is about
  to die. `wait_out_rotation` holds the kill while the marker names a process it
  is about to terminate. A marker abandoned by a crash names a pid that is not a
  victim, so it costs one file read rather than the full wait.
- `EXIT_DRAIN_MS` is 3 s, sized from the keychain write's own retry ladder so a
  rotation that is going to succeed is not cut off one step from the end. A
  timeout is recorded and never enforced.

**Not fixed, deliberately.** The window opens the moment GoTrue commits, which is
inside an await no exit hook can reach. A process that dies while the response is
still on the wire never had the replacement token. Closing that needs a
write-ahead marker, and a marker changes what the next launch is allowed to
conclude from a rejected token - which is the classification logic #17 just
settled.

**Invariant to keep**: **a process that can be killed must never be the only
place a credential exists.** Where that cannot be arranged, whoever ends the
process - including a future copy of the app itself - is the one that has to wait.

## #19 - Cloud sync ran without its background loops for the whole session

**Symptom.** In Passive mode, nothing arrived until the user pressed Sync now.
Reminders never fired. Restarting the app did not help; toggling sync off and on
did, which is what made it look like a settings problem.

**Cause.** Two construction sites for one object. `setup_runtime` built a
`SyncClient` and put the `Arc` straight into `AppState`; `get_or_create_client` in
`sync/commands.rs` built one *and* started `spawn_passive_pull_loop` and
`spawn_reminder_loop`, which are called from nowhere else.

So whenever sync was already enabled at launch - the normal case for anyone using
it - the boot path won the race to install a client, and no command could ever
repair it: `get_or_create_client` returns early when one is already there. The
loops were unreachable for the life of the process. Toggling sync off and on
cleared the slot and let the command path build the complete one.

**Fix.** The boot path calls the same helper, split as
`get_or_create_client_with(state, app, config)` so startup can pass the config it
has already read. The `enabled` gate stays at the call site, because the helper
deliberately does not consult it - a sign-in has to be able to build a client
before sync was ever turned on.

Making the loops actually run exposed two things that had been rare enough to
ignore, and both are fixed here rather than left as a periodic hazard:

- `flush_and_pull` had no re-entrancy guard. Five things trigger it, and two at
  once start from the same cursor, walk the same pages, race each other writing
  `last_server_ts`, and re-download the same blobs off a metered quota. It is now
  serialised on `flush_lock`.
- `PendingQueue::drain` cleared the queue file before sending anything, so for
  the length of the flush the ops were on neither the disk nor the server. A lost
  `Push` is recovered - the server deduplicates by `client_id` - but a lost
  `Delete` is not: the tombstone is the only record of the deletion, so losing it
  leaves the row on the server and the next pull hands the entry back. Ops now
  move through `sync_pending.inflight.json`, which `load` folds back in.

**Invariant to keep**: **one constructor per thing that has to be started, not
just built.** A second construction site does not merely duplicate code; it
creates a state the first site can reach and the rest of the program treats as
complete. The tell is a bug that a restart does not fix but toggling the feature
does.

## #20 - The spaces list returned 500 whenever Redis had been left alone

**Symptom.** `GET /api/v1/spaces` failing with
`redis.exceptions.ConnectionError`, so the Spaces screen loaded with nothing in
it. Intermittent in a way that pointed at nothing: it cleared on a retry, and it
came back after any quiet spell.

**Cause.** `redis.asyncio.from_url` constructs the `ConnectionPool` itself, so it
inherits none of the defaults `Redis.__init__` would have applied - no retries,
no health check, no timeouts. A connection the peer had closed while the service
was idle therefore raised on its first use instead of being reconnected, and
`ConnectionPool.ensure_connection` raises from outside the retry wrapper anyway.

What turned that into a 500 is where the read sat. Every field of a spaces
response comes from Postgres except one: `online`, a presence hint. Postgres had
already answered in full, and the request was then failed by the one value on it
that nothing authorizes anything against.

Three more failures were in the same file, all of them the same shape:

- Presence was read per member - one `SMEMBERS` plus one `EXISTS` per device,
  for every member of every space in the list. Configuring a read timeout, which
  is part of the fix, would have multiplied that timeout by the size of the
  account.
- The pub/sub listener had no supervisor, so a single `RedisError` ended
  realtime delivery for the life of the process. It also cannot rely on
  `health_check_interval`: `check_health` runs from `parse_response`, which a
  listener blocked in a read never reaches. Keepalive is what notices a dead peer
  there, and a `socket_timeout` would tear the subscription down on every quiet
  interval - so that one client omits it deliberately.
- Fan-out publishes raised, and every one of them runs *after* its write has
  committed. That answers 500 for work that succeeded.

**Fix.** One `client_kwargs(blocking_reads=)` builds both clients, so the
difference between the request pool and the listener is stated in one place with
the reason attached. `presence_for_users` batches a whole space into two
pipelines and degrades to "everyone offline". The listener is supervised with
backoff to a ceiling; publishes are best-effort behind a dropped-event gauge on
the admin metrics route.

`user_is_online` was left raising on purpose. Its two callers decide things -
publishing user-offline on socket teardown, and the sweeper evicting a device -
and reporting offline there announces that a user with live devices went away,
with nothing to correct it, because the online announcement only fires on
connect.

**Invariant to keep**: **a value that is only displayed must never be able to
fail a response the rest of which is already correct.** The test is not how
reliable the store is, it is what the caller does with the answer: a hint
degrades, a decision raises. Keeping both in one helper is what made this
possible, so they are now two, and the boundary is the docstring.

## #21 - Spaces disappeared because the deploy shipped code its database had never seen

**Symptom.** Immediately after a release, a user's spaces were gone. The screen
loaded and listed nothing; the account, the memberships and the owned spaces were
all still in Postgres, untouched.

**Cause.** Revisions `0017_space_key_handover` and `0018_space_join_requests`
were merged but had never been applied. Pushing the backend to `main` is what
triggers a deploy, so the push published code that selected columns and a table
the live database did not have, and `GET /api/v1/spaces` 500'd on
`relation ... does not exist`.

Nothing caught it and nothing was going to. The deploy pipeline runs no migration
step against the live database (see
`orange-copy-paste-clipboard-backend/docs/DEPLOY.md`), so a green deploy says
nothing about the schema either way. `pytest` cannot catch it either: the harness
builds its schema with `Base.metadata.create_all`, so a table can exist for every
test and be absent from every real database.

Then the recovery was delayed by the tool meant to perform it. The **Migrate
database** workflow was dispatched with its default `action=current`, which is
read-only. It went green, and because that action wrote only to the job log and
never to the run summary, the run page was blank - which reads exactly like a
migration that had nothing to do. The schema stayed at `0016` through a run that
looked like the fix.

**Fix.** `0017` and `0018` applied, and the workflow made incapable of being
silent: every run writes where the database stands whatever action it was given;
a read-only run that finds pending revisions warns and prints the dispatch that
would apply them; `run-name` states whether the run applies changes; an `upgrade`
re-reads the revision afterwards and fails if the database did not move; and an
unreachable database now fails the step instead of being reported as an empty
one. `orange-copy-paste-clipboard-backend/docs/DEPLOY.md` documents the workflow
and no longer implies a deploy migrates.

**Not fixed, deliberately.** `action` still defaults to the read-only `current`.
A default that writes to a production database is a worse failure than a default
that reports, and reporting is now loud enough that skipping the second step is
hard rather than silent.

**Invariant to keep**: **a green run is not evidence; the revision is.** Any step
that can succeed without doing the thing has to say which of the two happened -
a job that reports nothing will be read as a job that found nothing to do, and
that reading is unfalsifiable from the outside. The deployment order follows from
the same point: migrate first, deploy second, and read the revision back.

---

## #22 - One large copy took the app from 15 MB to several GB and crashed the UI

**Symptom.** Copying the contents of a 500 MB text file took the process from its
usual 11-15 MB to 6-8 GB. The window crashed, and the app was slow and unresponsive
after a restart - which made it look like a leak that survived the process.

**Cause.** History capped how *many* entries it held (`MAX_HISTORY`, 100) and
nothing capped how large one could be. That is only a problem because an entry is
not stored once. On the way to the user a single capture is duplicated into: the
dedupe check (`is_duplicate_top` called `top(1)`, which **cloned** the previous
entry on every clipboard change), the store (`push` clones to return the inserted
entry), JSON for `clipboard:new-entry` and then a UTF-16 string in the main
webview, the copy-popup payload and the paste-popup payload in two more webviews,
`crypto::encrypt` plus its base64 and the `push_req.clone()` kept for the queue,
and a full MessagePack buffer on every flush. Roughly a dozen copies of whatever
one entry holds, several of them at twice the size in UTF-16.

Two frontend paths then made it feel worse than it was. `matchesQuery` built
`entryText(entry).toLowerCase()` - a fresh full-length copy - per entry per render,
and again per dimension for the filter option counts, so every keystroke in the
search box allocated the whole history over again. And the entry viewer rendered
the content into a single `<pre>`, which is what actually took the window down.

It looked like a leak because it behaved like one: the entry was persisted, so it
was reloaded on the next launch and every copy of it was made again.

**Fix.** `MAX_TEXT_BYTES` (4 MiB) bounds one text, rich-text or file-list entry,
enforced at the three doors an entry can come through - capture, the sync merge,
and load. Capture measures the OS handle with `GlobalSize` before `arboard`
decodes anything, so on Windows an oversized payload is never allocated at all;
`read_clipboard_capture` returns a three-state `Capture` so a refusal is *handled*
rather than retried, which matters because the watcher re-reads anything it did not
handle every 220 ms. `drop_oversized` prunes a history file written before the cap,
which is what stops the fault surviving a restart. The dedupe compares in place
(`top_matches`), and the search box compiles one case-insensitive `RegExp` per query
instead of lowercasing every entry.

A refused copy always shows the app's own toast, ignoring both
`notification_enabled` and `notif_copy`. That is deliberate: the copy and paste
toasts confirm something that worked and the user already knows about, but this one
reports something that did *not* happen, and the only other sign of it is the
item's absence from a list.

**Also found, same class.** `get_file_preview` called `fs::read(path)` and *then*
checked the length against its limit, so asking for a preview of a 30 GB video read
all 30 GB into memory to throw it away. It measures `metadata().len()` first now.

**Invariant to keep**: **a bounded count of unbounded items is not a bound.** Every
store that fans its contents out - to a webview, to disk, to ciphertext - has to cap
the size of one item, not just how many it keeps. And the size check belongs where
the bytes enter the process, not where they hurt: a limit tested after the
allocation it was meant to prevent has already been paid.

---

## #23 - Removal placeholders sat under the wrong day and accused the reader of moderating themselves

**Symptom.** Two complaints about the same rows. A placeholder for an item taken
out of a space appeared in a date group of its own, keyed to the day of the
removal rather than the day the item sat on, so it read as an unrelated row with
nothing around it to say what it referred to. And the text said "A space owner
took this item out of the space" to the space owner, about an item they had
taken out themselves.

**Cause.** Two facts the feed needs were never written down, so both were
inferred.

*Placement.* `feedTimestamp` had only `deleted_at` to place a placeholder - when
the removal happened, nothing about when the item sat. Yet the item's own
timestamp is still readable whenever a marker is written, either from the local
copy or off the tombstone that announced it.

*Wording.* The copy branched on `by_author`, a *relation* between two ids
computed upstream rather than a fact recorded on the spot, wrong in two ways that
both land on this reader: a payload missing either id was reported as moderation,
and the backend records `author_id` against a row that may not be the remover's
(it clears every row carrying that `client_id`), so an owner removing their own
item is told a space owner moderated them.

**Fix.** Record both facts instead of deriving them. `DeletedMarker` gains
`entry_ts` (the item's own time, read while the copy is still there) and
`removed_by` (the actor as an id); the feed places by `entry_ts` and compares
`removed_by` with this account's own id, so "You" is a fact. `by_author` is then
computed locally against the author of the copy *this device holds*, with the
wire's value kept only as a fallback when there is nothing to compare.

The backend half was fixed in the same pass: `remove_entry_from_space` prefers
the remover's own row when choosing which author to record, and the wire contract
in `orange-copy-paste-clipboard-backend/docs/architecture.md` now says outright
that `author_id` is advisory and a client must not compute "did the author remove
this" from it. The record cannot be made fully correct at its current granularity
(one row per (space, entry), several authors for one `client_id`), which is the
other reason the client stopped depending on it. Older records without the fields
(`#[serde(default)]`) drop the actor claim entirely, reading "This item was taken
out of the space".

**Invariant to keep**: **a relation between two ids is not a fact - record the
id.** `by_author` had to be computed by whoever published the event, from fields
that may not have arrived, and every consumer inherited the mistake with no way
to check it. An id can be compared against a known one at the point of use, and a
comparison that cannot be made is visible as such rather than defaulting to a
wrong answer about a real person.

## #24 - An image copied offline was dropped, and never synced even after reconnect

**Symptom.** With no connection, the notification centre showed "N items were not
sent - Image upload failed: could not reach the server". When the connection came
back, those images still never synced. Text copied in the same window did sync on
reconnect; only images were lost.

**Cause.** An image entry stores its bytes in a blob, so its push uploads the blob
*first* and then sends an entry that points at it. `spawn_push_clipboard_entry`
ran the blob upload before building the push, and on any error at all recorded a
skip and returned. `upload_image_blob` flattened its error to a plain string, so
"the host could not be reached" (a transport failure, no HTTP status, transient by
definition) was indistinguishable from "the server refused this body" (a 413 or a
402, permanent). Both were reported to the user as "not sent" and dropped.

Text never hit this. A text push has no blob, so it reaches `push_entry_task`,
which on a transient failure queues a ready-to-send `PendingOp::Push` that the
next flush retries. An image could not use that queue: the blob was never
uploaded, so there was no `blob_key` to serialize, so there was nothing to park.

**Fix.** `upload_image_blob` now returns whether the failure was retryable
(`request-upload`'s `ApiError::is_transient`; the transfer and confirm stages run
only once connected, so a drop there is retryable too). A retryable failure no
longer records a skip - it queues a new `PendingOp::PushLocal { client_id }`, a
queue op that carries only the id. On the next flush that op re-reads the local
entry and re-runs the whole push, blob and all; if the server is still unreachable
its own image branch queues a fresh `PushLocal`, so a connection that never comes
back cannot drop the entry. A genuine refusal (over 5 MB, or the account full) is
still a recorded skip, because retrying it forever would tell nobody. The entry
carries the amber "waiting to upload" badge the whole time, the same as a queued
text push.

**Invariant to keep**: **a failure that is a wait must not be reported as a
refusal.** The two are the same `Err` at the call site and only the status tells
them apart; collapsing them to a string threw away the one bit that decided
whether the user's data was recoverable.

## #25 - Realtime sync sat idle in the tray until the window was reopened

**Symptom.** On Realtime, an item copied on another device did not appear until
the user opened the app from the tray; likewise a local push made while briefly
offline did not go up on its own. Bringing the window to the front fixed it every
time, which made it look like the app only synced when watched.

**Cause.** The only thing that flushed the pending queue and pulled the delta in
the background was `sync_catch_up`, wired to the window **refocus** event. While
minimized to the tray the window never refocuses, so that path never ran. The two
mechanisms that should have covered it did not: the WebSocket reconnect handler
reconciled spaces on connect but never flushed or pulled, and the 5-minute
background loop fired only in Passive mode (`due = mode == Passive`). So a Realtime
device that lost its socket - laptop sleep, a NAT recycle, a network blip - came
back on the socket but never caught up on anything sent during the gap, and a push
that queued on a transient failure sat until the user happened to focus the window.

**Fix.** Two triggers, matching the two gaps. The reconnect handler now runs a
`flush_and_pull` after its spaces reconcile whenever the mode is not Manual - the
socket only carries what arrives after it comes up, so this is what recovers the
gap. And the background loop runs in every non-manual mode, not just Passive: a
delta pull from `last_server_ts` is one request that returns nothing when the
socket already kept up, but it flushes a queue no socket event happened to touch.
Manual mode is untouched - it still goes up only on Sync now.

**Invariant to keep**: **a mode that syncs on its own must not depend on the window
being visible.** Refocus is a fine *extra* nudge, but making it the only
background trigger meant the product quietly stopped working exactly when it was
doing its job - running in the tray.

## #26 - The delete confirmation flooded the IPC bridge and Windows killed the message queue

**Symptom.** Opening the delete confirmation from either quick popup (copy or
paste) spewed an unbounded flood of `PostMessage failed ; is the messages queue
full? Error code 0x80070718 - Not enough quota is available to process this
command.` (`ERROR_NOT_ENOUGH_QUOTA`). The main window's bulk-delete dialog never
did it.

**Cause.** `ConfirmDeleteDialog` resolves an entry's origin in an effect that
depended on the `entryKeys` **array**, and `describeDelete` sets state with the
result. The popups render the dialog with a fresh array literal every time -
`entryKeys={[`clipboard:${entryId}`]}` - so each render produced a new array
*identity*. New identity -> effect re-runs -> four `invoke`s + `setOrigin` ->
re-render -> new array -> effect re-runs, with nothing to break the cycle. Each
turn of the loop posts several messages across the Tauri IPC bridge, and Windows
caps a thread's message queue (default 10000 posted messages, `USERPostMessageLimit`),
so the queue saturates in a fraction of a second and every subsequent post fails.
App.tsx escaped it only by luck: it holds the keys in state, so the array identity
happened to be stable.

**Fix.** Key the effect on a primitive instead of the array: `keyStr =
entryKeys.join("\n")`, deps `[open, keyStr]`, and split the string back into keys
inside the effect. Two renders with the same keys now produce the same dependency,
so the lookup runs once per open no matter how the caller builds the array. Fixed
centrally in the dialog so no call site has to remember to memoize.

**Invariant to keep**: **never depend on an array or object passed as a prop in a
`useEffect` that sets state - key on a primitive derived from it.** A parent that
builds the value inline (the common, reasonable thing to do) hands you a new
reference every render; combined with a `setState` in the effect that is an
infinite loop, and on Windows it manifests not as a hang but as a message-queue
quota failure several layers away from the cause.

## #27 - A received item, once deleted, could come back showing as yours

**Symptom.** After deleting an item another member had shared ("remove from my
devices"), a file or image item would reappear in the Spaces feed some time
later, attributed to **You** instead of its real author. It was intermittent and
only ever hit file/image entries.

**Cause.** Two defects that only bite together. Deleting a received item is meant
to keep the record of who wrote it: `spawn_delete_entry` calls
`forget_received_copy`, which drops the local copy and the server id but keeps the
`remote_entries` flag and the `entry_owners` name, precisely so the entry can
never later be taken for an unsynced local one. But the tombstone-push success
path (and its queued-flush twin) then called `id_map.remove_entry`, which wipes
exactly those two records. The `remove_entry` predated the "remove from my
devices" feature - it was written for an owned delete, where dropping the server
id is correct - and the feature added `forget_received_copy` above it without
removing the wipe below it, so the two directly contradicted each other. Once
`remote_entries` no longer held the key, `is_remote_entry` returned false and the
feed rendered the item as ours.

That alone only left a placeholder, because a delete removes the local copy first.
The second defect kept the copy on screen: file and image bodies merge on a
separate async blob task, and that task re-adds the history row (and re-affirms
authorship) when the download finishes. A pull or socket re-delivery of the
author's live row during the delete starts such a task; it lands its
`upsert_synced` **after** the delete removed the copy but around the same time as
the deferred `remove_entry` - so the row is present while its remote flag is gone.
Text entries have no blob task, so they never showed the live "You" card.

**Fix.** Two parts. The delete paths run `remove_entry` only for an owned item;
for a received one the copy is already forgotten and the authorship is left
standing. And both blob merge tasks check for a `content_gone` deletion marker
under the id_map lock right before `upsert_synced`, and skip the re-add if the
item was deleted while the blob was in flight - so a removed item stays removed
instead of racing back in.

**Invariant to keep**: **a received item's authorship (`remote_entries` +
`entry_owners`) must outlive its local copy.** It is the only thing standing
between "someone else shared this" and "this is mine to publish", and every path
that drops the copy has to use `forget_received_copy`, never `remove_entry`,
unless the item is genuinely being deleted for everyone. And an async merge that
re-adds a row has to re-check that the row was not deleted while it was working -
the delete that ran meanwhile left a marker for exactly that reason.

## #28 - The "somebody asked to join" notification offered a dead "Join" button that never cleared

**Symptom.** When someone asked to join a space this user could approve for, the
notification read "Somebody asked to join" with **Join** and **Decline** buttons.
Pressing Join did nothing, and the row stayed - buttons and all - even after the
person had been let in from the Spaces screen. The label was also wrong: the user
is not joining, they are letting someone else in.

**Cause.** A join-request knock and an invite received both use the
`space_invite` notification kind, so the popout rendered both with the invite's
buttons and its `answerInvite` handler. But `answerInvite` acts on
`n.data.invite_id`, and a knock (`note_join_requested`) carried only `space_id` -
no invite id - so the very first line, `if (!inviteId) return;`, made Join a
no-op. Nothing ever resolved the knock either: `notifications_refresh` reconciles
invites received, not join requests, so the row had no path back to "answered"
and sat in the feed indefinitely.

**Fix.** Three parts. `note_join_requested` now stores `request_id` (and
`space_name`) on the notification, which is what the buttons act on. The popout
tells the two shapes apart by that field: a knock (`request_id`) shows **Accept**
/ **Decline** wired to `space_approve_join` / `space_decline_join`, while an
invite (`invite_id`) keeps **Join** / **Decline**. Approving from the knock
passes no requester key - the approval still lands and the space key reaches the
new member on the reconcile the command already spawns. And both approve/decline
commands now resolve the knock (`space-join:{request_id}`) to "Let in" /
"Declined" and commit, so answering from **either** surface - the notification
buttons or the Invites list - retires the row and shows the outcome.

**Known gap**: a knock answered by a *different* approver still lingers on this
device until dismissed - there is no per-request "resolved elsewhere" event the
way invites have one. Resolving at the shared command covers the common case
(the same user approves); the cross-approver case is left for when the server
publishes a resolution event, tracked in backend issue
`RoverTools-Smart-Clipboard-App-Backend#22`.

---

## #29 - Relaunching the running app replaced it with a fresh copy instead of surfacing it

**Symptom.** Launching the app while it was already running in the background -
from the taskbar, a second click of the icon - flashed the startup toast and left
the app in the background instead of bringing its window forward. Task Manager
showed one process throughout, which is what made it look like a focus bug rather
than a relaunch bug: the running copy was never surfaced. A first fix (0.3.3),
which routed the single-instance callback through the tray's `show_main_window`,
did nothing, and looked from the outside like the focus call simply failing.

**Cause.** Two startup mechanisms that cancel each other, and the order decides
which wins. `run()` calls `kill_previous_instance` before the Tauri builder
exists, so any non-`--trigger` launch force-kills the running copy and takes over
(the same call behind #18). The `tauri-plugin-single-instance` plugin, registered
first inside the builder, is meant to do the opposite: detect the running copy,
forward this launch's argv to it over `WM_COPYDATA`, and exit - leaving the
original alive to raise its window in the callback.

The kill runs first, so the plugin never gets the chance. By the time the new
instance's plugin setup looks for a primary, `kill_previous_instance` has already
terminated it, so the new instance finds nothing, becomes primary itself, and
runs the full `.setup()` closure - which is the only place the splash is shown.
The focus callback added in 0.3.3 was therefore dead code on a normal launch:
the instance that would have received the `WM_COPYDATA` and run
`show_main_window` was killed a moment earlier. A PID trace made it plain -
launch a second copy and the *old* pid dies while the *new* one survives, the
inverse of a single-instance handoff.

The trap in the evidence: "one process" was true at every glance but it was a
*different* process after each relaunch, so watching the count never revealed the
replacement. Only polling the pids across the launch showed the old dying and a
new one taking its place.

**Fix.** A plain relaunch no longer kills - it defers to the single-instance
plugin, which forwards to the running instance and raises it. Killing is kept
only for the two launches that genuinely must replace a running copy: a dev
rebuild (`cfg!(debug_assertions)`), and the app restarting *itself* for an update
or health recovery. The self-restart announces itself with a short-lived temp-dir
marker (`mark_self_restart` / `consume_self_restart_marker`, mirroring the
rotation marker of #18 and freshness-capped so a crashed mark cannot force a
later user relaunch to replace instead of focus); `updater_install` marks before
the installer hand-off / `app.restart`, and `health_restart_app` before its
`app.restart`. On Windows the updater's installer closes the old process before
relaunching, so the replacement finds nothing to kill and boots cleanly; the
marker exists for the Linux/`app.restart` path, where the old process is still
dying as the new one starts and must be taken over rather than deferred to.

**Invariant to keep**: **kill-and-replace and single-instance handoff are
mutually exclusive, and a plain relaunch must forward, never replace.** Only a
self-initiated restart may take over a running copy, and it has to say so - a
launch that unconditionally kills the previous instance makes every focus/forward
mechanism downstream of it unreachable, no matter how correct that mechanism is
in isolation. Shipped in 0.3.4.
