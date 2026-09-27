# Orange Copy Paste: desktop app

The Orange Copy Paste desktop app for **Windows and Linux**: a clipboard history you can search, popups at the cursor for capturing and pasting, a notes editor, and optional end-to-end encrypted sync and sharing. This folder is the app's source, built with React 19 and TypeScript on a Rust and Tauri 2 core.

![The clipboard history screen](../docs/images/clipboard-history.png)

- **Interface:** React 19, TypeScript, Vite, plain CSS with variables for theming.
- **Core:** Rust and Tauri 2. It owns clipboard access, storage, operating system integration, and all encryption.
- **Package manager:** Bun.

To install and use the app, download it from the [releases page](https://github.com/NotRover/RoverTools-Orange-Copy-Paste-App/releases/latest) and follow [Install and first run](https://orange-copy-paste-app.pages.dev/docs/getting-started/). How each feature behaves for a user is in the [user guide](https://orange-copy-paste-app.pages.dev/docs/).

## Features

**Capture**
- Global hotkeys: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> captures the selection, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> opens the quick-paste popup.
- A background watcher polls the clipboard every 220 ms and records what you copy. Copying *from* the app never adds a duplicate entry.
- Entry types: text, rich HTML, images, files and folders, and videos. Images are written to disk and loaded through Tauri's asset protocol instead of being held in memory.

**Clipboard screen**
- Entries grouped by day under collapsible headers, in tiles, grid or single-column view.
- Search, and filters by type, date, group, cloud state and space. Sort by newest, oldest, A to Z, Z to A, or type.
- Groups you can create, rename, recolor and delete. `Pinned` and `Saved` are built in and cannot be renamed.
- Up to 10 pins, which survive **Clear all**. Bulk selection for delete, pin and group changes, a right-click menu on each card, and an undo after **Clear all**.
- A marker on the entry that is currently on the system clipboard.
- A built-in video player for video entries.

**Notes screen**
- A block editor built on Tiptap, stored as ProseMirror JSON. Older Markdown notes are converted the first time they are edited.
- Headings 1 to 3, bold, italic, underline, strikethrough, inline code, bullet, ordered and nested task lists, quotes, callouts in five tones, highlighted code blocks, tables, links, images, horizontal rules, text color, highlight, alignment, and indenting with <kbd>Tab</kbd>.
- Cards in the list render from the stored JSON, without an editor instance per card.
- Export as a `.md` file or copy as Markdown. Export is a one-way conversion, not the storage format.
- Attachments are saved in the app's data folder and referenced from the note, so the note stays small.
- Clipboard entries and groups can be embedded in a note. Notes share pins, groups, search and bulk actions with clipboard entries.

**Popups and window**
- The capture popup shows what was just captured; the paste popup lists recent and pinned entries. Both open at the cursor, stay inside the screen, and follow the main window's theme.
- System tray, close to tray, start minimized, run on startup, a splash screen, and a remembered window size and position.
- In-app notifications with a master switch and one switch per action.
- Dark and light themes, following the system unless you choose one.
- A health watchdog notices when saving stops working, warns you, sets suspect data files aside, and recovers them on the next launch.
- Self-update from a signed release feed.

**Sync (optional)**
- Sign in with email and password or Google. Each computer registers as a device and can be revoked.
- Encrypted sync of history, notes and settings, with live updates and an offline queue that uploads when you reconnect.
- Sharing through **spaces**: live, any number of members, and a person can be in several. Each space has its own key.
- End-to-end encryption throughout. Keys live in memory, wiped when dropped, and in the system credential store; never on disk in plain form, and never on the server. The design is explained in the [security model](https://orange-copy-paste-app.pages.dev/docs/security/).

## Run it from source

You need Bun, a stable Rust toolchain, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/): WebView2 on Windows, and the GTK and WebKitGTK stack on Linux (see [Linux](#linux) below).

```bash
bun install
bun run tauri dev
```

The app window opens with an empty history. Copy something anywhere and it appears at the top. Everything except sync works without further setup.

| Task | Command |
| --- | --- |
| Interface only, in a browser, without Rust | `bun run dev` |
| Full desktop app | `bun run tauri dev` |
| Type-check and build the interface | `bun run build` |
| Check the Rust code compiles | `cd src-tauri && cargo check` |
| Build installers for this system | `bun run tauri build` |

Recommended VS Code extensions: **Tauri** and **rust-analyzer**.

Do not turn on **Run on startup** while running `tauri dev`: the startup entry points at the development build, which does not launch without the dev server.

## How it works

The app is one Tauri process with several windows: the main window, the capture and paste popups, notifications, and the splash screen. Rust owns state, storage, operating system integration and all encryption; React only draws. They talk through Tauri commands (`invoke`) for requests and `domain:event` events for pushes.

- **Capture:** the hotkey simulates <kbd>Ctrl</kbd>+<kbd>C</kbd>, reads the clipboard (files first, then HTML, text, image), adds the entry, and shows the capture popup at the cursor.
- **Paste:** the hotkey shows the paste popup; picking an entry writes it to the clipboard, hides the popup and simulates <kbd>Ctrl</kbd>+<kbd>V</kbd>.
- **No duplicates:** a flag is set before every write the app makes to the clipboard, and the watcher skips those writes. This is what keeps history free of duplicates.
- **Storage:** changes mark the data dirty, and a background thread writes it as MessagePack on an interval. Images and attachments are separate files.
- **Sync:** runs on its own async runtime, encrypts on the computer, pushes and pulls, and resolves conflicts to the newest edit. It never sends a merged change back out as a new one. The app works fully with sync off.

The full picture, including every command, event and file, is in [`docs/architecture.md`](docs/architecture.md).

## Project structure

```text
src/                               the interface (React)
|- components/
|  |- app/                         the main window
|  |  |- App.tsx                   shell: routing, theme, event wiring
|  |  |- clipboard-screen/         timeline, entry cards, search, groups, bulk actions
|  |  |- notes-screen/             notes list and editor (editor-engine/ has its own SPEC.md)
|  |  |- spaces-screen/            shared feed: spaces, invites, members, per-space rules
|  |  |- account-screen/           sign-in, sync mode, devices, storage
|  |  |- settings-screen/          preferences, and the section styles other screens share
|  |  `- shortcuts-screen/         hotkey reference
|  |- copy-popup/  paste-popup/    the two popups, each its own window
|  `- notifications/  splash/      notification and splash windows
|- hooks/                          shared React hooks
`- types.ts                        shared types that mirror the Rust structs

src-tauri/src/                     the core (Rust)
|- lib.rs                          startup, and registration of every command
|- clipboard/                      commands, history model and storage, image/file/HTML formats
|- notes/                          commands, note model, storage
|- sync/                           sync engine, encryption, server and Supabase clients, offline queue
|- runtime/                        watcher, hotkeys, popups, tray, notifications
|  `- platform/                    Windows and Linux key injection and screen geometry
|- state/                          shared app state
|- health.rs                       watchdog, safe file writes, quarantine
`- updater.rs                      signed self-update

docs/architecture.md               how the app works inside
docs/bugfix-history.md             past regressions: read before changing watcher, hotkeys, popups or paste
```

## Sync in your build

Sync stays off until the build knows which server and Supabase project to use: a server URL, the Supabase project URL, and its publishable key, compiled in from `src-tauri/src/sync/config.rs`. An installed copy can be pointed elsewhere through `settings.json`. The steps, and the Google sign-in setup that is easy to get wrong, are in [Point the app at your server](https://orange-copy-paste-app.pages.dev/docs/developers/self-hosting/#point-the-app-at-your-server).

After Google sign-in, the app asks for an account password. That is expected: it is the encryption secret, not a second login.

## Linux

The Windows-only parts (Win32 clipboard formats, cursor and monitor queries, key injection) are compiled out and replaced with Linux equivalents.

**Build prerequisites (Debian and Ubuntu):**

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Fedora and Arch have equivalents; see the Tauri prerequisites.

**At runtime** the app types keystrokes with `xdotool` on X11, `wtype` on wlroots compositors, or `ydotool` on GNOME and KDE Wayland, and stores sync keys in GNOME Keyring or KWallet. The full package list, the Wayland hotkey setup, and what does not work on Linux yet are in the [Linux notes](https://orange-copy-paste-app.pages.dev/docs/linux/).

**Packaging:** `bun run tauri build` makes `.deb`, `.rpm` and AppImage on Linux, and the NSIS installer on Windows. Releases publish only the `.deb` and AppImage. Linux bundles cannot be built from Windows: use a Linux machine, a VM, WSL, or the **Build Linux (manual)** workflow in the Actions tab, whose `rovertools-linux` artifact is for testing only.

## Releases and updates

A release is one workflow run in the workspace repository. Installed copies check for it at startup and every six hours after, and offer it. The process, channels and signing are in [`../docs/releasing.md`](../docs/releasing.md).

## Where data is stored

Everything lives in the app data folder: `%APPDATA%\io.github.notrover.orange-copy-paste\` on Windows, `~/.local/share/io.github.notrover.orange-copy-paste/` on Linux. That includes history, saved entries, notes, settings, images and attachments. The file layout is in [`docs/architecture.md`](docs/architecture.md). Interface-only preferences, such as theme, layout and sort, are kept in `localStorage` under `sc-*` keys.

## Contributing

Setup, checks and pull request rules are in the workspace [CONTRIBUTING.md](../CONTRIBUTING.md). Report vulnerabilities as described in [SECURITY.md](../SECURITY.md).
