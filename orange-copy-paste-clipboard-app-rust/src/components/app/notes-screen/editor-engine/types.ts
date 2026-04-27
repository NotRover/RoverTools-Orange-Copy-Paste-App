// ── Editor Engine — Types ─────────────────────────────────────────────────

export interface NoteContent {
  v: 3;
  markdown: string;
}

/** Two visible modes. Both are editable; both round-trip to the same markdown. */
export type EditorMode = "normal" | "markdown";

// Low-level textarea ops (markdown-mode only).
export type FormatAction =
  | { kind: "wrap"; before: string; after: string; placeholder?: string }
  | { kind: "linePrefix"; prefix: string; togglePrefixes?: string[] }
  | { kind: "fence"; lang?: string }
  | { kind: "insert"; text: string }
  | { kind: "link"; url: string; text?: string }
  | { kind: "hr" };

/** Mode-agnostic command dispatched by the toolbar. Each mode interprets it. */
export type EditorCommand =
  | { kind: "bold" }
  | { kind: "italic" }
  | { kind: "strike" }
  | { kind: "code" }
  | { kind: "heading"; level: 1 | 2 | 3 }
  | { kind: "paragraph" }
  | { kind: "blockquote" }
  | { kind: "bulletList" }
  | { kind: "orderedList" }
  | { kind: "taskList" }
  | { kind: "codeBlock" }
  | { kind: "hr" }
  | { kind: "link"; url: string; text?: string }
  | { kind: "insertTable" }
  | { kind: "insertText"; text: string }
  | { kind: "clipEmbed"; id: string }
  | { kind: "groupEmbed"; name: string };

export type BlockKind =
  | "p" | "h1" | "h2" | "h3"
  | "bq" | "todo" | "todoChecked"
  | "ul" | "ol" | "code" | "hr";

/** Toolbar-facing active state. Inline marks are best-effort in markdown mode. */
export interface ActiveState {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  blockKind: BlockKind;
}
