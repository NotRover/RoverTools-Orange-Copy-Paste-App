# Changelog

**Owns:** the user-facing history of the Smart Clipboard desktop app, one file per
release, and `next.md` — the notes staged for the release you have not cut yet.
**Not here:** the version of record (`orange-copy-paste-clipboard-app-rust/src-tauri/Cargo.toml`),
and how releases are cut ([`../docs/releasing.md`](../docs/releasing.md)).

## The files

- **`next.md`** is the staging file, and the only one you edit. Draft it with
  `/update-changelog` or by hand before cutting a release. Skeleton:
  [`TEMPLATE.md`](TEMPLATE.md). **If `next.md` is empty when you cut a real release,
  the workflow errors** — write the notes first, on purpose.
- **`<version>-<bump>-<channel>.md`** is one shipped release —
  `0.2.0-minor-stable.md`, `0.1.14-patch-beta.md`, `1.0.0-major-stable.md`. The
  workflow creates it by renaming `next.md` on release, so the name always states the
  real version, the bump, and the channel it went out on. You never name these by hand.
- Every shipped release from `0.1.0` on has a file here; the published assets also live
  on this repo's [Releases](https://github.com/NotRover/RoverTools-Orange-Copy-Paste-App/releases).
- **`../CHANGELOG.md`** (repo root) is a browsable index of every release, newest first,
  generated from the files here by
  [`../.github/scripts/gen-changelog.sh`](../.github/scripts/gen-changelog.sh) on each
  release. It is an artifact, not a source — never hand-edit it; edit the per-release file
  here and it rebuilds on the next release.

## What goes in one

A lead, then only the sections that apply:

```
One or two sentences framing what this release is about.

### New
- A capability the user did not have before, in one to three sentences: what it does
  and why it helps.

### Fixed
- A wrong behaviour made right, and what that means for the user.

### Internal
- Backend, MCP, refactor or dependency work. Kept for the record, never shown to users.
```

The lead and the **New / Improved / Fixed** sections are user-facing copy: the app's
"What's new" panel renders them, the GitHub release body renders the same text as
markdown, and the No-AI-Slop rules in `../CLAUDE.md` apply. `feat` goes to New, `perf`
and refinements to Improved, `fix`/`revert` to Fixed.

**Substance is the point.** Each entry is one to three full sentences that say what
changed and why it helps — not a one-line paraphrase of the commit subject. Give every
distinct user-facing change its own entry rather than collapsing a release into four
lines; a release with a dozen visible changes reads like one. `### Internal` is the
exception: keep it a terse footnote, one line for a run of bumps.

**`### Internal`** is different: backend changes, MCP plumbing, refactors, CI, docs and
dependency bumps go here so the history is complete, but the release workflow **drops
this section before publishing** — it never reaches the app or the GitHub release. Sort
by what a user sees, not by commit type: an internal `feat` deep in the plumbing belongs
in Internal. A release whose user-facing sections are all empty fails on purpose.

> A beta you later promote to stable keeps its `-beta` filename — the name records how
> the release was first cut, which is history, not a bug. Rename it to `-stable` by hand
> if you want the directory to track the current channel.
