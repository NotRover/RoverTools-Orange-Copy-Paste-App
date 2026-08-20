<!--
  Draft the next release's notes in changelog/next.md, with /update-changelog or by
  hand. Start with one plain sentence about what the release gives the user, then fill
  only the sections that apply and delete the empty ones.

  Rules (New / Improved / Fixed ship to users):
  - One sentence per bullet, present tense, user perspective. End with a period.
  - Describe the visible effect, not the code. No jargon, file names, or internal detail.
  - ASCII punctuation only. No em dashes, curly quotes, or the section sign.
  - feat -> New, perf or a refinement -> Improved, fix -> Fixed.

  Internal work (backend, MCP plumbing, refactors, CI, docs, dependency bumps) goes under
  ### Internal. It is KEPT here for the record but NOT shown to users: the release
  workflow drops the Internal section when it publishes the notes.

  On release the workflow publishes New/Improved/Fixed (minus this comment, the Internal
  section, and any empty section), then moves this file to
  changelog/<version>-<bump>-<channel>.md and opens a fresh next.md. An empty user-facing
  set fails a real release on purpose.
-->

Joining a shared space is quicker, and it works the moment a member approves you.

### New
- Request access to a space with a code or link, and get in once a member approves.

### Improved
- Enter a shared space right away after joining; sending waits only until its key arrives.

### Fixed
- Stay signed in instead of being signed out while your device is still registered.

### Internal
- Consolidate the docs so each fact has one home, and bump the backend submodule.
