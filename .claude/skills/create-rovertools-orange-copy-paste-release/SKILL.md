---
name: create-rovertools-orange-copy-paste-release
description: "Cut a release of the Orange Copy Paste desktop app — optional args: [patch|minor|major] [stable|beta] [dry-run|preview]. Asks for whatever is not specified rather than assuming, shows the version and notes about to ship, dispatches the release workflow after an explicit yes, then verifies both update channels. Use when asked to create/cut/ship a release, publish a new version, bump the app version, ship a beta, or preview what the next release would contain."
argument-hint: "[patch|minor|major] [stable|beta] [dry-run|preview] — asks for anything omitted"
---

# Cut an Orange Copy Paste release

## Nothing is assumed

Three things decide what a run does. **Every one of them must come from the user, in
this conversation, on this call.** There are no defaults here — not `patch`, not
"stable", not "publish for real". A release is irreversible in public, and a silent
default is how the wrong one ships.

| Decision | Values |
| --- | --- |
| **Bump** | `patch` (bug fixes), `minor` (new features), or `major` (breaking, or committing to 1.0) |
| **Channel** | `stable` (everyone) or `beta` (subscribers only) |
| **Mode** | `publish`, `dry-run` (build only), or `preview` (dispatch nothing) |

Whatever the invocation supplies, take it. For anything it does not, **ask** — see
Step 0. Never infer one decision from another: "ship a release" says nothing about the
bump, and `beta` says nothing about whether it is a patch or a minor.

Drives [`.github/workflows/release.yml`](../../../.github/workflows/release.yml), which
bumps the version, builds signed bundles, and publishes them as GitHub Releases on the
App repo the in-app updater reads.

**The workflow checks its own prerequisites** — placeholder signing key or a missing
signing secret — and stops in seconds with a message saying what to fix. Do not
re-implement those checks here; dispatch and read the failure.

Reference: [`docs/releasing.md`](../../../docs/releasing.md).

## Arguments

Arguments are optional shortcuts that pre-answer one of the three decisions. They
combine — `beta minor` answers two, leaving only the mode to ask about.

| Argument | Answers | Meaning | Publishes? |
| --- | --- | --- | --- |
| `patch` | Bump | `0.2.0` → `0.2.1` | — |
| `minor` | Bump | `0.2.0` → `0.3.0` | — |
| `major` | Bump | `0.2.0` → `1.0.0` | — |
| `beta` | Channel | Offered only to beta subscribers | Yes, betas only |
| `stable` | Channel | Offered to everyone | Yes, to everyone |
| `dry-run` | Mode | Build and verify, then stop | No |
| `preview` | Mode | Print the version and notes, then stop | No |

A bare invocation with no arguments answers nothing, so all three get asked.

## Hard rules

- **Never guess a decision.** Bump, channel and mode each come from the user or get
  asked. "They probably meant patch" is exactly the reasoning that ships the wrong thing.
- **Never dispatch a real release without the user saying yes in that turn.** It pushes
  a commit and tag to `main` and publishes publicly.
- **Never push tags, commit, or edit secrets yourself.**
- **Always pass all three flags explicitly** — `-f bump=…`, `-f prerelease=…`,
  `-f dry_run=…` — even when a value matches the workflow's own default. The default can
  change; an explicit flag is a record of what was chosen.
- **Never flip the prerelease flag by editing a release afterwards.** Getting the channel
  wrong is silent in both directions: an accidental beta reaches nobody, an
  accidentally-omitted one reaches everybody.

---

## Step 0 — Gather what is missing

Read the invocation. For every decision it did **not** answer, ask — all of them in a
single `AskUserQuestion` call, not one at a time. Skip a question only when the argument
already answered it.

- **Bump** — "Patch (bug fixes)" / "Minor (new features)" / "Major (breaking changes, or
  committing to 1.0)". Show what each produces from the current version, e.g.
  `0.1.0 → 0.1.1` vs `0.1.0 → 0.2.0` vs `0.1.0 → 1.0.0`; run Step 1's first command
  before asking, so those numbers are real rather than illustrative. Offer major only
  when it was asked for by name — it is rarely what someone means by "a new release",
  and 1.0.0 is a statement about stability, not a bigger number.
