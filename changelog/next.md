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

Your history and notes now live in one local database, and you can encrypt it.

### New

- Encrypt your history and notes on this PC. The new switch under Settings > Data encrypts the text of every entry and note with a key kept in your computer's credential store, so a copied database cannot be read. It is off by default, and turning it on or off rewrites everything in a few seconds.
- Encrypted entries show a shield next to the cloud icon on their card, so you can see at a glance which entries are protected on this PC.
- Open the app log from Settings > Data. The app now keeps a log file on disk, with no clipboard contents in it, that you can attach to a bug report.

### Improved

- History, notes and notifications are stored in one database that is written as you go. Every copy is saved the moment it happens, so a crash or a forced shutdown no longer loses recent entries, and the app no longer needs to repair its files at startup.
- The first start after updating moves your existing history, notes and sync records into the database, and the start after that removes the old files. The data folder now holds only the database, your images and files, settings and the log.

### Fixed

### Internal

- `app.db` (SQLite, WAL, write-through per mutation) replaces the MessagePack files and the JSON sync records; `storage/import.rs` migrates them once. The flush loop, dirty flags, seal and quarantine machinery are gone.
- `logging.rs` writes every `log` record to `logs/app.log` with size rotation; `crash.log` is folded into it.
- Encryption at rest is AES-256-GCM on the text columns with a per-install keychain key and a per-row flag (schema v2), not a page cipher.
