# Editor Engine

A Tiptap editor for the Smart Clipboard notes screen. There is one editable
surface and one read-only preview, both backed by ProseMirror JSON.

```
┌─ Editor Engine ─────────────────────────────────────────────────────────┐
│                                                                         │
│   note.content ─── string ─── Tiptap JSON                               │
│         │                                                               │
│         ├──► NotionEditor   (Tiptap WYSIWYG, single surface)            │
│         │                                                               │
│         └──► NotionPreview  (read-only, used in note cards)             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Storage

`note.content` is a string holding `JSON.stringify(editor.getJSON())`, a
serialised ProseMirror document. `parseStoredContent(raw)` returns the parsed
doc, or an empty doc when the string does not parse. `extractPlainText(raw)`
powers note titles and search snippets; `hasRenderableContent(raw)` decides
whether an untitled note is worth keeping (text, image, table, rule or embed).

## Public API (`index.ts`)

| export                      | purpose                                            |
| --------------------------- | -------------------------------------------------- |
| `NotionEditor`              | The editable surface. Mount this in note editors.  |
| `NotionEditorHandle`        | Imperative ref: `applyCommand`, `getContent`, ...  |
| `EditorStats`               | `{ blocks, line, chars, words }` from `onStatsChange`. |
| `NotionPreview`             | Read-only renderer for note cards.                 |
| `EditorCommand`             | Toolbar command type.                              |
| `ActiveState`               | Toolbar feedback (current block, marks, alignment).|
| `AlignValue` / `EmbedForm`  | Alignment values; embed insert-form shape.         |
| `CalloutTone`               | `info` \| `success` \| `warning` \| `danger` \| `neutral` |
| `extractPlainText`          | Plain-text projection for titles/search.           |
| `hasRenderableContent`      | Whether the doc holds anything a reader would miss.|
| `noteToMarkdown`            | Markdown export.                                   |
| `initAttachmentResolver`    | One-shot init for local-attachment URL plumbing.   |
| `imageAttachmentUrl` / `fileAttachmentUrl` | Build `note-attachment://` / `note-file://` URLs. |

## Toolbar contract

The toolbar in `note-editor/NoteEditor.tsx` emits `EditorCommand` values via
`editorRef.current.applyCommand(cmd)`. Every panel the toolbar opens goes
through `note-editor/ToolbarPopover.tsx`; the toolbar holds one `openMenu` id,
so at most one panel is open and outside-click handling lives in one place.

To add a toolbar action:

1. Add a `kind` to `EditorCommand` in `types.ts`.
2. Add a case in `NotionEditor.tsx`'s `applyCommand` switch.
3. Add a button in `NoteEditor.tsx` that dispatches it. If it needs a panel,
   add a `MenuId` and wrap the button in `ToolbarPopover`.

Caret state for active feedback comes from `editorRef.current.getActiveState()`.

The toolbar offers headings 1-3, left/center/right alignment and no cell
background. The schema still accepts headings 4-6, justified text and cell
backgrounds so notes written before the trim render unchanged.

## Custom Tiptap nodes

- `extensions/Callout.ts` - block container with a `tone` attribute.
- `extensions/ImageView.tsx` - the stock inline Image plus a `width` attribute
  (percent of the column) and a node view with selection-only controls.

### Attachments

A reference to a clipboard entry or a group is a **chip** (compact) or a
**card** (with its content). Both are inline: they flow in the text, sit
next to each other, and are selected like an image: click selects one, click and drag selects a range, Shift+click extends
the selection to a card, and Ctrl+click (Cmd on mac) toggles a card in a pick that need not be contiguous. A pick is drawn like a
range, and Backspace/Delete, copy and cut act on it; any plain selection change drops it (`extensions/MultiSelect.ts`). Cards are
not draggable while unselected, since a drag that starts on one must begin a range; a selected card drags to move. No open/closed state is stored; "Show all" in a card
is local React state. Entries come from `embed-context.tsx`.

| node        | form         | file                        |
| ----------- | ------------ | --------------------------- |
| `clipEmbed` | inline chip  | `extensions/ClipEmbed.tsx`  |
| `groupRef`  | inline chip  | `extensions/GroupRef.tsx`   |
| `clipCard`  | inline card  | `extensions/ClipCard.tsx`   |
| `groupCard` | inline card  | `extensions/GroupCard.tsx`  |
| `fileCard`  | compact card | `extensions/FileCard.tsx`   |

All of them render through `extensions/AttachmentCard.tsx`: one header (kind
tile, title, meta, hover-only actions with Remove last) and a body that is the
entry text, the group's newest rows, or nothing. Chips show the same card as
a hover preview via `extensions/HoverCard.tsx`, in a body portal. Colours come
from the `.ee-kind--*` classes in `markdown.css`; a chip, a tile and a row of
the same kind share them. The Card / Chip choice is a switch in the toolbar's
insert picker, remembered for the session; that picker previews the pick by
rendering these same components, so what it shows is what gets inserted.

`fileCard` holds `href` (`note-file://...`), `name` and `size`. Open and Show
in folder go through the Rust `open_note_attachment` command, which only
accepts a bare filename inside the attachment stores.

`CodeBlockLowlight` comes from the official Tiptap extension. Tiptap v3's
StarterKit already bundles Link and Underline; they are switched off there and
added once with the attachment-resolving overrides.

## Styling

`markdown.css` is one rule set under `.ee-rich`. The editor root is
`.ee-rich.ProseMirror`, the preview root is `.ee-rich.ee-preview`, and only
those two root blocks differ. `NotionPreview` must emit the same DOM Tiptap
renders for each node; a `.ee-preview X` rule for something the editor also
shows is a regression.

## Invariants

1. `note.content` is a string holding Tiptap JSON. Empty / unparseable
   strings render as an empty doc.
2. Attachment nodes survive every round-trip. A clip whose entry is gone
   renders as a dashed "Removed from clipboard" chip or card that still offers
   Remove.
3. Images are inline nodes. `parseStoredContent` wraps a block-level image from
   an older note in a paragraph, so both surfaces always see a valid doc.
3a. Cards are inline atoms, so `parseStoredContent` wraps any card sitting at
   block level (older notes, or JSON a block-era build wrote) in a paragraph,
   the same way it wraps a block image. It also lifts what older notes stored:
   a chip with `expanded: true` becomes the matching inline card, in place, and
   a `note-file://` link becomes an inline `fileCard`. Stray `expanded` attrs
   are dropped. Idempotent.
4. Image and link `src`/`href` keep their `note-attachment://` /
   `note-file://` schemes in the persisted JSON; resolution to displayable
   asset URLs happens at DOM render time only.
5. Attachments live on the device that saved them. Sync carries the reference,
   not the file.

## Verification

From `orange-copy-paste-clipboard-app-rust/`:

1. `bun run build`
2. Manual smoke checks:
   - Toolbar: bold/italic/underline/strike/code, headings 1-3, quote, callout
     (each tone), lists, task list, code block, table, link, image, clip and
     group as chip and as card, attach document, alignment, color, highlight.
   - Chip hover shows the card; it closes on leave, keystroke and scroll.
   - Card actions appear on hover; Copy turns into a check; Remove deletes.
   - Selected image shows Open / Remove and the S M L Full strip.
   - A note saved before this change opens with its expanded chips as cards
     and its file links as file cards.
   - Opening one popover closes any other; outside click and Escape close it.
   - Closing an untitled note that holds only an image keeps the note.
   - Cards in the list render previews that match the editor.
