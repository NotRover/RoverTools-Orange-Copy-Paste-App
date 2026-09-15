# Releasing the Smart Clipboard app

**Owns:** shipping. The release workflow, the two update channels, the signing key, the
version-of-record, and the smoke test. Read before touching
`.github/workflows/release.yml`.
**Not here:** what the app does; and the *content* of the release notes, which lives in
[`changelog/`](../changelog/) (staged in `changelog/next.md`). This file is about
getting builds to users.

Shipping a release is one workflow run. Everything else — version number, release
notes, the update feed, the signed bundles — is derived from that.

```bash
gh workflow run release.yml
```

That is a patch release. For a feature release, `-f bump=minor`; for a breaking one or
the move to 1.0, `-f bump=major`. Or click **Run workflow** on [`.github/workflows/release.yml`](../.github/workflows/release.yml) in
the Actions tab and pick from the dropdown.

The workflow checks its own prerequisites first and stops in the first few seconds
with a message telling you what to fix, so a misconfigured release fails before it
spends a build rather than after.

**Or from Claude Code:** `/create-rovertools-orangecp-release`
([`.claude/skills/…/SKILL.md`](../.claude/skills/create-rovertools-orangecp-release/SKILL.md)).
It asks for the bump, the channel and the mode — assuming none of them, on every call —
shows the version and the notes about to ship, dispatches only after an explicit yes,
then verifies both channels. Arguments pre-answer whatever you already know:
`/create-rovertools-orangecp-release minor beta`, or `preview` to see what the next
release would contain without dispatching anything.

---

## How it fits together

```
you dispatch release.yml
   │
   ├─ bump the version in Cargo.toml   (patch or minor — your choice)
   ├─ notes = changelog/next.md  (renamed to changelog/<ver>-<bump>-<channel>.md on release)
   │
   ├─ build signed NSIS (Windows) + AppImage/deb (Linux)
   │
   └─ publish to the PUBLIC releases repo: bundles + latest.json
              │
              └─ app checks that feed ~8s after launch, then every 6h → banner
```

The source repo stays private. The **releases** repo is public because the updater
fetches over plain HTTPS with no credentials — a private repo's assets are behind
auth, and the only way to reach them would be shipping a token inside the app.

Nothing here touches the sync backend.

---

## One-time setup

Three things. The workflow will tell you if any are missing.

### 1. Signing keypair

```bash
cd orange-copy-paste-clipboard-app-rust && bun tauri signer generate -w ~/.tauri/rovertools-updater.key
```

