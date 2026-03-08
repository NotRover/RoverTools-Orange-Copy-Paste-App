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

## #2 — Paste popup window intercepts clicks when visually hiding during slow image pastes

**Date**: 2026-03-09  
**Severity**: High  
**Symptoms**:

- Pasting a copied image sporadically caused a completely different text entry from the bottom of the list to be pasted instead.
- This only happened when clicking on screen right after hitting enter or clicking to paste an image.

**Root Causes** (2 related issues):

### 2a. Image decoding blocks thread while the popup is still visually hiding

**File**: `src-tauri/src/clipboard/commands.rs`  
The `paste_entry` Tauri command called `write_entry_to_clipboard` before calling `hide_popup`. For large images, `write_entry_to_clipboard` takes a long time to decode the base64 string to pixels and send it to the OS clipboard, blocking the Rust thread. The Tauri window stayed physically open for this entire duration.
**Fix**: Moved `hide_popup(&app, "paste-popup");` to the exact beginning of the `paste_entry` function before `write_entry_to_clipboard` is called.

### 2b. React container intercepts pointer events while opacity is 0

**File**: `src/components/paste-popup/pastePopup.css`  
The React frontend instantly sets the main container to `opacity: 0` during the delay, but the OS window is still open. Since there was no `pointer-events: none` on the transparent container, clicking on the screen behind the popup would accidentally hit an invisible entry item in the React DOM, firing a second conflicting `paste_entry` event.
**Fix**: Added `pointer-events: none` to the `.paste-container` class and restored `pointer-events: auto` to the `.paste-container.visible` class.

### 2c. Main thread blocked by synchronous clipboard interaction

**File**: `src-tauri/src/clipboard/commands.rs`  
The `paste_entry` command was executing synchronous calls to write data to the clipboard (`write_entry_to_clipboard`) on the main Tauri thread. When a large image payload was written to the clipboard, the entire event loop paused, preventing further keyboard inputs or interactions. Additionally, because the `suppress_next_capture` atomic boolean was evaluated _after_ the write operation, the OS clipboard event was detected by the background clipboard watcher concurrently and processed before the flag was raised.
**Fix**: Wrapped the clipboard writing and `schedule_paste` call in a `std::thread::spawn()` block. Elevated the `suppress_next_capture` boolean change above the actual `write_entry_to_clipboard` logic so the watcher successfully ignores the clipboard modification event triggered by the OS.
