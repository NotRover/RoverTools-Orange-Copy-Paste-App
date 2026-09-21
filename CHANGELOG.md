# Changelog

Every shipped release of Orange Copy Paste, newest first. Generated from the
per-release files in [`changelog/`](changelog/) by
`.github/scripts/gen-changelog.sh` on each release. Do not edit by hand; edit the
source file in `changelog/` instead.

## 0.3.8 (patch, beta) - 2026-09-21

This release points the in-app updater at the current release location.

### Fixed
- The updater now checks for new versions in the right place, so update checks and downloads work correctly.

---

## 0.3.7 (patch, beta) - 2026-09-16

### Improved
- Account sync now runs on its own dedicated address. Existing sign-ins keep working; just update the app.

---

## 0.3.6 (patch, beta) - 2026-09-15

### Fixed
- Copying several history entries at once now confirms it worked with a short message, and tells you when a selection could not be copied instead of looking like nothing happened.

---

## 0.3.5 (patch, beta) - 2026-09-14

This release adds bulk copy from selection mode and rounds out the paste popup with a keep-open option, an in-app guide, and clearer previews.

### New
- Copy several clips at once. In selection mode a new Copy action puts every selected entry on the clipboard together: text entries join into one block, and files or images copy as a group. If you mix text with files or images, Copy turns off and tells you which kinds clash.
- Choose whether the paste popup stays open after you copy. A new setting, "Keep paste popup open after copying," leaves the popup up so you can grab another clip; pasting still closes it. It is on by default.
- A quick guide in the paste popup. A "?" in the header lists how to paste, use the number keys, and reach the per-row pin, copy, and delete actions.

### Improved
- The paste popup preview now shows the full file or image name instead of cutting it off.
- The paste popup fits all ten number-keyed rows without scrolling, and the preview panel slides in when you open it.

### Fixed
- The close button in the paste popup is no longer clipped at the window edge.

---

## 0.3.4 (patch, beta) - 2026-09-07

Launching the app while it is already running now reliably brings the window you already have to the front.

### Fixed
Starting the app while it was already running in the background could open a fresh copy behind the startup toast instead of showing the window you already had. It now brings the running app to the front, the same as clicking the tray icon or the taskbar.

---

## 0.3.3 (patch, beta) - 2026-09-07

Starting the app while it is already running now brings it back into focus.

### Fixed
Launching the app while it is already running in the background now brings its window to the front, the same way clicking the tray icon or taskbar entry does. Before, a second launch just flashed the startup toast and left the app in the background.

---

## 0.3.2 (patch, beta) - 2026-09-06

A refreshed startup experience and a hands-off way to stay current. The splash now lives quietly in the corner, tells you when an update is waiting, and can install it for you.

### New
- The startup splash is now a small card in the bottom-right corner instead of a box in the middle of the screen. It slides in by the tray, shows a quick tip for using the app, and slides away on its own.
- The splash checks for a newer version as the app starts and tells you when one is available, so you find out at launch rather than the next time you open Settings.
- You can now have updates install themselves. Turn on "Install updates automatically" in Settings under Updates, and when a new version is found at startup the app downloads and installs it before it opens. Nothing installs while you are working, only at launch, and it is off until you turn it on.
- The copy and paste popups can be moved. Drag either one by its header to shift it out of the way for that appearance.

### Fixed
- The copy popup no longer pops up again when you use the copy shortcut on something that is already at the top of your history. It appears only when something new is actually captured.

---

## 0.3.1 (patch, beta) - 2026-09-03

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

---

## 0.3.0 (minor, beta) - 2026-09-02

Files and folders now sync across your devices, and deleting synced or shared items is clearer and safer to do.

### New
Files and folders now sync across your devices, sent as a single zipped copy that unpacks on the other side.

Deleting a synced item now asks you to confirm first, and the prompt spells out what the delete does. A "Don't ask again" option turns it off.

Deleting an item someone shared with you now removes it from all your devices at once, while it stays in the space for everyone else.

### Improved
The copy and paste quick popups have a cleaner, redesigned look.

The quick-copy popup opens faster.

Removing an item from the cloud now says it stays on this device and leaves your other devices.

### Fixed
Images copied while offline now retry on their own and catch up once you are back online.

Opening the delete confirmation from a quick popup no longer floods the app and can hang it.

---

## 0.2.3 (patch, beta) - 2026-08-29

A fix for password reset, which stopped working after the sync service changed
addresses.

### Fixed
- The link in your password reset email opens the app again. Requesting a new
  password from the sign-in screen now works from start to finish.

