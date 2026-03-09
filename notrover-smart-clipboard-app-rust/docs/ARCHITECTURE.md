# Smart Clipboard — Architecture

> **Created by Salman Tariq — DO NOT DELETE**

A Tauri v2 + React desktop clipboard manager for **Windows and Linux** with real-time monitoring, global hotkeys, and multi-window popups.

---

## Table of Contents

- [High-Level Overview](#high-level-overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Rust Backend](#rust-backend)
  - [Entry Point & Setup](#entry-point--setup)
  - [State Management](#state-management)
  - [Clipboard Module](#clipboard-module)
  - [Runtime Module](#runtime-module)
- [Frontend](#frontend)
  - [Build & Entry Points](#build--entry-points)
  - [Shared Types](#shared-types)
  - [Main App (App.tsx)](#main-app)
  - [Screens](#screens)
  - [Popups](#popups)
  - [UI Components](#ui-components)
- [Data Flows](#data-flows)
- [Persistence & Storage](#persistence--storage)
- [Tauri Configuration & Permissions](#tauri-configuration--permissions)

---

## High-Level Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Tauri Process                         │
│                                                         │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────┐  │
│  │  Clipboard   │   │   Hotkey     │   │  Popup     │  │
│  │  Watcher     │   │   Handlers   │   │  Windows   │  │
│  │  (220ms poll)│   │  Ctrl+Shift  │   │  copy/paste│  │
│  └──────┬───────┘   └──────┬───────┘   └─────┬──────┘  │
│         │                  │                  │         │
│         └──────────┬───────┘                  │         │
│                    ▼                          │         │
│         ┌──────────────────┐                  │         │
│         │   AppState       │                  │         │
│         │  ┌─────────────┐ │                  │         │
│         │  │ History     │ │◄─────────────────┘         │
│         │  │ (Mutex)     │ │                            │
│         │  └─────────────┘ │                            │
│         │  suppress_flag   │                            │
│         └────────┬─────────┘                            │
│                  │                                      │
│                  ▼ events + commands                    │
│  ┌───────────────────────────────────────────────────┐  │
│  │              Tauri IPC Bridge                     │  │
│  └───────────────────────────────────────────────────┘  │
└──────────┬──────────────────┬──────────────┬────────────┘
           ▼                  ▼              ▼
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │  Main Window │  │  Copy Popup  │  │ Paste Popup  │
   │  (React SPA) │  │  (React SPA) │  │ (React SPA)  │
   │  920×640     │  │  340×260     │  │ 340×460      │
   └──────────────┘  └──────────────┘  └──────────────┘
```

The app runs as a single Tauri process with three webview windows. The Rust backend owns all clipboard operations, history storage, and OS integrations. The React frontends communicate via Tauri commands (request/response) and events (push notifications).

---

## Tech Stack

### Backend

| Component                    | Version | Purpose                                                                        |
| ---------------------------- | ------- | ------------------------------------------------------------------------------ |
| Tauri                        | 2       | App framework, windowing, IPC                                                  |
| tauri-plugin-global-shortcut | 2       | Ctrl+Shift+C / Ctrl+Shift+V                                                    |
| tauri-plugin-autostart       | 2       | Launch on OS startup                                                           |
| arboard                      | 3       | Cross-platform clipboard (text + images); bypassed on Windows for image writes |
| windows-sys                  | 0.59    | Win32 APIs (clipboard formats, key simulation, monitors) — Windows only        |
| image                        | 0.25    | PNG encode/decode for clipboard images                                         |
| base64                       | 0.22    | Data-URL encoding                                                              |
| parking_lot                  | 0.12    | Mutex without poisoning                                                        |
| serde + serde_json           | 1       | Serialization for IPC and disk persistence                                     |

### Frontend

| Component       | Version | Purpose                             |
| --------------- | ------- | ----------------------------------- |
| React           | 19.1    | UI framework                        |
| TypeScript      | 5.8     | Type safety                         |
| Vite            | 7       | Build tool (multi-page)             |
| @tauri-apps/api | 2       | IPC (commands + events)             |
| Vanilla CSS     | —       | Styling (CSS variables for theming) |

---

## Project Structure

```
src-tauri/
├── src/
│   ├── main.rs                 # Process entry point
│   ├── lib.rs                  # App builder, setup, Tauri command registration
│   ├── clipboard/
│   │   ├── mod.rs              # Module re-exports
│   │   ├── commands.rs         # Tauri command handlers (get_history, copy, paste, etc.)
│   │   ├── history.rs          # ClipboardEntry, ClipboardHistory ring buffer
│   │   ├── files.rs            # CF_HDROP read/write (Windows file clipboard)
│   │   └── image.rs            # Multi-format image clipboard read/write
│   ├── runtime/
│   │   ├── mod.rs              # Module re-exports
│   │   ├── clipboard_watcher.rs # Background polling thread (220ms)
│   │   ├── hotkeys.rs          # Global shortcut handlers (Ctrl+Shift+C/V)
│   │   ├── popup_windows.rs    # Window creation, show/hide, focus handlers
│   │   ├── commands.rs         # Window control commands (close/resize popups)
│   │   ├── tray.rs             # System tray icon and menu
│   │   ├── platform/
│   │   │   ├── mod.rs           # cfg-gated module selection + cross-platform popup_position()
│   │   │   ├── windows.rs      # Win32: key simulation, cursor, monitors, DPI
│   │   │   └── linux.rs        # xdotool/wtype: key simulation, cursor, screen info
│   │   └── window_state.rs     # Persistent window geometry (position, size)
│   └── state/
│       ├── mod.rs              # Re-exports
│       ├── app_state.rs        # AppState (shared history + flags)
│       └── popup_state.rs      # Popup dimensions, event payload structs
├── Cargo.toml
├── tauri.conf.json
└── capabilities/default.json

src/
├── types.ts                    # Shared types (ClipboardEntry, helpers)
├── components/
│   ├── app/
│   │   ├── index.html          # Main window HTML entry
│   │   ├── App.tsx             # Root component, state management, event listeners
│   │   ├── App.css
│   │   ├── sidebar/            # Navigation sidebar
│   │   ├── clipboard-screen/   # Main history view (masonry/list, day groups)
│   │   │   └── entry-card/     # Individual entry cards (text/image/file)
│   │   ├── search-screen/      # Search + type filters
│   │   ├── settings-screen/    # User preferences (paste slots)
│   │   ├── shortcuts-screen/   # Keyboard shortcut reference
│   │   ├── card-menu/          # Right-click context menu (portal)
│   │   ├── status-pill/        # Entry count summary bar
│   │   ├── toast/              # Toast notifications (undo clear)
│   │   └── tooltip/            # Tooltip portal
│   ├── copy-popup/
│   │   ├── copy-popup.html     # Copy popup HTML entry
│   │   ├── CopyPopup.tsx       # Copy confirmation popup (preview, pin, delete)
│   │   └── copyPopup.css
│   └── paste-popup/
│       ├── paste-popup.html    # Paste popup HTML entry
│       ├── PastePopup.tsx      # Quick paste popup (keyboard slots, tabs)
│       └── pastePopup.css
```

---

## Rust Backend

### Entry Point & Setup

**`main.rs`** — Minimal entry: calls `lib::run()`.

**`lib.rs`** — Orchestrates the entire startup sequence:

1. **`kill_previous_instance()`** — Terminates any existing app process so global hotkeys are released. On Windows uses `tasklist`/`taskkill`; on Linux uses `pgrep`/`kill -9`.
2. **`create_shared_history()`** — Creates `Arc<Mutex<ClipboardHistory>>`.
3. **`app_state_from_history()`** — Builds `AppState` from the shared history and suppress flag.
4. **`setup_runtime()`** — Called inside `tauri::Builder::setup`:
   - Loads pinned entries from `{app_data}/pinned_entries.json`
   - Creates popup windows (hidden, off-screen)
   - Registers global shortcuts (Ctrl+Shift+C, Ctrl+Shift+V)
   - Starts clipboard watcher thread
   - Sets up main-window focus handler (auto-hides popups)
   - Restores saved window geometry
   - Starts window move/resize tracking
5. Registers all Tauri command handlers.
6. Hooks `WindowEvent::Destroyed` on the main window to `exit(0)` the entire process.

### State Management

```
AppState
├── history: Arc<Mutex<ClipboardHistory>>   ← shared across all threads
├── suppress_next_capture: Arc<AtomicBool>  ← prevents watcher re-capturing
├── persist_history: Arc<AtomicBool>        ← cached mirror of the setting (~1ns check)
├── history_dirty: Arc<AtomicBool>          ← triggers periodic flush to history.json
├── close_to_tray: Arc<AtomicBool>          ← hide to tray instead of quitting
└── start_minimized: Arc<AtomicBool>        ← start hidden (minimized to tray)
```

**`AppState`** is managed by Tauri and injected into every command handler via `State<'_, AppState>`. The same `Arc` references are also held by the clipboard watcher thread and the hotkey handler closures.

**Suppress flag**: When `copy_entry`, `paste_entry`, or Ctrl+Shift+C write to the OS clipboard, they set `suppress_next_capture = true`. The next watcher poll sees this, clears it, and skips capture — preventing duplicate entries.

**History persistence**: When `persist_history` is enabled, the `history_dirty` flag is set on every mutation. A background thread flushes the full history to `history.json` every 2 seconds when dirty.

### Clipboard Module

#### `history.rs` — In-Memory History Store

```
ClipboardEntry {
    id: String           ← monotonic counter (AtomicU64)
    kind: EntryKind      ← Text | Image | File
    content: String      ← plain text / data:image/png;base64,... / newline-delimited paths
    timestamp: u64       ← Unix ms
    pinned: bool
    groups: Vec<String>  ← user-defined group tags (e.g. "Persistent")
}
```

**`ClipboardHistory`** is a `Vec<ClipboardEntry>` with most-recent-first ordering:

| Method                              | Behavior                                                  |
| ----------------------------------- | --------------------------------------------------------- |
| `push(entry)`                       | Prepend, trim unpinned entries beyond `MAX_HISTORY` (100) |
| `push_if_distinct(entry)`           | Skip if top entry matches (kind + content)                |
| `push_if_distinct_with_flag(entry)` | Same, also returns whether insertion happened             |
| `top(n)`                            | First N entries                                           |
| `find(id)` / `find_mut(id)`         | Lookup by ID                                              |
| `pin(id)` / `unpin(id)`             | Toggle pinned flag                                        |
| `remove(id)`                        | Delete by ID                                              |
| `clear()`                           | Remove all unpinned entries                               |
| `set_groups(id, groups)`            | Replace the groups list for an entry                      |
| `add_group(id, group)`              | Add a single group tag (no duplicates)                    |
| `purge_group(group)`                | Remove a group tag from every entry that has it           |
| `rename_group(old, new)`            | Rename a group tag across all entries                     |
| `pinned_entries()`                  | All entries with the "Persistent" group tag               |
| `load_pinned_from_file(path)`       | Restore pinned/persistent entries from JSON on startup    |
| `save_persistent_to_file(path)`     | Persist pinned/persistent entries to JSON                 |
| `save_all_to_file(path)`            | Flush full history to disk (for history persistence)      |

#### `commands.rs` — Tauri Command Handlers

| Command                    | Signature                     | Description                                            |
| -------------------------- | ----------------------------- | ------------------------------------------------------ |
| `get_history`              | `() → Vec<ClipboardEntry>`    | Return full history (most-recent first)                |
| `delete_entry`             | `(id) → bool`                 | Remove entry, emit `clipboard:entry-deleted`           |
| `clear_history`            | `() → bool`                   | Remove all unpinned entries                            |
| `pin_entry`                | `(id) → bool`                 | Pin entry (max 10), auto-save to disk                  |
| `unpin_entry`              | `(id) → bool`                 | Unpin entry, auto-save to disk                         |
| `copy_entry`               | `(id) → bool`                 | Write entry to OS clipboard, set suppress flag         |
| `paste_entry`              | `(id) → bool`                 | Write to clipboard, hide popup, simulate Ctrl+V        |
| `save_history`             | `() → bool`                   | Flush full history to disk (on first enable)           |
| `set_entry_groups`         | `(id, groups) → bool`         | Set group tags for an entry, auto-save                 |
| `purge_group_from_entries` | `(group) → bool`              | Remove a group tag from all entries                    |
| `rename_group_in_entries`  | `(old_name, new_name) → bool` | Rename a group tag across all entries                  |
| `get_setting`              | `(key) → Option<Value>`       | Read a setting from `settings.json`                    |
| `set_setting`              | `(key, value) → bool`         | Write a setting; syncs in-memory caches for known keys |
| `get_image_file_preview`   | `(path) → Option<String>`     | Read image file → data-URL (max 12 MB)                 |
| `get_video_file_preview`   | `(path) → Option<String>`     | Read video file → data-URL (max 36 MB)                 |

**Internal helpers:**

- `read_clipboard_entry()` — Reads current OS clipboard in priority order: text → files (CF_HDROP) → images (CF_PNG, registered formats, CF_DIB fallback). Returns `Option<ClipboardEntry>`.
- `write_entry_to_clipboard(entry)` — Writes a `ClipboardEntry` back to the OS clipboard. Text via arboard (with retry), files via CF_HDROP. **Images**: on Windows uses direct Win32 API (`write_image_to_clipboard`) bypassing arboard entirely; on Linux/other uses arboard RGBA fallback.
- `open_clipboard_with_retry()` — Opens an arboard `Clipboard` handle with up to 6 retries (50ms delay between each) to handle contention with the watcher thread or external apps.

#### `files.rs` — Windows File Clipboard (CF_HDROP)

Reads and writes file lists via `CF_HDROP` clipboard format using Win32 APIs:

- **Read**: `OpenClipboard` → `GetClipboardData(CF_HDROP)` → `DragQueryFileW` to extract paths.
- **Write**: Build `DROPFILES` struct + UTF-16 filename block → `GlobalAlloc` → `SetClipboardData(CF_HDROP)`.
- **Serialization**: File paths stored as newline-delimited strings in `ClipboardEntry.content`.

#### `image.rs` — Multi-Format Image Clipboard

**Reading** — tries formats in priority order:

1. **Registered custom formats**: `"PNG"`, `"image/png"`, `"image/jpeg"`, `"image/webp"`, `"image/bmp"`, `"JFIF"` — covers browsers, Snipping Tool, etc.
2. **CF_HDROP** — image file exposed as a shell file-drop.
3. **arboard fallback** — `CF_DIB`/`CF_DIBV5` for screenshots and classic Win32 apps.

Image data is encoded as `data:<mime>;base64,...` URLs for frontend display.

**Writing (Windows)** — `write_image_to_clipboard(data_url)`:

Bypasses arboard entirely to avoid OS error 1418 caused by arboard's internal proxy-thread racing with the clipboard watcher. Uses direct Win32 API:

1. Decode base64 → image → RGBA pixels **before** opening the clipboard.
2. `OpenClipboard` with up to 10 retries (50ms delay).
3. `EmptyClipboard` → write **CF_DIB** (BITMAPINFOHEADER + BGRA bottom-up pixel data) + registered **"PNG"** format.
4. `CloseClipboard`.

**Writing (Linux/other)** — uses `data_url_to_rgba()` to decode the image, then writes via arboard's `set_image()` (which works reliably on non-Windows platforms).

### Runtime Module

#### `clipboard_watcher.rs` — Background Polling Thread

- Dedicated thread with **220ms polling interval**.
- **Windows**: Uses `GetClipboardSequenceNumber()` to detect changes cheaply via a change token.
- **Linux**: No change token available — reads the clipboard every cycle and compares against the last captured content.
- On change, calls `capture_clipboard_change()`:
  - Checks suppress flag (skips if set by user action).
  - Reads clipboard via `read_clipboard_entry()`.
  - Deduplicates against top history entry.
  - Pushes to history, emits `clipboard:new-entry` to all windows.
  - If `persist_history` is enabled, marks `history_dirty` for background flush.
- Only advances the sequence token when capture succeeds — if the clipboard was locked, the next poll retries.

#### `hotkeys.rs` — Global Shortcut Handlers

**Ctrl+Shift+C** (`handle_copy_shortcut`):

1. Toggle-hide copy popup if already visible.
2. Set suppress flag (prevents watcher race).
3. Simulate Ctrl+C (with 120ms delays before/after).
4. Read the clipboard.
5. Push to history (deduplicated), emit `clipboard:new-entry`.
6. Show the copy popup with the entry preview.

**Ctrl+Shift+V** (`handle_paste_shortcut`):

1. Toggle-hide paste popup if already visible.
2. Lock history, grab top 10 recent + top 10 pinned.
3. Emit `paste-popup:entries` to paste popup, show it near cursor.

#### `popup_windows.rs` — Multi-Window Management

Creates two popup windows at startup (hidden, off-screen, frameless, transparent, always-on-top, skip-taskbar):

- **copy-popup** (340×260) — Copy confirmation with preview.
- **paste-popup** (340×460) — Quick paste list with keyboard shortcuts.

**Hiding**: `hide_popup()` moves the window to `(-9999, -9999)` **before** calling `hide()`. This prevents the invisible-but-positioned window from intercepting mouse clicks on the content underneath.

Also sets up a handler that hides all popups when the main window gains focus.

#### `platform/` — OS Abstraction

`platform/mod.rs` selects the correct submodule at compile time via `#[cfg]` gates and re-exports a uniform API. It also contains the cross-platform `popup_position()` function.

| Function                       | Windows (`platform/windows.rs`)                                  | Linux (`platform/linux.rs`)                                  |
| ------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `simulate_copy()`              | Releases Shift/Ctrl, sends Ctrl↓ C↓ C↑ Ctrl↑ via `keybd_event`   | `xdotool key ctrl+c` (X11) or `wtype -M ctrl -k c` (Wayland) |
| `simulate_paste()`             | Releases Shift/Ctrl, sends Ctrl↓ V↓ V↑ Ctrl↑ via `keybd_event`   | `xdotool key ctrl+v` (X11) or `wtype -M ctrl -k v` (Wayland) |
| `popup_position(w, h)`         | _(cross-platform in mod.rs)_ — near cursor, clamped to work area | _(same)_                                                     |
| `cursor_pos()`                 | `GetCursorPos()` → physical pixel coordinates                    | `xdotool getmouselocation` → parse x/y                       |
| `work_area_for_point(x, y)`    | `MonitorFromPoint` + `GetMonitorInfoW`                           | `xdpyinfo` → parse `dimensions:` line                        |
| `scale_factor_for_point(x, y)` | `GetDpiForMonitor` → DPI scaling factor                          | Returns `1.0` (Wayland compositors handle scaling)           |

**Note on simulate_paste (Windows)**: Before sending Ctrl+V, the function explicitly releases Shift and Ctrl keys to prevent modifier corruption. Without this, if the user held Shift while triggering a paste, the OS would see Ctrl+Shift+V instead of Ctrl+V.

**Note on Linux**: `is_wayland()` checks the `WAYLAND_DISPLAY` environment variable. If set, uses `wtype`; otherwise falls back to `xdotool` (X11).

#### `tray.rs` — System Tray

Sets up a system tray icon with a context menu:

- **Show Orange Copy Paste** — Shows/unminimizes the main window.
- **Quit** — Exits the app.

Left-clicking the tray icon also shows the main window. Integrates with `close_to_tray` setting: when enabled, closing the main window hides it to the tray instead of quitting.

#### `window_state.rs` — Persistent Window Geometry

Saves window position, size, and maximized state to `{app_data}/window-state.json` on every move/resize. Restores on startup with guards: minimum 200×200 dimensions, re-center if position is off-screen.

---

## Frontend

### Build & Entry Points

Vite is configured for a **multi-page build** (three separate HTML entry points → three separate JS bundles):

| Window      | Entry HTML                                    | Entry Component  | Dimensions         |
| ----------- | --------------------------------------------- | ---------------- | ------------------ |
| main        | `src/components/app/index.html`               | `App.tsx`        | 920×640, resizable |
| copy-popup  | `src/components/copy-popup/copy-popup.html`   | `CopyPopup.tsx`  | 340×260, frameless |
| paste-popup | `src/components/paste-popup/paste-popup.html` | `PastePopup.tsx` | 340×460, frameless |

Dev server runs on port 1420 (fixed for Tauri dev mode).

### Shared Types

**`types.ts`** defines the core `ClipboardEntry` interface matching the Rust struct, plus helpers:

```typescript
interface ClipboardEntry {
  id: string;
  type: "text" | "image" | "file"; // serde renames "kind" → "type"
  content: string;
  timestamp: number;
  pinned: boolean;
}

type AppScreen = "clipboard" | "search" | "shortcuts" | "settings";
type AppTheme = "dark" | "light";
```

Helpers: `timeAgo()`, `truncateText()`, `filePaths()`, `isImageFile()`, `isVideoFile()`, `classifyFileEntry()`.

### Main App

**`App.tsx`** is the root of the main window. It owns:

- **`entries: ClipboardEntry[]`** — the full clipboard history state.
- **`screen: AppScreen`** — which screen is currently active.
- **`theme: AppTheme`** — dark/light mode (persisted to `localStorage`).
- **`undoSnapshot`** — snapshot for "undo clear history" (5-second window).

**Initialization (on mount):**

1. Subscribe to `clipboard:new-entry` events (prepend to state, deduplicated by ID).
2. Subscribe to `clipboard:entry-deleted` events (remove from state).
3. Fetch `get_history` from Rust, **merge** with any entries already received via events.

**Focus resync:**
Listens to `tauri://focus` on the main window. On focus, re-fetches full history from Rust to catch up with any events that may have been missed while the app was in the background.

### Screens

#### Clipboard Screen (`ClipboardScreen.tsx`)

The main history view. Entries are grouped by day ("Today", "Yesterday", "Mar 6") and sorted within each group.

**Features:**

- **Layout toggle**: Masonry (CSS grid, variable heights) or List (full-width rows). Persisted to `localStorage`.
- **Sort**: Newest, Oldest, A→Z, Z→A, Type. Persisted to `localStorage`.
- **Day groups**: Collapsible with animated transitions.
- **Toolbar**: Sort dropdown + layout toggle + clear-all button.
- **Empty state**: Placeholder with Ctrl+Shift+C hint.

#### Entry Card (`EntryCard.tsx`)

Renders a single `ClipboardEntry` with type-specific previews:

| Type                | Preview                                                             |
| ------------------- | ------------------------------------------------------------------- |
| Text                | Truncated content (160 chars)                                       |
| Image               | `<img src={data-URL}>`                                              |
| File (single image) | Image preview loaded async via `get_image_file_preview`             |
| File (single video) | `<video>` with controls                                             |
| File (single other) | Filename only                                                       |
| File (multiple)     | Thumbnail strip (up to 3 images) + "+N" badge, expandable file list |

**Interactions:**

- Click → copy to clipboard, 1.5s "Copied!" feedback.
- Right-click → context menu (Copy, Pin/Unpin, Delete) via `CardMenu`.
- Relative timestamps update every 15 seconds.

#### Search Screen (`SearchScreen.tsx`)

- **Text search**: Debounced, case-insensitive substring match on content/filenames.
- **Type filters**: All, Pinned, Text, Image, File (combinable with search query).
- **Recent searches**: Auto-saved (max 8), click to reapply, per-term remove.
- Results rendered as `EntryCard` components.

#### Settings Screen (`SettingsScreen.tsx`)

- **Paste slots**: How many entries shown in the paste popup (3–10, default 3). Persisted to `localStorage.sc-paste-slots`.
- **Persist history**: Save full clipboard history to disk (survives restarts). Stored in `settings.json`.
- **Close to tray**: Hide to system tray on close instead of quitting. Stored in `settings.json`.
- **Start minimized**: Launch hidden in tray. Stored in `settings.json`.

#### Shortcuts Screen (`ShortcutsScreen.tsx`)

Read-only reference page showing all keyboard shortcuts organized by section (Global, Clipboard Cards, Search & Filter).

### Popups

#### Copy Popup (`CopyPopup.tsx`)

Shown after Ctrl+Shift+C near the cursor. Displays:

- Type badge (Image / Text / N Files).
- Content preview (text truncated to 200 chars, image thumbnail, file names).
- Pin and Delete action buttons.
- Auto-dismisses on blur (`tauri://blur`), Esc key, or close button.

Listens to `clipboard:copied` event from Rust.

#### Paste Popup (`PastePopup.tsx`)

Shown on Ctrl+Shift+V near the cursor. Displays:

- **Tabs**: Recent / Pinned.
- **Numbered slots** (1–9, 0): Press number key to instantly paste that entry.
- Arrow key navigation + Enter to paste selected.
- Expandable file entries for multi-file items.
- Dynamic height resize via `invoke("resize_paste_popup", { height })`.

Listens to `paste-popup:entries` event from Rust. Auto-dismisses on blur or Esc.

### UI Components

| Component           | Purpose                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `Sidebar`           | Navigation (4 screens) + theme toggle. Icon-based, fixed position.  |
| `StatusPill`        | "N text · M img · K files · X total" summary bar.                   |
| `CardMenu`          | Right-click context menu (Copy, Pin/Unpin, Delete). Portal to body. |
| `ToastNotification` | Timed notification with progress bar + optional action (Undo).      |
| `TooltipPortal`     | CSS-driven tooltips via `data-tooltip` attributes.                  |
| `WindowControls`    | Frameless window buttons (minimize, maximize/restore, close).       |

---

## Data Flows

### Clipboard Capture (Background)

```
OS Clipboard Changes
        │
        ▼ (220ms poll)
GetClipboardSequenceNumber()
        │ token changed?
        ▼
capture_clipboard_change()
        │
        ├─ suppress flag set? → clear flag, skip (return true)
        │
        ├─ read_clipboard_entry() → None? → return false (retry next poll)
        │
        ├─ duplicate of top entry? → skip (return true)
        │
        └─ history.push(entry)
           emit("clipboard:new-entry")
           return true → advance last_token
```

### Ctrl+Shift+C (Copy to History)

```
User presses Ctrl+Shift+C
        │
        ├─ popup already visible? → toggle hide, done
        │
        ▼ (spawn thread)
    set suppress = true
    simulate Ctrl+C
    wait 120ms
    read_clipboard_entry()
        │
        ▼
    history.push_if_distinct()
        │
        ├─ inserted? → emit("clipboard:new-entry")
        │
        ▼
    show copy-popup
    emit("clipboard:copied") to popup window
```

### Ctrl+Shift+V (Quick Paste)

```
User presses Ctrl+Shift+V
        │
        ├─ popup already visible? → toggle hide, done
        │
        ▼
    history.top(10) + pinned_entries().take(10)
    emit("paste-popup:entries") to popup
    show paste-popup near cursor
        │
        ▼ (user presses 1-9 or Enter)
    invoke("paste_entry", { id })
        │
        ▼
    hide paste-popup (move offscreen first)
    spawn background thread:
        suppress = true
        write_entry_to_clipboard()
          ├─ Text: arboard with retry (6 attempts)
          ├─ Image (Win): direct Win32 API (CF_DIB + PNG)
          ├─ Image (Linux): arboard set_image()
          └─ File: CF_HDROP
        wait 80ms
        simulate Ctrl+V (release modifiers first on Windows)
```

### Frontend State Sync

```
                    Rust Backend
                        │
            ┌───────────┼───────────┐
            ▼           ▼           ▼
     clipboard:    clipboard:    tauri://focus
     new-entry    entry-deleted   (main window)
            │           │           │
            ▼           ▼           ▼
     prepend to    filter out    re-fetch
     entries[]     by id         get_history()
            │           │        merge with
            └───────────┼────────existing
                        ▼
                  React re-render
```

---

## Persistence & Storage

| What              | Location                          | Format                                                 | When Saved           | When Loaded   |
| ----------------- | --------------------------------- | ------------------------------------------------------ | -------------------- | ------------- |
| Pinned entries    | `{app_data}/pinned_entries.json`  | JSON array of `ClipboardEntry`                         | On pin/unpin/groups  | On startup    |
| Full history      | `{app_data}/history.json`         | JSON array of `ClipboardEntry`                         | Every 2s when dirty  | On startup    |
| Settings          | `{app_data}/settings.json`        | JSON object `{ key: value }`                           | On `set_setting`     | On startup    |
| Boot ID           | `{app_data}/boot_id.txt`          | Plain text (boot epoch seconds)                        | On startup           | On startup    |
| Window geometry   | `{app_data}/window-state.json`    | `{ x, y, width, height, maximized }`                   | On every move/resize | On startup    |
| Theme preference  | `localStorage.sc-theme`           | `"dark"` or `"light"`                                  | On toggle            | On mount      |
| Layout preference | `localStorage.sc-layout`          | `"masonry"` or `"list"`                                | On change            | On mount      |
| Sort preference   | `localStorage.sc-sort`            | `"newest"` / `"oldest"` / `"a-z"` / `"z-a"` / `"type"` | On change            | On mount      |
| Paste slot count  | `localStorage.sc-paste-slots`     | `"3"` – `"10"`                                         | On change            | On popup show |
| Recent searches   | `localStorage.sc-recent-searches` | JSON string array (max 8)                              | On search            | On mount      |

**Note**: When `persist_history` is disabled (default), unpinned clipboard history is in-memory only and lost on app restart. Only pinned entries survive. When enabled via Settings, the full history is flushed to `history.json` every 2 seconds.

---

## Tauri Configuration & Permissions

### Windows (tauri.conf.json)

| Window      | Size    | Properties                                                                                |
| ----------- | ------- | ----------------------------------------------------------------------------------------- |
| main        | 920×640 | Resizable, frameless, initially hidden (shown by window-state restore), dark bg `#0e0e0e` |
| copy-popup  | 340×260 | Frameless, transparent, no shadow, always-on-top, skip taskbar, not resizable             |
| paste-popup | 340×460 | Same as copy-popup                                                                        |

### Permissions (capabilities/default.json)

Applied to all three windows:

- `core:default` — basic Tauri runtime
- `core:window:allow-show`, `allow-hide`, `allow-set-position`, `allow-set-focus`, `allow-minimize`, `allow-maximize`, etc.
- `core:event:default` — emit/listen for custom events
- `global-shortcut:default` — register/unregister global keyboard shortcuts

### Build

- **Dev**: `bun run dev` → Vite on `localhost:1420`
- **Prod**: `bun run build` → `tsc && vite build` → `dist/`
- **Bundle**: NSIS installer (Windows)
- **Release profile**: `opt-level = "z"`, LTO, single codegen unit, stripped symbols
