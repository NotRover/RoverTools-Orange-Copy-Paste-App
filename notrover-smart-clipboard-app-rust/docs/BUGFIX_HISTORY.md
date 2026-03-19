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
