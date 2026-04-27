# Editor Engine

The notes editor for the Smart Clipboard app. Markdown is the only storage
format. The engine exposes two editable surfaces over the same markdown
string and a read-only renderer used by note cards.

```
┌─ Editor Engine ─────────────────────────────────────────────────────────┐
│                                                                         │
│   note.content ─── markdown string ─── single source of truth           │
│         │                                                               │
│         ├──► MarkdownEditor (host)                                      │
│         │       ├── RichEditor       (Tiptap WYSIWYG, "normal" mode)    │
│         │       └── <textarea>       (raw markdown, "markdown" mode)    │
│         │                                                               │
│         └──► MarkdownPreview (read-only, used in note cards)            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Key principles

1. **Markdown is canonical.** Everything serializes to / parses from a plain
   markdown string. There is no AST, no JSON envelope, no version field.
   `note.content` is a string that any other tool can read.
2. **Two modes, same content.** "Normal" is a Tiptap WYSIWYG; "Markdown" is
   a textarea. Switching modes pulls the current value out of the active
   surface and feeds it to the other. No duplicate state.
3. **Mode-agnostic toolbar.** Toolbar buttons emit `EditorCommand` values.
   Each surface interprets the command its own way (Tiptap chain vs.
   textarea string ops). The toolbar doesn't care which mode is active.
4. **GitHub-readme-style HTML.** Inline HTML is allowed in markdown
   (`<details>`, `<kbd>`, `<sub>`, etc.) and round-trips through both modes.
   Rendering is sanitized in `MarkdownPreview` (read-only) and via the
   Tiptap schema (editable).

## File layout

```
editor-engine/
├── README.md                ← you are here
├── index.ts                 ← public API barrel
├── types.ts                 ← EditorMode, EditorCommand, BlockKind, …
├── markdown.ts              ← markdownToPlainText (titles, search)
├── format-actions.ts        ← textarea ops + commandToAction mapper
├── markdown.css             ← styles for textarea + Tiptap + chip nodes
│
├── MarkdownEditor.tsx       ← dual-mode host. Renders one surface, routes commands.
├── RichEditor.tsx           ← Tiptap surface (normal mode)
├── MarkdownPreview.tsx      ← read-only renderer (note cards)
│
├── embed-context.tsx        ← React context bridging clipboard entries → NodeViews
└── extensions/
    ├── ClipEmbed.tsx        ← Tiptap node for <span data-clip-embed="…">
    └── GroupRef.tsx         ← Tiptap node for <span data-group-ref="…">
```

## Public API (`index.ts`)

| export                           | what it is                                                          |
|----------------------------------|---------------------------------------------------------------------|
| `MarkdownEditor`                 | The dual-mode editor component. The thing you mount.                |
| `MarkdownEditorHandle`           | Ref handle: `applyCommand`, `getMarkdown`, `setMode`, `focus`, …    |
| `MarkdownPreview`                | Read-only markdown renderer (note cards / list views).              |
| `RichEditor` / `RichEditorHandle`| The Tiptap surface, exported in case you want it standalone.        |
| `EditorMode`                     | `"normal" \| "markdown"`                                            |
| `EditorCommand`                  | Mode-agnostic toolbar command (see below).                          |
| `FormatAction`                   | Low-level textarea op (used by markdown mode internally).           |
| `BlockKind` / `ActiveState`      | Toolbar feedback (current heading, list, marks under caret, …).     |
| `markdownToPlainText`            | Strip markdown to plain text — for titles, search, etc.             |
| `applyAction` / `commandToAction`| Pure helpers if you ever need to manipulate markdown without a DOM. |
| `detectBlockKind` / `detectActiveState` | Caret-state detection in markdown mode.                      |

## How the host (`MarkdownEditor`) works

```tsx
<MarkdownEditor
  ref={editorRef}                    // → MarkdownEditorHandle
  noteId={note.id}                   // remount-trigger when switching notes
  initialMarkdown={note.content}     // initial content
  initialMode="normal"               // optional, defaults to "normal"
  entries={clipboardEntries}         // for resolving clip-embed labels
  onChange={(md) => save(md)}        // fires on every edit
  onModeChange={(m) => …}            // when the user toggles the mode switch
  onSelectionChange={refreshToolbar} // selection moved
/>
```

State flow:

1. The host holds a `valueRef` with the latest markdown.
2. Each surface's `onChange` updates `valueRef` and forwards to the parent.
3. On `setMode(next)`, the host pulls the latest from the active surface,
   stores it in `valueRef`, then unmounts the old surface and mounts the
   new one with `defaultValue={valueRef.current}` — so the new surface
   boots from the fresh value.
4. The handle's `applyCommand(cmd)` routes to the active surface:
   - normal  → `RichEditor.applyCommand(cmd)` → Tiptap chain
   - markdown → `commandToAction(cmd)` → `applyAction(state, action)` → textarea mutation

## Toolbar commands

`EditorCommand` is the contract between the toolbar and the engine. To add a
new toolbar action you add a `kind` here, then implement it in two places:

```ts
type EditorCommand =
  | { kind: "bold" } | { kind: "italic" } | { kind: "strike" } | { kind: "code" }
  | { kind: "heading"; level: 1 | 2 | 3 } | { kind: "paragraph" }
  | { kind: "blockquote" } | { kind: "bulletList" } | { kind: "orderedList" }
  | { kind: "taskList" } | { kind: "codeBlock" } | { kind: "hr" }
  | { kind: "link"; url: string; text?: string } | { kind: "insertTable" }
  | { kind: "insertText"; text: string }
  | { kind: "clipEmbed"; id: string } | { kind: "groupEmbed"; name: string };