---

## 0.2.2 (patch, beta) - 2026-08-28

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

---

## 0.2.1 (patch, beta) - 2026-08-28

Two fixes for the Spaces feed. Placeholders for items taken out of a space now sit where
the item was, and they say who took it out.

### Fixed
- A placeholder for an item removed from a space now sits where the item sat, among the
  things it was shared alongside. It used to land under the day it was taken down, in a
  date group of its own with nothing around it to say what it referred to.
- The placeholder now names who removed it. Taking your own item out of a space read as
  "A space owner took this item out of the space", describing you in the third person as
  somebody who had moderated you. It now says "You", and when it was someone else it uses
  their name.
- The picture on a "Shared by" chip no longer shows a broken-image icon. A profile
  picture that cannot be loaded falls back to initials, the way every other picture in
  the app already did.

---

## 0.2.0 (minor, beta) - 2026-08-24

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

---

## 0.1.16 (patch, beta) - 2026-08-21

This release is about staying signed in. The app no longer shows the sign-in screen while
it is still reconnecting your account, and closing or relaunching it while it renews your
session no longer throws that session away.

### Fixed
- The app no longer shows the sign-in screen while it is still reconnecting. You see a
  reconnecting message instead, so you do not sign in again over a session that was
  coming back on its own.
- Quitting from the tray, closing the window, or launching the app again while the first
  copy is still running no longer signs you out. Each of those waits a moment for a
  session renewal in progress to finish.
- Installing an update no longer loses the last few seconds of what you copied.
- Passive sync mode works from the moment the app starts. Items arrive on their own
  schedule, and reminders about a Manual queue waiting to upload or storage running low
  appear again, without you needing to open the Account screen first.
- An item you delete while offline stays deleted. The pending deletion could be dropped
  if the app closed part way through a sync, which brought the item back.
- Release notes in the Settings update card show their headings and lists instead of raw
  markdown.

---

## 0.1.15 (patch, beta) - 2026-08-20

The app can now tell you things without you looking at it: a short sound when something
happens, and a Windows notification when you are working in another window. It also fixes
a password reset that could leave you locked out of your account.

### New
- The app plays a short sound when a shared item arrives, someone asks to join your
  space, a space opens up for you, or an action is refused.
- Windows notifications appear for those same events, but only when the app is not the
  window you are working in, so a toast never lands on top of what you are already
  looking at.
- Settings has new Notifications and Sounds sections, with a button to play each sound
  before you decide to keep it on.
- Sounds for copying and pasting are available but off by default, since they fire far
  more often than the rest.

### Improved
- Scroll bars on Settings, Account, and the note editor are now inset to match the rest
  of the app instead of sitting flush against the window edge.
- Rows on Settings and Account have a bit more space between the label and its divider,
  so long option lists read less crammed.

### Fixed
- Password reset works again after failing on the step right after you opened the reset
  link. It also tells you plainly when a link was already used or came from a different
  install.
- Sign-in errors now say what went wrong in plain language (wrong password, unconfirmed
  address, expired session, email already in use) instead of a raw server error with a
  status code.
- Opening the app no longer announces every space you already belong to as newly
  available; you are told once, when access actually arrives.

---

## 0.1.14 (patch, beta) - 2026-08-20

Joining a shared space is quicker: ask for access with a code or link, and you are in and working the moment a member approves you.

### New
- You can now request access to a space instead of needing a direct invite. Share or open a space code or link, and once any member approves the request you join, with the space key handed to your device automatically.

### Improved
- Joining a space no longer makes you wait. You enter and can read the space right away, and only writing to it pauses until the space key arrives, rather than the whole space being blocked until then.
- The download progress bar in the update notification moved under the Download button, so the notification has room to show readable release notes while an update downloads.

### Fixed
- You no longer get signed out unexpectedly. As long as your device is still registered, the app keeps your session instead of dropping it when a server check comes back ambiguous.

### Internal
- Documentation consolidation, the new changelog directory flow, and backend submodule updates.

---

## 0.1.13 (patch, beta) - 2026-08-19

A round of interface fixes, with clearer feedback when a space invite is turned down.

### Improved
- When a space invite is refused, the app now tells you why and shows it as a toast, instead of failing quietly.

### Fixed
- The paste slots menu and the account card work again after a display issue had broken them.
- A space error no longer shows up in two panels at the same time; you see it once, where it belongs.

### Internal
- Render server configuration in the MCP settings, plus backend submodule updates.

---

