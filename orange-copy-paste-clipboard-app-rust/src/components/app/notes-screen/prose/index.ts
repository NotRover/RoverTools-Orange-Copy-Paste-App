// ── Prose Engine — Public API ─────────────────────────────────────────────
export type {
  NoteDoc, BlockNode, InlineNode,
  TextNode, ClipEmbedNode, GroupRefNode, LinkNode, ImageNode,
  BlockType, ParaBlockType, ListBlockType, Alignment,
} from "./types";
export { isParaBlock, isListBlock, isAlignableBlock } from "./types";

export {
  parseNote, emptyDoc, docPlainText,
  inlinesToHtml, parseInlines, getBlockHtml, parseBlockEl,
} from "./serialize";

export { default as BlockEditor } from "./BlockEditor";
export type { BlockEditorHandle, BlockEditorProps } from "./BlockEditor";
