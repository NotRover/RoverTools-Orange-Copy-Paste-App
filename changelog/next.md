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

Files and folders now sync across your devices, and deleting synced or shared items is clearer and safer to do.

### New

Files and folders now sync across your devices, sent as a single zipped copy that unpacks on the other side.

Deleting a synced item now asks you to confirm first, and the prompt spells out what the delete does. A "Don't ask again" option turns it off.

Deleting an item someone shared with you now removes it from all your devices at once, while it stays in the space for everyone else.

### Improved

The copy and paste quick popups have a cleaner, redesigned look.

The quick-copy popup opens faster.

Removing an item from the cloud now says it stays on this device and leaves your other devices.

### Fixed

Images copied while offline now retry on their own and catch up once you are back online.

Opening the delete confirmation from a quick popup no longer floods the app and can hang it.

### Internal

Backend: account_full no longer refuses a new tombstone insert (the quota counts live rows only), so removing a received entry works at any quota; sync architecture docs updated. Copy and paste popup preview refactor. Submodule pointer bumps (backend, website).
