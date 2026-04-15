# CLAUDE.md - RoverTools Workspace Guide

This workspace has two submodules. Apply these instructions to both.
Keep edits minimal, verify changes, and avoid unnecessary token usage.

## Workspace Layout

- `orange-copy-paste-clipboard-app-rust/`: desktop Smart Clipboard app (React + TypeScript + Tauri + Rust) with clipboard and notes domains.
- `orange-copy-paste-clipboard-backend/`: backend/web-server submodule (currently scaffold stage; README-only, no active source files yet).

## Source Priority

Use live code first, then docs for context.

- `orange-copy-paste-clipboard-app-rust/README.md`
- `orange-copy-paste-clipboard-app-rust/docs/ARCHITECTURE.md`
- `orange-copy-paste-clipboard-app-rust/src-tauri/src/**`
- `orange-copy-paste-clipboard-app-rust/src/components/**`
- `orange-copy-paste-clipboard-app-rust/docs/BUGFIX_HISTORY.md` (high-value regression history)

Docs may be stale. Confirm behavior from current code before making assumptions.

## App Submodule: Key Commands

Run from `orange-copy-paste-clipboard-app-rust/`.

- Install deps: `bun install`
- Frontend dev: `bun run dev`
- Tauri app dev: `bun run tauri dev`
- Frontend typecheck/build: `bun run build`
- Rust compile check: `cd src-tauri && cargo check`
- Desktop bundle: `bun run tauri build`

## Backend Submodule: Current State

- Intended role: web server / API functionality.
- Current repository state: minimal scaffold (no implementation files yet).
- If backend code is added, detect stack from lockfiles/manifests and then add only stack-specific commands and rules.

## App Submodule: High-Impact Files

Frontend:

- `src/components/app/App.tsx`: app shell, event wiring, screen state, and history synchronization.
- `src/components/app/clipboard-screen/ClipboardScreen.tsx`: main history UI, grouping, sorting, filtering, bulk operations.
- `src/components/app/clipboard-screen/entry-card/EntryCard.tsx`: per-entry rendering and interactions.
- `src/components/app/notes-screen/NotesScreen.tsx`: notes CRUD/editor UI, note grouping/filtering, and notes-specific bulk actions.
- `src/components/paste-popup/PastePopup.tsx`: quick-paste popup behavior and selection flow.
- `src/components/copy-popup/CopyPopup.tsx`: capture confirmation popup.

Rust/Tauri backend:

- `src-tauri/src/lib.rs`: startup composition root and command registration.
- `src-tauri/src/runtime/clipboard_watcher.rs`: clipboard polling and capture pipeline.
- `src-tauri/src/runtime/hotkeys.rs`: global shortcuts and handlers.
- `src-tauri/src/runtime/platform/windows.rs`: Windows key simulation, cursor/monitor handling, and popup placement primitives.
- `src-tauri/src/runtime/popup_windows.rs`: popup creation/position/clamping/hide logic.
- `src-tauri/src/clipboard/commands.rs`: clipboard command handlers for copy/paste/history actions.
- `src-tauri/src/clipboard/history.rs`: history model, dedupe logic, persistence, image externalization.
- `src-tauri/src/notes/commands.rs`: notes command handlers (CRUD, pinning, grouping).
- `src-tauri/src/notes/store.rs`: notes model and MessagePack persistence (`notes.bin`).
- `src-tauri/src/state/app_state.rs`: shared app state and runtime flags.

## Non-Negotiable Invariants (App)

- Preserve watcher/shortcut dedupe behavior; do not introduce duplicate captures.
- Respect suppress-flag flow when writing to clipboard from commands/hotkeys.
- Keep active clipboard id updates consistent with copy/paste actions.
- Preserve popup boundary clamping and reliable hide behavior.
- Keep pin/clear semantics stable: clear-all must preserve pinned entries.
- Avoid regressing file-backed image behavior and large-image performance.
- Keep group operations consistent across clipboard entries and notes when changing group logic.
- Be careful with autostart while running `tauri dev` (dev-path startup entries can break launches without Vite).

## Cross-Submodule Working Rules

- Do not modify both submodules unless the task explicitly requires coordination.
- If cross-submodule changes are needed, document contract clearly (API payloads, command names, expected behavior).
- Keep each commit logically scoped by submodule where possible.

## Verification Rules

Pick the smallest valid check set for the files changed.

- App frontend changes: `bun run build`
- App Rust/Tauri changes: `cd src-tauri && cargo check`
- Behavior-sensitive runtime changes (watcher/hotkeys/popup/paste): run `bun run tauri dev` and smoke test that specific user flow.
- Backend changes (when code exists): run that stack's lint/type/test commands only after discovering them from manifests.

## Token-Saving Strategy

- Read only files tied to the task; avoid broad recursive reads.
- For large files, inspect targeted sections first, expand only when necessary.
- Prefer concise in-place diffs over wide refactors.
- Do not repeat architecture details already known from local docs/code.
- Summarize findings with actionable points only.
- For unrelated tasks, start a fresh session/context.

## Done Criteria

A task is complete when:

- Relevant checks pass for touched submodule(s).
- No obvious regression in impacted clipboard/server flow.
- Diff is minimal and consistent with existing patterns.
- Assumptions and risks are explicitly called out.
