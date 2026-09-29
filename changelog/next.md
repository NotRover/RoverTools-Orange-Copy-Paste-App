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

This release keeps your clipboard history through restarts, reboots and new PCs. Anything your account holds that is missing on a PC now comes back on its own, and you can also ask for it from the Account screen.

### New
- The Account screen has a new "Restore from cloud" line with a "Restore" button. It downloads anything your account holds that is missing on this PC, then shows what it did, such as "Restored 1,445 items." or "Nothing to restore." Items you deleted stay deleted.
- Missing items now come back without you asking: after every sign-in, at startup, when you first get access to a space on this PC, and when your account holds more of your items than this PC does. In "Manual" sync mode this waits until you press "Refresh" or "Restore".

### Improved
- Clipboard history no longer stops at 100 entries. Older entries stay until you delete them or clear your history. The size limit for a single entry is unchanged.
- Entries are no longer cleared when your PC restarts. Before, unsaved entries were removed after every reboot even with "Keep history across restarts" on.
- The first start after updating can bring back older synced entries that the old 100-entry limit, a restart with "Keep history across restarts" off, or the reboot clear had removed, along with items you deleted whose removal never reached the cloud. For long-time users this can be thousands of entries. Delete the ones you do not want and they stay deleted.
- "Keep history across restarts" is now on by default, including on existing installs where you never changed it. With it off, only pinned and Saved entries and anything in the cloud or a space stay after a restart. If you want it off, turn it off in Settings on each PC.
- "Auto-save copied entries" is now on by default, including on existing installs where you never changed it. Every new entry goes to the Saved group, so "Clear history" keeps it and only removes entries copied while Auto-save was off. To have "Clear history" remove new entries, turn off "Auto-save copied entries" in Settings on that PC.
- "Keep history across restarts" and "Auto-save copied entries" now apply to each PC separately and no longer follow your account. Changing one on this PC leaves your other PCs as they are. Your theme, layout, sort order, groups and your other synced settings still follow your account, as before.
- The recovery code now has its own line on the Account screen, with a "Replace" button once you have saved one, or "New code" if you have not.

### Fixed
- A PC signed in to sync could show an empty clipboard history, with nothing in your spaces, after a restart, while your other PCs still had everything. If this happened to you, update the app: the missing items come back at the next start, or press "Restore" on the Account screen.
- Signing out and back in with the same account no longer leaves a PC with an empty history. Before, items this PC had downloaded once were never downloaded again.
- Signing in on a new PC no longer replaces your account's settings with that PC's defaults. The PC now takes your account's settings first and applies them, and after that sends only the settings you change on it.
- The layout control could show one layout while the history showed another, such as tiles selected with the history in two columns. Empty or unknown layout and sort values from your account are now ignored.
- A PC with no groups of its own no longer clears the groups on your other PCs. As a result, deleting your last group on one PC leaves the groups on your other PCs in place.
- Pinning or unpinning an entry is now saved with "Keep history across restarts" off. Before, the change could be lost when the app closed.
- Turning on "Keep history across restarts" no longer replaces your saved history with only the entries the app held at that moment.
- Saving history no longer deletes the images and received files of entries that were missing from the app at that moment, so those entries keep their pictures and files when they come back.
- With "Keep history across restarts" off, quitting the app now also deletes the images and received files of the entries it clears.
- Installing an update no longer closes the app before it has saved your newest entries.
- Items you delete stay deleted. The removal is recorded before it is sent, so a restore or a sync that runs at the same moment cannot bring the item back. An item you delete while signed out or with sync off stays deleted on this PC, but it stays in the cloud and on your other devices.
- If the app cannot load your clipboard history when it starts, it now tries again instead of showing an empty history that looks like your entries are gone. If it still cannot, it says "Could not load your clipboard history. Nothing was deleted. Restart the app to try again." Your history shows as soon as a later load works, such as when you come back to the window.
- Filters from the "Cloud" section, such as "In cloud" or a space, and the "Mine" and "From others" filters no longer apply while you are signed out or the app is still signing you back in. Before, your clipboard history or notes could look partly or completely empty with no filter showing. Your choices are kept and apply again when you sign in.
- Changing your theme, layout, sort order, "Number-key paste slots", or your groups and their colors now reaches your other running PCs within a few seconds. Before, the change went out only when the app restarted or another synced setting changed. A new layout or sort order shows on the other PC the next time you open its clipboard history.
- A settings sync that could not finish, such as on a PC that went offline, no longer undoes a change you make on another PC afterwards. Before, the next sync could send a setting that PC had just received, such as your theme, back over the newer one.

### Internal
- Sync engine: an additive restore sweep downloads account rows this install lacks. It runs after each sign-in, at launch and on Refresh when `id_map` lists missing rows or the own-item count from `/sync/breakdown` is ahead, and on a space's first key arrival (a durable once-per-space gate). Manual mode defers it; the sweep replaces `backfill_pull`.
- Deletes are write-ahead: every Delete is persisted to `sync_pending.json` before it is sent, and a delete with no client writes a permanent `local_only` marker in `id_map.json` instead of queuing a tombstone.
- Settings sync: three-way merge of server, local and last-synced base, pulled before the first push and applied to the running app. `keep_history` and `autosave` no longer roam, and empty or unknown values are refused.
- Settings sync: the PUT sends `base_updated_at`, the stamp of the blob the round pulled, so the server stores it only over that blob; a refused round keeps what it applied in its base and merges again against the newer blob. Needs the backend's conditional PUT deployed; an older server ignores the field and stays last-write-wins.
- Persistence: `MAX_HISTORY` and the reboot clear removed; the full save no longer sweeps `images/` and `received-files/`; a far smaller file moves the old `.bak` to `.bak.prev`; history is flushed before the cursor moves, at quit and before the updater exits; pins flush with Keep history off.
- Fixed in passing: the sealed-leftover lock deadlock, a queued Delete dropped when its tombstone could not be built, `backfill_pull` swallowing page errors, a personal-delete race with Pull and Live downloads, and duplicate tombstones from a flush during a delete fan-out.
- Rust tests cover the uncapped history store and its upgrade, the restore sweep and its delete guards, write-ahead and offline deletes, the settings merge and the `.bak.prev` rotation; the degraded-mode suite is updated.
