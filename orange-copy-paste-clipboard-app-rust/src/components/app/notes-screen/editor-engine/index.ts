// ── Editor Engine — Public API ────────────────────────────────────────────

export type { NoteContent, EditorMode, FormatAction, BlockKind } from "./types";
export {
  emptyContent,
  parseNoteContent,
  markdownToPlainText,
} from "./markdown";
export { applyAction, detectBlockKind } from "./format-actions";
export { default as MarkdownEditor } from "./MarkdownEditor";
export type { MarkdownEditorHandle, MarkdownEditorProps } from "./MarkdownEditor";
export { default as MarkdownPreview } from "./MarkdownPreview";
