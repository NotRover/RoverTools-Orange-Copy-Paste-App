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
| `ActiveState` / `BlockKind` | Toolbar feedback (current block, marks, alignment).|
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

- `extensions/ClipEmbed.ts` - inline atom for clipboard-entry chips.
  Renders via React node view; entries come from `embed-context.tsx`.
- `extensions/GroupRef.tsx` - inline atom for group-name chips.
- `extensions/Callout.ts` - block container with a `tone` attribute.

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
2. Embed nodes (`clipEmbed`, `groupRef`) survive every round-trip and degrade
   to "Missing entry" / blank chip when the referenced entry is gone.
3. Images are inline nodes. `parseStoredContent` wraps a block-level image from
   an older note in a paragraph, so both surfaces always see a valid doc.
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
     (each tone), lists, task list, code block, table, link, image, clip
     embed, group embed, alignment, color, highlight.
   - Opening one popover closes any other; outside click and Escape close it.
   - Closing an untitled note that holds only an image keeps the note.
   - Cards in the list render previews that match the editor.
