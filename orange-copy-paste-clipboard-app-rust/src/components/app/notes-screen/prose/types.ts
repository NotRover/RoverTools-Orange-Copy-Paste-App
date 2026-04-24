// ── Prose Engine — Document AST ───────────────────────────────────────────

export type Alignment = "left" | "center" | "right" | "justify";

export interface NoteDoc {
  v: 2;
  nodes: BlockNode[];
}

export type BlockNode =
  | { type: "p";    children: InlineNode[]; align?: Alignment }
  | { type: "h1";   children: InlineNode[]; align?: Alignment }
  | { type: "h2";   children: InlineNode[]; align?: Alignment }
  | { type: "h3";   children: InlineNode[]; align?: Alignment }
  | { type: "bq";   children: InlineNode[] }
  | { type: "todo"; children: InlineNode[]; checked: boolean; align?: Alignment }
  | { type: "code"; children: InlineNode[] }
  | { type: "ul";   items: InlineNode[][] }
  | { type: "ol";   items: InlineNode[][] }
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

export type ParaBlockType = "p" | "h1" | "h2" | "h3" | "bq" | "todo" | "code";
export type ListBlockType  = "ul" | "ol";
export type BlockType      = ParaBlockType | ListBlockType | "hr";

export function isParaBlock(node: BlockNode): node is Extract<BlockNode, { children: InlineNode[] }> {
  return node.type === "p"    || node.type === "h1"   || node.type === "h2"
      || node.type === "h3"   || node.type === "bq"   || node.type === "todo"
      || node.type === "code";
}

export function isListBlock(node: BlockNode): node is { type: ListBlockType; items: InlineNode[][] } {
  return node.type === "ul" || node.type === "ol";
}

export function isAlignableBlock(node: BlockNode): node is Extract<BlockNode, { align?: Alignment }> {
  return node.type === "p"  || node.type === "h1" || node.type === "h2"
      || node.type === "h3" || node.type === "todo";
}
