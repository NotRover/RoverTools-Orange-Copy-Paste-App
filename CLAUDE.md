# CLAUDE.md — RoverTools Workspace Guide

RoverTools is a **cross-device Smart Clipboard product**: a Tauri desktop app plus an end-to-end-encrypted cloud-sync backend. Keep edits minimal, verify against live code, and treat the docs as context — not truth.

<communication>
Be concise and direct. Match length to the task.

- Plain language; no filler or preamble ("Great question!", "I'll now…", "It's worth noting…").
- No recap of what was just said; no restating the request back before answering.
- When summarizing changes, say what changed and why — skip the line-by-line walkthrough unless asked.
- Surface assumptions and risks explicitly; don't bury them.
- Don't pad. If the answer is one line, let it be one line.
</communication>

<scope>
Every changed line should trace to the request.

- If a request is ambiguous, surface the interpretations and ask — don't pick silently, especially for the sync/crypto contract where a wrong guess is hard to reverse.
- No abstractions for single-use code, no config that wasn't asked for.
- Cleanup of code you're already touching is fine; don't wander into unrelated files. Flag out-of-scope issues instead of silently fixing or ignoring them.
</scope>

<working-notes>
Context is lossy — compaction and long sessions wash out earlier detail. On any multi-step or multi-file task (especially anything crossing the client/backend contract), lean on durable tools — todo lists for tracking, a working-notes file for the reasoning — instead of trusting the context window to hold it.

**File:** `.scratch/<YYYY-MM-DD>-<topic-slug>.md` at the workspace root — e.g. `2026-08-12-group-key-rewrap.md`. Gitignored; never commit it. One file per task/topic, reused across sessions.

**Contents, terse:** goal + issue/PR link · plan checklist · decisions with one-line rationale · current state & next step · key files as `path:line` · which repo(s) each change lands in · verification run so far (checks passed/failed) · blockers/open questions.

**Discipline:** create it early, before you're lost. Update after each meaningful step — record decisions and results as they happen (including approaches ruled out and why); prune stale notes. After a compaction, or when context feels thin, re-read it before acting. Delete it once shipped.
</working-notes>

## Subagents

- **Always spawn subagents on Opus** — pass the model explicitly (`model: "opus"`). Never Sonnet or Haiku, regardless of how small the task looks.
- Subagents inherit none of this session's context — restate the goal, the relevant `path:line`, and which repo the work lands in.

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

**Sharing:** one primitive, the **Space** - persistent, live, any number of members, and a user can be in several at once. Each space has a random **Space Key** (kept as a keyring, newest first) distributed to members via X25519 key wrapping.

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
- `components/app/spaces-screen/SpacesScreen.tsx` — Spaces: shared feed, create/join, invites, members, per-space auto-copy and send filters.
- `components/app/account-screen/AccountScreen.tsx` — sync auth (login/signup/Google), cloud sync mode (realtime/passive), devices/presence, storage. No sharing UI - that lives on the Spaces screen.
- `components/app/settings-screen/SettingsScreen.tsx` — app preferences (slots, storage folder, history behavior); owns the shared `scr-*`/`set-section-*` styles other screens reuse.
- `components/app/shortcuts-screen/ShortcutsScreen.tsx` — hotkey reference.
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
- `spaces/` — spaces, invites, and space-key distribution.
- `blobs/` — presigned upload/download (`s3.py`), quota. `admin/` — internal stats/ops.
- `migrations/versions/` — Alembic (`0001`…`0011`; `0011_spaces` is written but **not applied** and is destructive). `tests/` — pytest (`test_auth`, `test_sync`, `test_blobs`, `test_spaces_invites`).

## Cross-System Contract & Invariants

These bind the client and backend. Changing one side usually means changing the other — document the contract (payloads, event names, behavior) when you do.

**Auth & identity**
- Supabase Auth owns identity (signup/login/refresh/reset). The backend **verifies** JWTs (PyJWT: ES256/RS256 via the project JWKS, legacy HS256 shared secret; `aud="authenticated"`, `sub`=user id) and **never signs**.
- Device-scoped routes require `Authorization: Bearer <jwt>` **and** `X-Device-Id`. WebSocket: `/ws?token=<jwt>&device_id=<id>`.