- **Channel** — "Stable (everyone)" / "Beta (subscribers only)".
- **Mode** — "Publish" / "Dry run (build only, publishes nothing)" / "Preview (show the
  version and notes, dispatch nothing)".

If the user's answer to any question is ambiguous or arrives as free text that does not
map to one of the values, ask again rather than picking the nearest. Do not proceed to
Step 3 until all three are settled.

---

## Step 1 — Show what will ship

Constant: the repo `NotRover/RoverTools-Orange-Copy-Paste-App`, which is both the source
and where releases are published.

```bash
grep -m1 '^version = ' orange-copy-paste-clipboard-app-rust/src-tauri/Cargo.toml && git fetch origin main --tags -q && git rev-parse --abbrev-ref HEAD && git status --porcelain
```

Releases are cut from `main`, and the workflow builds from the pushed ref — so an unpushed
commit will not be in the release. Say so if the branch is not `main` or the tree is dirty.

The notes users will read are the user-facing sections of `changelog/next.md`. Print
them the way the release will — comment stripped, the `### Internal` section dropped,
blank edges trimmed:

```bash
perl -0777 -pe 's/<!--.*?-->//gs' changelog/next.md | awk '/^#{1,6}[[:space:]]+[Ii]nternal[[:space:]]*$/{s=1;next} /^#{1,6}[[:space:]]/{s=0} !s' | sed -e '/./,$!d' | tac | sed -e '/./,$!d' | tac
```

> The `### Internal` section is kept for the record but never shipped, so it is dropped
> above. Keep every command in this file free of `$0`, `$1`, `$2` — a `$0` here is
> rewritten to the skill's first argument before the shell sees it, which would corrupt
> an `awk`/`sed` script. The awk above uses only the flag `s` and awk's implicit line
> printing, no `$0`.

Report the current version and the version being cut (patch bumps the third number,
minor the second and zeroes the third), then the notes verbatim. Any empty
New/Improved/Fixed heading you see here would be dropped at publish. **If no user-facing
section has an entry, a real release will fail at its first step** — stop and have the
user run `/update-changelog` (or fill `changelog/next.md` by hand) before dispatching.
Flag any line that reads as jargon or breaks the copy rules: the fix is to edit
`changelog/next.md`, not to hand-edit anything at dispatch.

Stop here if invoked with `preview`.

## Step 2 — Confirm

Restate all three settled decisions together, so a wrong answer in Step 0 is visible
before it becomes public:

```text
0.1.0 → 0.1.1 · stable (everyone) · publish
pushes a commit and tag to main, and publishes publicly
yes · or: change bump · change channel · dry-run · cancel
```

**Wait for an explicit yes.** Anything else is a new choice, not a confirmation — go back
to Step 0 for whichever decision they are changing, and show this block again.

Skip this step only in `preview` mode, which never dispatches. `dry-run` still gets
confirmed: it costs a full matrix build.

## Step 3 — Dispatch

All three flags, always, filled in from Step 0 — never shortened by leaning on a
workflow default:

```bash
gh workflow run release.yml -f bump=patch -f prerelease=false -f dry_run=false --repo NotRover/RoverTools-Orange-Copy-Paste-App
```

Substitute the settled values: `bump=patch|minor|major`, `prerelease=true` for a beta,
`dry_run=true` for a rehearsal. Read the command back before running it — it is the last
point where a wrong channel is still cheap to fix.

Then watch it. Each block resolves the run id itself — shell state does not persist
between commands, and a literal `<RUN_ID>` placeholder parses as input redirection. The
`sleep` matters: `workflow run` returns before the run is queryable, so watching
immediately picks up the *previous* run.

```bash
sleep 8 && RUN_ID=$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId' --repo NotRover/RoverTools-Orange-Copy-Paste-App) && echo "watching run $RUN_ID" && gh run watch "$RUN_ID" --exit-status --repo NotRover/RoverTools-Orange-Copy-Paste-App
```

