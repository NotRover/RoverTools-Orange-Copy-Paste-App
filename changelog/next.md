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

A round of clipboard, sharing, and image-viewer refinements, with fixes for notifications and synced items.

### New
Copied bundles of files now show as a preview grid or list with a chip marking the bundle, so you can see what is inside at a glance.

The image viewer has an Original size option next to Fit, and the magnifier zooms in and out on its own from wherever you are.

Clicking a space notification for a comment, invite, or join request now opens that space. Space activity also shows a desktop notification while the app is open, unless you are already looking at that space.

Spaces have a delete-for-me option, and removing a shared item from a space now asks you to confirm and explains what the removal does.

### Improved
Your cloud storage breakdown loads much faster, without the long counting wait.

Cloud storage stats now count only the items you uploaded, and the app remembers whether you last viewed This device or Cloud.

### Fixed
A join request notification can be acted on directly and clears itself once you have answered it.

A space you just created no longer shows up twice in the list.

An item someone shared with you no longer comes back as your own after you delete it.

### Internal
Cloud storage stats are backed by a new server breakdown endpoint, with the full row sweep kept as a fallback.

Backend and website submodule pointers were bumped to match.