## 0.1.12 (patch, beta) - 2026-08-19

Recovery codes make a forgotten password survivable, and a new cloud view shows exactly what you have stored so you can manage it.

### New
- You can set a recovery code when sync is on. Your synced data is encrypted with a key only your password unlocks, so a forgotten password used to mean losing access to everything synced; the recovery code is a second way back in.
- A new cloud view in your account shows what you have stored, grouped by type, and lets you open any item directly instead of guessing what is taking up space.
- Space invites are now managed from a single popover, so creating, sharing, and revoking them all happen in one place.

### Improved
- A space invite can be shared as a web link instead of only a deep link, so it opens for people who do not have the app installed yet.
- When an item cannot be uploaded, the app now tells you the reason instead of just failing.

### Fixed
- Password reset links work again, and resetting your password keeps your synced items instead of stranding them.
- After signing in with Google, you can retry your password without starting the whole login over.
- A refused image upload no longer leaves orphaned storage behind in the cloud.
- Removing items from the cloud no longer deletes the copies on your own device.
- Screens now stay current on their own, without switching away and back to force a refresh.
- Clearing a notification now sticks, instead of the notification reappearing.
- A note title can be changed and cleared again.
- Manual sync mode no longer holds your uploads back until you switch modes.
- A saved file is never replaced with a version holding less than it already had.

### Internal
- Supabase MCP configuration, permissions and section-sign documentation, and backend submodule updates.

---

## 0.1.11 (patch, beta) - 2026-08-18

You can now comment on anything shared into a space, and every destructive action gives you a chance to undo it.

### New
- Comment on any item shared into a space, so a shared clip or note can carry a conversation instead of standing on its own.
- Open a comment thread in a popover straight from the comment chip on an item, without leaving the feed.
- Select several items in a space at once and remove them together, instead of one at a time.
- Every destructive action now has an undo window, so a mistaken delete or removal can be taken back before it sticks.

### Fixed
- Tagging someone in a comment no longer leaves the raw markup showing in the box.

### Internal
- Backend submodule updates.

---

## 0.1.10 (patch, beta) - 2026-08-18

Invites and alerts now live in one place, and a new manual sync mode lets you decide exactly when your data goes up.

### New
- A single notifications area gathers space invites, space changes, sync problems, and messages from the team, so alerts are no longer scattered across the app.
- Manual sync mode syncs only when you ask it to, for when you want to control exactly when uploads happen rather than have them run on their own.

### Fixed
- A shared entry now shows who actually wrote it, rather than crediting the wrong person.
- A shared image is no longer treated as your own while it is still downloading.
- Stale sync bookkeeping left behind on this device is now cleaned up, so old state does not linger and cause confusion.
- Removal wording, resharing, and presence in spaces were corrected.

### Internal
- Backend submodule updates.

---

## 0.1.9 (patch, beta) - 2026-08-18

Sharing now respects who owns what: only the person who created an entry can change it.

### Fixed
- Only the author of a shared entry can change it now, so someone else in the space cannot alter what you shared.
- Cloud actions are no longer offered on entries you did not write, matching what you are actually allowed to do.
- Card chips appear in the same order on every screen, so items look consistent as you move around the app.

### Internal
- Backend submodule updates.

---

## 0.1.8 (patch, beta) - 2026-08-18

A batch of reliability fixes for signing in, staying signed in, and joining spaces.

### Fixed
- Google sign-in no longer hangs partway through.
- You are no longer signed out after installing an update; your session carries across the upgrade.
- A busy settings file no longer resets your preferences back to defaults.
- Shared entries now show who shared them.
- New members of a space no longer sit waiting on the space key before they can take part.
- Joining a space no longer fills the feed with items that had already been removed.

### Internal
- Backend submodule updates.

---

## 0.1.7 (patch, beta) - 2026-08-17

A small fix that makes removals in a space accountable.

### Fixed
- When an item is removed from a space, the app now shows who took it out and when, instead of leaving the removal unexplained.

---

## 0.1.6 (patch, beta) - 2026-08-17

Cloud actions now live on every item, and a run of fixes makes sync and spaces clearer about what is happening.

### New
- Upload, remove, or filter by cloud state directly from any clipboard entry or note, instead of only from a separate screen.
- A space now shows who shared each item, and what happened when one is removed.

### Improved
- The update notification is clearer and shows release notes you can actually read.
- Filters now show how many items each option would leave you before you apply it, so you can see the effect of a filter in advance.
- Cloud icons now mean one thing each, and card badges are readable at a glance rather than crowded.
- The app tells you what happened when you upload or share an item, instead of leaving you to guess whether it worked.

