# Orange Copy Paste — Complete Client Architecture Walkthrough

This is a desktop Smart Clipboard app built with **React + TypeScript** (frontend) running inside a **Tauri** shell with a **Rust** backend. The two communicate exclusively through Tauri's IPC bridge: `invoke()` for synchronous calls and `listen()` for events pushed from Rust to JS.

---

## 1. Technology Stack

| Layer | Tech |
|---|---|
| UI framework | React 18 + TypeScript |
| Bundler | Vite (via `bun run dev`) |
| Desktop shell | Tauri v2 |
| Rust backend | `arboard` (clipboard), `parking_lot` (mutexes), `rmp_serde` (MessagePack), `reqwest` (HTTP), `tauri-plugin-global-shortcut` |
| Rich text editor | Tiptap (ProseMirror-based) |
| Persistence | MessagePack `.bin` files + JSON `settings.json` |
| Sync | Custom REST + WebSocket API over HTTPS |

---

## 2. Application Entry Point and Bootstrapping

### Rust side — `lib.rs`

`run()` is the application entry point. Here is exactly what happens at startup, in order:

1. **Kill previous instance** — `kill_previous_instance()` uses `tasklist`/`taskkill` (Windows, with `CREATE_NO_WINDOW` flag) or `pgrep`/`kill -9` (non-Windows) to find and kill any other running copy of the executable. After killing, it sleeps **400 ms** (Windows) or **300 ms** (non-Windows) to give the OS time to reclaim the global hotkeys. This is essential because global hotkeys are OS-exclusive — a previous process still holding them would cause a panic on re-registration.

2. **Create shared state** — `ClipboardHistory` is wrapped in `Arc<Mutex<>>` (using `parking_lot` for a non-poisoning, faster mutex). A `SuppressFlag` (`Arc<AtomicBool>`) is also created; this prevents the clipboard watcher from re-capturing entries that *the app itself* just wrote to the clipboard.

3. **`AppState` struct** — This is the single shared state object injected into Tauri's state system. It holds:
   - `history: Arc<Mutex<ClipboardHistory>>` — all clipboard entries in memory
   - `suppress_next_capture: Arc<AtomicBool>` — the suppress flag
   - `keep_history, close_to_tray, start_minimized, notification_enabled, notif_copy, notif_paste, autosave, show_splash` — `AtomicBool` flags read from `settings.json` once at startup and then kept in memory so every command avoids a disk read. `notification_enabled` and `notif_copy`/`notif_paste` default to `true` when the key is absent from `settings.json`.
   - `active_clipboard_id: Arc<Mutex<String>>` — tracks which entry is currently in the OS clipboard
   - `notes: Arc<Mutex<NoteStore>>` — all notes in memory
   - `notes_dirty, history_dirty: Arc<AtomicBool>` — dirty flags for deferred disk writes
   - `sync_client: Mutex<Option<Arc<SyncClient>>>` — the optional cloud sync client

4. **`setup_runtime()`** — This is where everything is wired up:
   - Resolves all file paths (`history.bin`, `notes.bin`, `settings.json`, `images/`, `pinned_entries.bin`, `boot_id.txt`) from Tauri's `app_data_dir()`
   - Loads history — see boot-ID comparison logic below
   - Loads notes from `notes.bin`
   - Seeds all `AtomicBool` flags from `settings.json`
   - Sets up the system tray via `runtime::tray::setup_tray()`
   - Starts the **background flush thread** — see below
   - Calls `setup_popup_windows()` — creates the copy-popup, paste-popup, and notification windows off-screen but pre-built
   - Calls `register_global_shortcuts()` — registers `Ctrl+Shift+C` and `Ctrl+Shift+V`
   - Calls `start_clipboard_watcher()` — starts the background polling thread
   - Calls `setup_main_window_focus_handler()` — hides popups on main window focus
   - Calls `window_state::restore()` and `window_state::setup_tracking()` — restores and tracks window size/position
   - Optionally initializes the cloud sync client if `SyncConfig::load()` says it was enabled

