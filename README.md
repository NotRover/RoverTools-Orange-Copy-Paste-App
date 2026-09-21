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

**Sharing** is one primitive: the **Space** — persistent, live, any number of members, and a user can be in several at once. Each space has a random key (kept as a keyring, newest first) distributed to members by wrapping it for each member's X25519 public key.

The full contract — payload shapes, event envelopes, key lifecycle — is in the [backend architecture doc](orange-copy-paste-clipboard-backend/docs/architecture.md), which owns it.

---

## Repository layout

Three components, **three git repositories**. The client lives directly in this repo; the backend and the website are each submodules with their own repos.

```text
RoverTools/
├─ orange-copy-paste-clipboard-app-rust/   # desktop app — part of this repo
├─ orange-copy-paste-clipboard-backend/    # submodule → RoverTools-Orange-Copy-Paste-Backend
├─ orange-copy-paste-clipboard-website/    # submodule → RoverTools-Orange-Copy-Paste-Website
├─ docs/
│  ├─ architecture.md                      # cross-system architecture and integration contract
│  └─ releasing.md                         # how a release is cut
├─ .github/workflows/
│  ├─ release.yml                          # manual: version, build, sign, publish
│  └─ build-linux.yml                      # manual: Linux bundles without a Linux machine
├─ .claude/skills/                         # Claude Code skills — e.g. cutting a release
└─ CLAUDE.md                               # workspace guide for AI coding agents
```

Clone with the submodule:

```bash
git clone --recurse-submodules https://github.com/NotRover/RoverTools-Orange-Copy-Paste-App.git
```

If you already cloned without it:

```bash
git submodule update --init --recursive
```

Default branch is `main` on all three repos. Keep each commit scoped to one repo — don't bundle a submodule-pointer bump with client code unless you're coordinating a release.

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

From Claude Code: `/create-rovertools-orange-copy-paste-release [patch|minor|major] [stable|beta] [dry-run|preview]` — the skill asks for whatever you leave out, shows the version and notes about to ship, and dispatches only after an explicit yes.

The dispatch flags (`bump`, `prerelease`, `dry_run`), the two-channel stable/beta design, the one-time signing-key and releases-repo setup, and the pre-trust smoke test all live in [`docs/releasing.md`](docs/releasing.md). `.github/workflows/build-linux.yml` builds Linux bundles on demand. Releases never touch the sync backend; it deploys on its own.

---

## Conventions

- **Commit messages:** lowercase `type(scope): subject`, then a few single-line bullets on what changed and why.
- **Release notes** live in [`changelog/`](changelog/): draft `changelog/next.md` with `/update-changelog` (or by hand) before releasing — an empty one fails the release. Internal changes go under `### Internal` and are kept but never shown to users.
- **Pull requests** open as drafts against each repo's own `main`.
- **Migrations are written, never auto-applied.** Authoring an Alembic revision is normal work; applying it to a real database is a separate, explicitly approved step.
- **Backend work goes on its own branches** in the backend repo, not alongside client changes.

---

## Further reading

- [`docs/architecture.md`](docs/architecture.md) — the map: which doc owns which fact, and the invariants that bind the two components. Start here to find the right doc.
- [`docs/releasing.md`](docs/releasing.md) — the release pipeline end to end.
- [Client README](orange-copy-paste-clipboard-app-rust/README.md) · [client architecture](orange-copy-paste-clipboard-app-rust/docs/architecture.md) · [bugfix history](orange-copy-paste-clipboard-app-rust/docs/bugfix-history.md).
- [Backend README](orange-copy-paste-clipboard-backend/README.md) · [backend architecture](orange-copy-paste-clipboard-backend/docs/architecture.md) · [deployment guide](orange-copy-paste-clipboard-backend/docs/DEPLOY.md).

> Docs are context, not truth. Where a doc and the code disagree, the code wins — and the doc is worth fixing.