**End-to-end encryption (client-only)**
- UMK is a **random 32-byte key** (envelope model). The password derives only a wrapping key `KEK = Argon2id(password, kdf_salt)`; the UMK is stored server-side wrapped (`pw_wrapped_umk`, AES-GCM) and unwrapped on login. Both live **in-memory only** (`Zeroizing`), never written to disk or logs. A wrong password → GCM unwrap failure. OAuth (Google) users set an account password that serves as this secret.
- Content: AES-256-GCM with **AAD = `client_id`** (binds ciphertext to its entry). The per-user **identity keypair is derived deterministically from the UMK** (same on every device, never stored server-side; only the public half is registered).
- Content is encrypted once under a random per-entry **CEK**; the CEK is wrapped under the UMK (`"personal"`) and under each target space's key, so one entry can be in several spaces. `wrapped_keys` is opaque to the server; `space_ids` is what it fans out on. Removing a member rekeys the space; revocation is best-effort for entries already pulled.
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
- `id_map.json` (and `entry_states()` on top of it) is **this device's** record of what it pushed or pulled — never a view of the account. Anything account-wide (removing cloud copies, quota, reconciliation) must ask the server; a row another device pushed is invisible locally. See bug #7 in `docs/BUGFIX_HISTORY.md`.
- Be careful with autostart while running `tauri dev` (dev-path startup entries can break launches without Vite).

## Code Conventions

**Client — the Rust/React boundary**
- Rust owns state, persistence, and **all** crypto; React is UI. Never reimplement encryption, key handling, or merge logic in TypeScript.
- Frontend → Rust: `invoke<T>("command_name", { camelCaseArgs })` from `@tauri-apps/api/core`. Commands are snake_case and domain-prefixed (`spaces_list`, `space_set_send_filter`, `get_setting`); register new ones in `lib.rs`.
- Tauri commands return `Result<T, String>` — surface errors as strings, don't panic in command paths.
- Rust → Frontend: events are namespaced `domain:event` in kebab-case (`clipboard:new-entry`, `sync:history-merged`, `sync:status-changed`). Match that shape for new events and update both sides together.
- Shared TS shapes live in `src/types.ts`; keep them in sync with the serde structs they mirror.
- Screens keep their own CSS next to the component; shared page-header/section styles come from `settings-screen/SettingsScreen.css`.

### User-Facing Copy: No AI Slop

Covers every string a user reads: labels, buttons, empty states, toasts, errors, emails, landing copy. Not code comments, commit messages, or PR bodies.

- ASCII punctuation only. No `—`, `–`, `“ ” ‘ ’`, `…`, `•`, `→`, `×`, `✓`, `★`, `✨`, non-breaking spaces. Hyphens are fine ("real-time"). Emoji only if the design calls for it, never as an icon.
- No stock AI words: delve, tapestry, landscape, seamless, robust, elevate, empower, unlock, transform, unleash, supercharge, leverage, utilize, harness, journey, effortless.
- No stock shapes: "It's not just X, it's Y", three-adjective lists, "In today's ... world", Furthermore/Moreover openers, two-abstract-noun feature titles ("Seamless Integration").
- Short, specific, concrete. Name the real action or number. Cut any sentence that can go without losing meaning.

**Backend**
- Routers stay thin: HTTP concerns in the route, logic in the domain service. Versions and route prefixes come from `src/version.py` — never hardcode `/api/v1`.
- Device-scoped routes go through the shared JWT + `X-Device-Id` dependencies in `dependencies.py`; don't re-parse tokens per route.

## Commands

**Client** (from `orange-copy-paste-clipboard-app-rust/`):
- Install: `bun install` · Frontend dev: `bun run dev` · Full app: `bun run tauri dev`
- Frontend typecheck+build: `bun run build` · Rust check: `cd src-tauri && cargo check` · Bundle: `bun run tauri build`
- Release (from the workspace root, only when asked): `/create-rovertools-orangecp-release`, or `gh workflow run release.yml -f bump=… -f prerelease=… -f dry_run=…`

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
- **Commit only when the user asks in that turn** — never proactively, and never bundle a push with it.
- Commit messages: lowercase `type(scope): subject`, then 3–5 single-line bullets on what changed and why. No wall of text, and **no AI attribution footer** (`Co-Authored-By`, "Generated with…") anywhere — commits, PRs, or comments.
- PRs are always opened as drafts (`gh pr create --draft`); never merge or mark ready without being asked. When editing a PR body, fetch the existing body first and splice — don't clobber screenshots or bot summaries.

