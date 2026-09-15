# RoverTools — Smart Clipboard

A cross-device smart clipboard. Copy text, images, or files on one machine and they show up on every other machine you own — with notes, group sharing, and real-time collaboration on top. Everything that leaves a device is **end-to-end encrypted**, so the server relays and stores ciphertext it cannot read.

This workspace holds both halves of the product, plus its public docs site:

| Component | What it is | Stack |
| --- | --- | --- |
| [`orange-copy-paste-clipboard-app-rust/`](orange-copy-paste-clipboard-app-rust) | The desktop app — clipboard capture, history, notes, sharing UI, and all cryptography | React 19 + TypeScript + Vite on Tauri 2 / Rust |
| [`orange-copy-paste-clipboard-backend/`](orange-copy-paste-clipboard-backend) | The cloud-sync API — encrypted store, realtime fan-out, sharing, blob brokering | Python 3.14 + FastAPI, Supabase Postgres, Redis, S3/R2 |
| [`orange-copy-paste-clipboard-website/`](orange-copy-paste-clipboard-website) | The public docs and marketing site — how-to guides and the landing page | Astro + Starlight, bun |

The app lives in this parent repo; the backend and the website are each submodules with their own repos. Each component has its own README with setup, structure, and development instructions.

---

## How the halves fit together

```
  Device A                          Device B
  ┌──────────────────┐              ┌──────────────────┐
  │  Desktop app     │              │  Desktop app     │
  │  local store     │              │  local store     │
  │  SyncClient ─────┼──HTTPS/WSS───┼───── SyncClient  │
  └────────┬─────────┘              └─────────┬────────┘
           │                                  │
           ▼                                  ▼
  ┌──────────────────────────────────────────────────────┐
  │  FastAPI backend — stateless, horizontally scalable   │
  │  Supabase (Postgres + Auth) · Redis · S3 / R2         │
  └──────────────────────────────────────────────────────┘
```

**The client is the source of truth.** It captures the clipboard, stores history and notes locally, holds every key, and performs all encryption and decryption. The Rust side owns crypto and the sync engine; React is only UI.

**The backend is a relay and durable store.** It verifies Supabase-issued JWTs (it never signs any), persists ciphertext, fans changes out over WebSocket, and hands out presigned blob URLs. It is the source of truth for the wire contract — and for nothing else.

**Cloud is optional.** With sync disabled or the server unreachable, the app is fully functional; work queues locally and drains on reconnect.

### The sync flow, end to end

1. The client authenticates against Supabase Auth directly.
2. `POST /api/v1/auth/bootstrap` returns the profile's `kdf_salt` and password-wrapped master key.
3. The client derives a wrapping key from the account password (Argon2id) and unwraps the **User Master Key** in memory — a wrong password simply fails the AES-GCM unwrap.
4. It registers the device and publishes the device's public key.
5. Entries are encrypted locally, pushed, and pulled; merges are last-write-wins on `updated_at`.
6. `/ws` streams live changes from other devices and group members.

**Deletes are tombstones** — a push carrying `deleted_at`, never a DELETE route — and a tombstone always wins a conflict.

**Sharing** comes in two shapes, both built on a random per-group key wrapped individually for each member with X25519: persistent **pool groups**, and ephemeral **Live Share** sessions scoped to clipboard, notes, or both.

The full contract — payload shapes, event envelopes, key lifecycle — is in the [backend architecture doc](orange-copy-paste-clipboard-backend/docs/ARCHITECTURE.md), which owns it.

---

## Repository layout

Two components, **two git repositories**. The client lives directly in this repo; only the backend is a submodule.

```text
RoverTools/
├─ orange-copy-paste-clipboard-app-rust/   # desktop app — part of this repo
├─ orange-copy-paste-clipboard-backend/    # submodule → RoverTools-Smart-Clipboard-App-Backend
├─ docs/
│  ├─ ARCHITECTURE.md                      # cross-system architecture and integration contract
│  └─ RELEASING.md                         # how a release is cut
├─ .github/workflows/
│  ├─ release.yml                          # manual: version, build, sign, publish
│  └─ build-linux.yml                      # manual: Linux bundles without a Linux machine
├─ .claude/skills/                         # Claude Code skills — e.g. cutting a release
└─ CLAUDE.md                               # workspace guide for AI coding agents
```

Clone with the submodule:

```bash
git clone --recurse-submodules https://github.com/NotRover/RoverTools-Smart-Clipboard-App-RUST.git
```

If you already cloned without it:

```bash
git submodule update --init --recursive
```

Default branch is `main` on both repos. Keep each commit scoped to one repo — don't bundle a submodule-pointer bump with client code unless you're coordinating a release.

---

## Quick start

**Desktop app** — needs Bun, a stable Rust toolchain, and the Tauri v2 prerequisites for your OS:

```bash
cd orange-copy-paste-clipboard-app-rust && bun install && bun run tauri dev
```

It runs offline out of the box. Cloud sync stays dark until the build points at a deployment — see the client README's cloud sync setup.

**Backend** — needs Python 3.14+, `uv`, and Docker for the local Postgres/Redis/MinIO stack:

```bash
cd orange-copy-paste-clipboard-backend && cp .env.example .env && docker-compose up
```

Then apply migrations with `uv run alembic upgrade head`. API docs land at `http://localhost:8000/api/docs`.

---

## Verification

