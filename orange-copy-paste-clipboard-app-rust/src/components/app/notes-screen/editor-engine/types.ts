// ── Editor Engine — Types ─────────────────────────────────────────────────
// Markdown is the source of truth. NoteContent is a thin wrapper that lets us
// version the storage format and migrate older NoteDoc JSON on read.

export interface NoteContent {
  v: 3;
  markdown: string;
}

export type EditorMode = "source" | "preview";

// Inline format actions operate on the textarea selection.
export type FormatAction =
  | { kind: "wrap"; before: string; after: string; placeholder?: string }
  | { kind: "linePrefix"; prefix: string; togglePrefixes?: string[] }
  | { kind: "fence"; lang?: string }
  | { kind: "insert"; text: string }
  | { kind: "link"; url: string; text?: string }
  | { kind: "hr" };

// Block-type tokens used by the toolbar to drive heading/list/etc. buttons.
export type BlockKind =
  | "p" | "h1" | "h2" | "h3"
  | "bq" | "todo" | "todoChecked"
  | "ul" | "ol" | "code" | "hr";
