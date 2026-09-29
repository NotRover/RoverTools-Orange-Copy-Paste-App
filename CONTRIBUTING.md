# Contributing to Orange Copy Paste

This file is for people changing the desktop app or the workspace around it. To install or use the app, see the [user guide](https://orange-copy-paste-app.pages.dev/docs/) instead. The sync server and the website have their own repositories and their own CONTRIBUTING files.

## Ways to contribute

- Report a bug or ask for a feature by [opening an issue](https://github.com/NotRover/RoverTools-Orange-Copy-Paste-App/issues).
- Fix a bug or build a feature with a pull request. For anything bigger than a small fix, open an issue first so the approach is agreed before you spend time on it.
- Improve the docs. User how-to lives on the [website repository](https://github.com/NotRover/RoverTools-Orange-Copy-Paste-Website); contributor reference lives in `docs/` here and in the app's `docs/`.

## Where things are

| Path | What it is |
|---|---|
| `orange-copy-paste-clipboard-app-rust/src/` | The app's interface, in React and TypeScript |
| `orange-copy-paste-clipboard-app-rust/src-tauri/` | Rust: clipboard capture, storage, all encryption, and the sync engine |
| `orange-copy-paste-clipboard-app-rust/docs/` | How the app works inside, and past regressions |
| `docs/` | The architecture map, permissions, the release process, and the writing guide |
| `changelog/` | Release notes, one file per release |
| `orange-copy-paste-clipboard-backend/`, `orange-copy-paste-clipboard-website/` | Separate repositories, cloned into this folder and ignored by it |

Rust owns state, storage and all encryption; React is only the interface. Do not reimplement encryption, key handling or merge logic in TypeScript.

## Set up

You need [Bun](https://bun.sh), a stable [Rust toolchain](https://rustup.rs), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your system.

```bash
git clone https://github.com/NotRover/RoverTools-Orange-Copy-Paste-App.git
cd RoverTools-Orange-Copy-Paste-App/orange-copy-paste-clipboard-app-rust
bun install
bun run tauri dev
```

The app window opens with an empty history. To work on the interface without the Rust side, run `bun run dev` instead.

## Before you open a pull request

Run the checks for what you changed, from `orange-copy-paste-clipboard-app-rust/`:

| You changed | Run |
|---|---|
| The interface (`src/`) | `bun run build` |
| Rust (`src-tauri/`) | `cd src-tauri && cargo check` |
| Clipboard capture, hotkeys, popups, paste or sync | `bun run tauri dev`, then try that exact flow by hand |
| Docs or any text a user reads | The checklist at the end of [`docs/writing-docs.md`](docs/writing-docs.md) |

Testing sync end to end needs a running server and two accounts. If you could not test it, say so in the pull request.

Then:

- Branch off `main`, and keep each pull request to one change.
- Open the pull request as a draft until it is ready for review.
- Write the commit message as a lowercase `type(scope): subject` line, then a few bullets on what changed and why.
- Match the surrounding code: naming, structure and how much it comments.

## Changes that cross to the server

The server defines what goes over the wire: routes, payloads, socket events and the encryption envelope. Its [`docs/architecture.md`](https://github.com/NotRover/RoverTools-Orange-Copy-Paste-Backend/blob/main/docs/architecture.md) is the reference. A change on one side of that boundary is a change in both repositories, and the reference is updated in the same change. How the app works inside is in [`orange-copy-paste-clipboard-app-rust/docs/architecture.md`](orange-copy-paste-clipboard-app-rust/docs/architecture.md).

## License

By contributing, you agree that your contributions are licensed under the GNU Affero General Public License v3.0, the same license as the project (see [LICENSE](LICENSE)).
