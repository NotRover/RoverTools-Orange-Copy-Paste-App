// ── Editor Engine — Types ─────────────────────────────────────────────────
// Notion-like Tiptap editor. Storage is ProseMirror JSON serialized as a
// string. Legacy markdown content is auto-migrated on first edit.

import type { JSONContent } from "@tiptap/react";

export type AlignValue = "left" | "center" | "right" | "justify";

/** Mode-agnostic command dispatched by the toolbar. */
export type EditorCommand =
  | { kind: "bold" }
  | { kind: "italic" }
  | { kind: "underline" }
  | { kind: "strike" }
  | { kind: "code" }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 }
  | { kind: "paragraph" }
  | { kind: "blockquote" }
  | { kind: "callout"; tone?: CalloutTone }
  | { kind: "bulletList" }
  | { kind: "orderedList" }
  | { kind: "taskList" }
  | { kind: "codeBlock"; language?: string }
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
  | { kind: "align"; value: AlignValue }
  | { kind: "textColor"; value: string | null }
  | { kind: "highlight"; value: string | null };

export type CalloutTone =
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "neutral";

export type BlockKind =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "bq"
  | "callout"
  | "todo"
  | "todoChecked"
  | "ul"
  | "ol"
  | "code"
  | "hr";

export interface ActiveState {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  inTable?: boolean;
  blockKind: BlockKind;
  align?: AlignValue;
  textColor?: string;
  highlight?: string;
}

export type EditorContent = JSONContent;
