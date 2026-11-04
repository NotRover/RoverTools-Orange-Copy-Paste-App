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

### Improved
- On Linux the app no longer draws its own startup notice or copy and paste popups. Those windows could not be placed reliably on every desktop. A clip that is too large for history, and the short wait for sync when you quit, now show as normal desktop notifications. Update checks work as before.

### Fixed
- Updates now install on Linux. A copy installed from the deb package used to download the update and then fail with an error. It now installs the new deb after asking for your password, then reopens.

### Internal
- Linux: dropped the XWayland default added in 0.5.3; GDK runs natively again.
- The release workflow can now finish a release whose first publish stopped at a draft.
- Linux ships as a deb only. The AppImage is no longer built; an AppImage install sees no update and has to install the deb once.
- A feed with no entry for this install is treated as no update on every platform, not as a failed check.
