// ── WYSIWYG Engine — Public API ───────────────────────────────────────────
export type {
  NoteDoc, BlockNode, InlineNode,
  TextNode, ClipEmbedNode, GroupRefNode, LinkNode, ImageNode,
  BlockType, ParaBlockType, ListBlockType,
} from "./types";
export { isParaBlock, isListBlock } from "./types";

export {
  parseNote, emptyDoc, docPlainText,
  htmlToDoc, docToHtml,
  inlinesToHtml, parseInlines, getBlockHtml, parseBlockEl,
} from "./serialize";

export { default as BlockEditor } from "./BlockEditor";
export type { BlockEditorHandle, BlockEditorProps } from "./BlockEditor";