### Fixed
- Uploading an older note to the cloud works again.
- Space invite links open the app, and invite codes copy with their dash intact so they paste and validate correctly.
- Removing an item from the cloud now also clears the copies other devices had uploaded, instead of leaving them behind.
- The three leftover test notes no longer appear on the notes screen.

### Internal
- Backend submodule updates, including the space entry-removed event.

---

## 0.1.5 (patch, beta) - 2026-08-16

The Spaces screen is reworked around one shared space, and uploads are sturdier and clearer about what they are doing.

### New
- A shared space lets you sync clips and notes with other people, with cloud sync you can slow down when you do not want it running at full speed.
- See which items came into a space and which went out, so the flow of shared content is visible at a glance.
- The app checks that an upload fits before sending it, so you find out up front instead of after a failed transfer.
- You can turn off the cloud badge on cards from settings, if you would rather not see it on every item.

### Improved
- The Spaces screen now puts your spaces on the left and what each space does on the right, with resizable side panels that reopen where you left them.
- The space list groups by who is around, and the rules column stays in view with quieter chips, so the panel is easier to read.
- Destructive buttons now look different from ordinary ones, so a delete is harder to hit by accident.

### Fixed
- Images upload again, and older items can be synced by hand.
- Uploads no longer flood the server or report failures that did not actually happen, and bulk uploads no longer fail outright.
- The connection state shown right after startup now reflects reality instead of a stale value.

### Internal
- Backend submodule updates, including the blob storage work.

---

## 0.1.4 (patch, beta) - 2026-08-15

Sync holds its connection and is clearer about what it is doing.

### Fixed
- Sync now stays connected instead of dropping out, and shows what it is currently doing, so you are not left wondering whether your data is actually going up.

### Internal
- Backend submodule updates.

---

## 0.1.3 (patch, beta) - 2026-08-15

You stay signed in across restarts, updates, and reinstalls, and the window remembers being maximized.

### Fixed
- Your sync session now survives restarts, updates, and reinstalls, so you are not asked to sign in again every time you reopen the app.
- The app no longer forgets that its window was maximized when you restart it.

### Internal
- Release pipeline documentation and a fix to the release-notes preview in the release skill.

---

## 0.1.2 (patch, beta) - 2026-08-15

The updater keeps looking for new versions the whole time the app is open, and the installed app now identifies itself properly on your system.

### Improved
- The app checks for updates continuously while it is running, so a new version can be offered without needing a restart before it is noticed.
- The app ships with real publisher metadata, so the installer and the running app identify themselves properly instead of looking like an unknown program.
- User-facing text was cleaned up to use plain ASCII punctuation, so labels and messages render the same on every system.

### Internal
- Release run summaries, SmartScreen install documentation, workflow run titling, and backend submodule updates.

---

## 0.1.1 (patch, beta) - 2026-08-15

This release has no user-facing changes.

### Internal
- A release-plumbing version reclaimed after a cancelled run.

---

## 0.1.0 (patch, beta) - 2026-08-15

The first release of RoverTools Smart Clipboard. Copy text, images, or files on one device and reach them from the rest, keep notes alongside your clips, and share with other people, all end-to-end encrypted so the server only ever holds data it cannot read.

### New
- Clipboard history captures whatever you copy - plain text, rich text, images, and files - and keeps it in a searchable timeline you can sort, filter, and group by day.
- Pin the clips you want to keep around, and clear the rest without losing the pinned ones.
- Sort clips and notes into your own groups, with bulk actions to pin, group, or remove many at once instead of one at a time.
- A built-in notes editor sits next to your clipboard, with rich text, task lists, headings, and its own grouping and bulk actions.
- Copy and paste popups let you grab or drop an item from a small window reachable by global hotkeys, without switching to the main app.
- Encrypted cloud sync carries your history and notes across your devices, with the most recent change winning a conflict. All encryption happens on your device, so the server stores only ciphertext it cannot read.
- Shared spaces let you share clips and notes with other people, with each space's key wrapped individually for every member so only members can read what is shared.
- The app runs on Linux as well as Windows, including keystroke injection and cursor-placed popups on both X11 and Wayland.
- In-app updates download and install a new version for you, so you never have to track down and run an installer by hand.
- Local storage is durable: writes survive a crash, and the app tells you when the disk refuses a write instead of quietly losing your data.

### Internal
- Foundational sync, cryptography, and backend work behind the first release.
