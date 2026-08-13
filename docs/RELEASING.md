# Releasing the Smart Clipboard app

Shipping a release means running one workflow. Version numbers, the changelog and
the update feed are all derived from commit history — none of them are edited by
hand.

- **Workflow:** [`.github/workflows/release.yml`](../.github/workflows/release.yml) — manual dispatch only
- **Changelog/version rules:** [`cliff.toml`](../cliff.toml)
- **Feed the app reads:** `https://github.com/Spectrewolf8/RoverTools-Releases/releases/latest/download/latest.json`

---

## How it fits together

```
commits (feat:/fix:/…)
   │
   ├─ git-cliff ──► next version ──► Cargo.toml (single source of truth)
   │                └──────────────► CHANGELOG.md + release notes
   │
   └─ matrix build ─► signed NSIS (Windows) + AppImage/deb (Linux)
                          │
                          └─► public releases repo: bundles + latest.json
                                      │
                                      └─► app checks it a few seconds after launch
```

The source repo stays private. The **releases** repo is public because the updater
fetches over plain HTTPS with no credentials — a private repo's assets are behind
auth, and the only way to reach them would be shipping a token inside the app.

Nothing about this touches the sync backend.

---

## One-time setup

### 1. Create the releases repo

A **public** repo named `RoverTools-Releases`, with **at least one commit** (a
README is enough). `gh release create` needs a commit to hang the release tag on;
an empty repo fails.

It holds no source — only release assets and `latest.json`.

### 2. Generate the signing keypair

```bash
bun tauri signer generate -w ~/.tauri/rovertools-updater.key
```

This prints a public key and writes the private key. Then:

- Put the **public** key in `src-tauri/tauri.conf.json` under
  `plugins.updater.pubkey`, replacing `REPLACE_ME_WITH_TAURI_SIGNER_PUBLIC_KEY`.
- Keep the **private** key and its password somewhere durable — a password
  manager, not just the CI secret store.

> **The private key is load-bearing.** Every installed copy of the app only trusts
> bundles signed by it. Lose it and the update channel is dead: you would have to
> ship a new public key inside a new build, which users can only get by installing
> manually — exactly the friction this system exists to remove. Back it up before
> the first release, not after.

### 3. Add the repository secrets

In the **source** repo's Settings → Secrets and variables → Actions:

| Secret | What it is |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password set when generating it |
| `RELEASES_REPO_TOKEN` | A PAT with `contents: write` on `RoverTools-Releases` |

The workflow's own token cannot write to another repo, hence the PAT. A
fine-grained token scoped to just that one repo is enough.

### 4. Tag today's `main` as the baseline

```bash
git tag -a v0.1.0 -m "v0.1.0 baseline" && git push origin v0.1.0
```

Without this there is no release tag for git-cliff to measure from, and two things
go wrong: `--bumped-version` has no baseline and refuses to compute one, and the
first release's notes would be **every commit in the project's history** — hundreds
of bullets in the update prompt.

`v0.1.0-build.2` does not count; it is excluded by `tag_pattern` as a CI build.

### 5. Check branch protection

The workflow pushes a `chore(release): vX.Y.Z` commit to `main`. If `main` is
protected, either allow the Actions bot to push or run releases from an unprotected
branch.

---

## Cutting a release

```bash
gh workflow run release.yml -f bump=auto -f dry_run=true
```

`dry_run=true` does everything except commit, tag and publish. Use it the first
time, and after any edit to the workflow. When the rehearsal looks right:

```bash
gh workflow run release.yml -f bump=auto -f dry_run=false
```

**Inputs**

- `bump` — `auto` derives the version from the commits since the last release tag:
  `feat:` → minor, `fix:` / `perf:` → patch. `patch` / `minor` override it.
- `dry_run` — build and verify without publishing.

> **"No version bump — there are no releasable commits"** means everything since the
> last tag was a `chore:`, `docs:`, `refactor:`, `test:`, `ci:` or `build:` commit.
> Those are excluded from the version calculation as well as the notes, so `auto`
> has nothing to work from. That is deliberate — it stops a release that would be
> byte-identical to the last one from being published. Ship it with
> `-f bump=patch` if you want it out regardless; the notes fall back to
> "Maintenance release — internal changes only."

