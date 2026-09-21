# Contributing to RoverTools

Thanks for your interest in RoverTools, the cross-device Smart Clipboard app.
This repository holds the **desktop client** (React + TypeScript + Vite on the
front end, Tauri + Rust underneath). The cloud-sync backend lives in its own
repository and is included here as a submodule.

If you are a *user* looking for how to install or use the app, see the docs site
instead: https://orange-copy-paste-app.pages.dev. This file is for people
building or changing the code.

## Ways to contribute

- Report a bug or request a feature by opening an issue.
- Fix a bug or build a feature via a pull request.
- Improve the docs in `docs/` (contributor reference) — user-facing how-to lives
  on the website, not here.

For anything larger than a small fix, open an issue first so we can agree on the
approach before you spend time on it.

## Project layout

| Path | What it is |
|------|------------|
| `src/` | React + TypeScript front end |
| `src-tauri/` | Tauri v2 + Rust: clipboard capture, storage, all crypto and the sync engine |
| `docs/` | Contributor reference (architecture, permissions, release process) |
| `orange-copy-paste-clipboard-backend/` | Cloud-sync API — a git submodule with its own repo |

The Rust side owns state, persistence, and all encryption; React is the UI. Do
not reimplement crypto, key handling, or merge logic in TypeScript.

## Getting set up

Prerequisites:

- [Bun](https://bun.sh) (package manager and script runner)
- A [Rust toolchain](https://rustup.rs) (stable)
- The [Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/)
  for your OS

Clone with submodules and install:

```bash
git clone --recurse-submodules https://github.com/NotRover/RoverTools-Orange-Copy-Paste-App.git
cd RoverTools-Orange-Copy-Paste-App
bun install
```

Run the app in development:

```bash
bun run tauri dev
```

Front-end only (no Rust shell):

```bash
bun run dev
```

## Before you open a pull request

Run the checks that match what you touched:

- **Front end** (`src/`): `bun run build` (typechecks and builds).
- **Rust / Tauri** (`src-tauri/`): `cd src-tauri && cargo check`.
- **Runtime behavior** (clipboard watcher, hotkeys, popups, paste, sync): run
  `bun run tauri dev` and smoke-test the specific flow. Full end-to-end sync
  needs a live backend and two accounts; if you cannot run it, say so in the PR.

Please also:

- Branch off `main`; keep each pull request scoped to one change.
- Open pull requests as **drafts** until they are ready for review.
- Write clear commit messages: a lowercase `type(scope): subject` line, then a
  few bullets on what changed and why.
- Match the surrounding code — naming, structure, and comment density.

## Coding notes

- Front end to Rust: `invoke<T>("command_name", { camelCaseArgs })`. Commands are
  snake_case and domain-prefixed; register new ones in `src-tauri/src/lib.rs`.
- Rust to front end: events are namespaced `domain:event` in kebab-case. Update
  both sides together.
- Shared TypeScript types live in `src/types.ts`; keep them in step with the
  serde structs they mirror.
- User-facing strings use plain ASCII punctuation and concrete language.

## Architecture and internals

`docs/architecture.md` in this repo maps the client internals. The wire contract
(routes, payloads, socket events, crypto envelope) is owned by the backend
repository's `docs/architecture.md`. A change that crosses the client/backend
boundary is a change in both repositories.

## License

By contributing, you agree that your contributions are licensed under the
GNU Affero General Public License v3.0, the same license as the project (see
[LICENSE](LICENSE)).
