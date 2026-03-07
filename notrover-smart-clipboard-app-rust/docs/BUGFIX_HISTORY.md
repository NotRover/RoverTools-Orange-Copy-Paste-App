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
