# Smart Clipboard (Tauri + React + Rust)

Smart Clipboard is a desktop clipboard manager built with:

- **Frontend:** React + TypeScript + Vite
- **Backend:** Rust + Tauri 2
- **Target platforms:** Windows and Linux (X11 recommended; see [Linux support](#linux-support) for Wayland caveats and feature parity)

It captures copied text/images/files into history, shows quick popups near the cursor, and supports fast paste actions from recent clipboard entries.

---

## Features

- **Global shortcuts:**
  - `Ctrl + Shift + C` → capture current selection into history and show copy popup
  - `Ctrl + Shift + V` → show recent history popup for quick paste
- **Clipboard history** with support for:
  - Text entries
  - Image entries (stored as raw binary files on disk, served via Tauri asset protocol)
  - File entries (single and multiple files)
  - Multiple image files (with thumbnail previews)
  - Video files (with custom in-card player — play/pause, seek, mute only)
- **Clipboard screen:**
  - **Day-grouped timeline** — entries grouped by date with collapsible day sections and dot-rail navigation
  - Tiles card grid (Pinterest-like layout) and list layout — toggle persisted to `localStorage`
  - **Sort controls** — sort dropdown with: Newest, Oldest, A → Z, Z → A, Type (text/file/image); sort persisted to `localStorage`
  - **Search & filter panel** — search by content and filter by type/date/groups (with active filter count)
  - **Group manager** — create, rename, recolor, and delete user groups; system groups (`Pinned`, `Saved`) are protected
  - **Bulk selection mode** — bulk delete, bulk pin/unpin, and bulk group operations
  - Click any card to copy it back to clipboard
  - **Pin entries** — pin important entries so they survive clear-all; visual "Pinned" chip on pinned cards
  - **Active clipboard indicator** — chip + accent border marks the entry currently in the OS clipboard
  - Type chip (Text / Image / File / Files / Images) acts as expand toggle for multi-file entries
  - Compact preview of multi-file entries (first 3 names + count)
  - Full expanded file list with per-file thumbnails
  - Relative timestamp shown in card footer, refreshed every 15 s
  - Subtle "Copied" and "Pinned" feedback animations on cards
  - Right-click context menu (CardMenu) per entry: copy, pin/unpin, delete
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
- **Notes screen**:
  - **Dual-mode editor** — switch between a rich (WYSIWYG) Tiptap surface and a raw Markdown textarea; markdown is the source of truth and round-trips losslessly between modes
  - **Markdown preview** for note cards and read-only views (markdown-it + remark-gfm + sanitized HTML)
  - **Full formatting toolbar** working in both modes: headings, bold/italic/strike/code, bullet/ordered/task lists, blockquote, code block, link, horizontal rule, table, text color, highlight, alignment, image, clipboard embed, group reference
  - **Attachments persisted to disk** — pasted/dropped images and picked files are saved to a per-app attachments folder; references in the markdown source use clean custom schemes (`note-attachment://filename`, `note-file://filename`) and are resolved to Tauri asset URLs only at render time
  - **Native textarea undo** preserved in markdown mode via minimal-diff `execCommand("insertText")` edits
  - **Indentation handling** — Tab/Shift-Tab sinks/lifts list items or inserts/removes 4-space indents; non-list indentation is normalized to non-breaking spaces so markdown doesn't reinterpret it
  - Block-image spacing normalization so images inserted next to text don't fuse into the same paragraph on round-trip
  - Pin/unpin and group tagging
  - Search/filter and bulk actions
- **Settings screen**:
  - Paste popup entry count (3–10)
  - Persist history, close-to-tray, and start-minimized toggles
  - Notification master toggle and per-action toggles (`notif_copy`, `notif_paste`)
  - Autosave toggle to auto-tag new entries with the `Saved` group
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
  - `rmp-serde` for binary persistence (MessagePack)
  - `parking_lot` for efficient shared mutex state
  - `windows-sys` (Windows only) for input/cursor/monitor and clipboard format helpers; Linux uses `xdotool`/`wtype`/`xdpyinfo` via `runtime/platform/linux.rs`
  - `keyring` for OS credential storage (Windows Credential Manager / Linux Secret Service)

---

## Prerequisites

- **Node/Bun toolchain** (project uses `bun` as package manager)
- **Rust toolchain** (stable)
- **Tauri prerequisites** for your OS (WebView2 on Windows, the GTK/WebKitGTK stack on Linux — see below)

Recommended VS Code extensions:

- Tauri
- rust-analyzer

---

## Linux support

The app builds and runs on Linux. All Windows-only integrations (Win32 clipboard
formats, cursor/monitor queries, keystroke injection) are compiled out and
replaced with Linux equivalents, so the same source tree targets both platforms.

### Build prerequisites (Debian/Ubuntu)

Install the standard Tauri v2 Linux toolchain before `bun run tauri build`:

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

(Fedora/Arch have equivalent packages — see the Tauri v2 prerequisites docs.)

### Runtime dependencies

Keystroke injection and cursor/monitor placement shell out to small,
widely-available utilities. Injection uses a **capability ladder** — the app
detects the session and tries the best-available tool, falling back only when
one is missing or fails, so a single binary works across X11 and Wayland:

| Tool | Purpose | When needed |
|------|---------|-------------|
| `xdotool` | Ctrl+C/Ctrl+V injection, cursor position | X11 (and XWayland) sessions |
| `wtype` | Ctrl+C/Ctrl+V injection | Wayland on wlroots compositors (Sway, Hyprland, River) |
| `ydotool` (+ `ydotoold`) | Ctrl+C/Ctrl+V injection fallback | Wayland on GNOME/KDE, where `wtype` is blocked — needs the daemon running and uinput access |
| `x11-utils` (`xdpyinfo`) | Monitor work-area geometry | X11 (optional; falls back to 1920×1080) |
| `xdg-utils` (`xdg-open`) | "Open data folder" | all |
| A Secret Service provider (GNOME Keyring / KWallet) | Stores sync device keys & refresh tokens | only when cloud sync is used |
| A system-tray host (e.g. GNOME AppIndicator extension) | Tray icon & menu | for the tray |

The `.deb` **depends** on `xdotool | wtype` (at least one injector) and
**recommends** `x11-utils` and `ydotool`. On GNOME/KDE Wayland, install and
enable `ydotool` for working paste injection:

```bash
sudo apt install -y ydotool          # provides ydotool + ydotoold
sudo systemctl enable --now ydotool  # or run `ydotoold` in your session
# ensure your user can access /dev/uinput (a udev rule or the input group)
```

### Packaging

`bun run tauri build` produces `.deb`, `.rpm`, and AppImage bundles on Linux
(and the NSIS installer on Windows) — `bundle.targets` lists all four and Tauri
builds only the ones valid for the host.

### Known limitations on Linux

These degrade gracefully (no crash) but are not yet at Windows parity:

- **Wayland:** keystroke injection works via the ladder above (`wtype` on
  wlroots, `ydotool` on GNOME/KDE). What remains compositor-dependent — because
  Wayland forbids clients from reading the global cursor or positioning their
  own windows, and the global-shortcut plugin still relies on X11 grabs — is:
  **cursor-anchored popup placement, global hotkeys, always-on-top, and window
  transparency.** For the full cursor-popup + global-hotkey experience, **X11 is
  recommended.**
- **File-list clipboard:** copying **File** entries (and file-backed images) back
  to the clipboard is Windows-only; on Linux the write returns an error
  (`text/uri-list` support is not implemented yet).
- **HTML clipboard:** rich-HTML entries are not written to the Linux clipboard
  yet (plain-text/image entries work via `arboard`).
- **Clipboard capture:** file-drops and HTML sources are not captured into
  history on Linux (text and images are).
- **Image labels:** auto-generated image labels show a raw timestamp instead of a
  localized date/time.

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

- `history.rs`: in-memory clipboard history model, operations, and binary persistence (image files + MessagePack)
- `image.rs`: image clipboard format handling + data URL conversion
- `files.rs`: Windows `CF_HDROP` read/write for single and multiple file paths
- `html.rs`: CF_HTML rich text clipboard read/write
- `commands.rs`: Tauri IPC commands for clipboard actions (get/delete/clear/copy/paste/pin/unpin/groups/bulk) and clipboard read/write helpers

### 2) `runtime` module (OS/runtime integrations)

- `hotkeys.rs`: global hotkey registration and handlers
- `platform/` (`mod.rs`, `windows.rs`, `linux.rs`): platform-specific OS interaction (simulate copy/paste, cursor position, monitor work area, screen-boundary clamping)
- `popup_windows.rs`: popup window creation, positioning helpers, screen-edge clamping, popup hide utilities
- `notifications.rs`: copy/paste notification toast logic
- `tray.rs`: system tray icon and menu
- `window_state.rs`: saved window geometry (position/size persistence)
- `commands.rs`: runtime-oriented IPC commands (close/resize popups, autostart, open data folder)

### 3) `state` module (shared app state)

- `app_state.rs`: `AppState` managed by Tauri — includes shared history, suppress flag, notification toggles, active clipboard ID, and other setting caches
- `popup_state.rs`: popup constants and payload types used for emitted events

### 4) `notes` module (notes domain)

- `store.rs`: `Note` model, in-memory note store, MessagePack persistence (`notes.bin`)
- `commands.rs`: Tauri IPC commands for note CRUD, pinning, and group operations

### 5) `lib.rs` (composition root)

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
│  ├─ sort-options.tsx            ← sort dropdown options
│  ├─ clipboard-screen/
│  │  ├─ ClipboardScreen.tsx     ← day-grouped timeline, sort controls, layout toggle, clear-all
│  │  ├─ ClipboardScreen.css
│  │  ├─ bulk-actions/
│  │  ├─ group-manager/
│  │  ├─ search-filter/
│  │  ├─ topbar/
│  │  └─ entry-card/
│  │     ├─ EntryCard.tsx        ← per-entry card (text/image/file/video previews, chips, footer)
│  │     └─ EntryCard.css
│  ├─ notes-screen/
│  │  ├─ NotesScreen.tsx         ← note CRUD, rich text editor, embeds, groups, filters
│  │  └─ NotesScreen.css
│  ├─ settings-screen/
│  │  ├─ SettingsScreen.tsx      ← user preferences (persist history, notifications, close-to-tray)
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
│  │  ├─ CardMenu.tsx            ← right-click context menu (copy/pin/save/groups/delete)
│  │  └─ CardMenu.css
│  ├─ toast/
│  │  └─ ToastNotification.tsx   ← undo toast for clear-all
│  └─ tooltip/
│     └─ TooltipPortal.tsx       ← CSS-driven tooltip component
├─ copy-popup/                  ← standalone OS window
│  ├─ CopyPopup.tsx
│  ├─ copy-popup.html
│  └─ copyPopup.css
├─ notifications/               ← standalone OS window
│  ├─ Notification.tsx
│  ├─ notification.html
│  └─ notification.css
├─ entry-types/                 ← shared component
│  ├─ EntryTypePill.tsx
│  └─ entryTypes.css
└─ paste-popup/                 ← standalone OS window
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
│  │  ├─ copy-popup/
│  │  ├─ notifications/
│  │  ├─ entry-types/
│  │  └─ paste-popup/
│  ├─ hooks/
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
│  │  │  ├─ html.rs
│  │  │  └─ image.rs
│  │  ├─ runtime/
│  │  │  ├─ mod.rs
│  │  │  ├─ commands.rs
│  │  │  ├─ hotkeys.rs
│  │  │  ├─ clipboard_watcher.rs
│  │  │  ├─ notifications.rs
│  │  │  ├─ popup_windows.rs
│  │  │  ├─ tray.rs
│  │  │  ├─ window_state.rs
│  │  │  └─ platform/
│  │  │     ├─ mod.rs
│  │  │     ├─ windows.rs
│  │  │     └─ linux.rs
│  │  ├─ notes/
│  │  │  ├─ mod.rs
│  │  │  ├─ commands.rs
│  │  │  └─ store.rs
│  │  └─ state/
│  │     ├─ mod.rs
│  │     ├─ app_state.rs
│  │     └─ popup_state.rs
│  ├─ Cargo.toml
│  └─ tauri.conf.json
├─ docs/
│  ├─ ARCHITECTURE.md
│  └─ BUGFIX_HISTORY.md
├─ package.json
└─ README.md
```

---

## Hotkeys and Runtime Flow

**Copy flow:**

1. User presses `Ctrl+Shift+C`
2. Runtime simulates `Ctrl+C`, reads clipboard (Windows priority: files → html → text → image)
3. New entry is pushed to history; `clipboard:new-entry` event emitted to main window and copy popup
4. Copy popup appears near the cursor showing what was captured
5. Active clipboard ID is updated; `clipboard:active-id` event emitted

**Paste flow:**

1. User presses `Ctrl+Shift+V`
2. Paste popup appears near cursor with the top 10 recent + top 10 pinned entries
3. Selecting an entry: sets `suppress_next_capture` flag, writes to clipboard, hides popup, simulates `Ctrl+V`
4. Clipboard watcher sees the suppress flag and skips re-adding the entry to history
5. Active clipboard ID is updated; paste notification shown if enabled

**Suppress flag** (`Arc<AtomicBool>` in `AppState`):

- Set by `copy_entry`, `paste_entry`, and Ctrl+Shift+C shortcut before writing to clipboard
- Checked by the clipboard watcher before recording a new capture
- Prevents duplicate entries when copying from within the app

---

## localStorage Keys

| Key                  | Values                                                     | Purpose                      |
| -------------------- | ---------------------------------------------------------- | ---------------------------- |
| `sc-theme`           | `"dark"` \| `"light"`                                      | User's manual theme override |
| `sc-layout`          | `"tiles"` \| `"list"`                                      | Clipboard screen layout mode |
| `sc-sort`            | `"newest"` \| `"oldest"` \| `"a-z"` \| `"z-a"` \| `"type"` | Active sort order            |
| `sc-paste-slots`     | `"3"` – `"10"`                                             | Paste popup entry count      |
| `sc-recent-searches` | JSON string array (max 8)                                  | Recent search terms          |
| `sc-groups`          | JSON string array                                           | Available custom groups      |
| `sc-group-colors`    | JSON object (`group -> palette index`)                     | User-picked group colors     |

---

## Notes

- The app targets Windows and Linux. On Windows, clipboard file support (`CF_HDROP`), cursor position, and monitor work area use `windows-sys` directly; the equivalent Linux paths live in `runtime/platform/linux.rs` and shell out to `xdotool`/`wtype`/`xdpyinfo` (see [Linux support](#linux-support)).
- Popup windows use `transparent: true` + `decorations: false` + `shadow: false` with a CSS-padded body to achieve clean rounded corners without OS border artifacts (transparency requires a compositor on Linux).
- Theme (`dark`/`light`) is stored in `localStorage` under `sc-theme` and read by both popup windows on focus; falls back to the OS `prefers-color-scheme` media query when no manual override is set.
- Release profile in `src-tauri/Cargo.toml` is optimized for smaller binaries (`opt-level = "z"`, `lto`, `strip`).
- The custom `VideoPlayer` component deliberately suppresses the native browser context menu on `<video>` to avoid exposing Download, Picture-in-Picture, and Playback speed controls that don't belong in a clipboard manager.