```

Implementing a new command:

1. **Tiptap (normal mode)** — add a case in `RichEditor.tsx` `applyCommand`
   switch. Use the chain API: `c.toggleX().run()`, `c.insertContent(…)`, etc.
2. **Markdown (markdown mode)** — add a case in `format-actions.ts`
   `commandToAction`. Return a `FormatAction` (`wrap`, `linePrefix`, `fence`,
   `insert`, `link`, `hr`).
3. **Toolbar** — add a button in `note-editor/NoteEditor.tsx` that calls
   `dispatch({ kind: "yourNewKind", … })`.

Active state on toolbar buttons comes from `editorRef.current.getActiveState()`,
which both surfaces implement.

## Custom Tiptap nodes (embeds)

`ClipEmbed` and `GroupRef` are the template for any custom inline node:

- They serialize to `<span data-X="…"></span>` in markdown via
  `addStorage().markdown.serialize`. Inline HTML round-trips through the
  Markdown extension's `html: true` mode.
- They render via `ReactNodeViewRenderer` so you get a real React component
  inside the editor (the chip).
- They read external state (clipboard entries) via `embed-context.tsx`.
  When entries change, the context provider re-renders and node views
  pick up the new value automatically.

To add a new custom node, copy `extensions/ClipEmbed.tsx`, change the tag
attribute (`data-mention`, `data-callout`, etc.), and register it in
`RichEditor.tsx`'s `extensions` array.

## Markdown rendering (preview)

`MarkdownPreview` powers note cards. Pipeline:

```
markdown → remark-parse → remark-gfm → rehype-raw → rehype-sanitize → React
```

- **GFM**: tables, task lists, strikethrough, autolinks.
- **rehype-raw**: lets users embed inline HTML (the GitHub-readme experience).
- **rehype-sanitize**: GitHub-ish allow-list. `<script>` is dropped;
  `tauri-asset:` and `asset:` URLs are allowed for local images.
- **Custom components**: `<span data-clip-embed>` and `<span data-group-ref>`
  are intercepted in the `components` map and rendered as chips matching the
  editor.

To add a new render-only feature (math, mermaid, callouts, etc.):

1. Add the relevant `remark-*` / `rehype-*` plugin to the plugin arrays.
2. If it produces custom HTML, allow the tag/attrs in the sanitize schema.
3. If you want a custom React component, add a key to the `components` map.

## Storage

`note.content` is a markdown string. That's it. No version, no envelope,
no migration. If you need to differentiate empty notes, check
`hasMeaningfulContent(rawContent)` from `notes-utils.ts`.

## Adding plugins / extending — quick reference

| You want…                          | Where to change                                           |
|------------------------------------|-----------------------------------------------------------|
| New toolbar button                 | `EditorCommand` (types.ts) + RichEditor + commandToAction + NoteEditor toolbar JSX |
| Syntax-highlighted code blocks     | Replace `codeBlock` in StarterKit with `CodeBlockLowlight`; add highlighter for preview |
| Math / Mermaid / Footnotes         | `remark-*` plugin in MarkdownPreview; configure Markdown extension in RichEditor if needed |
| Inline mention / wiki-link / tag   | New Tiptap node (mirror ClipEmbed) + render mapping in MarkdownPreview |
| Slash command menu                 | `RichEditor.tsx` — Tiptap suggestion utility; or intercept in MarkdownEditor `onKeyDown` |
| New keyboard shortcut              | Markdown mode: `MarkdownEditor.handleTextareaKeyDown`; Normal mode: Tiptap `addKeyboardShortcuts()` on the relevant extension |
| Allow a new HTML tag in preview    | `MarkdownPreview.tsx` sanitize `schema` |
| New storage attribute on a node    | Add to node's `addAttributes()` and update `parseHTML`/`renderHTML` so it survives the markdown round-trip |

## Dependencies

- `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit` — core editor.
- `@tiptap/extension-{underline,link,task-list,task-item,table,table-row,table-cell,table-header,placeholder}` — feature extensions.
- `tiptap-markdown` — bridges Tiptap ↔ markdown (uses markdown-it under the hood).
- `react-markdown`, `remark-gfm`, `rehype-raw`, `rehype-sanitize` — read-only renderer for note cards.

## Known constraints

- **Bundle size**: Tiptap adds ~190 KB gzipped. If startup latency for the
  notes screen becomes an issue, lazy-load `RichEditor` (dynamic import on
  first switch to normal mode); markdown mode alone is small.
- **Live mode-switch quirks**: very long markdown documents may take a few
  hundred ms to parse into a Tiptap document. The host doesn't show a
  spinner — switches are synchronous and happen on click.
- **Inline HTML fidelity**: the Markdown extension uses `html: true`, so
  arbitrary inline HTML round-trips. But complex block-level HTML
  (nested `<table>` with custom CSS, etc.) will be normalized to Tiptap's
  schema in normal mode and may drop attributes. Stick to the GFM-ish
  vocabulary for safety.
- **Atomic embed nodes**: `ClipEmbed` and `GroupRef` are atoms. They can be
  selected/deleted as a unit but cannot contain text — by design.