On failure, read the log rather than guessing:

```bash
gh run view "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId' --repo NotRover/RoverTools-Orange-Copy-Paste-App)" --log-failed --repo NotRover/RoverTools-Orange-Copy-Paste-App
```

Stop here if invoked with `dry-run` — nothing was published, so there is nothing to verify.

## Step 4 — Verify both channels

The workflow already asserts all of this and fails if it is wrong, so a green run is
strong evidence. Confirm independently anyway — this is the one thing users depend on.

What "correct" looks like depends on which kind of release it was:

| | Stable release | Beta |
| --- | --- | --- |
| Stable feed reports | the new version | the **previous** version |
| Beta feed reports | the new version | the new version |

A beta showing up in the stable feed means every user is being offered an untested
build — treat that as urgent, not cosmetic.

Neither block needs a local `jq` or `base64` — `gh --jq` runs the whole expression
itself, including the base64 decode, so these work on a bare machine:

```bash
echo "stable channel:" && curl -fsSL https://github.com/NotRover/RoverTools-Orange-Copy-Paste-App/releases/latest/download/latest.json | grep -o '"version":"[^"]*"\|"windows-x86_64"\|"linux-x86_64"'
```

```bash
echo "beta channel:" && gh api repos/NotRover/RoverTools-Orange-Copy-Paste-App/contents/beta.json --jq '.content | gsub("\n";"") | @base64d | fromjson | "version=\(.version)  platforms=\(.platforms | keys | join(", "))"'
```

Both must list `windows-x86_64` and `linux-x86_64`. A `.deb` entry would be a bug —
package-manager installs cannot self-update, so they are published for manual download
only and must never appear in a feed.

```bash
gh release list --repo NotRover/RoverTools-Orange-Copy-Paste-App --limit 5 --json tagName,isLatest,isPrerelease --jq '.[] | "\(.tagName) latest=\(.isLatest) prerelease=\(.isPrerelease)"'
```

## Step 5 — Report

- The version published and a link to the release.
- **Stable release:** installed copies are offered it within ~8 seconds of their next
  launch, notify-first — nothing installs until the user presses Download, then
  Restart & install.
- **Beta:** only beta subscribers are offered it (Settings → Updates → *Get beta
  versions*); everyone else is unaffected. Promoting it later is an edit of the same
  bundles, no rebuild:

  ```bash
  gh release edit v0.3.0 --repo NotRover/RoverTools-Orange-Copy-Paste-App --prerelease=false --latest
  ```

  The release's changelog file keeps its `-beta` name — it records how the release was
  first cut. If you want `changelog/` to reflect the current channel, rename it by hand
  in the source repo: `git mv changelog/0.3.0-minor-beta.md changelog/0.3.0-minor-stable.md`.
- `main` now carries the `release: vX.Y.Z` commit and tag (and the new
  `changelog/<version>-<bump>-<channel>.md` plus a reset `changelog/next.md`), so the
  local clone needs a `git pull`.
- Anything that could not be checked, and why.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Stops immediately on prerequisites | Read the message — it names the missing piece. Setup is `docs/releasing.md`; the user fixes it, not you. |
| `has no .sig` | `createUpdaterArtifacts` was removed from `tauri.conf.json`, or the signing secrets are wrong. |
| Publish step 403 / not found | The publish job lacks `contents: write`, or a branch protection rule blocks the release commit/tag. The built-in `GITHUB_TOKEN` handles publishing to this repo — no PAT. |
| Published but nobody is offered it | It went out as a beta, or the pubkey in the shipped build does not match the signing key. |
| `stable feed is serving it` on a beta run | The prerelease flag did not take. Fix with `gh release edit <tag> --prerelease=true` before anyone launches. |
| `beta.json serves <older>` | The beta-feed step failed or was skipped. Beta subscribers are stuck on the previous release until it is rewritten. |
| Release commit rejected on push | Branch protection on `main` blocks the Actions bot. |