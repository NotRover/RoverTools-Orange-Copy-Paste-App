# Prose Engine

The Prose Engine is the notes rich-text core used by the Notes screen.

It provides:

- A versioned note document model (`NoteDoc` v2)
- HTML/contenteditable parsing and rendering helpers
- A block-based editor (`BlockEditor`) with structural editing behavior
- Inline embeds for clipboard items and note groups

This directory is the source of truth for note document structure and editor behavior in the app.

## Directory Layout

- `types.ts`: Document AST and type guards
- `serialize.ts`: AST <-> HTML conversion and note parsing utilities
- `BlockEditor.tsx`: Interactive block editor implementation
- `block-editor.css`: Editor styles
- `index.ts`: Public exports for consumers

## Data Model

### Root Document

```ts
interface NoteDoc {
  v: 2;
  nodes: BlockNode[];
}
```

- `v` is required and currently must be `2`
- `nodes` is an ordered list of block nodes

### Block Nodes

Supported block types:

- `p`
- `h1`, `h2`, `h3`
- `bq` (blockquote)
- `todo` (with `checked` state)
- `code`
- `ul`, `ol` (list items as inline arrays)
- `hr`

Alignment is supported on:

- `p`, `h1`, `h2`, `h3`, `todo`

### Inline Nodes

Supported inline nodes:

- `text` with marks (`bold`, `italic`, `underline`, `strike`, `code`)
- `clip_embed` (references clipboard entry id)
- `group_ref` (references group by name)
- `link` (`href`, `text`)
- `image` (`src`, optional `alt`)

## Public API

Consumers should import from `index.ts` (or via `note-doc.ts` re-export) whenever possible.

### Types and Guards

From `types.ts`:

- `NoteDoc`, `BlockNode`, `InlineNode`
- `TextNode`, `ClipEmbedNode`, `GroupRefNode`, `LinkNode`, `ImageNode`
- `BlockType`, `ParaBlockType`, `ListBlockType`, `Alignment`
- `isParaBlock(node)`
- `isListBlock(node)`
- `isAlignableBlock(node)`

### Serialization and Parsing

From `serialize.ts`:

- `emptyDoc()`: returns minimal valid v2 doc (`p` block)
- `parseNote(raw)`: parse persisted JSON string to `NoteDoc`
  - returns empty doc for empty/invalid/non-v2 input
- `docPlainText(doc)`: flatten note text for previews/search
- `parseInlines(element)`: inline DOM -> inline AST
- `parseBlockEl(element, type)`: block DOM -> `BlockNode`
- `inlinesToHtml(nodes)`: inline AST -> HTML
- `getBlockHtml(node)`: block AST -> editable innerHTML fragment

## BlockEditor

`BlockEditor.tsx` exports:

- default component: `BlockEditor`
- `BlockEditorProps`
- `BlockEditorHandle`

### Props

```ts
interface BlockEditorProps {
  noteId: string;
  initialDoc: NoteDoc;
  entries: ClipboardEntry[];
  onChange: (doc: NoteDoc) => void;
}
```

### Imperative Handle

```ts
interface BlockEditorHandle {
  execFmt(cmd: string, value?: string): void;
  setBlockType(type: BlockType): void;
  getBlockType(): BlockType;
  setAlignment(align: Alignment | null): void;
  getAlignment(): Alignment | null;
  indent(): void;
  outdent(): void;
  insertClipEmbed(id: string): void;
  insertGroupEmbed(name: string): void;
  insertLink(url: string): void;
  saveRange(): void;
  focus(): void;
  flush(): NoteDoc;
}
```

### Editing Semantics

- Enter behavior:
  - Paragraph/heading/blockquote/todo: split block
  - Code block:
    - Enter at end: create next paragraph
    - Enter inside: newline
    - Shift+Enter: split block
  - List (`ul`/`ol`): Enter on empty trailing item exits list into paragraph
- Backspace at block start merges with previous paragraph-like block
- Arrow up/down at boundaries navigates between adjacent blocks
- Todo checkbox toggles `checked`
- Alignment updates apply only to alignable block types

### Embed Behavior

Clipboard embeds (`data-clip-embed`) and group embeds (`data-group-ref`):

- Render as non-editable inline or block chips
- Support selection, keyboard delete, and drag resize
- Persist width/height to `data-embed-width` / `data-embed-height`
- Clip embeds can toggle inline <-> block mode via `data-embed-mode`

## Persistence and Compatibility

- Persisted notes are JSON strings encoding `NoteDoc` v2
- `parseNote` currently accepts only v2 shape (`{ v: 2, nodes: [...] }`)
- Invalid payloads are safely coerced to `emptyDoc()`

## Integration Points

Current consumers in Notes screen:

- `note-editor/NoteEditor.tsx` for editing
- `NotePreview.tsx` for read-only rendering
- `note-doc.ts` as a convenience re-export

## Styling

`block-editor.css` defines editor visual behavior:

- Block styles (`.ns-be-*`)
- Align classes
- Todo and code presentation
- Embed selection/resizing visuals
- Placeholder behavior

Keep style class names synchronized with `BlockEditor.tsx` markup and data attributes.

## Development Notes

- The editor uses contenteditable and `document.execCommand` for inline marks.
- Structural edits are managed by AST/block state and DOM parsing.
- Save calls are debounced in the editor layer before `onChange`.

When changing behavior:

- Update AST types first if data shape changes
- Keep `parseInlines` and `inlinesToHtml` round-trip logic aligned
- Verify Enter/backspace/list transitions and embed interactions
- Ensure persisted output remains valid v2 `NoteDoc`
