# Smart Clipboard (Tauri + React + Rust)

Smart Clipboard is a desktop clipboard manager built with:

- **Frontend:** React + TypeScript + Vite
- **Backend:** Rust + Tauri 2
- **Target platform:** Windows-first (global hotkeys and clipboard integrations are implemented for Windows)

It captures copied text/images/files into history, shows quick popups near the cursor, and supports fast paste actions from recent clipboard entries.

---

## Features

- **Global shortcuts:**
  - `Ctrl + Shift + C` → capture current selection into history and show copy popup
  - `Ctrl + Shift + V` → show recent history popup for quick paste
- **Clipboard history** with support for:
  - Text entries
  - Image entries (stored as data URLs)
  - File entries (single and multiple files)
  - Multiple image files (with thumbnail previews)
  - Video files (with custom in-card player — play/pause, seek, mute only)
- **Clipboard screen:**
  - **Day-grouped timeline** — entries grouped by date with collapsible day sections and dot-rail navigation
  - Masonry-style card grid (Pinterest-like layout) and list layout — toggle persisted to `localStorage`
  - **Sort controls** — sort dropdown with: Newest, Oldest, A → Z, Z → A, Type (text/file/image); sort persisted to `localStorage`
  - Click any card to copy it back to clipboard
  - **Pin entries** — pin important entries so they survive clear-all; visual "Pinned" chip on pinned cards
  - Type chip (Text / Image / File / Files / Images) acts as expand toggle for multi-file entries
  - Compact preview of multi-file entries (first 3 names + count)
  - Full expanded file list with per-file thumbnails
  - Relative timestamp shown in card footer, refreshed every 15 s
  - Subtle "Copied" and "Pinned" feedback animations on cards
  - Right-click context menu (CardMenu) per entry: copy, pin/unpin, delete
  - Search/filter screen to filter text entries by content
  - **Clear all** button with 5-second undo toast — pinned entries are preserved
  - Duplicate suppression — copying from history does not re-add the entry
- **Video player (custom):**
  - Replaces native browser controls to remove unwanted menu items (Download, PiP, Playback speed)
  - Controls overlay (play/pause, seek bar, mute) appears on hover
  - Right-click context menu suppressed on the video element
- **Paste popup** (`Ctrl + Shift + V`):
  - Shows 5 most recent entries
  - Closes on focus loss (blur) or close button
  - Syncs with main app's dark/light theme
- **Cursor popup** (after `Ctrl + Shift + C`):
  - Shows what was just captured
  - Closes on focus loss
  - Syncs with main app's dark/light theme
- **Popup screen-boundary clamping** — popups never render off-screen or clipped at monitor edges
- **Settings screen** (placeholder, to be filled)
- **Shortcuts screen** — documents all app shortcuts and interactions
- **Status pill** — bottom-right Obsidian-style bar showing text / image / file / total counts
- **Dark & Light mode** — toggle persisted to `localStorage`, shared across main window and popups; follows OS preference automatically when no manual override is set
- **IPC command surface** exposed to frontend via Tauri `invoke`

---

## Tech Stack

- **UI:** React 19, TypeScript 5, Vite 7
- **Desktop runtime:** Tauri 2
- **Rust crates:**
  - `tauri-plugin-global-shortcut` for global hotkeys
  - `arboard` for clipboard text/image access
  - `image` + `base64` for image encode/decode and data URL conversion
  - `parking_lot` for efficient shared mutex state
  - `windows-sys` for Windows input/cursor/monitor and clipboard format helpers

---

## Prerequisites

- **Node/Bun toolchain** (project uses `bun` as package manager)
- **Rust toolchain** (stable)
- **Tauri prerequisites** for your OS (WebView2 on Windows, etc.)

Recommended VS Code extensions:

- Tauri
- rust-analyzer

---

## Getting Started

From project root:

```bash
bun install
```

Run frontend only:

```bash
bun run dev
```

Run desktop app (Tauri + frontend):

```bash
bun run tauri dev
```

Build frontend:

```bash
bun run build
```

Build desktop bundle:

```bash
bun run tauri build
```

Backend compile check:

```bash
cd src-tauri
cargo check
```

---

## Module Design (Backend)

The backend is organized by **feature/domain**, not by technical layer alone.

### 1) `clipboard` module (clipboard domain)

- `history.rs`: in-memory clipboard history model and operations
- `image.rs`: image clipboard format handling + data URL conversion
- `files.rs`: Windows `CF_HDROP` read/write for single and multiple file paths
- `commands.rs`: Tauri IPC commands for clipboard actions (get/delete/clear/copy/paste/pin/unpin) and clipboard read/write helpers

### 2) `runtime` module (OS/runtime integrations)

- `hotkeys.rs`: global hotkey registration and handlers
- `platform.rs` + `platform_windows.rs`: platform-specific OS interaction (simulate copy/paste, cursor position, monitor work area, screen-boundary clamping)
- `popup_windows.rs`: popup window creation, positioning helpers, screen-edge clamping, popup hide utilities
- `commands.rs`: runtime-oriented IPC commands (close popup windows)

### 3) `state` module (shared app state)

- `app_state.rs`: `AppState` managed by Tauri — includes shared history and `suppress_next_capture` atomic flag
- `popup_state.rs`: popup constants and payload types used for emitted events

### 4) `lib.rs` (composition root)

`src-tauri/src/lib.rs` wires all modules:

- Creates shared history state and suppress flag
- Registers plugins and invoke handlers
- Sets up popup windows and hotkeys during app setup