5. **Command registration** — All Tauri `#[tauri::command]` functions are registered in `invoke_handler`. There are ~50 commands covering clipboard, notes, runtime, and sync operations.

6. **Window event handler** — On `CloseRequested`, if `close_to_tray` is enabled, `api.prevent_close()` is called and the window is hidden instead. On `Destroyed`, the whole process exits.

### Boot-ID comparison and history loading

The boot-ID file (`boot_id.txt`) stores the system boot epoch in seconds. At startup:

- **`keep_history` off** — always load `pinned_entries.bin` only (saved entries only)
- **`keep_history` on, `history.bin` doesn't exist** — load `pinned_entries.bin` as fallback
- **`keep_history` on, same boot** — `current_boot.abs_diff(previous_boot) < 5` (5-second tolerance) AND `history.bin` exists → `load_all_from_file()`, full restore
- **`keep_history` on, new boot** — different boot epoch AND `history.bin` exists → `load_all_from_file()` then immediately `clear()` (strips all non-saved entries, keeping pinned + "Saved" group)

The boot epoch is computed on Windows via `GetTickCount64()` (uptime from boot subtracted from current Unix time), and on Linux via `/proc/stat` `btime` field.

### Background flush thread

`FLUSH_INTERVAL_MS = 2000`. The thread wakes every 2 seconds and:
- If `keep_history` is on AND `history_dirty` flag is set: calls `save_all_to_file(&history_path)` (also purges unreferenced image files — see §4) AND writes `save_saved_to_file(&pinned_entries_path)` to keep the saved-entries file in sync
- If `notes_dirty` flag is set: calls `save_to_file(&notes_path)`

Both dirty flags are atomically swapped to `false` before the write begins.

---

## 3. Clipboard Watching — `clipboard_watcher.rs`

This is the core capture loop. It runs on a dedicated background thread, polling every **220 ms** (`WATCH_INTERVAL_MS = 220`).

**On Windows**, it uses `GetClipboardSequenceNumber()` — a Windows API that returns an integer incremented by the OS every time the clipboard changes. The watcher stores `last_token`, and if `token == last_token` it skips. This is very efficient (no read on no change).

**The capture pipeline** in `capture_clipboard_change()`:

1. Check `suppress.swap(false, Ordering::Relaxed)` — if `true`, the app itself just wrote to clipboard (from `copy_entry`/`paste_entry`/`Ctrl+Shift+C`). Skip this change and return `true` (mark as handled so token advances).

2. Call `read_clipboard_entry()` which tries clipboard formats in priority order:
   - **CF_HDROP (files)** — checked first. All file drops (including image files dragged from Explorer) become `File` entries with newline-delimited paths. This is intentional: re-copying writes CF_HDROP back so files paste correctly in Explorer.
   - **CF_HTML (rich HTML)** — checked next for HTML with embedded images/tables (Word, Teams, etc.). Stores the HTML fragment + plain text fallback separated by `\n---PLAINTEXT---\n`.
   - **Plain text** — via `arboard`
   - **Images** — screenshots, browser copies. Read as RGBA pixels, encoded to PNG data-URL. Retried up to **5 times** (`IMAGE_READ_RETRY_COUNT`) with **90 ms delay** (`IMAGE_READ_RETRY_DELAY_MS`) because some apps (e.g. Discord) write the clipboard asynchronously.
   - Clipboard open itself is retried **6 times** (`CLIPBOARD_OPEN_RETRIES`) with **50 ms delay** (`CLIPBOARD_OPEN_RETRY_DELAY_MS`) if locked.

3. **Deduplication** — `content_matches()` checks if the new entry matches the current top of history. For images, this uses a 64-bit hash of the original data-URL (computed with `DefaultHasher` at creation time and stored as `content_hash`), so it works even after the image has been externalized to a file path. Text uses direct string comparison.

