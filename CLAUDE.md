# CLAUDE.md — RoverTools Workspace Guide

RoverTools is a **cross-device Smart Clipboard product**: a Tauri desktop app plus an end-to-end-encrypted cloud-sync backend. Keep edits minimal, verify against live code, and treat the docs as context — not truth.

<communication>
Be concise and direct. Match length to the task.

- Plain language; no filler or preamble ("Great question!", "I'll now…").
- When summarizing changes, say what changed and why — skip the line-by-line walkthrough unless asked.
- Surface assumptions and risks explicitly; don't bury them.
</communication>

<scope>
Every changed line should trace to the request.

- If a request is ambiguous, surface the interpretations and ask — don't pick silently, especially for the sync/crypto contract where a wrong guess is hard to reverse.
- No abstractions for single-use code, no config that wasn't asked for.
- Cleanup of code you're already touching is fine; don't wander into unrelated files. Flag out-of-scope issues instead of silently fixing or ignoring them.
</scope>

## Instruction Scope

- `CLAUDE.md` is the authoritative instruction file for Claude Code in this workspace (root and both components).
- `AGENTS.md` is for other agents/tools — **ignore it** as Claude Code.

## Workspace Layout

Two components, **two git repos**:

| Path | Role | Repo |
|------|------|------|
| `orange-copy-paste-clipboard-app-rust/` | Desktop Smart Clipboard app (React + TypeScript + Vite + Tauri/Rust). Clipboard, notes, and cloud-sync domains. | Part of the **parent** repo (`RoverTools` → renamed `RoverTools-Smart-Clipboard-App-RUST`) |
| `orange-copy-paste-clipboard-backend/` | Cloud-sync API: FastAPI + Supabase (Postgres + GoTrue Auth) + Redis + S3/R2 blobs. | **Submodule** — its own repo (`RoverTools-Smart-Clipboard-App-Backend`) |

The client lives **directly** in the parent repo; only the backend is a submodule. Default branch on both repos is `main`.

## Project Overview

A user copies text/images/files (or writes notes) on one device and sees them on every other device, with **optional real-time sharing** to other users — all **end-to-end encrypted**, so the server never sees plaintext.

**Two halves, one contract:**

- **Client** captures the clipboard, stores history + notes locally, holds all key material, and does all encryption/decryption. The Rust side owns the crypto and sync engine; React is the UI.
- **Backend** is a stateless relay + store: it verifies Supabase JWTs (never signs), persists ciphertext, fans out changes over WebSocket, and brokers blob storage. It is the **source of truth for the wire contract**.

**Core sync flow:** client authenticates with Supabase → `POST /api/v1/auth/bootstrap` (gets `kdf_salt`) → derives the User Master Key → registers a device → pushes/pulls encrypted entries (last-write-wins) → receives live updates over `/ws`. Deletes are **tombstones** (a push with `deleted_at`), not a DELETE route.

**Sharing:** persistent **pool groups** and ephemeral **Live Share** sessions, both built on a random per-group **Group Key** distributed via X25519 key wrapping.

Specifics (models, quotas, exact payloads) change — **treat the code as source of truth.**

### Tech Stack

- **Client app** (`orange-copy-paste-clipboard-app-rust/`): React 19 + TypeScript + Vite frontend (`src/`); Tauri v2 + Rust backend (`src-tauri/`). Package manager **bun**. Rust sync deps: `reqwest`, `tokio`, `tokio-tungstenite`, `aes-gcm`, `argon2`, `x25519-dalek`, `sha2`, `keyring`, `zeroize`. History/notes persist as MessagePack; images externalized to disk.
- **Backend** (`orange-copy-paste-clipboard-backend/`): Python **3.14+**, FastAPI + uvicorn, SQLAlchemy async + asyncpg, Alembic, `redis[hiredis]`, `boto3` (S3/R2), `pyjwt` (HS256), `slowapi` (rate limiting). Managed with **`uv`**; lint **ruff**, types **ty**, tests **pytest** (`pytest-asyncio` + `fakeredis`). `Dockerfile` + `docker-compose.yml` present.

## Project Structure