**What users see:** within a few seconds of their next launch, a strip under the
titlebar saying the new version is available, with the generated notes behind
"What's new". Nothing downloads or installs until they press a button.

---

## Versioning

`src-tauri/Cargo.toml` is the **single source of truth**. `tauri.conf.json` has no
`version` field on purpose — Tauri falls back to Cargo.toml, so there is one place
to be wrong instead of three. `package.json`'s version is cosmetic and kept in step
by the workflow.

Pre-1.0 rules (set in `cliff.toml`): `feat:` bumps the minor, everything else the
patch, and a breaking change also only bumps the minor — `0.x` promises nothing
that a major bump would be announcing. When cutting 1.0, flip
`breaking_always_bump_major` in `cliff.toml`.

Only plain `vX.Y.Z` tags count as releases. The `v0.1.0-build.N` tags from
[`build-linux.yml`](../.github/workflows/build-linux.yml) are throwaway CI builds
and are excluded by `tag_pattern`.

---

## What can and cannot self-update

| Bundle | Self-updates | Why |
|---|---|---|
| NSIS (`.exe`) | **Yes** | The installer reruns and replaces the app in place |
| AppImage | **Yes** | A single file the updater can swap |
| `.deb` / `.rpm` | No | Owned by the package manager; published for manual install only |

`.deb`/`.rpm` are still built and attached, they just never appear in
`latest.json` — offering an update the client cannot install would be worse than
offering none.

macOS is not built at all today. Adding it means a `.app.tar.gz` target plus Apple
notarization, which is its own piece of work.

---

## Beta channel (free)

`releases/latest/download/…` resolves to the newest **non-prerelease**. So a
release marked as a prerelease in the releases repo is invisible to the updater:
install it by hand to test, and no one else is offered it. Publishing a normal
release afterwards promotes the feed.

---

## Verification and safety rails

The workflow fails rather than shipping something broken:

- **Non-semver version** → refused before building. The updater compares semver, so
  an unparseable version would publish and then never be offered.
- **No bump** → refused. Nothing releasable since the last tag.
- **Missing signing key** → refused before spending a build.
- **A missing `.sig`** for an updatable bundle → refused. Unsigned bundles build
  fine and are then rejected by every client, which is the worst failure mode:
  invisible until users are stuck.
- **Feed verification** → after publishing, the workflow fetches `latest.json`
  through the same URL the app uses and HEADs every bundle URL it advertises, so a
  broken redirect or a mangled asset name surfaces in CI.
- **Pruning** keeps the newest 5 releases and explicitly skips whichever is marked
  latest, so the release currently being served is never deleted.

### Asset names have no spaces, deliberately

Tauri names bundles after `productName` — "Orange Copy Paste" — and GitHub rewrites
spaces in uploaded asset names to dots. That would silently invalidate every URL in
`latest.json`. The workflow renames bundles to a `RoverTools_<version>_…` prefix and
builds the URLs from the renamed files.

---

## Things worth knowing

**Updates are disabled in debug builds.** A dev build reports the Cargo.toml
version, so it would see any release as an upgrade and happily install over
`target/debug` — replacing a build that loads from `devUrl` with one that doesn't.
`updater.rs` refuses instead; "Check now" in Settings says so.

**"Run on startup" survives an update.** An update reinstalls rather than patches,
so the recorded startup path can end up naming a replaced executable. The app
rewrites the entry from its own location at every launch when the setting is on
(`reconcile_autostart`).

**Windows installs are per-user** (`nsis.installMode: currentUser`), which keeps the
install path stable across versions and avoids a UAC prompt on every update.

**Install ends the process.** On Windows the installer takes over and the app exits
mid-call; on Linux the AppImage is replaced and the app restarts itself. This is why
installing sits behind a second confirmation rather than following the download —
nobody should lose their window to a background download finishing.

---

## Manual smoke test before trusting it

Full end-to-end can only be checked with two real releases:

1. Release `0.2.0`. Install it normally.
2. Release `0.2.1`.
3. Launch the `0.2.0` install. Within ~8 seconds the banner should appear with the
   `0.2.1` notes.
4. Download → progress bar → "Restart & install" → app comes back on `0.2.1`.
5. With "Run on startup" on, confirm it is still on and pointing at the new
   executable after the update.