4. If not duplicate, `hist.push(entry)` is called, then:
   - If `autosave` is on, the "Saved" group is added to the entry
   - `set_active_clipboard_id()` updates the active ID and emits `clipboard:active-id` to the frontend
   - `app.emit("clipboard:new-entry", new_entry)` notifies the frontend
   - The sync client's `on_new_clipboard_entry()` hook is called

---

## 4. History Model — `clipboard/history.rs`

`ClipboardHistory` is a `Vec<ClipboardEntry>` (most-recent first) capped at **`MAX_HISTORY = 100`** non-saved entries.

**`ClipboardEntry`** struct:
- `id: String` — monotonic integer ID from `NEXT_ID: AtomicU64`
- `kind: EntryKind` — `Text | Image | File | Html` (serialized as `"type"` for JS compatibility via `#[serde(rename = "type")]`)
- `content: String` — for Text: the text; for Image: file path (or data-URL before externalization); for File: newline-delimited paths; for Html: `{html}\n---PLAINTEXT---\n{plaintext}`
- `timestamp: u64` — Unix epoch ms
- `pinned: bool`
- `groups: Vec<String>` — user-defined tags
- `label: Option<String>` — human-readable label for images (e.g., "Image Jan 5, 2:30 PM"), formatted on Windows using `SYSTEMTIME`/`FILETIME` Windows APIs for local timezone. On non-Windows, falls back to the raw timestamp.
- `content_hash: Option<u64>` — fast dedup hash for images using `DefaultHasher`; `#[serde(skip)]` so not persisted
- `server_id, sync_status` — transient sync fields, also `#[serde(skip)]`

**Image externalization** — When a new image is pushed via `push()`, if the content is a data-URL (`starts_with("data:")`), `save_image_to_disk()` decodes the base64, writes the raw bytes to `{id}_{safe_label}.{ext}` in the images directory, and replaces `content` with the absolute file path. Supported extensions: `jpg`, `webp`, `gif`, `bmp`, `png` (default). The `content_hash` computed from the original data-URL is preserved so deduplication still works after externalization.

**The cap logic** — After `push()`, if `entries.len() > MAX_HISTORY`, entries are retained using:
```
retain(|e| is_saved(e) || normal_count < MAX_HISTORY)
```
Saved entries (`pinned || groups.contains("Saved")`) are never evicted. Only non-saved entries are counted against the 100-entry cap.

**Image file GC** — `save_all_to_file()` (called by the flush thread) also scans the images directory and deletes any image files that are no longer referenced by any entry in history. This prevents orphaned image files from accumulating.

**Persistence** — Two files on disk:
- `history.bin` — full history (only written when `keep_history` is on)
- `pinned_entries.bin` — only `is_saved()` entries (written on every flush cycle, loaded at every startup regardless of `keep_history`)

Both use **MessagePack** via `rmp_serde`, which is compact and fast.

**`load_saved_from_file()`** — Merges saved entries into the current history (replacing any with matching IDs), then calls `externalize_images()` to migrate any leftover inline data-URLs.

---

## 5. Global Shortcuts — `runtime/hotkeys.rs`

Two shortcuts are registered via `tauri-plugin-global-shortcut`:

**`Ctrl+Shift+C` — Copy shortcut:**

1. If copy-popup is visible (`win.is_visible()`), hide it (toggle behavior) and return
2. Spawn a thread, sleep **120 ms** (to let the OS process the key-release)
3. Set `suppress = true`, then call `platform::simulate_copy()` (sends `Ctrl+C` via key simulation)
4. Sleep another **120 ms** for the app that had focus to process the copy
5. Read the clipboard with `read_clipboard_entry()`
6. Push to history with dedup via `push_if_distinct_with_flag()`
7. If newly inserted: if `autosave` on, add "Saved" group; emit `clipboard:new-entry`; call `auto_save_history()`; call sync client's `on_new_clipboard_entry()`
8. **Unconditionally** (whether inserted or not): call `set_active_clipboard_id()` with the entry's ID
9. Call `show_copy_popup()` — positions the window near the cursor, emits `clipboard:copied`, shows and focuses the window

