# Smart Clipboard (Tauri + React + Rust)

Smart Clipboard is a desktop clipboard manager built with:

- **Frontend:** React + TypeScript + Vite
- **Backend:** Rust + Tauri 2
- **Target platform:** Windows-first (global hotkeys and clipboard integrations are implemented for Windows)

It captures copied text/images into history, shows quick popups near the cursor, and supports fast paste actions from recent clipboard entries.

---

## Features

- Global shortcuts:
  - `Ctrl + Shift + C` → capture current selection into history and show copy popup
  - `Ctrl + Shift + V` → show recent history popup for quick paste
- Clipboard history with support for:
  - Text entries
  - Image entries (stored as data URLs)
- Popup windows:
  - `cursor-popup` preview after copy
  - `paste-popup` showing recent entries
- IPC command surface exposed to frontend via Tauri `invoke`

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

- **Node/Bun toolchain** (project uses `bun` in Tauri build hooks)
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
- `commands.rs`: Tauri IPC commands for clipboard actions (get/delete/clear/copy/paste) and clipboard read/write helpers

This keeps clipboard business logic and its public command entry points together.

### 2) `runtime` module (OS/runtime integrations)

- `hotkeys.rs`: global hotkey registration and handlers
- `platform.rs` + `platform_windows.rs`: platform-specific OS interaction (simulate copy/paste, cursor position, monitor work area)
- `popup_windows.rs`: popup window creation, positioning helpers, popup hide utilities
- `commands.rs`: runtime-oriented IPC commands (close popup windows)

This module owns integrations with Tauri runtime lifecycle and OS behavior.

### 3) `state` module (shared app state)

- `app_state.rs`: `AppState` managed by Tauri and injected into commands
- `popup_state.rs`: popup constants and payload types used for emitted events

### 4) `lib.rs` (composition root)

`src-tauri/src/lib.rs` wires all modules:

- Creates shared history state
- Registers plugins and invoke handlers
- Sets up popup windows and hotkeys during app setup

This is intentionally thin and orchestration-focused.

---

## Current Project Structure

```text
notrover-smart-clipboard-app-rust/
├─ src/
│  ├─ components/
│  │  ├─ app/
│  │  ├─ cursor-popup/
│  │  └─ paste-popup/
│  └─ assets/
├─ src-tauri/
│  ├─ src/
│  │  ├─ lib.rs
│  │  ├─ main.rs
│  │  ├─ clipboard/
│  │  │  ├─ mod.rs
│  │  │  ├─ commands.rs
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

1. User presses `Ctrl+Shift+C`.
2. Runtime simulates `Ctrl+C`, reads clipboard (text first, then image formats).
3. New entry is pushed to history and event is emitted to `cursor-popup`.

For paste:

1. User presses `Ctrl+Shift+V`.
2. Runtime shows `paste-popup` with recent entries.
3. Selecting an entry writes it to clipboard, hides popup, then simulates paste.

---

## Notes

- The app is currently tuned for Windows-specific clipboard/runtime behavior.
- Release profile in `src-tauri/Cargo.toml` is optimized for smaller binaries (`opt-level = "z"`, `lto`, `strip`).