Run the smallest check set that covers what you touched.

| Changed | Run |
| --- | --- |
| Client frontend | `bun run build` |
| Client Rust/Tauri | `cd src-tauri && cargo check` |
| Runtime behavior (watcher, hotkeys, popups, paste, sync) | `bun run tauri dev` and smoke-test that flow |
| Backend Python | `uv run ruff check src` and `uv run ty check src`, plus `uv run pytest` for logic changes |

Full end-to-end sync needs a live backend, a Supabase project, and two accounts. If you can't run it, say so rather than assuming it works.

---

## Releasing

A release is one manual workflow run: `gh workflow run release.yml` for a patch, `-f bump=minor` for a feature release, `-f bump=major` for a breaking one.

`.github/workflows/release.yml` (dispatch only) checks its own prerequisites, publishes [`changelog/next.md`](changelog/) as the notes (erroring right away if it is empty), bumps the version in `src-tauri/Cargo.toml`, builds signed Windows NSIS and Linux AppImage/deb bundles, and publishes them plus `latest.json` to the **public** releases repo the in-app updater reads. On release it renames `next.md` to `changelog/<version>-<bump>-<channel>.md`. The source repo stays private; the releases repo has to be public because the updater fetches over plain HTTPS with no credentials.

### Dispatch flags

| Flag | Values | Default | Effect |
| --- | --- | --- | --- |
| `bump` | `patch` · `minor` · `major` | `patch` | `1.1.1` → `1.1.2` · `1.2.0` · `2.0.0` |
| `prerelease` | `true` · `false` | `false` | A beta: offered only to installs opted in under Settings → Updates → *Get beta versions*, invisible to everyone else. Promote it later with `gh release edit <tag> --prerelease=false --latest` — the same bundles, no rebuild. |
| `dry_run` | `true` · `false` | `false` | Build, sign and verify, then stop without publishing. Worth it after editing the workflow. |

A bump zeroes everything to its right, so no dispatch reaches `2.1.1` from `1.1.1` directly — set the predecessor by hand (`cargo set-version 2.1.0`) and release a `patch`.

### From Claude Code

`/create-rovertools-orangecp-release [patch|minor|major] [stable|beta] [dry-run|preview]` — [`SKILL.md`](.claude/skills/create-rovertools-orangecp-release/SKILL.md). Every argument is optional and the skill **asks for whatever you leave out rather than defaulting it**; it shows the version and the notes about to ship, dispatches only after an explicit yes, then verifies both channels. `preview` prints what the next release would contain and dispatches nothing.

### One-time setup

Three things, before the first release. The workflow checks all of them in its first step and names whichever is missing, so a misconfigured release fails in seconds rather than after a build.

1. **Signing keypair** — `cd orange-copy-paste-clipboard-app-rust && bun tauri signer generate -w ~/.tauri/rovertools-updater.key`. Put the public half in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey` and commit it. **Back the private key and its password up outside CI** — every installed copy trusts only bundles signed by it, so losing it kills the update channel: a new public key means a new build, which users can only get by installing by hand.
2. **Public releases repo** — `gh repo create NotRover/RoverTools-Releases --public --add-readme`. It holds no source, only assets and the update manifests. Public because the updater fetches over plain HTTPS with no credentials; `--add-readme` because a release needs a commit to tag.
3. **Three Actions secrets** on the source repo — `TAURI_SIGNING_PRIVATE_KEY` (the key file's contents), `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and `RELEASES_REPO_TOKEN` (a fine-grained PAT with **Contents: read and write** on the releases repo — the workflow's own token cannot write to another repo).

No baseline tag is needed; the first release's notes are just "First release." Versioning rules, the two-channel design, and the pre-trust smoke test are in [`docs/RELEASING.md`](docs/RELEASING.md).

`.github/workflows/build-linux.yml` builds Linux bundles on demand when you don't have a Linux machine handy.

Releases never touch the sync backend; it deploys on its own.

---

## Conventions

- **Commit messages:** lowercase `type(scope): subject`, then a few single-line bullets on what changed and why.
- **Release notes** live in [`changelog/`](changelog/): draft `changelog/next.md` with `/update-changelog` (or by hand) before releasing — an empty one fails the release. Internal changes go under `### Internal` and are kept but never shown to users.
- **Pull requests** open as drafts against each repo's own `main`.
- **Migrations are written, never auto-applied.** Authoring an Alembic revision is normal work; applying it to a real database is a separate, explicitly approved step.
- **Backend work goes on its own branches** in the backend repo, not alongside client changes.

---

## Further reading

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the map: which doc owns which fact, and the invariants that bind the two components. Start here to find the right doc.
- [`docs/RELEASING.md`](docs/RELEASING.md) — the release pipeline end to end.
- [Client README](orange-copy-paste-clipboard-app-rust/README.md) · [client architecture](orange-copy-paste-clipboard-app-rust/docs/ARCHITECTURE.md) · [bugfix history](orange-copy-paste-clipboard-app-rust/docs/BUGFIX_HISTORY.md).
- [Backend README](orange-copy-paste-clipboard-backend/README.md) · [backend architecture](orange-copy-paste-clipboard-backend/docs/ARCHITECTURE.md) · [deployment guide](orange-copy-paste-clipboard-backend/docs/DEPLOY.md).

> Docs are context, not truth. Where a doc and the code disagree, the code wins — and the doc is worth fixing.