**`Ctrl+Shift+V` — Paste shortcut:**

1. If paste-popup is visible, hide it (toggle) and return
2. Lock history, take `top(10)` recent entries + `pinned_entries().into_iter().take(10)` pinned entries, unlock
3. Position popup near cursor, emit `paste-popup:entries` to the popup window, show and focus the paste-popup window

---

## 6. Popup Windows — `runtime/popup_windows.rs`

Three popup windows are created at startup, all **hidden, off-screen** at `(-9999.0, -9999.0)` (`OFFSCREEN_POS`):

| Window | `focused` | `ignore_cursor_events` | Purpose |
|---|---|---|---|
| `copy-popup` | `true` | `false` | Confirmation after Ctrl+Shift+C |
| `paste-popup` | `false` | `false` | Entry picker after Ctrl+Shift+V |
| `notification` | `false` | `true` (click-through) | System toast notifications |

All three are built with: `decorations=false`, `transparent=true`, `shadow=false`, `resizable=false`, `always_on_top=true`, `skip_taskbar=true`, `visible=false`.

`hide_popup(label)` moves the window to `(-9999, -9999)` *before* calling `hide()`. This is a workaround for a WRY/Windows bug where `hide()` alone on transparent always-on-top windows can still intercept clicks during the brief transition.

`hide_all_popups()` hides copy-popup and paste-popup only. The notification window is intentionally excluded — it auto-dismisses on its own timer and should remain visible even when the main window gains focus.

`setup_main_window_focus_handler()` registers a `WindowEvent::Focused(true)` handler on the main window that calls `hide_all_popups()`.

---

## 7. Command Handlers — `clipboard/commands.rs`

Key constants:
- `IMAGE_READ_RETRY_COUNT = 5`, `IMAGE_READ_RETRY_DELAY_MS = 90`
- `CLIPBOARD_OPEN_RETRIES = 6`, `CLIPBOARD_OPEN_RETRY_DELAY_MS = 50`
- `PASTE_DELAY_MS = 80`
- `MAX_PINNED = 10`
- `MAX_IMAGE_PREVIEW_BYTES = 12 * 1024 * 1024` (12 MB)
- `MAX_VIDEO_PREVIEW_BYTES = 36 * 1024 * 1024` (36 MB)

**`copy_entry(id)`** — Looks up entry, calls `write_entry_to_clipboard()`, sets `suppress = true`, updates active ID, fires notification. Supports all 4 entry types.

