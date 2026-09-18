// ── Editor Engine — Types ─────────────────────────────────────────────────
// Notion-like Tiptap editor. Storage is ProseMirror JSON serialized as a
// string. Anything that does not parse renders as an empty document.

import type { JSONContent } from "@tiptap/react";

export type AlignValue = "left" | "center" | "right" | "justify";

/** How a clip or group reference enters the note: a chip in the sentence or
 *  a card on its own row. */
export type EmbedForm = "chip" | "card";

/** Command dispatched by the toolbar. The schema still accepts heading levels
 *  4-6, justified text and cell backgrounds from older notes; the toolbar just
 *  no longer offers them. */
export type EditorCommand =
  | { kind: "bold" }
  | { kind: "italic" }
  | { kind: "underline" }
  | { kind: "strike" }
  | { kind: "code" }
  | { kind: "heading"; level: 1 | 2 | 3 }
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
  | { kind: "clipEmbed"; id: string; as: EmbedForm }
  | { kind: "groupEmbed"; name: string; as: EmbedForm }
  | { kind: "fileCard"; href: string; name: string; size: number | null }
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
