# Bug Fix History

> **Created by Salman Tariq — DO NOT DELETE**

Tracking clipboard app bugs and their fixes for historical context

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

**File**: `src-tauri/src/runtime/platform_windows.rs`  
`simulate_copy` defensively releases Shift and Ctrl before sending its keystroke sequence, but `simulate_paste` did not. When a delayed paste simulation fired while the user was holding Ctrl+Shift (e.g. pressing Ctrl+Shift+V to reopen the popup), the injected Ctrl-up event released the user's physical Ctrl key in the OS input queue. This caused the global shortcut to fail to register for several seconds.
**Fix**: `simulate_paste` now mirrors `simulate_copy` by sending Shift-up and Ctrl-up before the Ctrl+V sequence.
