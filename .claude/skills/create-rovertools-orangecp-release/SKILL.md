---
name: create-rovertools-orangecp-release
description: Cut a release of the Orange Copy Paste desktop app. Preflights the signing key, baseline tag and secrets, computes the semantic version from conventional commits, rehearses with a dry run, then dispatches the real release and verifies the published update feed. Use when asked to create/cut/ship a release, publish a new version, bump the app version, or preview what the next version would be.
---

# Cut an Orange Copy Paste release

Drives `.github/workflows/release.yml`. That workflow computes the next version with
git-cliff, builds signed NSIS + AppImage bundles, assembles `latest.json`, and
publishes to the **public** releases repo the in-app updater reads.

Read [`docs/RELEASING.md`](../../../docs/RELEASING.md) if anything here is unclear —
it is the reference; this file is the procedure.

## Arguments

| Invocation | Behaviour |
| --- | --- |
| *(none)* | Full flow: preflight → preview → dry run → confirm → release → verify |
| `preview` | Preflight and preview only. Dispatches nothing. |
| `patch` / `minor` | Force the bump instead of deriving it from commits |
| `dry-run` | Stop after the dry run; do not offer the real release |

## Constants

- Source repo: `Spectrewolf8/RoverTools-Smart-Clipboard-App-RUST`
- Releases repo: `Spectrewolf8/RoverTools-Releases` (public)
- App dir: `orange-copy-paste-clipboard-app-rust`
- Version source of truth: `orange-copy-paste-clipboard-app-rust/src-tauri/Cargo.toml`
- Feed: `https://github.com/Spectrewolf8/RoverTools-Releases/releases/latest/download/latest.json`

## Hard rules

- **Never dispatch with `dry_run=false` without the user saying yes in that turn.** A
  real run pushes a commit and a tag to `main` and publishes a public release.
- **Never push a tag, commit, or edit a secret yourself.** Preflight *reports*
  problems; the user fixes them or explicitly asks you to.
- **Never mark a release as a prerelease** unless the user asks for a beta. The feed
  resolves to the newest *non*-prerelease, so a prerelease reaches nobody.
- If a preflight gate fails, **stop and report**. Do not "helpfully" continue —
  every gate below is something that silently produces a broken release.

---

## Step 1 — Preflight

Run these and report a compact pass/fail table. Do not proceed past a failure.

```bash
git rev-parse --abbrev-ref HEAD && git status --porcelain && git fetch origin main -q && git rev-list --left-right --count origin/main...HEAD
```

| Gate | Requirement | If it fails |
| --- | --- | --- |
| Branch | On `main` | Releases are cut from `main`; the workflow pushes its release commit there |
| Working tree | Clean | A dirty tree means the release may not match what is committed |
| Sync with origin | 0 behind, 0 ahead | Pull or push first — the workflow builds from the pushed ref |

```bash
grep -n 'pubkey' orange-copy-paste-clipboard-app-rust/src-tauri/tauri.conf.json
```

| Gate | Requirement | If it fails |
| --- | --- | --- |
| Signing pubkey | **Not** `REPLACE_ME_WITH_TAURI_SIGNER_PUBLIC_KEY` | Blocker. Builds would succeed and every client would reject them. Point the user at `docs/RELEASING.md` §2 to generate the keypair, and remind them to back the private key up **outside CI** — losing it kills the update channel permanently. |

```bash
git tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -3
```

| Gate | Requirement | If it fails |
| --- | --- | --- |
| Baseline tag | At least one plain `vX.Y.Z` tag | Blocker for `bump=auto`. git-cliff has nothing to measure from, and the notes would be the entire project history. Tell the user to run `git tag -a v0.1.0 -m "v0.1.0 baseline" && git push origin v0.1.0`. Do not create it yourself. |

`v0.1.0-build.N` tags do **not** count — they are throwaway CI builds excluded by
`tag_pattern` in `cliff.toml`.

```bash
gh secret list --repo Spectrewolf8/RoverTools-Smart-Clipboard-App-RUST
```

