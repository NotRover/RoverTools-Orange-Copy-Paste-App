<!--
  Draft the next release's notes in changelog/next.md, with /update-changelog or by
  hand. Start with one or two plain sentences about what the release is for, then fill
  only the sections that apply and delete the empty ones.

  Rules (New / Improved / Fixed ship to users):
  - Substance is the point. One to three sentences per entry: what changed and why it
    helps the user. Not a one-line paraphrase of the commit subject.
  - Give every distinct user-facing change its own entry. Do not collapse a release
    into four lines; bigger releases get fuller notes.
  - Present tense, user perspective. End with a period. Describe the visible effect,
    not the code. No jargon, file names, or internal detail.
  - ASCII punctuation only. No em dashes, curly quotes, or the section sign. Write two
    sentences rather than joining with a dash.
  - feat -> New, perf or a refinement -> Improved, fix -> Fixed.

  Internal work (backend, MCP plumbing, refactors, CI, docs, dependency bumps) goes under
  ### Internal. It is KEPT here for the record but NOT shown to users: the release
  workflow drops the Internal section when it publishes the notes.

  On release the workflow publishes New/Improved/Fixed (minus this comment, the Internal
  section, and any empty section), then moves this file to
  changelog/<version>-<bump>-<channel>.md and opens a fresh next.md. An empty user-facing
  set fails a real release on purpose.
-->

### New

- Passwords must be at least 8 characters. This applies when you sign up, change your password, or set one after signing in with Google.

### Improved

- Changing your password now asks for your current one first, and creating a recovery code asks for your password. Both actions can open your account from another machine, so only someone who knows the password can do them.
- A device you revoke from the account screen is signed out within seconds, even while it is running, instead of keeping access until its session expires.
- Links inside copied web content open in your browser only when you click them in the viewer. Previews no longer follow links on their own.
- Joining a space from a link now shows the join form with the code filled in, so you confirm before joining.

### Fixed

- Copied web content is cleaned before it is shown, so a page cannot run scripts or load remote images inside the app.
- Your account password now stays on your device. Signing in sends a separate login key derived from it, so the service that checks your sign-in never holds the password that unlocks your data. Existing accounts switch over the next time you sign in, with nothing to do and nothing re-encrypted.

### Internal

- Client: `derive_master` (Argon2id, email-salted) split with HKDF-SHA256 into `derive_auth_key` (the Supabase credential) and `derive_kek` (wraps the UMK, AAD `umk-envelope-v2`). Legacy `umk-envelope-v1` envelopes are opened read-only and re-wrapped on sign-in, then the Supabase credential is replaced.
- Backend `docs/architecture.md` section 7.1 documents the split and the migration; no backend code change.
