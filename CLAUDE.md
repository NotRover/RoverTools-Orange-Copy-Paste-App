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

- `CLAUDE.md` is the authoritative instruction file for Claude Code in this workspace (root and all three components).
- `AGENTS.md` is for other agents/tools — **ignore it** as Claude Code.

## Workspace Layout

Three components, **three git repos**:

| Path | Role | Repo |
|------|------|------|
| `orange-copy-paste-clipboard-app-rust/` | Desktop Smart Clipboard app (React + TypeScript + Vite + Tauri/Rust). Clipboard, notes, and cloud-sync domains. | Part of the **parent** repo (`RoverTools` → renamed `RoverTools-Smart-Clipboard-App-RUST`) |
| `orange-copy-paste-clipboard-backend/` | Cloud-sync API: FastAPI + Supabase (Postgres + GoTrue Auth) + Redis + S3/R2 blobs. | **Submodule** — its own repo (`RoverTools-Smart-Clipboard-App-Backend`) |
| `orange-copy-paste-clipboard-website/` | Public docs + presentation site (Astro + Starlight, bun). End-user how-to and the marketing landing page. | **Submodule** — its own repo (`RoverTools-OrangeCP-Website`) |

The client lives **directly** in the parent repo; the backend and the website are each submodules with their own repos. Default branch on all three repos is `main`.

## Project Overview

A user copies text/images/files (or writes notes) on one device and sees them on every other device, with **optional real-time sharing** to other users — all **end-to-end encrypted**, so the server never sees plaintext.

**Two halves, one contract:**

- **Client** captures the clipboard, stores history + notes locally, holds all key material, and does all encryption/decryption. The Rust side owns the crypto and sync engine; React is the UI.
- **Backend** is a stateless relay + store: it verifies Supabase JWTs (never signs), persists ciphertext, fans out changes over WebSocket, and brokers blob storage. It is the **source of truth for the wire contract**.

**Core sync flow:** client authenticates with Supabase → bootstraps the account → unwraps the User Master Key → registers a device → pushes and pulls encrypted entries, last-write-wins → receives live updates over a WebSocket. Deletes travel as tombstones.

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
- `components/app/account-screen/AccountScreen.tsx` — sync auth (login/signup/Google), cloud sync mode (realtime/passive/manual), devices/presence, storage. No sharing UI - that lives on the Spaces screen.
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
  - `crypto.rs` — password-derived key unwrap, AES-256-GCM content, X25519 device/identity keys, key wrap, SHA-256, keychain.
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

## Cross-System Contract

**The backend defines the contract, and its `docs/ARCHITECTURE.md` is the readable form of
it.** Read that file before changing anything that crosses the wire, and update it in the
same commit — payload shapes, event names, key derivation, the entry keying tuple and the
route prefixes all live there and are deliberately not repeated here, because a second copy
is a copy that goes stale. Who-may-do-what is `docs/PERMISSIONS.md`; the promises neither
side can keep alone are the root `docs/ARCHITECTURE.md`.

What you need before you have read any of it — shapes and prohibitions, no values:

- **Changing one side means changing the other.** A wire change is a two-repo change; assume
  it until you have checked.
- **Supabase owns identity.** The backend *verifies* tokens and **never signs** one. A design
  that needs the backend to issue a token is the wrong design.
- **Some routes are device-scoped.** Go through the shared dependencies in
  `dependencies.py` — never re-parse a token inside a route.
- **The client does all the crypto**, and the backend holds no key that opens anything it
  stores. Key material lives in memory only (`Zeroizing`) and never reaches disk, a log, or
  an IPC response. Never reimplement any of it in TypeScript.
- **Deletes travel as tombstones, not a delete route.** If you are looking for a `DELETE`
  endpoint for an entry, you are looking for something that does not exist.
- **Content is encrypted per entry, not under a master key.** Adding a sharing target is a
  key-wrapping change, never a re-encryption.

**Never assume a green deploy migrated.** `render.yaml` sets `preDeployCommand: alembic upgrade head`, but that field is paid-plan only and inert on `free`, and the deploy reports success either way — so a merged revision may or may not have reached the database, and the failure that produces is a live route 500ing on `relation ... does not exist`. Check rather than assume: the backend's **Migrate database** workflow previews the pending DDL automatically on any push to `main` that touches `migrations/**`, and applying is a separate deliberate dispatch of the same workflow (`action=upgrade`, `confirm=migrate`). Author and review migrations freely, but **never run them against a real database or push DB changes without explicit approval.** Details in the backend's `docs/DEPLOY.md`.

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

**Everywhere — docs, comments, copy, commits**
- **Never write the section sign (U+00A7).** Reference a section by number or name instead: "section 7.4", "sections 5.1-5.6", "the Cross-System Invariants section". Unlike the copy rules below, this one covers everything you write: markdown docs, code comments, commit messages, PR bodies, and chat replies.

