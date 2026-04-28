// ── Editor Engine — Types ─────────────────────────────────────────────────

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
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 }
  | { kind: "paragraph" }
  | { kind: "blockquote" }
  | { kind: "bulletList" }
  | { kind: "orderedList" }
  | { kind: "taskList" }
  | { kind: "codeBlock" }
  | { kind: "hr" }
  | { kind: "link"; url: string; text?: string }
  | { kind: "image"; src: string; alt?: string }
  | { kind: "insertTable" }
  | { kind: "tableAddRowAfter" }
  | { kind: "tableAddColumnAfter" }
  | { kind: "tableDeleteRow" }
  | { kind: "tableDeleteColumn" }
  | { kind: "insertText"; text: string }
  | { kind: "clipEmbed"; id: string }
  | { kind: "groupEmbed"; name: string }
  | { kind: "align"; value: "left" | "center" | "right" | "justify" }
  | { kind: "textColor"; value: string | null }
  | { kind: "highlight"; value: string | null };

export type AlignValue = "left" | "center" | "right" | "justify";

export type BlockKind =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "bq"
  | "todo"
  | "todoChecked"
  | "ul"
  | "ol"
  | "code"
  | "hr";

/** Toolbar-facing active state. Inline marks are best-effort in markdown mode. */
export interface ActiveState {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  inTable?: boolean;
  blockKind: BlockKind;
  align?: AlignValue;
  textColor?: string;
  highlight?: string;
}
