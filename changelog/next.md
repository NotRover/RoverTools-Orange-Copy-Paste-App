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

### Internal
- Backend: creating a space now announces it to the creator, so their connection picks up
  the new space. The owner could not see anything a new member shared until they
  restarted the app.
- Backend: the realtime hub re-resolves a user's channels itself when their membership
  changes, rather than depending on the client to ask.
- Backend: a removal record names the remover's own row as the author when there is one,
  instead of whichever row the database returned first.