| Gate | Requirement | If it fails |
| --- | --- | --- |
| Secrets | `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `RELEASES_REPO_TOKEN` all present | Blocker. The workflow fails fast on a missing key, but `RELEASES_REPO_TOKEN` is only needed at publish time — so a dry run passes and the real run dies after building. |

```bash
gh repo view Spectrewolf8/RoverTools-Releases --json visibility,defaultBranchRef --jq '"\(.visibility) default=\(.defaultBranchRef.name // "NO COMMITS")"'
```

| Gate | Requirement | If it fails |
| --- | --- | --- |
| Releases repo | Exists, `PUBLIC`, and has a default branch | Must be public — the updater fetches with no credentials. `NO COMMITS` means `gh release create` has nothing to tag; tell the user to add a README. |

---

## Step 2 — Preview the version and notes

Only if every gate passed. If `git-cliff` is unavailable locally, say so and skip to
the dry run, which computes the same thing in CI.

```bash
git cliff --bumped-version
```

```bash
git cliff --unreleased --strip all
```

Report: **current version → next version**, and the notes verbatim. These notes are
what users read in the update prompt, so flag anything that reads as internal jargon
rather than a user-facing change — that is a cue to reword commits, not the template.

**If the output is "There is nothing to bump":** everything since the last tag was a
`chore:`, `docs:`, `refactor:`, `test:`, `ci:` or `build:` commit. Those are excluded
from both the notes and the version calculation. This is intended — it stops a
release identical to the last one. Report it and offer `patch` as the override.

Stop here if invoked with `preview`.

---

## Step 3 — Dry run

Always rehearse first. This builds and verifies real signed bundles but commits,
tags and publishes nothing.

```bash
gh workflow run release.yml -f bump=auto -f dry_run=true --repo Spectrewolf8/RoverTools-Smart-Clipboard-App-RUST
```

Substitute the user's bump override for `auto` when one was given. Then watch it.

Shell state does not persist between commands here, so each block resolves the run id
itself rather than relying on a variable or a `<RUN_ID>` placeholder — a literal
placeholder would be parsed as an input redirection and fail confusingly:

```bash
sleep 8 && RUN_ID=$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId' --repo Spectrewolf8/RoverTools-Smart-Clipboard-App-RUST) && echo "watching run $RUN_ID" && gh run watch "$RUN_ID" --exit-status --repo Spectrewolf8/RoverTools-Smart-Clipboard-App-RUST
```

The `sleep` matters: `workflow run` returns before the run is queryable, so watching
immediately picks up the *previous* run.

On failure, pull the failing step's log rather than guessing:

```bash
gh run view "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId' --repo Spectrewolf8/RoverTools-Smart-Clipboard-App-RUST)" --log-failed --repo Spectrewolf8/RoverTools-Smart-Clipboard-App-RUST
```

Report the resolved version and whether both bundles produced a `.sig`. Stop here if
invoked with `dry-run`.

---

## Step 4 — Ask before the real release

Present, in one short block: the version being cut, the release notes, and that this
will push a commit and tag to `main` and publish a public release. Then **wait for an
explicit yes.**

```bash
gh workflow run release.yml -f bump=auto -f dry_run=false --repo Spectrewolf8/RoverTools-Smart-Clipboard-App-RUST
```

Watch it the same way as Step 3.

---

## Step 5 — Verify

The workflow verifies the feed itself and fails if it is wrong, so a green run is
strong evidence. Confirm independently anyway — this is the one thing users depend on:

```bash
curl -fsSL https://github.com/Spectrewolf8/RoverTools-Releases/releases/latest/download/latest.json
```

Check: `version` matches what was cut; `platforms` has **both** `windows-x86_64` and
`linux-x86_64`; each has a non-empty `signature`. A `.deb` entry here would be a bug —
package-manager installs cannot self-update, so they are published for manual download
only and must never appear in the feed.

Then confirm the new release is the one marked latest and is not a prerelease —
either would hide it from every client:

```bash
gh release list --repo Spectrewolf8/RoverTools-Releases --limit 5 --json tagName,isLatest,isPrerelease --jq '.[] | "\(.tagName) latest=\(.isLatest) prerelease=\(.isPrerelease)"'
```

And that the expected assets are attached (`isLatest` is **not** a valid field on
`release view` — only on `release list`, hence the two calls):

```bash
gh release view --repo Spectrewolf8/RoverTools-Releases --json tagName,isDraft,assets --jq '"\(.tagName) draft=\(.isDraft)\n\([.assets[].name] | join("\n"))"'
```

Expect the NSIS `.exe`, the AppImage, the `.deb`, a `.sig` beside each updatable
bundle, and `latest.json`.

---

## Step 6 — Report

Tell the user:

- The version published, and the link to the release.
- That installed copies will be offered it within ~8 seconds of their next launch,
  notify-first — nothing installs without the user pressing Download then
  Restart & install.
- That `main` now carries the `chore(release): vX.Y.Z` commit and tag, so their local
  clone needs a `git pull`.
- Any gate that was skipped or any check that could not be run, and why.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `No version bump — there are no releasable commits` | Only skipped commit types since the last tag. Use `bump=patch`. |
| `Resolved version '…' is not a plain X.Y.Z semver` | git-cliff returned something odd; check `tag_pattern` in `cliff.toml` still has the optional `v?`, or pass an explicit bump. |
| `has no .sig` | `createUpdaterArtifacts` was removed from `tauri.conf.json`, or the signing secrets are wrong. |
| Publish step 403 / not found | `RELEASES_REPO_TOKEN` is missing, expired, or lacks `contents: write` on the releases repo. |
| Release published but nobody is offered it | It was marked prerelease, or the pubkey in the shipped build does not match the signing key. |
| Release commit rejected on push | Branch protection on `main` blocks the Actions bot. |
| Feed serves an older version | The publish succeeded but a newer release is marked `latest`, or the run failed after `gh release create`. Check the run log. |
