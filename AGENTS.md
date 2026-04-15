# AGENTS.md

Agent playbook for this workspace.
Treat this as a README for coding agents: concise, actionable, and verification-oriented.

## Project Overview

- Workspace has two submodules:
  - orange-copy-paste-clipboard-app-rust: desktop Smart Clipboard app (React + TypeScript + Tauri + Rust).
  - orange-copy-paste-clipboard-backend: backend/web-server repo (currently scaffold stage).
- Default scope rule: edit one submodule per task unless the user explicitly asks for cross-submodule work.

## Source of Truth

- Use code as truth; use docs as context.
- Read in this order:
  1. Files directly touched by the task
  2. orange-copy-paste-clipboard-app-rust/README.md
  3. orange-copy-paste-clipboard-app-rust/docs/ARCHITECTURE.md
  4. orange-copy-paste-clipboard-app-rust/docs/BUGFIX_HISTORY.md
  5. CLAUDE.md

## Setup and Commands

- Run from orange-copy-paste-clipboard-app-rust/ unless noted.
- Install deps: bun install
- Frontend dev: bun run dev
- Tauri dev: bun run tauri dev
- Frontend type/build: bun run build
- Rust check: cd src-tauri && cargo check
- Desktop build: bun run tauri build

## Verification Requirements

- Frontend-only changes: run bun run build.
- Rust/Tauri-only changes: run cd src-tauri && cargo check.
- Runtime-sensitive changes (watcher/hotkeys/popup/paste): run bun run tauri dev and smoke test the changed flow.
- If backend code is added: detect stack from manifests first, then run only that stack's checks.
- If checks are skipped, explicitly state what was skipped and why.

## High-Impact Files (Rust App)

- src/components/app/App.tsx: app shell, listeners, and global UI state sync.
- src/components/app/clipboard-screen/ClipboardScreen.tsx: history render/sort/filter/group/bulk workflows.
- src/components/app/clipboard-screen/entry-card/EntryCard.tsx: per-entry rendering and interactions.
- src/components/app/notes-screen/NotesScreen.tsx: notes CRUD/editor/filter/group workflows.
- src/components/paste-popup/PastePopup.tsx: quick-paste UX and trigger path.
- src/components/copy-popup/CopyPopup.tsx: post-copy feedback popup.
- src-tauri/src/lib.rs: startup composition root and command registration.
- src-tauri/src/state/app_state.rs: shared flags/stores across runtime and commands.
- src-tauri/src/runtime/clipboard_watcher.rs: clipboard polling/capture loop.
- src-tauri/src/runtime/hotkeys.rs: global shortcut registration and handlers.
- src-tauri/src/runtime/platform/windows.rs: key simulation, monitor/cursor, popup placement primitives.
- src-tauri/src/runtime/popup_windows.rs: popup create/show/hide and boundary clamping.
- src-tauri/src/clipboard/commands.rs: clipboard command surface.
- src-tauri/src/clipboard/history.rs: history model, dedupe, persistence, image externalization.
- src-tauri/src/notes/commands.rs: notes command surface.
- src-tauri/src/notes/store.rs: notes model and persistence.

## Critical Invariants

- No duplicate capture regressions across watcher/hotkeys/commands.
- Keep suppress-next-capture behavior intact when writing clipboard content.
- Keep active clipboard id updates aligned with copy/paste actions.
- Preserve popup hide reliability and monitor-boundary clamping.
- Preserve clear-all semantics: pinned entries must remain.
- Avoid regressions in file-backed image handling and large-image performance.
- Keep group operations consistent across clipboard entries and notes.
- Use caution with autostart in tauri dev; dev executable startup entries can break launch without Vite.

## Role Modes

- Planner:
  - map impacted files and risks first
  - propose minimal validation plan before edits
- Implementer:
  - apply smallest viable diff
  - preserve existing style and boundaries
  - avoid unnecessary abstractions
- Reviewer:
  - prioritize regressions, race/order bugs, and state-sync risks
  - verify critical invariants and test coverage

## Backend Submodule Policy

- Current state is scaffold-only.
- Do not assume language/framework until manifests exist.
- When backend implementation appears:
  - identify stack from lockfile/manifests
  - add stack-specific commands/rules in a focused update

## PR and Handoff

- Keep commits logically scoped by submodule.
- Document cross-submodule contracts when both repos are touched.
- Final report must include:
  - what changed
  - checks run (and results)
  - remaining risks/assumptions

## Context and Token Discipline

- Read only files required for the active task.
- For large files, inspect targeted sections before expanding.
- Prefer concise diffs over broad refactors.
- Avoid repeating architecture background already in docs.
- For unrelated tasks, start a fresh session/context when possible.
- Prefer concise summaries with actionable facts only.

## Completion Criteria

A task is complete when:

- Relevant checks for touched areas pass.
- No obvious regression in affected user flow.
- Diff is minimal and cohesive.
- Assumptions, risks, and unverified items are explicitly listed.