**Client — the Rust/React boundary**
- Rust owns state, persistence, and **all** crypto; React is UI. Never reimplement encryption, key handling, or merge logic in TypeScript.
- Frontend → Rust: `invoke<T>("command_name", { camelCaseArgs })` from `@tauri-apps/api/core`. Commands are snake_case and domain-prefixed (`spaces_list`, `space_set_send_filter`, `get_setting`); register new ones in `lib.rs`.
- Tauri commands return `Result<T, String>` — surface errors as strings, don't panic in command paths.
- Rust → Frontend: events are namespaced `domain:event` in kebab-case (`clipboard:new-entry`, `sync:history-merged`, `sync:status-changed`). Match that shape for new events and update both sides together.
- Shared TS shapes live in `src/types.ts`; keep them in sync with the serde structs they mirror.
- Screens keep their own CSS next to the component; shared page-header/section styles come from `settings-screen/SettingsScreen.css`.

### User-Facing Copy: No AI Slop

Covers every string a user reads: labels, buttons, empty states, toasts, errors, emails, landing copy. Not code comments, commit messages, or PR bodies.

- ASCII punctuation only. No `—`, `–`, `“ ” ‘ ’`, `…`, `•`, `→`, `×`, `✓`, `★`, `✨`, non-breaking spaces, the section sign. Hyphens are fine ("real-time"). Emoji only if the design calls for it, never as an icon.
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
- **Website** (`orange-copy-paste-clipboard-website/`, any content or config) → `bun run build` from the submodule; it typechecks and generates the static output. See that submodule's own `CLAUDE.md`.

## Git & Repos

- The **client** is committed in the parent repo; the **backend** and the **website** are each submodules with their own repos. Keep each commit scoped to one repo; don't bundle a submodule-pointer bump with client code unless coordinating a release.
- Backend and website work each go on their **own dedicated branches** in their own repos. Compare/PR against each repo's `main`.
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
- **Release notes live in `changelog/`** — one file per release, staged in
  `changelog/next.md`, authored before a release with `/update-changelog` (or by hand)
  and published verbatim, so they are user-facing copy and the No-AI-Slop rules apply.
  `feat` → New, `perf`/refinements → Improved, `fix`/`revert` → Fixed; internal work
  (backend, MCP, refactors, CI, docs) → `### Internal`, which is kept for the record but
  dropped before publishing. Write sentences about the app, not the repo; the app's
  "What's new" panel renders the lead line and the sections, so keep that format. The
  workflow reads `next.md`, publishes it, then renames it to
  `changelog/<version>-<bump>-<channel>.md` and opens a fresh `next.md` — never rename or
  hand-edit a shipped file. **An empty `next.md` fails a real release on purpose.**
- The minisign signing key is the one irreplaceable secret: never read, print or commit it,
  and let the user run anything that touches it. Losing it kills updates for every install.
- Updates are off in debug builds by design, so the flow can only be verified from two
  published releases — never from `tauri dev`.

## Docs & Source Priority

Live code first. Docs are context and go stale — confirm behavior in code, and report a
mismatch rather than trusting the doc.

**One fact, one home.** A fact lives where it is enforced, and nowhere else. Every other
doc that needs it links to that home instead of restating it. This is the only rule that
keeps a doc set this size true: three copies of the wire contract cannot be kept in step
by intention, and the copy that drifts is the one nobody was reading when it broke.

| Fact | Home |
|------|------|
| Wire contract — routes, payloads, DDL, socket events, crypto envelope | `orange-copy-paste-clipboard-backend/docs/ARCHITECTURE.md` |
| Client internals — state, commands, events, persistence, runtime behavior | `orange-copy-paste-clipboard-app-rust/docs/ARCHITECTURE.md` |
| Who may do what, and where it is enforced | `docs/PERMISSIONS.md` |
| Regressions and their root causes | `orange-copy-paste-clipboard-app-rust/docs/BUGFIX_HISTORY.md` |
| The release pipeline | `docs/RELEASING.md` |
| User-facing release history, and the next release's notes | `changelog/` — one file per release, staged in `changelog/next.md` (skeleton `changelog/TEMPLATE.md`, convention `changelog/README.md`) |
| End-user how-to and the public marketing site | `orange-copy-paste-clipboard-website/` — its own repo (Astro + Starlight). Describes product behavior for users; links to the contract/internals homes rather than restating them |
| How to work in this repo | `CLAUDE.md` — process, plus enough orientation to navigate. Names of things, yes; **values** that can drift (exact payloads, KDF parameters, route strings) belong to the homes above |
| Where everything lives, and cross-component invariants with no other home | `docs/ARCHITECTURE.md` — a map, not a description |

Every reference doc opens with a two-line **Owns / Not here** header naming what only it
may say and where the neighbouring facts live. Read it before adding to that file: if what
you are about to write belongs to another home, edit that home instead. Deleting a
duplicate you happen to be standing next to is always in scope.

Two consequences worth stating outright, because both are easy to get wrong:

- **A contract change is one edit, not four.** Change the backend doc. Add a
  `docs/PERMISSIONS.md` row only if the change is about *who may*, and a client-doc row
  only if it is about client internals. Do not restate the payload anywhere.
- **A README is a front door, not a reference.** It may say what the thing is and how to
  run it. Anything a reader could act on wrongly — a payload, a key derivation, a
  precedence rule — is a link.

