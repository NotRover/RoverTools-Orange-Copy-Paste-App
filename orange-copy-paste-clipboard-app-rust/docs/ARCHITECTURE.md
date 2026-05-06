# Smart Clipboard — Architecture

> **Created by Salman Tariq — DO NOT DELETE**

A Tauri v2 + React desktop clipboard manager for **Windows and Linux** with real-time monitoring, global hotkeys, multi-window popups, and optional cloud sync with end-to-end encryption.

> **Cross-system context:** For how this app integrates with the FastAPI backend, see `docs/ARCHITECTURE.md` (workspace root). For backend internals, see `orange-copy-paste-clipboard-backend/docs/ARCHITECTURE.md`.

---

## Table of Contents

- [High-Level Overview](#high-level-overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Rust Backend](#rust-backend)
  - [Entry Point & Setup](#entry-point--setup)
  - [State Management](#state-management)
  - [Clipboard Module](#clipboard-module)
  - [Notes Module](#notes-module)
  - [Cloud Sync Module](#cloud-sync-module)
  - [Runtime Module](#runtime-module)
- [Frontend](#frontend)
  - [Build & Entry Points](#build--entry-points)
  - [Shared Types](#shared-types)
  - [Main App (App.tsx)](#main-app)
  - [Screens](#screens)
  - [Popups](#popups)
  - [UI Components](#ui-components)
- [Data Flows](#data-flows)
- [TODO — Implementation Checklist](#todo--implementation-checklist)
- [Persistence & Storage](#persistence--storage)
- [Tauri Configuration & Permissions](#tauri-configuration--permissions)
- [Cross-System Invariants](#cross-system-invariants)

---

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Tauri Process                            │
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────┐          │
│  │  Clipboard   │   │   Hotkey     │   │  Popup     │          │
│  │  Watcher     │   │   Handlers   │   │  Windows   │          │
│  │  (220ms poll)│   │  Ctrl+Shift  │   │  copy/paste│          │
│  └──────┬───────┘   └──────┬───────┘   └─────┬──────┘          │
│         │                  │                  │                  │
│         └──────────┬───────┘                  │                  │
│                    ▼                          │                  │
│         ┌──────────────────┐                  │                  │
│         │   AppState       │                  │                  │
│         │  ┌─────────────┐ │                  │                  │
│         │  │ History     │ │◄─────────────────┘                  │
│         │  │ (Mutex)     │ │                                     │
│         │  └─────────────┘ │                                     │
│         │  suppress_flag   │◄──────────────────────────────────┐ │
│         └────────┬─────────┘                                   │ │
│                  │                                             │ │
│                  ▼ events + commands          ┌────────────────┴─┴──┐
│  ┌───────────────────────────────────────┐   │   SyncClient         │
│  │          Tauri IPC Bridge             │   │  (background runtime)│
│  └───────────────────────────────────────┘   │  HTTP push/pull      │
│                                              │  WebSocket listener  │
└──────────┬──────────────┬──────────────┬─────│  crypto (AES/X25519) │
           ▼              ▼              ▼     │  offline queue       │
   ┌──────────────┐  ┌──────────┐  ┌────────┐ └──────────┬───────────┘
   │  Main Window │  │ Copy Pop │  │ Paste  │            │ HTTPS+WSS
   │  (React SPA) │  │ (React)  │  │ Popup  │            ▼
   │  920×560     │  │ 340×260  │  │(React) │  ┌─────────────────────┐
   └──────────────┘  └──────────┘  └────────┘  │  FastAPI Backend    │
                                               │  (cloud, optional)  │
                                               └─────────────────────┘
```

The app runs as a single Tauri process with three webview windows. The Rust backend owns all clipboard operations, history storage, and OS integrations. The React frontends communicate via Tauri commands (request/response) and events (push notifications). The `SyncClient` runs in a dedicated background Tokio runtime and is entirely optional — the app is fully functional without it.

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
| serde + serde_json           | 1       | Serialization for IPC and settings persistence                                 |
| rmp-serde                    | 1       | MessagePack binary serialization for history persistence                       |
| reqwest                      | 0.12    | Async HTTP client for sync push/pull (rustls TLS, JSON) — sync module only     |
| tokio-tungstenite            | 0.23    | Async WebSocket client for realtime events — sync module only                  |
| argon2                       | 0.5     | Argon2id key derivation for User Master Key (UMK) — sync module only           |
| aes-gcm                      | 0.10    | AES-256-GCM content encryption/decryption — sync module only                   |
| x25519-dalek                 | 2       | X25519 ECDH for multi-device key exchange and group key wrapping               |
| keyring                      | 2       | OS credential store for refresh token and device private key                   |

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
│   │   ├── history.rs          # ClipboardEntry, ClipboardHistory, binary persistence (image files + msgpack)
│   │   ├── files.rs            # CF_HDROP read/write (Windows file clipboard)
│   │   ├── html.rs             # CF_HTML read/write (rich text clipboard)
│   │   └── image.rs            # Multi-format image clipboard read/write
│   ├── notes/
│   │   ├── mod.rs              # Module re-exports
│   │   ├── commands.rs         # Tauri command handlers (get_notes, create/update/delete, groups)
│   │   └── store.rs            # Note model + MessagePack persistence
│   ├── sync/                   # Cloud sync module (optional, Phase 6)
│   │   ├── mod.rs              # SyncClient init, background Tokio runtime
│   │   ├── client.rs           # reqwest HTTP client, token refresh middleware
│   │   ├── ws_listener.rs      # WebSocket connection, event dispatch to Tauri event system
│   │   ├── pending_queue.rs    # sync_pending.json read/write for offline accumulation
│   │   ├── crypto.rs           # UMK derivation (Argon2id), AES-256-GCM, X25519 key exchange
│   │   ├── commands.rs         # Tauri commands: sync_login, sync_logout, sync_now, etc.
│   │   └── config.rs           # Server URL + sync-enabled flag (persisted in settings.json)
│   ├── runtime/
│   │   ├── mod.rs              # Module re-exports
│   │   ├── clipboard_watcher.rs # Background polling thread (220ms)
│   │   ├── hotkeys.rs          # Global shortcut handlers (Ctrl+Shift+C/V)
│   │   ├── notifications.rs    # Copy/paste notification toast logic
│   │   ├── popup_windows.rs    # Window creation, show/hide, focus handlers
│   │   ├── commands.rs         # Window control commands (close/resize popups)
│   │   ├── tray.rs             # System tray icon and menu
│   │   ├── platform/
│   │   │   ├── mod.rs           # cfg-gated module selection + cross-platform popup_position()
│   │   │   ├── windows.rs      # Win32: key simulation, cursor, monitors, DPI
│   │   │   └── linux.rs        # xdotool/wtype: key simulation, cursor, screen info
│   │   └── window_state.rs     # Saved window geometry (position, size)
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
│   │   ├── clipboard-screen/   # Main history view (tiles/list, day groups)
│   │   │   ├── bulk-actions/   # Multi-select actions bar
│   │   │   ├── group-manager/  # Group CRUD card
│   │   │   ├── search-filter/  # Search + filters panel
│   │   │   ├── topbar/         # Sort/layout/filter/group controls
│   │   │   └── entry-card/     # Individual entry cards (text/image/file)
│   │   ├── notes-screen/       # Notes UI (editor, list, filters, groups)
│   │   ├── settings-screen/    # User preferences (paste slots, notifications)
│   │   ├── shortcuts-screen/   # Keyboard shortcut reference
│   │   ├── card-menu/          # Right-click context menu (portal)
│   │   ├── status-pill/        # Entry count summary bar
│   │   ├── toast/              # Toast notifications (undo clear)
│   │   └── tooltip/            # Tooltip portal
│   ├── copy-popup/
│   │   ├── copy-popup.html     # Copy popup HTML entry
│   │   ├── CopyPopup.tsx       # Copy confirmation popup (preview, pin, delete)
│   │   └── copyPopup.css
│   ├── notifications/
│   │   ├── notification.html   # Copy/paste notification HTML entry
│   │   ├── Notification.tsx    # Notification component ("Copied"/"Pasted")
│   │   └── notification.css
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
   - Configures the images directory (`{app_data}/images/`) for on-disk image storage
   - Loads history from `{app_data}/history.bin` (MessagePack binary) + `{app_data}/images/`
   - Loads pinned entries from `{app_data}/pinned_entries.bin` (fallback on first run)
   - Creates popup windows (hidden, off-screen)
   - Registers global shortcuts (Ctrl+Shift+C, Ctrl+Shift+V)
   - Starts clipboard watcher thread
   - Starts background flush thread (saves dirty history every 2s)
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
├── keep_history: Arc<AtomicBool>           ← cached mirror of the setting (~1ns check)
├── history_dirty: Arc<AtomicBool>          ← triggers periodic flush to history.bin
├── close_to_tray: Arc<AtomicBool>          ← hide to tray instead of quitting
├── start_minimized: Arc<AtomicBool>        ← start hidden (minimized to tray)
├── notification_enabled: Arc<AtomicBool>   ← master toggle for copy/paste notifications
├── notif_copy: Arc<AtomicBool>             ← show notification on copy action
├── notif_paste: Arc<AtomicBool>            ← show notification on paste action
├── autosave: Arc<AtomicBool>               ← auto-add "Saved" group to new entries
├── active_clipboard_id: Arc<Mutex<String>> ← ID of the entry currently in the OS clipboard
├── notes: Arc<Mutex<NoteStore>>            ← shared notes store
├── notes_dirty: Arc<AtomicBool>            ← triggers periodic flush to notes.bin
└── sync_client: Option<Arc<SyncClient>>   ← None when sync disabled or not yet authed
```

**`AppState`** is managed by Tauri and injected into every command handler via `State<'_, AppState>`. The same `Arc` references are also held by the clipboard watcher thread and the hotkey handler closures.

**Suppress flag**: When `copy_entry`, `paste_entry`, or Ctrl+Shift+C write to the OS clipboard, they set `suppress_next_capture = true`. The next watcher poll sees this, clears it, and skips capture — preventing duplicate entries.

**History keeping**: When `keep_history` is enabled, the `history_dirty` flag is set on every mutation. A background thread flushes the full history to `history.bin` (MessagePack binary) every 2 seconds when dirty. Image data is externalised to individual files in the `images/` directory.

### Clipboard Module

#### `history.rs` — In-Memory History Store

```
ClipboardEntry {
    id: String            ← monotonic counter (AtomicU64); used as client_id in sync
    kind: EntryKind       ← Text | Image | File | Html
    content: String       ← plain text / file path (images) / newline-delimited paths / html---PLAINTEXT---text
    timestamp: u64        ← Unix ms
    pinned: bool
    groups: Vec<String>   ← user-defined group tags (e.g. "Saved")
    label: Option<String> ← display name (e.g. "Image Mar 17, 2:45 PM" for images)
    // Sync fields — NOT persisted to history.bin; maintained in id_map.json by SyncClient
    server_id: Option<String>   ← UUID assigned by server after first successful push
    sync_status: SyncStatus     ← Synced | Pending | LocalOnly (default: LocalOnly)
}
```

> **Sync note:** `server_id` and `sync_status` are transient fields populated at runtime by the SyncClient from `id_map.json`. They are excluded from MessagePack serialization. Their sole purpose is UI display (cloud icon on entry cards) and push dedup logic.

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
| `remove_group(id, group)`           | Remove a single group tag from an entry                   |
| `pinned_entries()`                  | All pinned entries                                        |
| `saved_entries()`                   | All entries that survive restarts (pinned or saved)       |
| `all()`                             | Full history slice (most-recent first)                    |
| `set_images_dir(dir)`               | Configure the directory for on-disk image storage         |
| `load_saved_from_file(path)`        | Restore saved entries from MessagePack binary on startup  |
| `save_saved_to_file(path)`          | Save pinned/saved entries to MessagePack binary           |
| `save_all_to_file(path)`            | Flush full history to disk, clean orphaned image files    |
| `load_all_from_file(path)`          | Load full history from MessagePack binary                 |

#### `commands.rs` — Tauri Command Handlers

| Command                    | Signature                     | Description                                                                                          |
| -------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `get_history`              | `() → Vec<ClipboardEntry>`    | Return full history (most-recent first)                                                              |
| `delete_entry`             | `(id) → bool`                 | Remove entry, emit `clipboard:entry-deleted`                                                         |
| `clear_history`            | `() → bool`                   | Remove all unpinned entries                                                                          |
| `pin_entry`                | `(id) → bool`                 | Pin entry (max 10), auto-save to disk                                                                |
| `unpin_entry`              | `(id) → bool`                 | Unpin entry, auto-save to disk                                                                       |
| `copy_entry`               | `(id) → bool`                 | Write entry to OS clipboard, set suppress flag, update active clipboard ID, show copy notification   |
| `paste_entry`              | `(id) → bool`                 | Write to clipboard, hide popup, simulate Ctrl+V, update active clipboard ID, show paste notification |
| `save_history`             | `() → bool`                   | Flush full history to disk (on first enable)                                                         |
| `get_active_clipboard_id`  | `() → String`                 | Return ID of entry currently in the OS clipboard                                                     |
| `set_entry_groups`         | `(id, groups) → bool`         | Set group tags for an entry, auto-save                                                               |
| `purge_group_from_entries` | `(group) → bool`              | Remove a group tag from all entries                                                                  |
| `rename_group_in_entries`  | `(old_name, new_name) → bool` | Rename a group tag across all entries                                                                |
| `bulk_delete_entries`      | `(ids) → u32`                 | Delete multiple entries, returns count removed                                                       |
| `bulk_pin_entries`         | `(ids, pin) → u32`            | Pin/unpin multiple entries (respects MAX_PINNED)                                                     |
| `bulk_set_groups`          | `(ids, groups) → u32`         | Set same groups on multiple entries                                                                  |
| `bulk_add_group`           | `(ids, group) → u32`          | Add a group to multiple entries                                                                      |
| `bulk_remove_group`        | `(ids, group) → u32`          | Remove a group from multiple entries                                                                 |
| `get_setting`              | `(key) → Option<Value>`       | Read a setting from `settings.json`                                                                  |
| `set_setting`              | `(key, value) → bool`         | Write a setting; syncs in-memory caches for known keys (`sync_enabled`, `sync_server_url` included)  |
| `get_image_file_preview`   | `(path) → Option<String>`     | Read image file → data-URL (max 12 MB)                                                               |
| `get_video_file_preview`   | `(path) → Option<String>`     | Read video file → data-URL (max 36 MB)                                                               |
| `check_missing_files`      | `(paths) → Vec<String>`       | Returns paths that do not exist (used by paste popup before paste)                                   |

#### `notes/commands.rs` — Notes Command Handlers

| Command                  | Signature                     | Description                     |
| ------------------------ | ----------------------------- | ------------------------------- |
| `get_notes`              | `() → Vec<Note>`              | Return all notes                |
| `create_note`            | `() → Note`                   | Create a new blank note         |
| `update_note`            | `(id, title, content) → bool` | Update note content/title       |
| `delete_note`            | `(id) → bool`                 | Delete a note by ID             |
| `pin_note`               | `(id) → bool`                 | Pin a note                      |
| `unpin_note`             | `(id) → bool`                 | Unpin a note                    |
| `set_note_groups`        | `(id, groups) → bool`         | Replace note groups             |
| `purge_group_from_notes` | `(group) → ()`                | Remove a group from all notes   |
| `rename_group_in_notes`  | `(old_name, new_name) → ()`   | Rename a group across all notes |

**Internal helpers:**

- `read_clipboard_entry()` — Reads current OS clipboard in priority order: files (CF_HDROP) → HTML (CF_HTML) → text → images (CF_PNG, registered formats, CF_DIB fallback). Returns `Option<ClipboardEntry>`.
- `write_entry_to_clipboard(entry)` — Writes a `ClipboardEntry` back to the OS clipboard. Text via arboard (with retry), files via CF_HDROP. **Images**: on Windows uses direct Win32 API (`write_image_to_clipboard`) bypassing arboard entirely; on Linux/other uses arboard RGBA fallback.
- `open_clipboard_with_retry()` — Opens an arboard `Clipboard` handle with up to 6 retries (50ms delay between each) to handle contention with the watcher thread or external apps.
- `set_active_clipboard_id(app, id)` — Updates the `active_clipboard_id` in `AppState` and emits the `clipboard:active-id` event to the frontend. Called from `copy_entry`, `paste_entry`, clipboard watcher, and copy shortcut handler.

#### `files.rs` — Windows File Clipboard (CF_HDROP)

Reads and writes file lists via `CF_HDROP` clipboard format using Win32 APIs:

- **Read**: `OpenClipboard` → `GetClipboardData(CF_HDROP)` → `DragQueryFileW` to extract paths.
- **Write**: Build `DROPFILES` struct + UTF-16 filename block → `GlobalAlloc` → `SetClipboardData(CF_HDROP)`.
- **Serialization**: File paths stored as newline-delimited strings in `ClipboardEntry.content`.

#### `html.rs` — Rich Text Clipboard (CF_HTML)

Reads and writes HTML content via the `CF_HTML` registered clipboard format:

- **Read**: Extracts the HTML fragment from the `CF_HTML` format header (StartFragment/EndFragment markers).
- **Write**: Constructs a `CF_HTML` header with proper byte offsets and writes the fragment via Win32 APIs.
- HTML entries store both the HTML fragment and a plain-text fallback separated by `\n---PLAINTEXT---\n`.

#### `image.rs` — Multi-Format Image Clipboard

**Reading** — tries formats in priority order:

1. **Registered custom formats**: `"PNG"`, `"image/png"`, `"image/jpeg"`, `"image/webp"`, `"image/bmp"`, `"JFIF"` — covers browsers, Snipping Tool, etc.
2. **CF_HDROP** — image file exposed as a shell file-drop.
3. **arboard fallback** — `CF_DIB`/`CF_DIBV5` for screenshots and classic Win32 apps.

Image data is initially encoded as `data:<mime>;base64,...` URLs. On push to history, images are externalised to individual files in the `images/` directory (named `{id}_{label}.{ext}`). The `content` field is replaced with the absolute file path. The frontend uses Tauri's `convertFileSrc()` asset protocol to display file-backed images.

**Writing (Windows)** — `write_image_to_clipboard(data_url)`:

Bypasses arboard entirely to avoid OS error 1418 caused by arboard's internal proxy-thread racing with the clipboard watcher. Uses direct Win32 API:

1. Decode base64 → image → RGBA pixels **before** opening the clipboard.
2. `OpenClipboard` with up to 10 retries (50ms delay).
3. `EmptyClipboard` → write **CF_DIB** (BITMAPINFOHEADER + BGRA bottom-up pixel data) + registered **"PNG"** format.
4. `CloseClipboard`.

**Writing (Linux/other)** — uses `data_url_to_rgba()` to decode the image, then writes via arboard's `set_image()` (which works reliably on non-Windows platforms).

### Notes Module

#### `store.rs` — Note Model and Storage

`NoteStore` keeps notes in-memory as `Vec<Note>` and persists them to `{app_data}/notes.bin` using MessagePack.

`Note` fields:

- `id`, `title`, `content` (sanitised HTML)
- `created_at`, `updated_at`
- `pinned`
- `groups`

Notes are sorted by `updated_at` descending, and a monotonic in-process counter is advanced on load to avoid ID collisions.

Like `ClipboardEntry`, notes carry transient `server_id: Option<String>` and `sync_status: SyncStatus` fields (not persisted to `notes.bin`).

#### Persistence Behavior

- Note mutations set `notes_dirty = true`.
- The shared background flush thread writes `notes.bin` every ~2s when dirty.
- Notes are loaded during startup in `setup_runtime`.

---

### Cloud Sync Module

> **Status:** Planned — Phase 6 of backend implementation.
> **Location:** `src-tauri/src/sync/`
> **Principle:** Additive only — no existing capture, storage, or popup logic changes.

#### Overview

The sync module runs entirely in a dedicated background Tokio runtime (separate from Tauri's internal runtime) so it can never block clipboard capture or the UI.

```
Clipboard capture (existing, unchanged)
         │
         ▼
  history.push(entry)          ← plaintext, same as today
         │
         ├──► emit clipboard:new-entry   ← UI update (unchanged)
         │
         └──► SyncClient.on_new_entry(entry)   ← new side-effect
                    │
                    ├─ encrypt(UMK, content) → encrypted_entry
                    ├─ online? → POST /sync/push immediately
                    └─ offline? → append to sync_pending.json
```

#### `mod.rs` — SyncClient

`SyncClient` is the public handle held in `AppState`. It exposes:

- `on_new_entry(entry)` — called after every successful history push
- `on_delete_entry(id)` — called from `delete_entry` command
- `on_update_entry(entry)` — called from pin/group mutation commands
- `flush_pending()` — manually trigger offline queue flush
- `connect_ws()` / `disconnect_ws()` — WebSocket lifecycle

On startup (when sync is enabled and a valid refresh token exists in the OS keychain):

1. Authenticate: exchange refresh token → access token
2. Pull delta: `GET /sync/pull?after_ts={last_cursor}` (paginated)
3. Decrypt and merge remote entries into local store
4. Flush `sync_pending.json`
5. Open WebSocket connection

#### `client.rs` — HTTP Client

- Wraps `reqwest::Client` with base URL, default auth header, and automatic token refresh on 401
- Refresh flow: intercepts 401 → `POST /auth/refresh` → retries original request transparently
- All requests have a 10s timeout
- Connection errors → logged, backed off (1s → 2s → 4s → max 60s exponential)

#### `ws_listener.rs` — WebSocket Listener

Maintains a persistent `tokio-tungstenite` WebSocket connection to `wss://{server}/ws?token=<access_token>`.

On each received message, dispatches to:

| Event                              | Action                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync:entry`                       | Decrypt → check if `client_id` already local → insert or update in history/notes → emit `clipboard:new-entry` or `notes:updated` Tauri event → advance cursor |
| `sync:delete`                      | Find entry by `server_id` → remove from local store → emit `clipboard:entry-deleted`                                                                          |
| `device:online` / `device:offline` | Update sync status indicator via Tauri event                                                                                                                  |
| `group:rekey`                      | Replace cached Group Key → decrypt future entries with new key                                                                                                |
| `ping`                             | Respond with `pong`; refresh Redis presence TTL                                                                                                               |

Connection drop → automatic reconnect after 5s backoff, then exponential up to 60s.

#### `pending_queue.rs` — Offline Queue

`sync_pending.json` lives in `{app_data}/sync_pending.json` and stores an ordered list of operations that need to be pushed:

```jsonc
[
  { "op": "push",   "entry": { ...encrypted_entry } },
  { "op": "delete", "client_id": "42", "entry_type": "clipboard" },
  { "op": "update", "entry": { ...encrypted_entry } }
]
```

On reconnect, the queue is flushed in order before pulling the delta. This ensures local-device ordering is preserved in the LWW (last-write-wins) conflict resolution.

#### `crypto.rs` — Encryption Primitives

All cryptography is performed here. Nothing outside this module touches raw key material.

| Function                                                | Description                                             |
| ------------------------------------------------------- | ------------------------------------------------------- |
| `derive_umk(password, kdf_salt) → [u8; 32]`             | Argon2id(password, salt, m=65536, t=3, p=4)             |
| `encrypt(key, plaintext, aad) → String`                 | `base64(nonce \|\| AES-256-GCM(key, plaintext, aad))`   |
| `decrypt(key, ciphertext_b64, aad) → String`            | Decode base64 → split nonce → AES-256-GCM decrypt       |
| `generate_x25519_keypair() → (privkey, pubkey)`         | Generates device keypair; privkey stored in OS keychain |
| `x25519_shared_secret(privkey, peer_pubkey) → [u8; 32]` | ECDH for device key handshake and group key wrapping    |
| `wrap_key(wrapping_key, key_to_wrap) → String`          | AES-256-GCM encrypt key material                        |
| `unwrap_key(wrapping_key, wrapped_b64) → [u8; 32]`      | Reverse of wrap_key                                     |

**Encryption invariant:** The UMK is passed in at call time from the in-memory `SyncClient` state. It is never written to disk. `crypto.rs` receives it as a `&[u8; 32]` slice.

**AAD (additional authenticated data)** = `client_id` of the entry — binds each ciphertext to its specific entry, preventing ciphertext transplanting attacks.

#### `commands.rs` — New Tauri Commands

| Command               | Signature                                           | Description                                                              |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| `sync_login`          | `(email, password, device_name) → Result<SyncUser>` | Authenticate; derives UMK in memory; stores refresh token in OS keychain |
| `sync_logout`         | `() → ()`                                           | Revoke device token; clear UMK; delete keychain entry                    |
| `sync_get_user`       | `() → Option<SyncUser>`                             | Returns cached login info if authenticated                               |
| `sync_get_status`     | `() → SyncStatus`                                   | `{ connected, last_synced_at, pending_count }`                           |
| `sync_now`            | `() → ()`                                           | Trigger immediate pull + queue flush                                     |
| `sync_set_enabled`    | `(enabled: bool) → ()`                              | Toggle sync; persists to `settings.json`                                 |
| `sync_set_server_url` | `(url: String) → ()`                                | Override default server URL (self-hosted)                                |
| `sync_get_groups`     | `() → Vec<SyncGroup>`                               | List joined shared groups                                                |
| `sync_create_group`   | `(name: String) → SyncGroup`                        | Create group; generates Group Key; posts to server                       |
| `sync_join_group`     | `(invite_code: String) → ()`                        | Join via invite code                                                     |
| `sync_leave_group`    | `(group_id: String) → ()`                           | Leave group; removes local GK                                            |
| `sharing_invite`      | `(email: String, scope: String) → SharingInvite`    | Create or invite to Live Share group (max 5 members); `scope` = `clipboard\|notes\|both` |
| `sharing_accept`      | `(invite_code: String, scope: String) → ()`         | Accept sharing invite; exchange Group Key via X25519                     |
| `sharing_get_sessions`| `() → Vec<SharingSession>`                          | List active sharing sessions with peer info and scope                    |
| `sharing_update_scope`| `(share_group_id: String, scope: String) → ()`       | Update what this user contributes to the share                           |
| `sharing_end_session` | `(share_group_id: String) → ()`                      | Terminate sharing; remove Live Share group UUID from `id_map.json`             |

#### File and Video Sync (5 MB Limit)

`kind: 'file'` entries captured from CF_HDROP are synced subject to a **5 MB total size cap**:

1. On `on_new_entry(entry)`, if `entry.kind == File`:
   - Read each file path from `entry.content` (newline-delimited).
   - Sum file sizes. If total > 5 MB: skip sync for this entry, increment `sync_status.skipped_count`, emit a `sync:file-skipped` Tauri event so the UI can surface a notification. Do not add to `sync_pending.json`.
   - If within limit: for each file, call `POST /blobs/request-upload` → upload bytes to R2 via pre-signed PUT → `POST /blobs/confirm-upload`. Collect `blob_key` values.
   - `encrypted_content` = encrypt(`[{ filename, mime_type, size_bytes, blob_key }, ...]` as JSON).
   - `blob_key` field on the push payload = first file's blob key (for server routing).
2. On receiving a `sync:entry` of `kind: 'file'` from the server: download each blob via pre-signed GET to `{app_data}/sync-downloads/`, update `entry.content` to the downloaded paths.

The same flow applies to video files (CF_HDROP paths to `.mp4`, `.mov`, etc.). The 5 MB check is per-clipboard-entry (sum of all files in that single clipboard event), not per file.

#### Live Share — Sync Module Integration

When an active sharing session exists, `on_new_entry` and `on_update_entry` check whether to fan out to the pair:

1. For each active sharing session in `SyncClient.sharing_sessions`:
   - If `session.my_scope` includes the `entry.entry_type`, append `session.share_group_id` to `entry.group_ids`.
   - Encrypt `encrypted_content` with the session's Group Key (GK), not UMK.
2. Push the entry with the extended `group_ids`. The server fans it out to the paired user via the group channel automatically.

On receiving `sharing:invite` via WebSocket: emit `sharing:invite-received` Tauri event → React shows invite notification in Settings.
On receiving `sharing:ended`: remove the Live Share group UUID from `id_map.json` and `sharing_sessions` in-memory.

#### `config.rs` — Sync Settings

Four settings are added to the existing `settings.json` store:

| Key               | Type   | Default                             | Description                         |
| ----------------- | ------ | ----------------------------------- | ----------------------------------- |
| `sync_enabled`    | bool   | false                               | Master toggle for all sync behavior |
| `sync_server_url` | string | `"https://api.orangeclipboard.app"` | API base URL (self-hosted override) |
| `sharing_enabled` | bool   | true                                | Whether Live Share is active (false = ignore all Live Share group fan-out) |
| `sharing_notify`  | bool   | true                                | Show notification when a peer copies something |

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
  - Updates `active_clipboard_id` and emits `clipboard:active-id`.
  - Shows copy notification if enabled.
  - If `persist_history` is enabled, marks `history_dirty` for background flush.
- Only advances the sequence token when capture succeeds — if the clipboard was locked, the next poll retries.

#### `hotkeys.rs` — Global Shortcut Handlers

**Ctrl+Shift+C** (`handle_copy_shortcut`):

1. Toggle-hide copy popup if already visible.
2. Set suppress flag (prevents watcher race).
3. Simulate Ctrl+C (with 120ms delays before/after).
4. Read the clipboard.
5. Push to history (deduplicated), emit `clipboard:new-entry`.
6. Update `active_clipboard_id`, emit `clipboard:active-id`.
7. Show the copy popup with the entry preview.

**Ctrl+Shift+V** (`handle_paste_shortcut`):

1. Toggle-hide paste popup if already visible.
2. Lock history, grab top 10 recent + top 10 pinned.
3. Emit `paste-popup:entries` to paste popup, show it near cursor.

#### `popup_windows.rs` — Multi-Window Management

Creates popup windows at startup (hidden, off-screen, frameless, transparent, always-on-top, skip-taskbar):

- **copy-popup** (340×260) — Copy confirmation with preview.
- **paste-popup** (340×460) — Quick paste list with keyboard shortcuts.
- **notification** (220×72) — Brief "Copied"/"Pasted" toast at bottom-right of screen.

**Hiding**: `hide_popup()` moves the window to `(-9999, -9999)` **before** calling `hide()`. This prevents the invisible-but-positioned window from intercepting mouse clicks on the content underneath.

Also sets up a handler that hides all popups when the main window gains focus.

#### `notifications.rs` — Copy/Paste Notifications

Manages the "notification" popup window that appears briefly at the bottom-right of the screen:

- `show_notification(app, entry, action)` — Positions the notification window and emits a `notification:show` event with a `NotificationPayload { kind, action }`.
- `notify_if_enabled(app, entry)` — Shows a "Copied" notification if both the master toggle (`notification_enabled`) and per-type flag (`notif_copy`) are enabled.
- `notify_paste_if_enabled(app, entry)` — Shows a "Pasted" notification if both `notification_enabled` and `notif_paste` are enabled.

The frontend `Notification.tsx` component renders a dynamic label and icon (clipboard icon for "Copied", paste icon for "Pasted") based on the `action` field.

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

#### `window_state.rs` — Saved Window Geometry

Saves window position, size, and maximized state to `{app_data}/window-state.json` on every move/resize. Restores on startup with guards: minimum 200×200 dimensions, re-center if position is off-screen.

---

## Frontend

### Build & Entry Points

Vite is configured for a **multi-page build** (four separate HTML entry points → four separate JS bundles):

| Window       | Entry HTML                                       | Entry Component    | Dimensions         |
| ------------ | ------------------------------------------------ | ------------------ | ------------------ |
| main         | `src/components/app/index.html`                  | `App.tsx`          | 920×560, resizable |
| copy-popup   | `src/components/copy-popup/copy-popup.html`      | `CopyPopup.tsx`    | 340×260, frameless |
| paste-popup  | `src/components/paste-popup/paste-popup.html`    | `PastePopup.tsx`   | 340×460, frameless |
| notification | `src/components/notifications/notification.html` | `Notification.tsx` | 220×72, frameless  |

Dev server runs on port 1420 (fixed for Tauri dev mode).

### Shared Types

**`types.ts`** defines the core `ClipboardEntry` interface matching the Rust struct, plus helpers:

```typescript
interface ClipboardEntry {
  id: string;
  type: "text" | "image" | "file" | "html"; // serde renames "kind" → "type"
  content: string;
  timestamp: number;
  pinned: boolean;
  groups: string[];
  label?: string; // e.g. "Image Mar 17, 2:45 PM"
}

type AppScreen = "clipboard" | "notes" | "shortcuts" | "settings";
type AppTheme = "dark" | "light";
```

Helpers: `timeAgo()`, `truncateText()`, `filePaths()`, `fileExtension()`, `fileNameFromPath()`, `isImageFile()`, `isVideoFile()`, `isDocumentFile()`, `isUrl()`, `classifyFileEntry()`, `deriveDisplayKind()`, `imageDisplayName()`, `resolveImageSrc()`, `htmlFragment()`, `htmlPlainText()`, `groupColorIndex()`, `groupColor()`, `setGroupColorIndex()`, `removeGroupColor()`, `renameGroupColor()`.

### Main App

**`App.tsx`** is the root of the main window. It owns:

- **`entries: ClipboardEntry[]`** — the full clipboard history state.
- **`notes: Note[]`** — note collection used by the Notes screen.
- **`screen: AppScreen`** — which screen is currently active.
- **`theme: AppTheme`** — dark/light mode (persisted to `localStorage`).
- **`undoSnapshot`** — snapshot for "undo clear history" (5-second window).
- **`activeClipboardId: string`** — ID of the entry currently in the OS clipboard.

**Initialization (on mount):**

1. Subscribe to `clipboard:new-entry` events (prepend to state, deduplicated by ID).
2. Subscribe to `clipboard:entry-deleted` events (remove from state).
3. Subscribe to `clipboard:active-id` events (update `activeClipboardId` state).
4. Fetch `get_history` and `get_active_clipboard_id` from Rust, **merge** with any entries already received via events.

**Focus resync:**
Listens to `tauri://focus` on the main window. On focus, re-fetches full history from Rust to catch up with any events that may have been missed while the app was in the background.

### Screens

#### Clipboard Screen (`ClipboardScreen.tsx`)

The main history view. Entries are grouped by day ("Today", "Yesterday", "Mar 6") and sorted within each group.

**Features:**

- **Layout toggle**: Tiles (CSS grid, variable heights) or List (full-width rows). Persisted to `localStorage`.
- **Sort**: Newest, Oldest, A→Z, Z→A, Type. Persisted to `localStorage`.
- **Day groups**: Collapsible with animated transitions.
- **Toolbar**: Sort dropdown + layout toggle + clear-all button.
- **Empty state**: Placeholder with Ctrl+Shift+C hint.

#### Entry Card (`EntryCard.tsx`)

Renders a single `ClipboardEntry` with type-specific previews:

| Type                | Preview                                                                               |
| ------------------- | ------------------------------------------------------------------------------------- |
| Text                | Truncated content (160 chars)                                                         |
| Image               | `<img>` via `resolveImageSrc()` (asset protocol for file-backed, data-URL for inline) |
| File (single image) | Image preview loaded async via `get_image_file_preview`                               |
| File (single video) | `<video>` with controls                                                               |
| File (single other) | Filename only                                                                         |
| File (multiple)     | Thumbnail strip (up to 3 images) + "+N" badge, expandable file list                   |

**Interactions:**

- Click → copy to clipboard, 1.5s "Copied!" feedback.
- Right-click → context menu (Copy, Pin/Unpin, Save, Groups, Expand/Collapse, Delete) via `CardMenu`.
- Relative timestamps update every 15 seconds.
- **"In clipboard" indicator**: An accent-colored border and chip are shown on the entry that is currently in the OS clipboard. The `activeClipboardId` is tracked in `AppState` and pushed to the frontend via the `clipboard:active-id` event. Updated by `copy_entry`, `paste_entry`, clipboard watcher, and copy shortcut handler.

**Footer chip overflow**: The chip bar (type, pinned, saved, in-clipboard, user groups) uses `flex-wrap` for graceful line wrapping. A dynamic measurement algorithm calculates how many group chips fit on the first row and renders a "+N" overflow button for the rest. When all groups fit, no overflow button is shown.

**Cloud sync indicator** (Phase 6): A small cloud icon is shown on each card driven by `SyncStatus` in the entry:

- Filled cloud ✓ — `Synced` (server_id exists and up-to-date)
- Outline cloud — `Pending` (queued in sync_pending.json)
- No icon — `LocalOnly` (sync disabled or entry predates sync enrollment)

#### Settings Screen (`SettingsScreen.tsx`)

- **Paste slots**: How many entries shown in the paste popup (3–10, default 3). Persisted to `localStorage.sc-paste-slots`.
- **Persist history**: Save full clipboard history to disk (survives restarts). Stored in `settings.json`.
- **Close to tray**: Hide to system tray on close instead of quitting. Stored in `settings.json`.
- **Start minimized**: Launch hidden in tray. Stored in `settings.json`.
- **Notifications**: Master toggle + individual checkboxes for copy and paste notifications. Stored in `settings.json`.

**Cloud Sync section** (Phase 6 additions):

- **Enable Cloud Sync** toggle → calls `sync_set_enabled`
- **Server URL** input (default blank = official server; enter custom for self-hosted) → calls `sync_set_server_url`
- **Login / Logout** form → calls `sync_login` / `sync_logout`
- **Connected devices** list → fetched via `GET /api/v1/auth/devices`; shows current device highlighted
- **Sync status indicator**: Synced ✓ / Syncing… / Offline / Re-login required → driven by `sync_get_status`
- **Shared Groups** panel: list, create, invite link, leave → calls `sync_create_group`, `sync_join_group`, `sync_leave_group`
- **Live Share** panel (Phase 8): create a Live Share session (up to 5 members), invite by email, view member list with individual scopes, change own scope, leave session, end session (owner only). Driven by `sharing_invite`, `sharing_accept`, `sharing_get_sessions`, `sharing_update_scope`, `sharing_end_session`

#### Notes Screen (`NotesScreen.tsx`)

- **Rich-text editing**: Formatting toolbar with headings, lists, quotes, code, and inline styling.
- **Clipboard/group embeds**: Insert clipboard references and group tags into note content.
- **Auto-save**: Debounced save while typing plus flush-on-unmount behavior.
- **Pinning and groups**: Pin notes and assign shared group tags.
- **Filtering**: Search and filter notes by query, groups, date range, and pin state.
- **Bulk actions**: Multi-select delete/pin/group operations.

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

| Component           | Purpose                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sidebar`           | Navigation (4 screens) + theme toggle. Icon-based, fixed position.                                                                                                                        |
| `StatusPill`        | "N text · M img · K files · X total" summary bar.                                                                                                                                         |
| `CardMenu`          | Right-click context menu (Copy, Pin/Unpin, Save, Groups, Expand/Collapse, Delete). Portal to body. Uses direct DOM positioning in `useLayoutEffect` to avoid first-render flash at (0,0). |
| `ToastNotification` | Timed notification with progress bar + optional action (Undo).                                                                                                                            |
| `Notification`      | Small bottom-right toast showing "Copied" or "Pasted" with dynamic icon. Separate webview window.                                                                                         |
| `TooltipPortal`     | CSS-driven tooltips via `data-tooltip` attributes.                                                                                                                                        |
| `WindowControls`    | Frameless window buttons (minimize, maximize/restore, close).                                                                                                                             |

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
           set_active_clipboard_id(app, entry.id)
           emit("clipboard:new-entry")
           notify_if_enabled(app, entry)   ← copy notification
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
    set_active_clipboard_id(app, entry.id)
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
    set_active_clipboard_id(app, entry.id)
    spawn background thread:
        suppress = true
        write_entry_to_clipboard()
          ├─ Text: arboard with retry (6 attempts)
          ├─ Image (Win, file-backed): CF_HDROP (instant, no decode)
          ├─ Image (Win, data-URL): direct Win32 API (CF_DIB + PNG)
          ├─ Image (Linux): arboard set_image()
          └─ File: CF_HDROP
        wait 80ms
        simulate Ctrl+V (release modifiers first on Windows)
        notify_paste_if_enabled(app, entry)  ← paste notification
```

### Frontend State Sync

```
                    Rust Backend
                        │
            ┌───────────┼───────────┐
            ▼           ▼           ▼
     clipboard:    clipboard:    clipboard:
     new-entry    entry-deleted  active-id
            │           │           │
            ▼           ▼           ▼
     prepend to    filter out    update
     entries[]     by id         activeClipboardId
            │           │           │
            │           │           │
            │           ▼           │
            │     tauri://focus     │
            │     (main window)     │
            │           │           │
            │           ▼           │
            │      re-fetch         │
            │      get_history()    │
            │      merge with       │
            └───────existing────────┘
                        ▼
                  React re-render
```

### Cloud Sync — Push (Local Capture → Server)

```
capture_clipboard_change() → history.push(entry)
         │
         └──► SyncClient.on_new_entry(entry)   [background runtime]
                    │
                    ├─ crypto::encrypt(UMK, content, aad=client_id)
                    ├─ crypto::encrypt(UMK, metadata_json, aad=client_id)
                    │
                    ├─ online? ──► POST /api/v1/sync/push [entry]
                    │              Server assigns server_ts
                    │              Server publishes to Redis
                    │              Response: { server_id, server_ts }
                    │              Update id_map.json, set sync_status=Synced
                    │
                    └─ offline? ─► append to sync_pending.json
                                  sync_status stays Pending
```

### Cloud Sync — Pull (Server → Local)

```
On startup / reconnect:
  GET /api/v1/sync/pull?after_ts={last_cursor}&limit=200
         │
         ▼ (for each entry in response)
  crypto::decrypt(UMK, encrypted_content, aad=client_id) → plaintext
  crypto::decrypt(UMK, encrypted_metadata) → { groups, label, pinned }
         │
         ├─ client_id already in local store?
         │     └─ Yes → compare server_ts; apply if newer (LWW)
         │     └─ No  → insert as new entry
         │              assign local id, record in id_map.json
         │
         ├─ emit clipboard:new-entry (or notes:updated) → React re-render
         └─ POST /api/v1/sync/cursor { last_server_ts }

Repeat until next_cursor = null
```

### Cloud Sync — Realtime (WebSocket → Local)

```
WebSocket message received:
  { "event": "sync:entry", "payload": { ...encrypted_entry } }
         │
         ▼
  Same as Pull path above for the single entry
  (skip if entry originated from this device_id)

  { "event": "sync:delete", "payload": { "server_id": "...", "deleted_at": T } }
         │
         ▼
  Find entry by server_id in id_map.json → local id
  history.remove(local_id)
  emit clipboard:entry-deleted → React removes from state
```

---

## Persistence & Storage

### Binary Persistence Format

History and pinned entries use a **MessagePack binary format** for fast, compact disk storage:

1. **Metadata** (`history.bin`, `pinned_entries.bin`) — Entry metadata serialized with **MessagePack** (`rmp-serde`) and written directly to disk (no compression). Image entries store an absolute file path instead of inline base64 data.
2. **Image store** (`images/`) — Raw image bytes (PNG, JPEG, WebP, etc.) written to individual files named `{id}_{label}.{ext}`. On `push()`, data-URL images are immediately externalised to this directory, keeping in-memory footprint small.
3. **On load** — File-path image entries are served to the frontend via Tauri's `convertFileSrc()` asset protocol. Old inline data-URLs from previous sessions are automatically externalised on load.
4. **Orphan cleanup** — `save_all_to_file` removes image files in `images/` that no longer correspond to any history entry.

### Storage Locations

| What               | Location                               | Format                                                           | When Saved               | When Loaded        |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------- | ------------------------ | ------------------ |
| Pinned entries     | `{app_data}/pinned_entries.bin`        | MessagePack binary                                               | On pin/unpin/groups      | On startup         |
| Full history       | `{app_data}/history.bin`               | MessagePack binary                                               | Every 2s when dirty      | On startup         |
| Image files        | `{app_data}/images/{id}_{label}.{ext}` | Raw binary image bytes (PNG/JPEG/WebP/etc.)                      | On push to history       | Via asset protocol |
| Settings           | `{app_data}/settings.json`             | JSON object `{ key: value }`                                     | On `set_setting`         | On startup         |
| Notes              | `{app_data}/notes.bin`                 | MessagePack binary                                               | Every 2s when dirty      | On startup         |
| Boot ID            | `{app_data}/boot_id.txt`               | Plain text (boot epoch seconds)                                  | On startup               | On startup         |
| Window geometry    | `{app_data}/window-state.json`         | `{ x, y, width, height, maximized }`                             | On every move/resize     | On startup         |
| Theme preference   | `localStorage.sc-theme`                | `"dark"` or `"light"`                                            | On toggle                | On mount           |
| Layout preference  | `localStorage.sc-layout`               | `"tiles"` or `"list"`                                            | On change                | On mount           |
| Sort preference    | `localStorage.sc-sort`                 | `"newest"` / `"oldest"` / `"a-z"` / `"z-a"` / `"type"`           | On change                | On mount           |
| Paste slot count   | `localStorage.sc-paste-slots`          | `"3"` – `"10"`                                                   | On change                | On popup show      |
| Group names        | `localStorage.sc-groups`               | JSON string array                                                | On group edits           | On mount           |
| Group colors       | `localStorage.sc-group-colors`         | JSON object (`group -> palette index`)                           | On color change          | On mount           |
| Recent searches    | `localStorage.sc-recent-searches`      | JSON string array (max 8)                                        | On search                | On mount           |
| Sync state         | `{app_data}/sync_state.json`           | `{ last_server_ts, device_id, user_id }`                         | After each pull          | On sync init       |
| Sync offline queue | `{app_data}/sync_pending.json`         | JSON array of pending push/delete/update ops (encrypted content) | On mutation when offline | On reconnect       |
| ID mapping         | `{app_data}/id_map.json`               | `{ "clipboard:42": "server-uuid", "note:7": "..." }`             | After each push          | On sync init       |

**Note**: When `persist_history` is disabled (default), unpinned clipboard history is in-memory only and lost on app restart. Only pinned entries survive. When enabled via Settings, the full history is flushed to `history.bin` every 2 seconds.

**Sync note**: `sync_pending.json` and `id_map.json` are safe to delete — loss triggers a re-sync (duplicate entries are deduped on next push). `sync_state.json` loss causes a full re-pull from the server on next startup.

---

## Tauri Configuration & Permissions

### Windows (tauri.conf.json)

| Window       | Size    | Properties                                                                                              |
| ------------ | ------- | ------------------------------------------------------------------------------------------------------- |
| main         | 920×560 | Resizable (min 640×440), frameless, initially hidden (shown by window-state restore), dark bg `#0e0e0e` |
| copy-popup   | 340×260 | Frameless, transparent, no shadow, always-on-top, skip taskbar, not resizable                           |
| paste-popup  | 340×460 | Same as copy-popup                                                                                      |
| notification | 220×72  | Same as copy-popup, plus `ignore_cursor_events`, positioned at bottom-right of screen                   |

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

---

## Cross-System Invariants

The following constraints span both this app and the backend. Violating any of them breaks either correctness, security, or the offline-first guarantee. The canonical list lives in `docs/ARCHITECTURE.md` (workspace root, §13); this is the app-side view.

| #   | Invariant                                      | App-side implication                                                                                                                                                |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Local store is always plaintext**            | `history.bin` and `notes.bin` must never be encrypted. Encryption boundary = network only.                                                                          |
| 2   | **Sync is always optional**                    | App boots and operates fully without `SyncClient` initialized. `sync_client: None` is a valid steady state.                                                         |
| 3   | **Server never sees plaintext**                | `crypto::encrypt` must be called before any data leaves the process. The `client.rs` HTTP methods only accept pre-encrypted `SyncEntry` structs.                    |
| 4   | **UMK never leaves the device**                | `derive_umk()` output is stored only in `SyncClient`'s memory field. Never written to any file, log, or IPC response. Cleared on `sync_logout()` or app exit.       |
| 5   | **Tombstones always propagate**                | `delete_entry` command must call `SyncClient.on_delete_entry(id)` even when offline. The delete must be queued in `sync_pending.json`.                              |
| 6   | **Capture pipeline is untouched**              | `clipboard_watcher.rs` and `hotkeys.rs` must not have sync logic. The `on_new_entry` call happens after `history.push()`, as a post-commit side-effect.             |
| 7   | **Suppress flag is respected**                 | `SyncClient.on_new_entry` must only be called when a genuine new entry is inserted, not on suppress-skipped polls.                                                  |
| 8   | **Sync runtime never blocks the main runtime** | All `SyncClient` methods are `async` and run in the dedicated background Tokio runtime. Use `Handle::current().spawn()` — never `block_on` from the Tauri runtime.  |
| 9   | **Cursor advances only on confirmed merge**    | `POST /sync/cursor` is sent only after the pulled entry is successfully decrypted and inserted into the local store.                                                |
| 10  | **ID mapping must survive restarts**           | `id_map.json` is flushed synchronously after each successful push response. A crash between push and flush is recoverable — the server deduplicates by `client_id`. |
| 11  | **Sharing is always opt-in**                   | No entry gets a sharing Live Share group UUID unless the user has an active session and the entry type matches their `share_scope`. Never auto-tag on sync re-enroll.      |
| 12  | **File/video sync is size-gated**              | `kind: 'file'` entries exceeding 5 MB total must never be pushed. Emit `sync:file-skipped` to the UI; do not silently drop.                                        |
| 13  | **Ending a sharing session is clean**          | `sharing_end_session` must remove the Live Share group UUID from `id_map.json` and in-memory `sharing_sessions` before returning. Future captures must not be tagged.     |

---

## TODO — Implementation Checklist

Tracks all client-side work not yet implemented. Organized by phase matching the backend sequencing (see `orange-copy-paste-clipboard-backend/docs/ARCHITECTURE.md §13`).

---

### Phase 6 — Cloud Sync (Rust module + React UI)

#### Rust: new module `src-tauri/src/sync/`

- [ ] Create `sync/mod.rs` — `SyncClient` struct, background Tokio runtime init, `Option<Arc<SyncClient>>` in `AppState`
- [ ] Create `sync/crypto.rs` — `derive_umk`, `encrypt`, `decrypt`, `generate_x25519_keypair`, `x25519_shared_secret`, `wrap_key`, `unwrap_key`
- [ ] Create `sync/client.rs` — `reqwest` HTTP client, base URL config, `Authorization` header injection, automatic 401 → token refresh → retry
- [ ] Create `sync/ws_listener.rs` — `tokio-tungstenite` WebSocket connection, reconnect backoff, dispatch table for all `sync:*`, `device:*`, `group:*` events
- [ ] Create `sync/pending_queue.rs` — read/write `{app_data}/sync_pending.json`; operations: `push`, `delete`, `update`; flush-in-order on reconnect
- [ ] Create `sync/commands.rs` — register all sync Tauri commands (see list below)
- [ ] Create `sync/config.rs` — read/write `sync_enabled` and `sync_server_url` from `settings.json`

#### Rust: Cargo.toml additions

- [ ] `reqwest = { features = ["json", "rustls-tls"] }`  # do not pin; use Cargo to resolve latest compatible
- [ ] `tokio-tungstenite = { features = ["rustls-tls-webpki-roots"] }`  # do not pin
- [ ] `argon2`  # do not pin; use latest
- [ ] `aes-gcm`  # do not pin; use latest
- [ ] `x25519-dalek`  # do not pin; use latest
- [ ] `keyring`  # do not pin; use latest

#### Rust: integration into existing files

- [ ] `state/app_state.rs` — add `sync_client: Option<Arc<SyncClient>>`
- [ ] `clipboard/history.rs` — add transient fields `server_id: Option<String>` and `sync_status: SyncStatus` to `ClipboardEntry` (skip serialization to `history.bin`)
- [ ] `notes/store.rs` — same transient fields on `Note`
- [ ] `clipboard/commands.rs` — call `SyncClient.on_new_entry(entry)` after every successful `history.push()`
- [ ] `clipboard/commands.rs` — call `SyncClient.on_delete_entry(id)` from `delete_entry` and `clear_history`
- [ ] `clipboard/commands.rs` — call `SyncClient.on_update_entry(entry)` from `pin_entry`, `unpin_entry`, `set_entry_groups`, bulk mutations
- [ ] `notes/commands.rs` — call `SyncClient.on_new_entry` / `on_update_entry` / `on_delete_entry` from note CRUD commands
- [ ] `lib.rs` — register sync commands; initialize `SyncClient` in `setup()` if `sync_enabled`

#### Rust: sync Tauri commands to implement

- [ ] `sync_login(email, password, device_name) → Result<SyncUser>`
- [ ] `sync_logout() → ()`
- [ ] `sync_get_user() → Option<SyncUser>`
- [ ] `sync_get_status() → SyncStatus` — `{ connected, last_synced_at, pending_count, skipped_count }`
- [ ] `sync_now() → ()`
- [ ] `sync_set_enabled(enabled: bool) → ()`
- [ ] `sync_set_server_url(url: String) → ()`
- [ ] `sync_get_groups() → Vec<SyncGroup>`
- [ ] `sync_create_group(name: String) → SyncGroup`
- [ ] `sync_join_group(invite_code: String) → ()`
- [ ] `sync_leave_group(group_id: String) → ()`

#### Rust: persistence files to implement

- [ ] `{app_data}/id_map.json` — read/write `{ entries: { client_id → server_uuid }, groups: { name → server_uuid } }`
- [ ] `{app_data}/sync_state.json` — read/write `{ last_server_ts, device_id, user_id }`
- [ ] `{app_data}/sync_pending.json` — managed by `pending_queue.rs` (already listed above)

#### React: App.tsx event wiring

- [ ] Listen for `sync:entry` Tauri event → decrypt (via invoke) → prepend to `entries[]` state
- [ ] Listen for `sync:note` Tauri event → merge into `notes[]` state
- [ ] Listen for `sync:status-changed` Tauri event → update sync status indicator

#### React: Settings screen — Cloud Sync section

- [ ] Enable/disable Cloud Sync toggle → `sync_set_enabled`
- [ ] Server URL input field → `sync_set_server_url`
- [ ] Login form (email + password) → `sync_login`
- [ ] Logout button → `sync_logout`
- [ ] Logged-in user display (email, display name)
- [ ] Connected devices list (fetched from backend) with current device highlighted and revoke button
- [ ] Sync status indicator: `Synced ✓` / `Syncing…` / `Offline` / `Re-login required` — driven by `sync_get_status`
- [ ] Shared Groups sub-panel: list joined groups, create new group, copy invite link, leave group

#### React: Entry card

- [ ] Cloud sync icon on each card: filled cloud ✓ (`Synced`) / outline cloud (`Pending`) / no icon (`LocalOnly`)

---

### Phase 7 — File & Video Sync (5 MB gate)

#### Rust: `sync/client.rs` or `sync/mod.rs`

- [ ] In `on_new_entry`: if `entry.kind == File`, read each file path from `entry.content` (newline-delimited)
- [ ] Sum file sizes; if total > 5 MB → emit `sync:file-skipped` Tauri event, increment `skipped_count`, return early (do not push)
- [ ] If within limit → for each file: `POST /blobs/request-upload` → PUT bytes to pre-signed R2 URL → `POST /blobs/confirm-upload`
- [ ] Build `encrypted_content` = `encrypt(UMK, JSON([{ filename, mime_type, size_bytes, blob_key }, ...]), aad=client_id)`
- [ ] Set `blob_key` on push payload to the first file's key

#### Rust: `ws_listener.rs` / pull handler

- [ ] On receiving a `kind: 'file'` entry from pull or WebSocket: for each `blob_key` in decrypted content list → `GET /blobs/{key}/download-url` → download to `{app_data}/sync-downloads/{filename}`
- [ ] Update local `entry.content` to the downloaded local file paths

#### React

- [ ] Listen for `sync:file-skipped` Tauri event → show dismissible notification in sync status area ("File too large to sync — must be under 5 MB")

---

### Phase 8 — Live Share

#### Rust: `SyncClient` additions

- [ ] Add `sharing_sessions: Vec<SharingSession>` field (loaded from `id_map.json` on init)
- [ ] `SharingSession` struct: `{ share_group_id, group_key: [u8; 32], my_scope, members: Vec<SessionMember> }`

#### Rust: sync Tauri commands to implement

- [ ] `sharing_invite(email: String, scope: String) → Result<SharingInvite>` — `POST /sharing` then `POST /sharing/{id}/invite`
- [ ] `sharing_accept(invite_code: String, scope: String) → Result<()>` — `POST /sharing/join`; derive shared secret; wrap Group Key; store GK in session
- [ ] `sharing_get_sessions() → Vec<SharingSession>`
- [ ] `sharing_update_scope(share_group_id: String, scope: String) → ()` — `PATCH /sharing/sessions/{id}/scope`
- [ ] `sharing_end_session(share_group_id: String) → ()` — `DELETE /sharing/sessions/{id}`; remove from `id_map.json`
- [ ] `sharing_leave_session(share_group_id: String) → ()` — `DELETE /sharing/sessions/{id}/leave`; remove from local session list

#### Rust: `on_new_entry` Live Share fan-out

- [ ] After pushing a new entry: for each active `SharingSession` where `my_scope` matches `entry.entry_type`
  - [ ] Re-encrypt `encrypted_content` with the session's `group_key` (GK) instead of UMK
  - [ ] Append `share_group_id` to `entry.group_ids`
  - [ ] Push the group-scoped copy to the server

#### Rust: `ws_listener.rs` — Live Share WS events

- [ ] `sharing:invite` → emit `sharing:invite-received` Tauri event to React (for invite notification UI)
- [ ] `sharing:accepted` → decrypt `wrapped_group_key` using own X25519 private key; store GK in `sharing_sessions`; persist to `id_map.json`
- [ ] `sharing:ended` → remove session from `sharing_sessions`; remove `share_group_id` from `id_map.json`
- [ ] `sharing:member_left` → update `session.members` list
- [ ] `sharing:scope_changed` → update the relevant member's scope in `session.members`

#### React: Settings screen — Live Share panel

- [ ] Create Live Share button → `sharing_invite` (opens invite form)
- [ ] Invite form: email field + scope selector (`clipboard` / `notes` / `both`) → `sharing_invite`
- [ ] Active sessions list: session name, member list (display name + their scope + online indicator)
- [ ] Own scope selector per session → `sharing_update_scope`
- [ ] Leave session button (non-owner) → `sharing_leave_session`
- [ ] End session button (owner only) → `sharing_end_session`
- [ ] Incoming invite notification (driven by `sharing:invite-received` Tauri event): accept/decline with scope selection → `sharing_accept`
