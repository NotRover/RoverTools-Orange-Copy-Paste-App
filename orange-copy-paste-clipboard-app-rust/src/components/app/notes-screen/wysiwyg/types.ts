// ── WYSIWYG Engine — Document AST Types ──────────────────────────────────
// Version-stamped format. parseNote() migrates legacy HTML automatically.

export interface NoteDoc {
  v: 2;
  nodes: BlockNode[];
}

export type BlockNode =
  | { type: "p";  children: InlineNode[] }
  | { type: "h1"; children: InlineNode[] }
  | { type: "h2"; children: InlineNode[] }
  | { type: "ul"; items: InlineNode[][] }
  | { type: "ol"; items: InlineNode[][] }
  | { type: "bq"; children: InlineNode[] }
  | { type: "hr" };

export type InlineNode =
  | TextNode
  | ClipEmbedNode
  | GroupRefNode
  | LinkNode
  | ImageNode;

export interface TextNode {
  type: "text";
  text: string;
  bold?:      true;
  italic?:    true;
  underline?: true;
  strike?:    true;
  code?:      true;
}

export interface ClipEmbedNode {
  type:    "clip_embed";
  id:      string;
  mode?:   "inline" | "block";
  width?:  number;
  height?: number;
}

export interface GroupRefNode {
  type:    "group_ref";
  name:    string;
  width?:  number;
  height?: number;
}

export interface LinkNode {
  type: "link";
  href: string;
  text: string;
}

export interface ImageNode {
  type: "image";
  src:  string;
  alt?: string;
}

// ── Inline paragraph-like block types ────────────────────────────────────
export type ParaBlockType = "p" | "h1" | "h2" | "bq";
export type ListBlockType = "ul" | "ol";
export type BlockType = ParaBlockType | ListBlockType | "hr";

export function isParaBlock(node: BlockNode): node is { type: ParaBlockType; children: InlineNode[] } {
  return node.type === "p" || node.type === "h1" || node.type === "h2" || node.type === "bq";
}

export function isListBlock(node: BlockNode): node is { type: ListBlockType; items: InlineNode[][] } {
  return node.type === "ul" || node.type === "ol";
}
