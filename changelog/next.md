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

The app comes to the Mac, Settings is one page with a contents list, devices carry their computer's name, you can point the app at your own server, and the copy popup is instant again.

### New
- The app now runs on a Mac, on Apple silicon and Intel. Each release has a `.dmg` for each chip, and updates install from inside the app as on Windows. The hotkeys are Cmd+Shift+V and Cmd+Shift+C, and the Shortcuts screen shows the Mac keys.
- On Linux and macOS, copied files and rich text are now captured into history and copy back out, as they already did on Windows, and image entries are labelled with the date and time.
- Developer options, at the end of Settings. Turn them on, after a confirmation, to point the app at your own server, inspect the sync connection, and read updates from your own feed. They are off by default and the default server does not change unless you tell it to.
- Point the app at a self-hosted server with one URL. Enter the server, press Discover and it fetches the rest from the server, then Test connection checks it before you save. A self-signed certificate can be pinned by its fingerprint, and plain http is allowed on a private network when you turn that on.
- The Connection panel under Developer options shows what the sync engine sees: whether the server answers and how fast, whether its database and Redis are up, the WebSocket state, the sync cursor, the pending queue and your storage use. The small button next to Reachable sends 5 requests in a row and shows their average.
- Reset to default, above Update feed under Developer options, puts the app back on the server the app shipped with after a confirmation. It stays greyed out while you are signed in.
- Search settings from the box above the list. It shows only the settings whose name or description contains what you typed.

### Improved
- Devices on the Account screen are listed under the computer's own name, such as the one Windows or macOS shows in its settings, instead of a generic "Orange CP" label, with a Windows, Apple, Android or Linux logo beside it. A device already registered picks up its name the next time it starts.
- Settings is one scrolling page again, with a contents list beside it. Pick a group in the list to jump to it, and the group you are looking at is lit as you scroll. The page is centered like the Account screen.
- A yellow asterisk marks any setting you have changed from its default, on the setting and on its group in the list, so you can see at a glance what is not stock.
- The Developer group and the Cloud sync card on the Account screen are each one card with divided rows instead of several stacked cards, and the Cloud sync rows say what they do in one line beside their control.
- The Passive sync mode is gone. Realtime already pulls in the background every 5 minutes, so Passive only delayed what you saw. A device that was on Passive is now on Realtime.

### Fixed
- The copy popup and the desktop notification show the moment you copy, instead of after the entry is written to disk.
- In-app toasts close when their progress bar ends. They used to stay up for as long as the app was busy after the bar had run out.

### Internal
- Release workflow builds and signs macOS bundles for both chips; Apple signing and notarization secrets are optional and documented in docs/releasing.md.
- tauri-plugin-deep-link 2.6.2 -> 2.6.3, which fixes the Linux build against rust-ini 0.21.3 (the failed v0.5.1 run).
