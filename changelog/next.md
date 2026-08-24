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

Anything you open now gets the whole window. A clipboard entry, a note, or an item someone
shared with you opens into a full view instead of a cramped panel, and the note editor
gains zoom.

### New
- Open a clipboard entry to fill the window, with text, images, HTML, and file lists shown
  at a readable size and zoom for the ones that need it.
- Set what a single click on an entry does, copy it or open it. Whichever you pick, the
  other happens on a double click.
- Items shared into a space open the same way, with the same view controls and zoom a
  clipboard entry gets.
- A note shared into a space opens in the note editor, so it reads the way your own notes
  do.
- Zoom the note editor with the buttons or with Ctrl and plus, minus, or nought. The size
  carries over to the next note you open.
- Expand the note editor to fill the window and hide the note list.

### Improved
- Opened items look the same on the clipboard, notes, and Spaces screens, with the same
  controls in the same place.
- The search bar gets out of the way while something is open, so the item has the screen
  to itself.
- The note editor matches the rest of the app, with pin, groups, and delete gathered into
  one menu.
- Cloud sync moved to a new server. Older versions cannot reach it, so update to keep
  syncing.
- Scrollbars look and behave the same everywhere, and none of them sit against the window
  edge any more.
- Searching your history stays fast when it holds a very large entry.

### Fixed
- Copying something enormous no longer stalls the app. Anything over 4 MB is refused as
  you copy it, and the app tells you why.
- Your settings reach the cloud again. They were collected and then never sent, so your
  other devices kept the old ones.
- Deleting a group now removes it from your notes, instead of leaving it there with no way
  to get rid of it.
- An item withdrawn from a space now disappears even from a device that was closed when it
  happened.
- Right-clicking no longer opens the browser's own menu, and Refresh no longer throws away
  what the window was holding. Cut, copy, and paste still work wherever you can type.
- The list of spaces lines up with the buttons underneath it.

### Internal
- Backend moved to a self-hosted VPS behind Docker and Caddy, with the deploy runbook,
  hardening notes, and design memo in the backend docs.
- Dropped 29 unused icons, an orphaned component, 46 dead CSS rules, a Tiptap dependency,
  5 dead Tauri commands, and 5 dead Rust helpers; the bridge reconciles at 129 to 129.
- Removed the unread settings_updated_at field, with tests pinning that an older
  sync_state.json still parses.
- Space removals now travel on pull as well as the socket, behind serde(default) so a
  client ahead of the backend still parses.
- MAX_INLINE_SYNC_BYTES derives from the server row limit so the two cannot drift; history
  files written before the cap are pruned and the amount reported.
- Extracted the HTML sanitiser into a shared module so the card and the viewer cannot
  disagree.
- Docs: migration-safety guidance for the VPS deploy, the DEPLOY.md home row, bugfix
  history for the empty-spaces-list regressions, and several backend submodule bumps.