Put the **public** key in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`,
replacing `REPLACE_ME_WITH_TAURI_SIGNER_PUBLIC_KEY`, and commit it.

> **Back the private key and its password up outside CI, before the first release.**
> Every installed copy only trusts bundles signed by it. Lose it and the update
> channel is dead — shipping a new public key means a new build, which users can only
> get by installing by hand, which is the friction this exists to remove.

### 2. Public releases repo

```bash
gh repo create NotRover/RoverTools-Releases --public --add-readme
```

`--add-readme` matters: a release needs a commit to tag, and an empty repo has none.
It holds no source, only assets and `latest.json`.

### 3. Three secrets

In the **source** repo → Settings → Secrets and variables → Actions:

| Secret | What it is |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you set when generating it |
| `RELEASES_REPO_TOKEN` | A fine-grained PAT with `contents: write` on the releases repo |

The PAT is needed because the workflow's own token cannot write to another repo.

**No baseline tag is required.** The first release's notes are just "First release" —
nobody is updating *to* a first release, they install it.

---

## Versioning

You choose the bump at dispatch. Nothing is inferred from commit messages.

| Bump | `1.1.1` becomes | When |
|---|---|---|
| `patch` | `1.1.2` | Bug fixes, tweaks |
| `minor` | `1.2.0` | New features |
| `major` | `2.0.0` | Breaking changes — or `0.9.x` → `1.0.0`, committing to stability |

A bump zeroes everything to its right, so there is no way to reach a version like
`2.1.1` directly from `1.1.1`. If you ever need an exact version, set its predecessor by
hand (`cargo set-version 2.1.0` in `src-tauri`, committed and pushed) and then release a
`patch`.

A major bump is not special to the updater — it compares semver and offers anything
higher, so `1.1.1` → `2.0.0` reaches users through the same banner as a patch.

`src-tauri/Cargo.toml` is the single source of truth; `tauri.conf.json` has no
`version` field on purpose (Tauri falls back to Cargo.toml) and `package.json`'s copy
is cosmetic, kept in step by the workflow. Only plain `vX.Y.Z` tags count as releases —
the `v0.1.0-build.N` tags from [`build-linux.yml`](../.github/workflows/build-linux.yml)
are throwaway CI builds and are ignored.

## Release notes

Notes live in [`changelog/`](../changelog/): one file per shipped release, plus
`changelog/next.md`, the notes staged for the release you have not cut yet. You write
`next.md` *before* dispatching. The workflow reads it as the very first step —
publishes it as the notes, then renames it to `changelog/<version>-<bump>-<channel>.md`
(e.g. `0.2.0-minor-stable.md`, `0.1.14-patch-beta.md`) and opens a fresh `next.md`. The
filename states the version, bump and channel — all resolved at dispatch, none guessed
— so the directory reads at a glance like the run-name does. The convention lives in
[`changelog/README.md`](../changelog/README.md).

Author `next.md` with `/update-changelog`: it reads the commits since the last release,
keeps the user-facing ones (`feat` → New, `perf` and refinements → Improved,
`fix`/`revert` → Fixed; internal types get nothing) and writes them as a lead sentence
plus sections in the app's voice. Or edit it by hand — the empty skeleton is
[`changelog/TEMPLATE.md`](../changelog/TEMPLATE.md).

These lines are **user-facing copy**: the app's "What's new" panel renders the lead
sentence and the New/Improved/Fixed sections, the GitHub release body renders the same
text as markdown, and the No-AI-Slop rules in `CLAUDE.md` apply.

Internal work — backend and MCP plumbing, refactors, CI, docs, dependency bumps — goes
under a **`### Internal`** section instead. It is kept in the release file for the
record, but the workflow **drops it before publishing**, so it never reaches users.
That way nothing is lost and the "What's new" panel stays about the app. `### Internal`
does not count toward the emptiness check below.

**An empty `next.md` fails a real release**, in the first few seconds, before anything
is built — the enforcement is deliberate, so you cannot ship a version with no notes.
The two exceptions: the very first release (no prior tag) publishes "First release.",
and a dry run substitutes a placeholder so the rehearsal can still exercise the build.
A change you want users to see has to reach `changelog/next.md`; one that stays out of
it reaches nobody.

A promoted beta keeps its `-beta` filename — the name records how it was first cut.
Rename it (`git mv changelog/<v>-<bump>-beta.md …-stable.md`) if you want the directory
to track the current channel.

**The releases repo gets a copy too.** After the tag lands, the workflow mirrors the
`changelog/` files into the public releases repo and regenerates that repo's `README.md`
from them — releases split into a Stable group and a Beta group, each a collapsible entry,
newest first — so someone browsing the releases repo reads the same notes as the app. The
layout lives in one place, [`.github/scripts/gen-releases-readme.sh`](../.github/scripts/gen-releases-readme.sh);
the grouping comes from each file's heading, so renaming a promoted beta's file to
`-stable` moves it between groups on the next release. The source `changelog/` is still the
one home you edit — the releases-repo copy is generated, never hand-edited.

---

## Beta releases

```bash
gh workflow run release.yml -f bump=minor -f prerelease=true
```

There are **two channels**, and anyone can opt in from Settings → Updates → *Get beta
versions*. Beta subscribers are offered betas **and** every normal release; stable
users are only ever offered normal releases.

| | Feed the app asks | Serves |
|---|---|---|
| Stable (default) | `releases/latest/download/latest.json` | Newest non-prerelease |
| Beta | `raw.githubusercontent.com/…/HEAD/beta.json` | Newest release of **either** kind |

Two different mechanisms because each is the simplest thing that works for its job.
Stable rides on GitHub's own `latest` resolution, which needs no maintenance and makes
promotion a one-line edit. Beta needs a pointer that *can* name a prerelease, and no
GitHub URL does that — so the workflow rewrites `beta.json` on **every** publish. That
"every" is what gives beta subscribers stable releases too.

