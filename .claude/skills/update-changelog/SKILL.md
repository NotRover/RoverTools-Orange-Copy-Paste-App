---
name: update-changelog
description: "Draft or refresh changelog/next.md (the notes staged for the next release) from the commits since the last release. Reads git history (and merged-PR context where useful), sorts user-facing changes into a lead sentence plus New / Improved / Fixed in the app's own voice, and records internal work (backend, MCP, refactors, CI) under Internal for the record - the workflow keeps that in the file but never publishes it. Use before cutting a release, or whenever the changelog has fallen behind the work that has landed. Shows the diff and stops; does not commit unless asked."
argument-hint: "(no args) — drafts [Unreleased] from commits since the last release tag"
---

# Update the changelog

You maintain [`changelog/next.md`](../../../changelog/next.md) — the notes staged for
the next release. The release workflow publishes that file verbatim as the release
notes and then renames it to `changelog/<version>-<bump>-<channel>.md`, so what you
write here is **user-facing copy**: the app's "What's new" panel and the GitHub release
body, not a log for the team. An empty `next.md` fails a real release on purpose, so
running this before a release is how the release gets its notes.

Reference: the convention and its home are
[`changelog/README.md`](../../../changelog/README.md); the release flow is
[`docs/RELEASING.md`](../../../docs/RELEASING.md); the empty skeleton is
[`changelog/TEMPLATE.md`](../../../changelog/TEMPLATE.md).

## What this does and does not touch

- **Only** `changelog/next.md`. Never edit a `changelog/<version>-*.md` file — those
  are shipped history.
- **Idempotent.** Running it again rewrites `next.md` from the same commit range; it
  does not append or duplicate.
- **Does not commit.** Edit the file, show the diff, stop. Commit only if the user
  asks in that turn.

## Step 1 — Find the range and read the work

```bash
LAST=$(git tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1); echo "since ${LAST:-<no release yet>}"; git log --no-merges --pretty='format:%s  %h' "${LAST:+$LAST..}HEAD"
```

That is the raw material. Where a subject is thin, read the commit or its merged PR
for the user-visible effect — `gh pr list --state merged --base main --limit 30`, then
`gh pr view <n>` for the Context/Solution. Use PRs for understanding, not as copy:
their bodies are written for reviewers.

Keep this command (and any you add) free of `$0`, `$1`, `$2` — a `$0` in a skill file
is rewritten to the skill's first argument before the shell ever sees it, which would
silently corrupt an `awk`/`sed` script.

## Step 2 — Sort by what a user can see

Nothing is thrown away — internal work is recorded under `### Internal`, which the
release workflow keeps in the file but strips before publishing. A commit's type is the
first filter, its content the second:

| Commit types | Goes to | Notes |
| --- | --- | --- |
| `feat` | **New** | A capability the user did not have before. |
| `perf`, and `feat` that refines something that already worked | **Improved** | Faster, smoother, less friction. |
| `fix`, `revert` | **Fixed** | A wrong behaviour made right. |
| `chore`, `ci`, `build`, `test`, `refactor`, `style`, `docs`, backend/MCP plumbing | **Internal** | Not shown to users, but kept for the record. One tidy line, not a dump. |

Judge by user-visibility, not type alone: a `feat` deep in the sync/MCP plumbing that a
user never notices belongs in **Internal**, and a `fix` that changes what a user sees
belongs in **Fixed**. If a range is **all** internal, fill only `### Internal` and leave
the user-facing sections empty — a release cut from that fails on purpose, which is the
signal to write real notes.

## Step 3 — Write it in the app's voice, with substance

These lines are the whole reason the file exists — users read them in the app's
"What's new" panel and on the GitHub release. **Substance is the point:** each entry
explains what changed and why it helps, not a one-line restatement of the commit
subject. A previous pass that reduced everything to bare one-liners is exactly the
failure this rewrite exists to prevent.

In `changelog/next.md`: a lead, then only the sections that have entries.

- **Lead:** one or two plain sentences framing what the release is about. No bullet.
- **Entries:** one to three full sentences each, present tense, from the user's
  perspective, ending with a period. Say the situation before, what is different now,
  and the benefit. Describe the visible effect, never the mechanism — no file names,
  type names, or internal detail.
- **Coverage — do not over-collapse.** Every distinct user-facing change gets its own
  entry; only merge commits that are genuinely the same change split apart. A release
  with a dozen user-facing commits has close to a dozen entries, not four. Bigger
  releases get fuller notes; order entries most to least significant.
- **Accuracy.** Expand only what the commit subject and obvious context support. Add
  the plain user-benefit framing that clearly follows; never invent numbers, UI names,
  or features that are not there. If a subject is thin and you cannot say more
  truthfully, write one solid sentence rather than padding.
- **Copy rules (New/Improved/Fixed ship):** ASCII punctuation only — no em dashes, en
  dashes, curly quotes, ellipsis character, or the section sign. Write two sentences
  rather than joining with a dash. Obey the No-AI-Slop rules in `CLAUDE.md`: no
  "seamless / robust / effortless / unlock / transform …", no "it's not just X, it's
  Y", no three-adjective piles. Concrete and specific — substance means real
  information, not more adjectives.
- **`### Internal`:** the one place you still collapse hard. Terse lines for the
  record, no user voice — still ASCII, still no section sign. Fold a run of submodule
  bumps, CI, and refactors into a single line; it is a footnote, not a report.

Thin (do not do this):
`Removing items from the cloud no longer deletes your local copies.`

Substantial (do this):
`Removing an item from the cloud used to also delete the copy on your own device. Now
it only clears the cloud copy, so your local history stays intact when you free up
cloud space.`

## Step 4 — Edit, show, stop

Write the lead sentence and the non-empty sections into `changelog/next.md`, below the
guidance comment (keep the comment). Delete any section that has no entries — do not
leave an empty `### Improved` behind — but keep `### Internal` when it has lines. There
is no version heading in `next.md`; the workflow adds one when it renames the file on
release.

Then show the diff (`git diff changelog/next.md`) and summarise what went into each
user-facing section and what you filed under Internal. Stop there — the user commits,
or asks you to.