### Client — frontend (`src/`)
- `components/app/App.tsx` — app shell, event wiring, screen state, history/notes sync listeners.
- `components/app/clipboard-screen/ClipboardScreen.tsx` — history UI: grouping, sorting, filtering, bulk ops.
- `components/app/clipboard-screen/entry-card/EntryCard.tsx` — per-entry rendering/interactions.
- `components/app/notes-screen/NotesScreen.tsx` — notes CRUD/editor, grouping, bulk actions.
- `components/app/sync-screen/SyncScreen.tsx` — sync feed UI (groups/sessions; still partly demo-scaffolded).
- `components/app/settings-screen/SettingsScreen.tsx` — sync auth (login/signup), devices/presence, groups, sharing.
- `components/paste-popup/PastePopup.tsx`, `components/copy-popup/CopyPopup.tsx` — quick-paste + capture popups.
- `types.ts` — shared TS types (entries, notes, sync/group/session/device shapes).

### Client — Rust (`src-tauri/src/`)
- `lib.rs` — startup composition root + Tauri command registration.
- `runtime/clipboard_watcher.rs` — clipboard polling + capture pipeline.
- `runtime/hotkeys.rs` — global shortcuts. `runtime/popup_windows.rs` — popup create/position/clamp/hide.
- `runtime/platform/windows.rs` — Windows key simulation, cursor/monitor, popup placement.
- `clipboard/commands.rs`, `clipboard/history.rs` — clipboard handlers; history model, dedupe, persistence, image externalization. Entry ids are **UUIDv4** (double as the cross-device `client_id`).
- `notes/commands.rs`, `notes/store.rs` — notes handlers; MessagePack persistence (`notes.bin`).
- `state/app_state.rs` — shared app state, dirty flags, `sync_client` handle.
- **`sync/`** — the cloud-sync engine:
  - `mod.rs` — `SyncClient` orchestrator (auth, push/pull, merge, group-key handling, blob upload/download).
  - `crypto.rs` — Argon2id UMK, AES-256-GCM content, X25519 device/identity keys, key wrap, SHA-256, keychain.
  - `client.rs` — async HTTP client for the backend API (auth, sync, groups, sharing, blobs).
  - `supabase.rs` — Supabase GoTrue (login/signup/refresh). `ws_listener.rs` — WebSocket receive + dispatch.
  - `commands.rs` — Tauri commands. `config.rs`, `id_map.rs`, `pending_queue.rs`, `sync_state.rs`, `types.rs`.

### Backend (`orange-copy-paste-clipboard-backend/src/`)
- `main.py` — app composition, router mounting, OpenAPI tags. `version.py` — single source for API/service versions + prefixes.
- `dependencies.py` — JWT verification + `X-Device-Id` extraction. `middleware.py` — security headers + `X-API-Version`. `database.py`, `redis_client.py`, `config.py`, `limiter.py`, `background.py`, `email.py`, `supabase_admin.py`.
- `realtime.py` — WebSocket endpoint, in-process hub, Redis pub/sub fan-out, presence.
- `auth/` — profiles, devices, public-key registration, bootstrap; Supabase token verification (`tokens.py`).
- `sync/` — push/pull/cursor, last-write-wins service. `settings/` — encrypted settings blob.
- `groups/` — pool groups + `sharing.py` (Live Share) + group-key distribution.
- `blobs/` — presigned upload/download (`s3.py`), quota. `admin/` — internal stats/ops.
- `migrations/versions/` — Alembic (`0001`…`0006`). `tests/` — pytest (`test_auth`, `test_sync`, `test_blobs`).

## Cross-System Contract & Invariants

These bind the client and backend. Changing one side usually means changing the other — document the contract (payloads, event names, behavior) when you do.

**Auth & identity**
- Supabase Auth owns identity (signup/login/refresh/reset). The backend **verifies** JWTs (PyJWT HS256, `aud="authenticated"`, `sub`=user id) and **never signs**.
- Device-scoped routes require `Authorization: Bearer <jwt>` **and** `X-Device-Id`. WebSocket: `/ws?token=<jwt>&device_id=<id>`.

**End-to-end encryption (client-only)**
- UMK = Argon2id(password, `kdf_salt`); **in-memory only** (`Zeroizing`), never written to disk or logs.
- Content: AES-256-GCM with **AAD = `client_id`** (binds ciphertext to its entry). The per-user **identity keypair is derived deterministically from the UMK** (same on every device, never stored server-side; only the public half is registered).
- Group Keys are random 32-byte keys, X25519-wrapped per member; shared entries encrypt under the Group Key, personal entries under the UMK.
- The server stores only ciphertext, public keys, and opaque wrapped keys — never plaintext.