---

## Frontend Component Structure

```text
src/components/
├─ app/                          ← main window
│  ├─ App.tsx                    ← root state, layout, screen routing, theme
│  ├─ App.css                    ← global CSS variables (dark/light), layout
│  ├─ clipboard-screen/
│  │  ├─ ClipboardScreen.tsx     ← day-grouped timeline, sort controls, layout toggle, clear-all
│  │  ├─ ClipboardScreen.css
│  │  └─ entry-card/
│  │     ├─ EntryCard.tsx        ← per-entry card (text/image/file/video previews, chips, footer)
│  │     ├─ EntryCard.css
│  │     └─ VideoPlayer.tsx      ← custom video player (play/pause, seek, mute; no native controls)
│  ├─ search-screen/
│  │  ├─ SearchScreen.tsx        ← full-text search/filter across history
│  │  └─ SearchScreen.css
│  ├─ settings-screen/
│  │  ├─ SettingsScreen.tsx      ← placeholder
│  │  └─ SettingsScreen.css
│  ├─ shortcuts-screen/
│  │  ├─ ShortcutsScreen.tsx     ← shortcut reference docs
│  │  └─ ShortcutsScreen.css
│  ├─ sidebar/
│  │  ├─ Sidebar.tsx             ← nav, theme toggle, settings button
│  │  └─ Sidebar.css
│  ├─ status-pill/
│  │  ├─ StatusPill.tsx          ← entry type counts bar
│  │  └─ StatusPill.css
│  ├─ card-menu/
│  │  ├─ CardMenu.tsx            ← right-click context menu (copy/pin/delete)
│  │  └─ CardMenu.css
│  └─ toast/
│     └─ ToastNotification.tsx   ← undo toast for clear-all
├─ cursor-popup/                 ← standalone OS window
│  ├─ CursorPopup.tsx
│  ├─ cursor-popup.html
│  └─ popup.css
└─ paste-popup/                  ← standalone OS window
   ├─ PastePopup.tsx
   ├─ paste-popup.html
   └─ pastePopup.css
```

---

## Current Project Structure

```text
notrover-smart-clipboard-app-rust/
├─ src/
│  ├─ components/
│  │  ├─ app/
│  │  ├─ cursor-popup/
│  │  └─ paste-popup/
│  ├─ types.ts
│  └─ assets/
├─ src-tauri/
│  ├─ src/
│  │  ├─ lib.rs
│  │  ├─ main.rs
│  │  ├─ clipboard/
│  │  │  ├─ mod.rs
│  │  │  ├─ commands.rs
│  │  │  ├─ files.rs
│  │  │  ├─ history.rs
│  │  │  └─ image.rs
│  │  ├─ runtime/
│  │  │  ├─ mod.rs
│  │  │  ├─ commands.rs
│  │  │  ├─ hotkeys.rs
│  │  │  ├─ platform.rs
│  │  │  ├─ platform_windows.rs
│  │  │  └─ popup_windows.rs
│  │  └─ state/
│  │     ├─ mod.rs
│  │     ├─ app_state.rs
│  │     └─ popup_state.rs
│  ├─ Cargo.toml
│  └─ tauri.conf.json
├─ package.json
└─ README.md
```

---

## Hotkeys and Runtime Flow

**Copy flow:**

1. User presses `Ctrl+Shift+C`
2. Runtime simulates `Ctrl+C`, reads clipboard (text → files → image)
3. New entry is pushed to history; `clipboard:new-entry` event emitted to main window and cursor popup
4. Cursor popup appears near the cursor showing what was captured

**Paste flow:**

1. User presses `Ctrl+Shift+V`
2. Paste popup appears near cursor with the 5 most recent entries
3. Selecting an entry: sets `suppress_next_capture` flag, writes to clipboard, hides popup, simulates `Ctrl+V`
4. Clipboard watcher sees the suppress flag and skips re-adding the entry to history

**Suppress flag** (`Arc<AtomicBool>` in `AppState`):

- Set by `copy_entry` and `paste_entry` commands before writing to clipboard
- Checked by the clipboard watcher before recording a new capture
- Prevents duplicate entries when copying from within the app

---

## localStorage Keys

| Key         | Values                                                     | Purpose                      |
| ----------- | ---------------------------------------------------------- | ---------------------------- |
| `sc-theme`  | `"dark"` \| `"light"`                                      | User's manual theme override |
| `sc-layout` | `"masonry"` \| `"list"`                                    | Clipboard screen layout mode |
| `sc-sort`   | `"newest"` \| `"oldest"` \| `"a-z"` \| `"z-a"` \| `"type"` | Active sort order            |

---

## Notes

- The app is Windows-first; clipboard file support (`CF_HDROP`), cursor position, and monitor work area all use `windows-sys` directly.
- Popup windows use `transparent: true` + `decorations: false` + `shadow: false` with a CSS-padded body to achieve clean rounded corners without OS border artifacts.
- Theme (`dark`/`light`) is stored in `localStorage` under `sc-theme` and read by both popup windows on focus; falls back to the OS `prefers-color-scheme` media query when no manual override is set.
- Release profile in `src-tauri/Cargo.toml` is optimized for smaller binaries (`opt-level = "z"`, `lto`, `strip`).
- The custom `VideoPlayer` component deliberately suppresses the native browser context menu on `<video>` to avoid exposing Download, Picture-in-Picture, and Playback speed controls that don't belong in a clipboard manager.
