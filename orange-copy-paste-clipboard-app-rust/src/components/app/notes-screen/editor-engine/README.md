# Editor Engine

A Notion-like Tiptap editor for the Smart Clipboard notes screen. There is one
editable surface and one read-only preview, both backed by ProseMirror JSON.
Drag handles and a "+" insert button appear next to the hovered block.

```
┌─ Editor Engine ─────────────────────────────────────────────────────────┐
│                                                                         │
│   note.content ─── string ─── Tiptap JSON (or legacy markdown)          │
│         │                                                               │
│         ├──► NotionEditor   (Tiptap WYSIWYG, single surface)            │
│         │                                                               │
│         └──► NotionPreview  (read-only, used in note cards)             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Storage

`note.content` is a string holding `JSON.stringify(editor.getJSON())` — a
serialised ProseMirror document. `parseStoredContent(raw)` returns the parsed
doc (or an empty doc on failure). `extractPlainText(raw)` powers note titles,
search snippets, and "is this note empty" checks.

## Public API (`index.ts`)

| export                      | purpose                                            |
| --------------------------- | -------------------------------------------------- |
| `NotionEditor`              | The editable surface. Mount this in note editors.  |
| `NotionEditorHandle`        | Imperative ref: `applyCommand`, `getContent`, …    |
| `NotionPreview`             | Read-only renderer for note cards.                 |
| `EditorCommand`             | Mode-agnostic toolbar command type.                |
| `ActiveState` / `BlockKind` | Toolbar feedback (current block, marks, alignment).|
| `CalloutTone`               | `info` \| `success` \| `warning` \| `danger` \| `neutral` |
| `parseStoredContent`        | Detect JSON vs legacy markdown.                    |
| `serializeDoc`              | `JSONContent → string` for persistence.            |
| `extractPlainText`          | Plain-text projection for titles/search.           |
| `initAttachmentResolver` …  | Local-attachment URL plumbing (unchanged).         |

## Toolbar contract

The toolbar in `note-editor/NoteEditor.tsx` emits `EditorCommand` values via
`editorRef.current.applyCommand(cmd)`. To add a new toolbar action:

1. Add a `kind` to `EditorCommand` in `types.ts`.
2. Add a case in `NotionEditor.tsx`'s `applyCommand` switch.
3. Add a button in `NoteEditor.tsx` that dispatches it.

Caret state for active feedback comes from `editorRef.current.getActiveState()`.

## Custom Tiptap nodes

- `extensions/ClipEmbed.ts` — inline atom for clipboard-entry chips.
  Renders via React node-view; entries come from `embed-context.tsx`.
- `extensions/GroupRef.tsx` — inline atom for group-name chips.
- `extensions/Callout.ts` — block container with a `tone` attribute.

`Details` (toggle blocks) and `CodeBlockLowlight` come from official Tiptap
extensions and don't need custom code.

## Preview rendering

`NotionPreview` walks the Tiptap JSON and renders React elements directly —
no editor instance per card.

## Block handles

`@tiptap/extension-drag-handle-react` renders a floating gutter next to the
hovered block in `NotionEditor.tsx`. The gutter has two buttons: "+" inserts
an empty paragraph after the hovered block, "⋮⋮" is the drag affordance.

## Dependencies

Core: `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`.
Features: `extension-{underline,link,task-list,task-item,table,table-row,
table-cell,table-header,placeholder,text-align,text-style,color,highlight,
image,details,code-block-lowlight,drag-handle-react}`, `lowlight`.

## Invariants

1. `note.content` is a string holding Tiptap JSON. Empty / unparseable
   strings render as an empty doc.
2. Embed nodes (`clipEmbed`, `groupRef`) survive every round-trip and degrade
   to "Missing clip" / blank chip when the referenced entry is gone.
3. Image and link `src`/`href` keep their `note-attachment://` /
   `note-file://` schemes in the persisted JSON; resolution to displayable
   asset URLs happens at DOM render time only.

## Verification

From `orange-copy-paste-clipboard-app-rust/`:

1. `bun run build`
2. Manual smoke checks:
   - Toolbar: bold/italic/underline/strike/code, headings, quote, callout
     (each tone), toggle list, lists, task list, code block, table, link,
     image, clip embed, group embed, alignment, color, highlight.
   - Hover the editor: drag handle and "+" appear next to each block.
   - Cards in the list render previews from JSON content.
