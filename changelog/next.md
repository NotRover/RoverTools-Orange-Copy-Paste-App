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

Settings is one page with a contents list, you can point the app at your own server, and the copy popup is instant again.

### New
- Developer options, at the end of Settings. Turn them on, after a confirmation, to point the app at your own server, inspect the sync connection, and read updates from your own feed. They are off by default and the official server does not change unless you tell it to.
- Point the app at a self-hosted server with one URL. Enter the server, press Discover and it fetches the rest from the server, then Test connection checks it before you save. A self-signed certificate can be pinned by its fingerprint, and plain http is allowed on a private network when you turn that on.
- The Connection panel under Developer options shows what the sync engine sees: whether the server answers and how fast, the WebSocket state, the sync cursor, the pending queue and your storage use.
- Search settings from the box above the list. It shows only the settings whose name or description contains what you typed.

### Improved
- Settings is one scrolling page again, with a contents list beside it. Pick a group in the list to jump to it, and the group you are looking at is lit as you scroll. The page is centered like the Account screen.
- A yellow asterisk marks any setting you have changed from its default, on the setting and on its group in the list, so you can see at a glance what is not stock.
- The Developer group and the Cloud sync card on the Account screen are each one card with divided rows instead of several stacked cards, and the Cloud sync rows say what they do in one line beside their control.
- The Passive sync mode is gone. Realtime already pulls in the background every 5 minutes, so Passive only delayed what you saw. A device that was on Passive is now on Realtime.

### Fixed
- The copy popup and the desktop notification show the moment you copy, instead of after the entry is written to disk.
- In-app toasts close when their progress bar ends. They used to stay up for as long as the app was busy after the bar had run out.

### Internal
- Backend: a public discovery route at /.well-known/orange-copy-paste.json returns the server's public settings so a client can be set up from one URL; SUPABASE_ANON_KEY is a new server setting.
- Certificate pinning and the plain-http rule live in the Rust sync config and TLS modules; the updater takes a feed and key override.
- The tauri npm packages now match the crate version and the React plugin moved to Vite 8, so tauri dev starts again.
- Docs: client architecture, self-hosting, settings and cloud-sync pages updated; bug #36 recorded.