**Design memos have a lifecycle.** `docs/SPACE-*.md` are memos: they argue for a change
before it exists, so while a design is unbuilt the memo is its home and may hold the whole
spec. **On ship, the memo shrinks to a decision record** — the rejected alternatives and
why, which is the one thing the reference docs deliberately do not carry — and everything
the code now enforces is deleted, having moved to the homes above. A memo left whole after
shipping is a second wire contract with no owner.

- Root `docs/_doc-template.html` — the house style for a rendered walkthrough. See Visual
  Docs below.

## Visual Docs

Some things do not land as markdown: a before/after UX change, a flow whose point is the
*order* of events, a mechanism where the interesting part is what a person sees at each
step. Those get a rendered HTML page with real diagrams. Prose docs stay markdown — this is
for explaining a change to a human, not for the durable spec.

**A walkthrough is dated and then left alone.** It explains one change at one moment, so it
is exempt from One fact, one home for the same reason it is cheap: nobody has to keep it
true. Say so in its header, date it, and never update it when the contract moves — the
reference doc is what moves. A walkthrough that gets maintained has quietly become a
fourth copy of the spec.

**Start from the template, never from scratch.** `docs/_doc-template.html` carries the
stylesheet, the font links, the mermaid init line, and a commented skeleton of every block.
Copy it, replace the body, leave the `<style>` alone. Reference implementation:
`docs/space-key-handover.html`.

**The token set.** Cool graphite neutrals biased toward the accent's complement, so the
app's orange reads as a decision. Never write a literal hex in the body, and never define a
colour *only* inside a media query or `[data-theme]` block — a page that does renders one
theme's text on the other theme's ground.

| Role | Tokens |
|---|---|
| Ground / ink / rules | `--paper` `--paper-2` `--paper-3` · `--ink` `--ink-2` `--ink-3` · `--rule` `--rule-hard` |
| States | `--accent` (the app's orange, deepened — reserved for the *after* state) · `--slate` (waiting) · `--rust` (refused, dead end), each with a `-dim` fill |
| Diagram plates | `--plate` `--plate-2` `--plate-rule` `--plate-ink` `--plate-ink-2` — **fixed dark in both themes** |
| Measure / scale | `--measure: 66ch` · `--step--1` through `--step-4` |

Full light palette on bare `:root`; the same tokens redefined under both
`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` and
`:root[data-theme="dark"]`, so an explicit choice wins in either direction and the
un-stamped "system" state still resolves.

**Three type roles, and mono is load-bearing.** **Archivo** 500-800 for headings, eyebrows
and labels; **Source Serif 4** for prose; **JetBrains Mono** for identifiers *and* for
literal product strings. Mono means "this is what the product actually shows" — that is
information, not emphasis. Never set prose in it. Fonts come from
`https://fonts.googleapis.com`, the only font host an Artifact's CSP admits.

**Diagram plates are fixed dark on purpose.** Mermaid takes one theme config per figure and
cannot follow a theme swap, so a plate that tried to be light-aware would be unreadable in
one of the two. Every mermaid block opens with this line verbatim, first line inside the
`<pre class="mermaid">`, no blank line before it:

```
%%{init: {'theme':'base','themeVariables':{'background':'#171C23','primaryColor':'#1F262F','primaryTextColor':'#DEE3E9','primaryBorderColor':'#3C4652','lineColor':'#7E8B99','textColor':'#C1CAD4','fontFamily':'JetBrains Mono, monospace','fontSize':'13px','actorBkg':'#1F262F','actorBorder':'#4A5666','actorTextColor':'#DEE3E9','actorLineColor':'#3C4652','signalColor':'#94A1AF','signalTextColor':'#C1CAD4','labelBoxBkgColor':'#1F262F','labelBoxBorderColor':'#3C4652','labelTextColor':'#DEE3E9','loopTextColor':'#C1CAD4','noteBkgColor':'#2A2118','noteTextColor':'#F0D9C0','noteBorderColor':'#7A5A38','altBackground':'#1B222A','sequenceNumberColor':'#171C23'}}}%%
```

One figure, one claim. The claim goes in the `figcaption`, never inside the drawing.

**The structural blocks, and what each one is for.** Structure encodes something true or it
does not appear.

- `.rails` — two panels, was and now, when one mechanism is the whole point of the page.
- `.ledger` — `surface | cell--was | cell--now`. The only shape for a per-surface
  comparison; a numbered list would imply an order that is not there.
- `.plate` — a diagram on the dark ground, mermaid or hand-authored SVG.
- `.notes` — short honest limits. **Not optional:** a doc that only lists wins is a pitch,
  not a record.
- `.chk--pass` / `.chk--open` — verification status. Never mark passed what was not run.

**Two ways to ship the same file.** As an Artifact, publish it as-is: the host supplies the
document wrapper and renders mermaid natively. As a repo file in `docs/`, add the doctype
wrapper, a four-rule CSS reset, and the mermaid ESM loader from jsDelivr before `</body>`.
Keep both copies in step when a page is published and committed.

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