`beta.json` is a committed file rather than a release asset on some fixed tag: a
mutable pointer *release* would either hijack `latest` or have to be excluded from
pruning by hand.

Promoting a beta to everyone, once you are happy with it:

```bash
gh release edit v0.3.0 --repo NotRover/RoverTools-Releases --prerelease=false --latest
```

An edit of the same bundles, not another build — so stable users receive exactly what
testers approved. Beta subscribers already have it and see nothing new, which is
correct.

Two things to know:

- **The version number is spent either way.** The bump and tag land on `main`
  regardless, so a beta that fails testing means the next attempt is the following
  patch.
- **Leaving the beta channel does not downgrade anyone.** The updater only moves
  forward. Someone on a beta stays there until a stable release passes it.

---

## What can and cannot self-update

| Bundle | Self-updates | Why |
|---|---|---|
| NSIS (`.exe`) | **Yes** | The installer reruns and replaces the app in place |
| AppImage | **Yes** | A single file the updater can swap |
| `.deb` / `.rpm` | No | Owned by the package manager; published for manual install only |

`.deb`/`.rpm` never appear in `latest.json` — offering an update the client cannot
install is worse than offering none. macOS is not built at all; that needs a
`.app.tar.gz` target plus Apple notarization.

---

## Safety rails

The workflow fails rather than shipping something broken:

- **Prerequisites** — placeholder pubkey, missing secret, or a releases repo that is
  missing, private or empty. Checked before building.
- **Non-semver version** → refused. The updater compares semver, so an unparseable
  version would publish and then never be offered.
- **A missing `.sig`** for an updatable bundle → refused. Unsigned bundles build fine
  and are then rejected by every client: invisible until users are stuck.
- **Feed verification** → after publishing, fetches `latest.json` through the same URL
  the app uses and range-requests every bundle URL it advertises.
- **Channel correctness** → every run confirms `beta.json` names the release just
  published, and a beta run additionally confirms the *stable* feed is **not** serving
  it. A beta leaking to everyone is silent otherwise.
- **Pruning** keeps the newest 5 releases and skips whichever is marked latest, so the
  release being served is never deleted.

Use `-f dry_run=true` to build and verify without publishing. Worth doing after editing
the workflow itself; not needed for an ordinary release.

### Asset names have no spaces, deliberately

Tauri names bundles after `productName` — "Orange Copy Paste" — and GitHub rewrites
spaces in uploaded asset names to dots, which would break every URL in `latest.json`.
The workflow renames bundles to a `RoverTools_<version>_…` prefix and builds the URLs
from the renamed files.

---

## Things worth knowing

**Windows warns on the first install.** The bundles have a minisign signature, not
an Authenticode one, so SmartScreen shows "unrecognized app" — *More info → Run
anyway*. The workflow appends a note saying so to every GitHub release body, but
not to `latest.json`: SmartScreen keys off the Mark of the Web, which browsers
attach to downloads and the updater doesn't, so in-app updates never trigger it.
Removing the warning needs a paid certificate; the app README has the options.

**Updates are disabled in debug builds.** A dev build reports the Cargo.toml version,
so it would see any release as an upgrade and install over `target/debug` — replacing a
build that loads from `devUrl` with one that doesn't. `updater.rs` refuses instead.

**"Run on startup" survives an update.** An update reinstalls rather than patches, so
the recorded path can name a replaced executable. The app rewrites the entry from its
own location at every launch when the setting is on (`reconcile_autostart`).

**Windows installs are per-user** (`nsis.installMode: currentUser`), which keeps the
install path stable across versions and avoids a UAC prompt on every update.

**Install ends the process.** On Windows the installer takes over and the app exits
mid-call; on Linux the AppImage is replaced and the app restarts itself. That is why
installing sits behind a second confirmation rather than following the download —
nobody should lose their window to a background download finishing.

---

## Smoke test before trusting it

The updater itself can only be checked with two releases:

1. Release once. Install it from the published `.exe` — not a local `tauri build`,
   which is unsigned and would not test the signing key.
2. Release again.
3. Launch the older install. Within ~8 seconds the banner should appear (a
   running app re-checks every 6 hours, so restarting is the fast way to see it).
4. Download → progress → **Restart & install** → the app comes back on the new version.
5. With "Run on startup" on, confirm it is still on and pointing at the new executable.