## Releases (client only)

Shipping is one dispatch of `.github/workflows/release.yml`: it bumps the version, builds
signed bundles and publishes them to the **public** `Spectrewolf8/RoverTools-Releases` repo
the in-app updater reads. The backend has no release pipeline. Reference:
[`docs/RELEASING.md`](docs/RELEASING.md).

- **Never dispatch unless the user asks in that turn**, and never guess the three inputs —
  bump, channel, mode. Ask for whatever wasn't stated; the
  `/create-rovertools-orangecp-release` skill enforces this.
- **Never hand-edit what the workflow owns:** versions, tags, `latest.json`, `beta.json`,
  or a published release's prerelease flag.
- `src-tauri/Cargo.toml` is the single source of version truth (`tauri.conf.json` has no
  `version` field on purpose; `package.json`'s copy is cosmetic). Only plain `vX.Y.Z` tags
  are releases — `v0.1.0-build.N` are throwaway CI builds.
- **Commit subjects become the release notes**, so they are user-facing copy and the
  No-AI-Slop rules apply. Only `feat`/`fix`/`perf`/`revert` reach users; internal types and
  the workflow's own `release: vX.Y.Z` are filtered out. Write a sentence about the app,
  not about the repo, and pick the type deliberately — `chore:` means users are not told.
- The minisign signing key is the one irreplaceable secret: never read, print or commit it,
  and let the user run anything that touches it. Losing it kills updates for every install.
- Updates are off in debug builds by design, so the flow can only be verified from two
  published releases — never from `tauri dev`.

## Docs & Source Priority

Use live code first; docs are context and may be stale — confirm behavior in code, and report mismatches rather than trusting docs.

- Client: `orange-copy-paste-clipboard-app-rust/docs/ARCHITECTURE.md`, `docs/BUGFIX_HISTORY.md` (high-value regression history), `README.md`.
- Backend: `orange-copy-paste-clipboard-backend/docs/ARCHITECTURE.md` (the definitive sync/crypto/contract reference), `TODO.md`.
- Root `docs/ARCHITECTURE.md` — shared/workspace-level context. Read selectively; if it conflicts with code, trust the code.
- Root `docs/RELEASING.md` — the release pipeline: setup, channels, safety rails, smoke test. Read before touching `.github/workflows/release.yml`.

## Token-Saving

- Read only files tied to the task; inspect targeted sections of large files first.
- Prefer concise in-place diffs over wide refactors; don't repeat architecture already known from code/docs.
- Summarize with actionable points; start a fresh context for unrelated tasks.

## Done Criteria

- Relevant checks pass for the touched repo(s).
- No regression in clipboard/notes/sync flows; cross-system contract stays consistent across client and backend.
- Diff is minimal and matches existing patterns.
- Assumptions, risks, and any deferred/untested paths are called out explicitly.

## Compact Instructions

When compacting, preserve — in enough detail to act on without the original messages:
- **Task & goal** — the active request, what "done" means, and the issue/PR link.
- **Decisions + rationale** — every settled choice and its one-line why, so nothing gets relitigated.
- **Current state & next step** — what's done, what's in progress, and the exact next action.
- **Critical facts** — key `path:line`, contract details (payloads, event names, key handling), root causes, and gotchas discovered.
- **Repo/branch context** — which repo each pending change belongs to (parent vs backend submodule), branch names, and whether anything is committed.
- **Verification state** — which checks were run and their results; which flows are untested and why.
- **User instructions** — explicit directions and constraints given this session.
- **Open blockers / questions** — anything unresolved or awaiting the user.
- **The working-notes file path** (`.scratch/…`), so it can be re-read after the summary.

Safe to compress or drop: verbose file/tool output (keep the `path:line`, not the dump), resolved dead-ends (keep a one-line "ruled out X because Y"), and preamble or chit-chat.
