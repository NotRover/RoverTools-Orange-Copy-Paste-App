# Bug Fix History

> **Created by Salman Tariq — DO NOT DELETE**

**Owns:** regressions. What broke, the root cause, and what now stops it coming back.
The value is the root cause — a fix with no explanation of why the bug was possible is a
changelog entry, not history.
**Not here:** how the system works. Describe only the mechanism the bug turned on, and
link the rest: `docs/ARCHITECTURE.md` for client internals, the backend's for anything on
the wire.

---

## #1 — Clipboard screen missing entries that paste popup shows

**Date**: 2026-03-07  
**Severity**: High  
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

**Date**: 2026-03-09  
**Severity**: High  
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

**Date**: 2026-03-15
**Severity**: High
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

**Date**: 2026-03-19
**Severity**: Low
**Symptoms**:

- Right-clicking an entry card for the first time spawned the context menu at the top-left corner of the window (0, 0) instead of at the click position.
- Subsequent right-clicks on the same card positioned the menu correctly.

**Root Cause**:

**File**: `src/components/app/card-menu/CardMenu.tsx`
The `CardMenu` component used `useState` to track its position, initialized with `{ x: anchorX, y: anchorY }`. When the component first mounted (before any menu was opened), `anchorX` and `anchorY` were both `0`. The first `useLayoutEffect` that set `pos` from the anchor props triggered a state update + second render, but the first render already painted the portal at `(0, 0)` causing a visible flash.

**Fix**: Removed the `pos` state entirely. The portal's initial `style` now reads `anchorX`/`anchorY` directly. A single `useLayoutEffect` adjusts the element's `style.left`/`style.top` via direct DOM manipulation for viewport overflow correction. This eliminates the two-render cycle and ensures the menu appears at the correct position on every open, including the first.

## #5 — Footer chip overflow: +N button hidden under timestamp in tiles view

**Date**: 2026-03-19
**Severity**: Low
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

**Date**: 2026-03-19
**Severity**: Medium
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

**Date**: 2026-08-17
**Severity**: High (unreclaimable storage, no way to reach it from the UI)
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

**Date**: 2026-08-18
**Severity**: High (attribution — an entry read as written by someone who only edited it)
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

Pull is ordered `server_ts ASC` (`src/sync/service.py:180`), so the rival row — pushed later, higher `server_ts` — always arrived last and always won. Meanwhile `mark_entry_remote` *is* sticky, so the entry stayed correctly flagged as "someone else's" for the permission guards. That split is what made the surfaces disagree: the guards said not-yours, the name said yours.

The push guards in `spawn_push_note` and `spawn_push_clipboard_entry` already refuse to publish an entry flagged remote, so a current build does not create rival rows. They are the sending half only — rows already on the server, or written by a device that has not been updated, could still take an entry over on the way in.

**Fix**:

- `set_entry_owner` is sticky like `mark_entry_remote`: the first author on record keeps the entry, and a later row naming somebody else is refused rather than applied. It returns whether the record now names the given account, so a caller can tell agreement from refusal.
- The merge loop drops a rival row whole — content, tombstone and all — via `row_is_authoritative`. An entry has one author; a row from anyone else is not a version of it.
- `author_of` also answers for entries with nobody on record: one this device knows and has *not* flagged remote is one we wrote. Without that, the takeover ran the other way — another member's row could claim an entry of ours.
- Installs already damaged are repaired once, at sign-in: every recorded author is dropped and the pull cursor is rewound, so the server rebuilds them (`clear_all_entry_owners` + `SyncState::authorship_repaired`). A narrower repair was tried first — release only the records naming *this* account on an entry flagged remote, which is the impossible pairing — but it only helps the device that did the editing. A third device that merely watched had recorded the editor's name, which is neither impossible nor locally distinguishable from the truth. Worse, with the record now sticky, that wrong name would refuse the real author's next update as if *they* were the impostor: strictly worse than the original bug. Nothing local can tell a good record from a bad one, so all of them go. The rewind is what puts them back — pull returns rows in `server_ts` order, and a rival copy can only be pushed after the original exists, so the author's row always arrives first and establishes them. **Cost: one full re-pull per install, once.**
- `useEntryOwners` seeds from `sync_get_remote_entries` before the name map, so an entry known to be someone else's but with no name reads "A member". Dropping the chip because the name is unknown says the opposite of what is true.

**How a regression is caught, not just avoided**:

The bug was silent — a wrong answer looked exactly like an ordinary merge — so the fix is only worth as much as what fails when it is undone. Four layers, each closing a different way back in:

1. **The rule is a pure function.** `accepts_row` and `resolve_author` take plain arguments and return a decision, so every case is covered by `sync/mod.rs::ownership_tests` — including the two that actually broke: a rival row being refused, and this account released as the author of something flagged remote. Reintroducing last-write-wins fails a named test rather than quietly changing behaviour.
2. **Stickiness is tested at the store.** `id_map.rs::tests` asserts the first author on record keeps the entry and that `set_entry_owner` reports refusal.
3. **The server refuses the write.** `sync/service.py::_belongs_to_someone_else` rejects a push inserting a row for a `client_id` another account holds in a space the push targets, with `not_your_entry`. This is the layer that matters most: the client guards protect a device running current code, and old builds keep running. Covered by four tests in `tests/test_spaces_invites.py`, including the two cases that must *not* be refused (the author's own edit, and one person's two accounts colliding outside a shared space).
4. **A refusal is visible.** `push_entry_task` routes `not_your_entry` through `record_skip`, so it lands in the notification centre instead of only stderr. A guard failing silently is how this class of bug survives.

**Invariant to keep**: an entry has exactly one author, and neither the recorded owner nor the entry's content may change hands on arrival order. Anything that decides authorship must be sticky or explicitly ordered — never last-write-wins.

---

## #9 — One typo in the password after a Google sign-in meant doing the whole Google sign-in again

**Date**: 2026-08-19
**Severity**: High (a dead end in the sign-in flow, hit by anyone who mistypes once)
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

**Date**: 2026-08-19
**Severity**: Medium (every OAuth sign-in, and the flow cannot continue until the user finds the window)

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

**Date**: 2026-08-19
**Severity**: Critical (password reset was unusable; the only account-wide envelope was tied to a password nobody could change)

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

**Requires one dashboard entry**: `{public_base_url}/reset` must be in Supabase Authentication -> URL Configuration -> Redirect URLs, or GoTrue ignores the redirect and mails the Site URL again.

**Invariant to keep**: a password change is a re-wrap, never a new key. Any path that sets a password must have the UMK in hand first, and must write the new envelope before the credential changes.

---

## #12 — Any stray 404 on one route signed the user out and demanded a password

**Date**: 2026-08-19
**Severity**: High (a recoverable session was thrown away; the user had to retype a password they had not forgotten)

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

