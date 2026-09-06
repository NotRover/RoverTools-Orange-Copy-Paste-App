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

A refreshed startup experience and a hands-off way to stay current. The splash now lives quietly in the corner, tells you when an update is waiting, and can install it for you.

### New

- The startup splash is now a small card in the bottom-right corner instead of a box in the middle of the screen. It slides in by the tray, shows a quick tip for using the app, and slides away on its own.
- The splash checks for a newer version as the app starts and tells you when one is available, so you find out at launch rather than the next time you open Settings.
- You can now have updates install themselves. Turn on "Install updates automatically" in Settings under Updates, and when a new version is found at startup the app downloads and installs it before it opens. Nothing installs while you are working, only at launch, and it is off until you turn it on.
- The copy and paste popups can be moved. Drag either one by its header to shift it out of the way for that appearance.

### Fixed

- The copy popup no longer pops up again when you use the copy shortcut on something that is already at the top of your history. It appears only when something new is actually captured.
