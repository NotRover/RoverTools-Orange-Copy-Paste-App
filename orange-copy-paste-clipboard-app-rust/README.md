# Orange Copy Paste — Smart Clipboard

A desktop clipboard manager and notes app for **Windows and Linux**, built with React 19 + TypeScript + Vite on a Rust/Tauri 2 core.

It watches the OS clipboard, keeps a searchable history of text/images/files, shows quick popups near the cursor for capture and paste, and adds a Markdown notes workspace. Optional **cloud sync** mirrors history and notes across your devices with **end-to-end encryption** — the server only ever sees ciphertext.

- **UI:** React 19, TypeScript 5.8, Vite 7, vanilla CSS (CSS variables for theming)
- **Core:** Rust + Tauri 2 — owns clipboard I/O, persistence, OS integration, and all crypto
- **Package manager:** `bun`

> Linux runs the same source tree; X11 is the smoothest experience. See [Linux support](#linux-support) for Wayland caveats.

---

## Table of contents

- [Features](#features)
- [Getting started](#getting-started)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [Cloud sync setup](#cloud-sync-setup)
- [Linux support](#linux-support)
- [Releases & updates](#releases--updates)
- [Storage & config reference](#storage--config-reference)
- [Further reading](#further-reading)

---

## Features

**Capture**
- Global hotkeys: `Ctrl+Shift+C` captures the current selection, `Ctrl+Shift+V` opens the quick-paste popup.
- Background clipboard watcher (220 ms poll) records anything you copy, with duplicate suppression so copying *from* the app never re-adds an entry.
- Entry types: text, rich HTML, images, single/multiple files, and videos. Images are written to disk and served over the Tauri asset protocol rather than held in memory.

**Clipboard screen**
- Day-grouped timeline with collapsible sections; tiles or list layout.
- Search + filter by content, type, date, and group; sort by newest/oldest/A–Z/Z–A/type.
- Groups: create, rename, recolor, delete. `Pinned` and `Saved` are protected system groups.
- Pin entries (survive clear-all), bulk select for delete/pin/group ops, per-card context menu, and a 5-second undo toast on clear-all.
- Active-clipboard indicator marks the entry currently held by the OS clipboard.
- Custom in-card video player (play/pause, seek, mute) with the native context menu suppressed.

**Notes screen**
- Notion-style WYSIWYG editor built on Tiptap. Note content is stored as a serialized ProseMirror JSON document; legacy Markdown notes are migrated on first edit.
- Toolbar: headings (H1–H5), bold/italic/underline/strike/inline code, bullet, ordered and nested task lists, blockquotes, callouts in five tones, syntax-highlighted code blocks (lowlight), tables with cell backgrounds, links with autolink, images, horizontal rules, text color, multicolor highlight, alignment, and Tab/Shift-Tab indent handling.
- Read-only card previews render straight from the stored JSON — no editor instance is mounted per card.
- Export a note as a `.md` file or copy it as Markdown; this is a one-way projection of the document, not the storage format.
- Attachments are saved to a per-app folder and referenced by custom schemes (`note-attachment://`, `note-file://`) resolved to Tauri asset URLs only at render time, so the stored document stays small and portable.
- Clipboard embeds and group references, plus the same pin/group/search/bulk model as clipboard entries.

**Popups & shell**
- Copy popup (what was just captured) and paste popup (recent + pinned entries), both cursor-anchored, screen-edge clamped, frameless, and theme-synced with the main window.
- System tray, close-to-tray, start-minimized, autostart, splash screen, and restored window geometry.
- Toast notifications with a master toggle plus per-action toggles.
- Dark/light theme following the OS by default, with a persisted manual override.
- Health watchdog: a background heartbeat detects a wedged state, warns the user, quarantines suspect data files, and recovers them on the next launch.
- In-app self-update against a signed release feed (check → download → install).

**Cloud sync (optional)**
- Sign in with email/password or Google; per-device registration and revocation.
- Encrypted push/pull of clipboard history, notes, and settings, with live updates over WebSocket and an offline queue that drains on reconnect.
- Sharing via persistent **pool groups** and ephemeral **Live Share** sessions.
- End-to-end encryption throughout: AES-256-GCM content keys, Argon2id password-derived key wrapping, X25519 key exchange between devices and group members. Key material lives in memory (zeroized on drop) and the OS credential store — never on disk in plaintext, never on the server.

---

## Getting started

**Prerequisites:** Bun, a stable Rust toolchain, and Tauri v2 platform prerequisites (WebView2 on Windows; the GTK/WebKitGTK stack on Linux — see [below](#build-prerequisites-debianubuntu)).

```bash
bun install
```

| Task | Command |
| --- | --- |
| Frontend dev server only | `bun run dev` |
| Full desktop app | `bun run tauri dev` |
| Typecheck + build frontend | `bun run build` |
| Rust compile check | `cd src-tauri && cargo check` |
| Build installers/bundles | `bun run tauri build` |

Recommended VS Code extensions: **Tauri**, **rust-analyzer**.

> Be careful running `bun run tauri dev` with autostart enabled — the startup entry can point at the dev path and break launches without Vite running.

---

## How it works

The app is a single Tauri process with several webview windows (main, copy popup, paste popup, notification, splash). Rust owns state, persistence, OS integration, and all cryptography; React is purely UI. They talk over Tauri IPC: commands (`invoke`) for request/response, events (`domain:event`) for pushes.

**Copy flow** — `Ctrl+Shift+C` → simulate `Ctrl+C` → read clipboard (priority: files → HTML → text → image) → push entry → emit `clipboard:new-entry` → show the copy popup at the cursor → update the active clipboard id.

**Paste flow** — `Ctrl+Shift+V` → show the paste popup with recent + pinned entries → on pick: set the suppress flag, write to the clipboard, hide the popup, simulate `Ctrl+V`.

**Suppress flag** — an `AtomicBool` in `AppState` set before any app-initiated clipboard write and checked by the watcher, so the app's own writes never come back as new captures. This is the invariant behind duplicate-free history.

**Persistence** — mutations mark dirty flags; a background thread coalesces them into MessagePack writes on an interval. Clipboard history lives in `history.bin`, saved entries in `pinned_entries.bin`, notes in `notes.bin`, preferences in `settings.json`, images and attachments as files on disk.

**Sync** — `SyncClient` runs on its own Tokio runtime. It encrypts locally, pushes/pulls against the backend, merges last-write-wins on `updated_at` (tombstones always win), and refreshes the UI via `sync:history-merged` / `sync:notes-merged`. It skips self-device entries so a merge is never echoed back as a push. The app is fully functional with sync switched off.

---

## Project structure

```text
src/                                 # React frontend
├─ components/
│  ├─ app/                           # main window
│  │  ├─ App.tsx                     # shell: routing, theme, event wiring
│  │  ├─ clipboard-screen/           # timeline, entry cards, search, groups, bulk actions
│  │  ├─ notes-screen/               # note CRUD + editor-engine/ (Tiptap, content codec, previews)
│  │  ├─ sync-screen/                # shared feed (groups, live sessions)
│  │  ├─ account-screen/             # auth, devices, groups, sharing
│  │  ├─ settings-screen/            # preferences; owns shared scr-*/set-section-* styles
│  │  ├─ shortcuts-screen/           # hotkey reference
│  │  └─ sidebar/ topbar/ toast/ tooltip/ status-pill/ update-banner/
│  ├─ copy-popup/  paste-popup/      # standalone OS windows
│  ├─ notifications/  splash/        # standalone OS windows
│  └─ entry-types/  icons.tsx        # shared UI
├─ hooks/                            # useUpdater, useMultiSelect, useHealthWarning, …
└─ types.ts                          # shared TS shapes mirroring the serde structs

src-tauri/src/                       # Rust core
├─ main.rs / lib.rs                  # entry point; composition root + command registration
├─ clipboard/                        # commands, history model + persistence, image/files/html formats
├─ notes/                            # commands, Note model, MessagePack store
├─ sync/                             # SyncClient, crypto, HTTP + WebSocket clients, Supabase auth,
│                                    #   OAuth loopback, offline queue, id map, config
├─ runtime/                          # watcher, hotkeys, popups, tray, notifications, window state
│  └─ platform/{windows,linux}.rs    # key injection, cursor/monitor geometry
├─ state/                            # AppState, dirty flags, popup payload types
├─ health.rs                         # panic hook, heartbeat watchdog, atomic writes, quarantine
└─ updater.rs                        # signed self-update check/download/install

docs/ARCHITECTURE.md                 # deep dive
docs/BUGFIX_HISTORY.md               # regression history — read before touching runtime flows
```

---

## Cloud sync setup

Sync stays off until the app points at a deployment. Three values are needed:

| Value | Where it comes from |
| --- | --- |
| Backend URL | Your deployed sync API, e.g. `https://your-service.onrender.com` |
| Supabase project URL | Supabase → Settings → API Keys → Project URL |
| Supabase publishable key | Supabase → Settings → API Keys |

> Use the **publishable** key (`sb_publishable_…`; older projects call it the **anon** key). Never ship the **secret** key (`sb_secret_…`) — it grants full project access, and the app rejects it outright.

**Setting the endpoints.** They are compiled in, so users never enter anything. Edit the constants at the top of `src-tauri/src/sync/config.rs`:

```rust
const DEFAULT_SERVER_URL: &str = "https://your-service.onrender.com";
const DEFAULT_SUPABASE_URL: &str = "https://your-project-ref.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY: &str = "sb_publishable_xxxxxxxxxxxxxxxx";
```

Committing these is fine — they're public-safe, so every clone and CI build produces a working app. If left blank, the sign-in screen reports an unconfigured build instead of failing silently.

**Overriding a shipped build.** `settings.json` in the app data directory overrides the compiled-in values via `sync_server_url`, `supabase_url`, `supabase_anon_key`. An escape hatch for self-hosting and debugging — deliberately no UI.

**Google sign-in** needs all three of these, or sign-in fails *after* the consent screen with no useful error:

1. Supabase → Authentication → Providers → **Google** enabled, with the Client ID/Secret from Google Cloud Console.
2. Google Cloud Console → OAuth client → Authorized redirect URIs → add `https://<project-ref>.supabase.co/auth/v1/callback`.
3. Supabase → Authentication → URL Configuration → Redirect URLs → add **all three** loopback URLs: `http://127.0.0.1:53170`, `:53171`, `:53172`.

Step 3 is the easy one to miss. A desktop app has no web origin, so the app binds a short-lived loopback server on the first free port from that list and uses it as the OAuth `redirect_to`; if those URLs aren't allow-listed, consent succeeds and Supabase then refuses to redirect back, leaving the app waiting until its 5-minute timeout. The port list is fixed in `src-tauri/src/sync/oauth.rs`.

After Google sign-in you'll be asked to set an **account password**. That's expected — it's your end-to-end encryption secret, not a second login. The server never sees it, and you re-enter it on each new device.

See the backend repo's `docs/DEPLOY.md` for standing up the server side.

---

## Linux support

All Windows-only integrations (Win32 clipboard formats, cursor/monitor queries, key injection) are compiled out and replaced with Linux equivalents.

### Build prerequisites (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Fedora/Arch have equivalents — see the Tauri v2 prerequisites docs.

### Runtime dependencies

Key injection uses a capability ladder: the app detects the session and picks the best available tool.

| Tool | Purpose | When needed |
| --- | --- | --- |
| `xdotool` | Ctrl+C/V injection, cursor position | X11 and XWayland |
| `wtype` | Ctrl+C/V injection | Wayland on wlroots (Sway, Hyprland, River) |
| `ydotool` + `ydotoold` | Injection fallback | Wayland on GNOME/KDE — needs the daemon and `/dev/uinput` access |
| `x11-utils` (`xdpyinfo`) | Monitor work area | X11; optional (falls back to 1920×1080) |
| `xdg-utils` (`xdg-open`) | "Open data folder" | all |
| GNOME Keyring / KWallet | Sync device keys and refresh tokens | cloud sync only |
| A tray host (e.g. AppIndicator extension) | Tray icon and menu | tray only |

The `.deb` depends on `xdotool | wtype` and recommends `x11-utils` and `ydotool`. On GNOME/KDE Wayland:

```bash
sudo apt install -y ydotool
sudo systemctl enable --now ydotool
```

### Packaging

`bun run tauri build` produces `.deb`, `.rpm`, and AppImage on Linux, and the NSIS installer on Windows — Tauri builds only the targets valid for the host. Linux bundles **cannot** be cross-compiled from Windows; use a Linux machine, VM, WSL, or CI.

For **test** Linux builds the parent repo ships a manual workflow, `.github/workflows/build-linux.yml` (`workflow_dispatch` only): Actions → **Build Linux (manual)** → Run workflow, then download the `rovertools-linux` artifact. It builds on `ubuntu-22.04` for broad glibc/WebKit compatibility. Its output is throwaway — to ship to users, see [Releases & updates](#releases--updates).

Install the `.deb` with `sudo apt install ./Orange.Copy.Paste_*.deb` — apt pulls an injector automatically. The AppImage is portable but bundles no injector; install `xdotool` or `wtype`/`ydotool` yourself.

### Known limitations

These degrade gracefully rather than crashing, but are not at Windows parity:

- **Wayland:** built-in global hotkeys don't fire (the plugin relies on X11 grabs), and cursor-anchored popup placement, always-on-top, and transparency are compositor-dependent — popups center on the active monitor instead. Use the CLI trigger below.
- **File-list and HTML clipboard writes** are Windows-only; on Linux those entries return an error (`text/uri-list` isn't implemented yet).
- **Capture:** file-drops and HTML sources aren't recorded into history on Linux (text and images are).
- **Image labels** show a raw timestamp instead of a localized date/time.

**CLI trigger (Wayland global hotkeys).** Bind your compositor's keybind to relaunch the binary with `--trigger`; the single-instance plugin routes it to the running app, which shows the same popup the hotkey would:

```bash
rovertools --trigger copy
```

```bash
rovertools --trigger paste
```

Use the real installed binary name/path (check the `Exec=` line in the installed `.desktop` file). Examples — Sway/Hyprland: `bindsym $mod+Shift+v exec rovertools --trigger paste`; GNOME: Settings → Keyboard → Custom Shortcuts; KDE: System Settings → Shortcuts → Custom. Works on every compositor including X11, but the app must already be running.

---

## Releases & updates

Nobody hand-distributes an installer after the first one. Cutting a release is a
single manual workflow; installed copies notice it on their next launch and offer
it. Version numbers, the changelog, and the update feed are all derived from commit
history — none of them are edited by hand.

Full operational detail, including one-time setup, lives in
[`../docs/RELEASING.md`](../docs/RELEASING.md).

### The shape of it

```text
commits (feat:/fix:/…)
   │
   ├─ git-cliff ──► next version ──► src-tauri/Cargo.toml
   │                └──────────────► CHANGELOG.md + release notes
   │
   └─ matrix build ─► signed NSIS (Windows) + AppImage/deb (Linux)
                          │
                          └─► public releases repo: bundles + latest.json
                                      │
                                      └─► app checks it ~8s after launch
```

The source repo is private; the **releases** repo is public because the updater
fetches over plain HTTPS with no credentials. Reaching a private repo's assets
would mean shipping a token inside the app.

### Cutting a release

Rehearse first — this does everything except commit, tag, and publish:

```bash
gh workflow run release.yml -f bump=auto -f dry_run=true
```

Then, once the rehearsal looks right:

```bash
gh workflow run release.yml -f bump=auto -f dry_run=false
```

`bump=auto` reads the commits since the last release tag; `patch` and `minor`
override it. Re-run with `dry_run=true` after any edit to the workflow itself.

To ship a beta instead, add `-f prerelease=true`. It publishes for real but stays
out of the update feed, so testers install it by hand and nobody else is offered it;
promoting it later is a `gh release edit` of the same bundles rather than another
build. Details in [docs/RELEASING.md](../docs/RELEASING.md#beta-channel-free).

### What users get

Within a few seconds of their next launch, a strip appears under the titlebar:
*"Version 0.3.0 is available"*, with the generated notes behind **What's new**.
Nothing downloads or installs until they press something — **Download**, then
**Restart & install** as a separate confirmation, so a background download
finishing never takes the window out from under someone mid-paste. **Skip this
version** silences that one release; the ✕ defers to the next launch. Settings →
**Updates** shows the running version, a manual check, and a toggle for the
automatic one.

### What to watch out for

| Trap | Why it matters |
| --- | --- |
| **The signing key is load-bearing** | Every installed copy only trusts bundles signed by it. Lose it and the update channel is dead — users would have to reinstall by hand to get a build carrying a new public key. Back it up outside CI before the first release. |
| **Commit messages *are* the changelog** | A `feat:` subject ships verbatim into the update prompt. Write them for users, not for yourself. |
| **Only `feat:`, `fix:` and `perf:` move the version** | `chore:`, `docs:`, `refactor:`, `test:`, `ci:`, `build:` and non-conventional commits are excluded from both the notes and the bump. A batch of nothing but those makes `bump=auto` fail with *"no releasable commits"* — which is the intent, not a bug. To ship it anyway, dispatch with `-f bump=patch`. |
| **`bun run tauri build` output cannot be served as an update** | Local builds are unsigned. Only `release.yml` produces the `.sig` files the feed needs. Use local bundles for testing, never for publishing. |
| **Only NSIS and AppImage self-update** | `.deb`/`.rpm` are owned by the package manager. They are still built and attached for manual install, but never appear in `latest.json` — offering an update the client can't apply is worse than offering none. |
| **The version lives in exactly one place** | `src-tauri/Cargo.toml`. `tauri.conf.json` has no `version` field on purpose (Tauri falls back to Cargo.toml), and `package.json`'s copy is cosmetic. Don't reintroduce it. |
| **`build-linux.yml` is not a release** | Its `v0.1.0-build.N` tags are throwaway CI builds, excluded from versioning by `tag_pattern` in `cliff.toml`, and it publishes to this repo rather than the releases repo. Never point the updater at it — its prune step would then be a way to break every install. |
| **Dev builds refuse to update** | A debug build reports the Cargo.toml version, so it would see any release as an upgrade and install over `target/debug`, replacing a build that loads from `devUrl`. Settings says so rather than letting it happen. |
| **Prereleases are invisible to the updater** | `releases/latest/download/…` resolves to the newest *non*-prerelease. That is exactly how `-f prerelease=true` works, so it is a feature when deliberate — and a silent one when not. Marking a release as a prerelease by hand in the releases repo pulls it out of the feed too. |
| **A beta still spends its version number** | `prerelease=true` changes only how the release is published: the bump, the `chore(release):` commit and the tag still land on `main`. A beta that fails testing costs you that number, and leaves its section in the changelog. |

Two safety rails worth knowing about, because they mean a bad release fails in CI
rather than in front of users: the workflow refuses to publish a version that isn't
plain semver or a bundle whose `.sig` is missing, and after publishing it re-fetches
`latest.json` through the same URL the app uses and checks every bundle URL it
advertises is reachable.

---

## Storage & config reference

**App data directory** — Windows `%APPDATA%\com.spect.orange-copy-paste\`, Linux `~/.config/com.spect.orange-copy-paste/`:

| File | Contents |
| --- | --- |
| `history.bin` | Full clipboard history (MessagePack) |
| `pinned_entries.bin` | Saved/pinned entries, kept even when history isn't persisted |
| `notes.bin` | Notes store |
| `settings.json` | Preferences and sync/endpoint overrides |
| `images/`, attachments dir | Externalized clipboard images and note attachments |
| `boot_id.txt` | Boot marker deciding whether history survives a reboot |

**localStorage keys** (UI-only preferences):

| Key | Values | Purpose |
| --- | --- | --- |
| `sc-theme` | `dark` \| `light` | Manual theme override |
| `sc-layout` | `tiles` \| `list` | Clipboard layout mode |
| `sc-sort` | `newest` \| `oldest` \| `a-z` \| `z-a` \| `type` | Sort order |
| `sc-paste-slots` | `3`–`10` | Paste popup entry count |
| `sc-recent-searches` | JSON array (max 8) | Recent search terms |
| `sc-groups` | JSON array | Custom groups |
| `sc-group-colors` | JSON object (group → palette index) | Group colors |

---

## Further reading

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — full architecture: modules, data flows, IPC surface, sync internals.
- [`docs/BUGFIX_HISTORY.md`](docs/BUGFIX_HISTORY.md) — regression history; read before changing watcher, hotkey, popup, or paste behavior.
- Workspace root [`docs/RELEASING.md`](../docs/RELEASING.md) — releasing and the update feed: one-time setup, signing keys, verification rails.
- Workspace root `docs/ARCHITECTURE.md` — cross-system context with the sync backend.
- Backend repo `docs/ARCHITECTURE.md` — the source of truth for the wire contract.
