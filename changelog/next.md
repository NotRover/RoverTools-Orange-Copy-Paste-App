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

Times were wrong whenever two of your devices disagreed about the clock, so an item
that had just arrived could claim to be minutes old. This release measures every
timestamp against the same clock, and adds a way to filter a list by who added what.

### New

Filter by who added an item. The clipboard, notes and Spaces filters each have a Mine
switch and a From others switch, so you can narrow a list down to your own items or to
what other people sent. Picking one clears the other, and each shows how many items it
would leave.

### Fixed

Something copied on another device no longer shows the wrong age. Every timestamp is
now measured against one shared clock instead of whichever machine happened to write
it, so an item that just arrived reads as new. It also lands in the right place when
you sort by time.

The cloud and sharing filters no longer run their labels together. Each option is now
given room in proportion to how long its label is, rather than an equal share, so the
counts stay readable at every window size.

The Clear button on the active filter bar no longer looks cut off. It now fills the end
of the bar and follows its rounded corner.

### Internal

Point the backend submodule at its current commit.

Remove a CSS rule that was added while measuring the filter bar and turned out to
change nothing.