**`paste_entry(id)`** — Hides the paste-popup first (so the popup doesn't intercept focus), then spawns a thread. Sets `suppress = true`, writes to clipboard, calls `schedule_paste()` which after **80 ms** simulates `Ctrl+V` (the delay allows the previously-focused window to regain focus before the keystroke arrives).

**`write_entry_to_clipboard(entry)`** — Type dispatch:
- Text: `arboard::Clipboard::set_text()`
- Html: custom CF_HTML writer in `clipboard/html.rs`
- Image (Windows, file-backed): write as CF_HDROP so the paste target gets the file path
- Image (non-Windows or legacy data-URL): decode RGBA and write via `arboard::set_image()`
- File: `write_files_to_clipboard()`

**`delete_entry(id)`** — Removes from history, emits `clipboard:entry-deleted`, calls `auto_save_history()`, calls sync client's `on_delete_clipboard_entry()` (tombstone must propagate even when offline).

**`clear_history()`** — First collects IDs of all `!e.pinned` (non-pinned) entries for sync tombstones, then calls `hist.clear()` (which retains all `is_saved()` entries — both pinned and "Saved" group). Note: only non-pinned entry IDs are sent as tombstones, not all non-saved ones.

**`pin_entry(id)` / `unpin_entry(id)`** — Enforces `MAX_PINNED = 10` cap. On success: calls `auto_save_history()`, emits `clipboard:entry-pinned`, calls sync client's `on_update_clipboard_entry()`.

**`set_setting(key, value)`** — Writes to `settings.json` (pretty-printed JSON) and also updates the corresponding `AtomicBool` in `AppState` immediately. Keys mapped to in-memory flags: `keep_history, close_to_tray, start_minimized, notification, notif_copy, notif_paste, autosave, show_splash`. Synced keys (which schedule a settings push to the cloud): `keep_history, close_to_tray, start_minimized, notification, notif_copy, notif_paste, autosave, sharing_notify`.

**`auto_save_history()`** — Doesn't write to disk directly. Sets `history_dirty = true`. The background flush thread picks this up within 2 seconds. Cost: two atomic operations ≈ 2 ns.

**Bulk commands**: `bulk_delete_entries`, `bulk_pin_entries` (respects `MAX_PINNED` cap, stops once limit reached), `bulk_set_groups` — all follow the same pattern: mutate history, emit per-entry events, call `auto_save_history()`, notify sync client.

---

## 8. Frontend App Shell — `App.tsx`

`App.tsx` is a ~1274-line React component that owns **all application state**. It's the single source of truth for entries, notes, groups, and theme.

**State initialization:**
- `entries` — loaded via `invoke("get_history")` on mount, then kept in sync via events
- `notes` — loaded via `invoke("get_notes")`, re-synced on window focus
- `screen` — persisted to `localStorage` (`sc-last-screen`), defaults to `"clipboard"`
- `availableGroups` — persisted to `localStorage` (`sc-groups`); also recovered at startup by scanning entry tags (one-time recovery to handle cases where groups were added before being saved)
- `theme` — persisted to `localStorage` (`sc-theme`); auto-follows OS preference when no manual preference is set

**Event listeners** (all registered with `listen()` from `@tauri-apps/api/event`):
- `clipboard:new-entry` — prepend to entries, dedup by ID
- `clipboard:entry-deleted` — filter out from entries
- `clipboard:entry-pinned` — update `pinned` field on matching entry
- `clipboard:entry-groups-changed` — update `groups` field on matching entry
- `clipboard:active-id` — update `activeClipboardId` (used to highlight the entry currently in clipboard)
- `sync:status-changed` — update `syncConnected` state for the sync pill
- `sync:remote-entry`, `sync:remote-delete` — apply remote changes from WebSocket
- `sync:collect-settings` — Rust asking JS to send current `localStorage` values for a push
- `sync:settings` — apply incoming settings from server to `localStorage`
- `sync:file-skipped` — toast when a file is too large to sync (>5 MB limit)

**Safety net re-sync**: Both `tauri://focus` and `document.visibilitychange` (for tray → show path) trigger a full `get_history()` re-sync. This catches any events missed during the window being hidden.

**Undo/delete pattern** — Every destructive operation (single delete, bulk delete, clear all, group delete, note delete) follows the same pattern:
1. Immediately remove from UI state (optimistic)
2. Store a snapshot in state (e.g., `deletedEntry`)
3. Set a **5-second timer** — if it fires, call the backend command
4. Show a toast with an "Undo" button that cancels the timer and restores state
5. When a new delete starts, commit any pending previous delete immediately

**Group state** — Groups are stored only in `localStorage` (key `sc-groups`). The backend doesn't know about the group list; it only stores which group tags each entry has. The frontend reconstructs the group list from entries at startup and syncs it via the cloud.

---

## 9. ClipboardScreen — `clipboard-screen/ClipboardScreen.tsx`

The main history view. Key features:

**Timeline grouping** — Entries are grouped by local calendar date using `toLocalDateKey()` (year-month-day string). Groups show "Today", "Yesterday", or a short date. Each group can be collapsed by clicking the day header (via `collapsed: Set<string>`).

**Sort modes** — Newest, oldest, A-Z, Z-A, type. Sorting is applied *within* each day group so the day grouping always reflects chronological order.

**Layout modes** — Tiles (CSS grid) or list. Switching fades out over 160ms (CSS transition + `fading` state) then switches layout.

**Search & filter** — Delegated to `useSearchFilter()` hook which maintains the query string and active filters. Filters include type (text/image/file/html), pinned-only, saved-only, and group filter.

**Multi-select** — `useMultiSelect()` hook tracks whether selection mode is active and which IDs are selected. Supports shift-click range selection via `selectRange(id, allVisibleIds)`. The "all visible IDs" array is computed from the sorted day groups so range selection works across group boundaries in the correct visual order.

**Bulk actions** — `BulkActionsBar` floats below the toolbar when selection mode is active. Operations: delete, pin/unpin, save/unsave, add/remove group.

---

## 10. EntryCard — `entry-card/EntryCard.tsx`

Each clipboard entry is rendered as a card. The card is aware of:
- `isInClipboard` — highlights the entry currently in the OS clipboard with a distinct border/indicator
- `isSelecting / isSelected` — shows a checkbox overlay in multi-select mode
- Content preview: text (truncated at 180 chars), image thumbnail (using `convertFileSrc()` for file-backed images or data-URL directly), HTML (renders plain-text fallback), file (shows icon + filename)
- A `CardMenu` (context menu) reachable via right-click or a "…" button, with actions: copy, pin, save, delete, set groups, expand/collapse

---

## 11. Paste Popup — `PastePopup.tsx`

A separate HTML page (`paste-popup.html`) that mounts its own React root. It runs in the Tauri `paste-popup` webview window.

**Flow:**
1. Receives `paste-popup:entries` event with `{ recent: ClipboardEntry[], pinned: ClipboardEntry[] }`
2. Shows up to `slots` entries (configurable 3–10, stored in `sc-paste-slots`)
3. Has two tabs: Recent and Pinned
4. Keyboard shortcuts: `1-9`, `0` (for 10th slot) to paste immediately; arrow keys to navigate; Enter to paste selected; Tab/Arrow left-right to switch tabs; Escape to close
5. Calls `invoke("paste_entry", { id })` — this hides the popup, writes to clipboard, then simulates Ctrl+V after 80 ms
6. Dismisses on blur (`tauri://blur` event)
7. Dynamically resizes via `invoke("resize_paste_popup", { height })` based on entry count and expanded file lists

---

## 12. Copy Popup — `CopyPopup.tsx`

Another separate HTML page (`copy-popup.html`). Shows confirmation of what was just copied.

**Flow:**
1. Receives `clipboard:copied` event with `{ id, kind, content }`
2. Shows a preview (text truncated, image thumbnail, file name)
3. Action buttons: Pin/Unpin, Save/Unsave (hidden if autosave is on), Delete
4. Dynamically resizes based on content length and media type
5. Dismisses on blur (with a **200 ms delay** so button clicks register first — frameless Windows windows can fire blur on the click that's targeting a button inside the popup)

---

## 13. Notes Screen — `NotesScreen.tsx`

**Split-pane layout** — When a note is open for editing, the screen splits: left panel is the notes list (resizable, 40–68% width, stored in `localStorage: ns-notes-list-width`), right panel is the editor. The splitter is a draggable handle that tracks `mousemove` globally while dragging.

**Filtering/sorting** — Same pattern as clipboard: search text (searched against title + HTML-stripped content), pinned-only filter, group filter, sort by newest/oldest/A-Z/Z-A. Pinned notes always sort above unpinned.

**Sections** — When there are both pinned and unpinned notes, collapsible "Pinned" / "Notes" section headers appear. Each section header is a button that toggles collapse state.

**Note state** — Notes are owned by `App.tsx` and passed down. All mutations (`onCreate`, `onUpdate`, `onDelete`, `onPin`, etc.) invoke the backend and update parent state. The same 5-second undo pattern applies to note deletion.

---

## 14. Notes Editor Engine — `editor-engine/NotionEditor.tsx`

A full Tiptap (ProseMirror) editor wrapped in a `forwardRef` component with an imperative handle.

**Extensions loaded:**
- `StarterKit` (paragraph, heading, bold, italic, strike, code, blockquote, bullet/ordered lists, horizontal rule, history)
- `Underline`, `Link` (autolink enabled)
- `TaskList` + `TaskItem` (nested todos with checkboxes)
- `Table` + `TableRow` + custom `ColoredTableCell/Header` (with `backgroundColor` attribute for cell highlight)
- `Placeholder` (per-node-type hints)
- `TextAlign` (left/center/right/justify for paragraphs and headings)
- `TextStyle` + `Color` (text color)
- `Highlight` (multi-color highlight)
- `CodeBlockLowlight` (syntax-highlighted code blocks via `lowlight`)
- Custom `Callout` extension (info/warning/success/error callout blocks)
- Custom `ClipEmbed` extension (embeds a clipboard entry inline in a note)
- Custom `GroupRef` extension (embeds a reference to a clipboard group)
- `IndentExtension` (Tab/Shift+Tab for list indentation)
- `ResolvedImage` (overrides image rendering to resolve `attachment://` URLs)
- `ResolvedLink` (overrides link rendering similarly)

**Content storage** — Content is stored as Tiptap JSON (ProseMirror document JSON) serialized to a string. `content-codec.ts` handles `parseStoredContent()` (which also auto-migrates legacy markdown on first edit) and `serializeDoc()`.

**Image handling** — Pasting or dropping an image triggers `insertImageFromFile()`, which calls `invoke("save_note_image", { bytes, ext })`. The Rust side saves the file to the note's attachments directory and returns the filename. The editor inserts an image node with a special `attachment://` URL that gets resolved at render time.

**Table controls** — When the cursor is inside a table, floating `+Row` / `-Row` / `+Col` / `-Col` buttons appear adjacent to the table, positioned via `getBoundingClientRect()` with viewport flip detection.

**`NotionEditorHandle`** — The imperative ref exposes: `applyCommand(cmd)` (the full command palette dispatcher), `insertText`, `insertClipEmbed`, `insertGroupEmbed`, `insertLink`, `getContent`, `getActiveState` (returns which marks/block types are active at the cursor), `focus`.

---

## 15. Sync System — `sync/`

**Architecture:** A `SyncClient` struct (Rust) wraps:
- `SyncHttpClient` — `reqwest`-based HTTP client with Bearer auth and automatic 401→token-refresh→retry
- `PendingQueue` — queues operations that need to be sent while offline
- `IdMap` — maps local entry IDs to server UUIDs (persisted to `id_map.json`)
- `WsListener` — WebSocket connection for real-time incoming entries

**Security:** All clipboard/note content is end-to-end encrypted using Argon2id key derivation and AES-GCM. The server never sees plaintext. Keys are derived from the user's password; the `kdf_salt` comes from the server on login.

**Sync flows:**
- **Push:** `on_new_clipboard_entry()` is called by the watcher/hotkey handler after each capture. The sync client encrypts the content and metadata, pushes to `POST /api/v1/sync/push`, stores the server_id in `IdMap`.
- **Pull:** On startup and after WS reconnect, pulls entries since the cursor timestamp.
- **Tombstones:** `on_delete_clipboard_entry()` queues a delete even when offline (stored in `PendingQueue`).
- **Settings sync:** `schedule_settings_push()` debounces settings changes and pushes encrypted settings blob to `PUT /api/v1/settings`. Uses last-write-wins via server-side timestamp comparison.
- **Live Share:** A separate concept (distinct from sync). Users can create "sharing sessions" — real-time clipboard sharing with specific people via invite codes, scoped to clipboard/notes/both.

**Frontend sync events** received from Rust:
- `sync:status-changed` → updates the sync pill indicator
- `sync:remote-entry` → prepends incoming entry to history
- `sync:remote-delete` → removes entry from history
- `sync:settings` → applies server settings to `localStorage`
- `sync:collect-settings` → Rust asking JS to send current `localStorage` values for a push
- `sync:file-skipped` → toast when a file is too large to sync (>5 MB limit)

---

## 16. Persistence Summary

| Data | File | Format | When written |
|---|---|---|---|
| Full clipboard history | `history.bin` | MessagePack | Every ~2s (dirty flag) when `keep_history` on |
| Saved/pinned entries | `pinned_entries.bin` | MessagePack | Every ~2s (flush thread), always |
| Notes | `notes.bin` | MessagePack | Every ~2s (dirty flag), always |
| Settings | `settings.json` | JSON (pretty-printed) | On `set_setting()` call |
| Clipboard images | `images/{id}_{label}.{ext}` | Raw image bytes | When image is first captured; orphans GC'd on next flush |
| Note images/files | `notes/{id}/attachments/` | Raw bytes | When image is pasted into note editor |
| Sync auth tokens | keychain/credential store | Encrypted | On login |
| Sync ID map | `id_map.json` | JSON | After every successful push |
| Boot ID | `boot_id.txt` | Plain text | On each startup |
| Groups | `localStorage: sc-groups` | JSON string | On every group add/delete/rename |
| Theme/layout/sort | `localStorage: sc-theme/sc-layout/...` | String | On each user preference change |

---

## 17. App State Shared Across Threads

`AppState` is Tauri-managed (`app.manage(app_state)`) and accessible in any command via `State<'_, AppState>`. Key design decisions:

- `AtomicBool` for all boolean flags — zero-contention reads from any thread
- `parking_lot::Mutex` (not `std::sync::Mutex`) for `ClipboardHistory` and `NoteStore` — doesn't poison on panic, slightly faster
- The suppress flag is `AtomicBool` specifically so the clipboard watcher (background thread) and command handlers (Tauri thread pool) can coordinate without taking a lock
- The flush thread uses `dirty` flags (atomic swap) rather than channels to avoid blocking the hot path

---

## 18. Screens and Navigation

| Screen | Component | Purpose |
|---|---|---|
| `clipboard` | `ClipboardScreen` | Main history UI |
| `notes` | `NotesScreen` | Notes CRUD + editor |
| `sync` | `SyncScreen` | Cloud sync settings, account, Live Share |
| `shortcuts` | `ShortcutsScreen` | Keyboard shortcut reference |
| `settings` | `SettingsScreen` | App settings (keep history, notifications, autostart, etc.) |

Navigation state lives in `App.tsx` (`screen` state), persisted to `localStorage`. The `Sidebar` component renders navigation buttons. All screens are conditionally rendered within a single `main-frame` div — there's no router, just conditional rendering.

---

## Key Design Invariants

1. **No duplicate capture** — The `suppress` flag ensures that when the app writes to clipboard (paste, copy_entry, Ctrl+Shift+C), the watcher ignores that change.

2. **Saved entries survive clear** — `clear_history()` calls `hist.clear()` which retains all `is_saved()` entries (pinned OR in "Saved" group). The frontend also filters `e.pinned || e.groups.includes("Saved")` before clearing UI state.

3. **Undo windows are 5 seconds** — Every delete in the frontend is deferred 5 seconds with an undo toast. The actual `invoke("delete_entry")` only fires if undo is not clicked.

4. **Active clipboard ID tracking** — After every copy (from watcher or copy_entry/paste_entry/Ctrl+Shift+C), `set_active_clipboard_id()` emits `clipboard:active-id`. The frontend uses this to highlight the current clipboard entry. The Ctrl+Shift+C handler calls this unconditionally (even when the captured content is a duplicate of the top entry).

5. **Image externalization + GC** — Images are never stored as data-URLs in persistent state. They are always saved as files at capture time. Unreferenced image files are deleted when history is flushed to disk.