**Sync semantics**
- Entries are keyed server-side by `(user_id, client_id, entry_type)`; `entry_type` is `"clipboard"` or `"note"` (singular).
- Last-write-wins on `updated_at`; **tombstones always win**. Deletes = a push with `deleted_at` set — there is **no delete route**.
- The Rust side decrypts and merges (only Rust has the UMK); the frontend refreshes on `sync:history-merged` / `sync:notes-merged`.

**API versioning**
- Client routes under `/api/v1`; admin under `/internal/v1`; `/internal/healthz` + `/internal/metrics` unversioned. Every response carries `X-API-Version`. Single source: `src/version.py`.

**Migrations are written, never auto-applied.** Author Alembic migrations, but **never apply them or push DB changes without explicit approval.**

## Non-Negotiable Invariants (Client App)

- Preserve watcher/shortcut **dedupe**; never introduce duplicate captures.
- Respect the **suppress-flag** flow when writing to the clipboard from commands/hotkeys.
- Keep active-clipboard-id updates consistent with copy/paste actions.
- Preserve popup boundary **clamping** and reliable hide behavior.
- Keep pin/clear semantics stable: **clear-all must preserve pinned entries**.
- Don't regress file-backed image behavior or large-image performance.
- Keep group operations consistent across clipboard entries **and** notes.
- Sync must never echo a merge back as a new push, and must skip self-device entries.
- Be careful with autostart while running `tauri dev` (dev-path startup entries can break launches without Vite).

## Commands

**Client** (from `orange-copy-paste-clipboard-app-rust/`):
- Install: `bun install` · Frontend dev: `bun run dev` · Full app: `bun run tauri dev`
- Frontend typecheck+build: `bun run build` · Rust check: `cd src-tauri && cargo check` · Bundle: `bun run tauri build`

**Backend** (from `orange-copy-paste-clipboard-backend/`, via `uv`):
- Lint: `uv run ruff check src` · Types: `uv run ty check src` · Tests: `uv run pytest`
- Run: `uv run uvicorn src.main:app --reload` · Or full stack: `docker-compose up`

> `ruff`/`ty` aren't on the venv PATH — always invoke through `uv run`.

## Verification Rules

Pick the smallest valid check set for what you touched.

- **Client frontend** → `bun run build`.
- **Client Rust/Tauri** → `cd src-tauri && cargo check`.
- **Behavior-sensitive runtime** (watcher/hotkeys/popup/paste/sync) → `bun run tauri dev` and smoke-test that specific flow. Full E2E sync needs a live backend + Supabase + two accounts; if you can't run it, say so — don't claim it works.
- **Backend Python** (any file) → always `uv run ty check src` and `uv run ruff check src`; fix all errors before done. Run `uv run pytest` for logic changes. Don't suppress with `# type: ignore` unless it's a documented third-party-stub false positive.

## Git & Repos

- The **client** is committed in the parent repo; the **backend** is a submodule with its own repo. Keep each commit scoped to one repo; don't bundle a submodule-pointer bump with client code unless coordinating a release.
- Backend work goes on its **own dedicated branches** in the backend repo. Compare/PR against each repo's `main`.
- **`uv.lock` churn:** `uv run` can regenerate `uv.lock`. If a task didn't intend a dependency change, restore it (`git checkout -- uv.lock`) so the commit stays scoped.
- Never apply migrations, push, or commit-push without explicit approval.

## Docs & Source Priority

Use live code first; docs are context and may be stale — confirm behavior in code, and report mismatches rather than trusting docs.

- Client: `orange-copy-paste-clipboard-app-rust/docs/ARCHITECTURE.md`, `docs/BUGFIX_HISTORY.md` (high-value regression history), `README.md`.
- Backend: `orange-copy-paste-clipboard-backend/docs/ARCHITECTURE.md` (the definitive sync/crypto/contract reference), `TODO.md`.
- Root `docs/ARCHITECTURE.md` — shared/workspace-level context. Read selectively; if it conflicts with code, trust the code.

## Token-Saving

- Read only files tied to the task; inspect targeted sections of large files first.
- Prefer concise in-place diffs over wide refactors; don't repeat architecture already known from code/docs.
- Summarize with actionable points; start a fresh context for unrelated tasks.

## Done Criteria

- Relevant checks pass for the touched repo(s).
- No regression in clipboard/notes/sync flows; cross-system contract stays consistent across client and backend.
- Diff is minimal and matches existing patterns.
- Assumptions, risks, and any deferred/untested paths are called out explicitly.
