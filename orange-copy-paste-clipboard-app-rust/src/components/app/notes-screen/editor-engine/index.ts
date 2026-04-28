// ── Editor Engine — Public API ────────────────────────────────────────────

export type {
  EditorMode,
  EditorCommand,
  FormatAction,
  BlockKind,
  ActiveState,
} from "./types";
export { markdownToPlainText } from "./markdown";
export {
  applyAction,
  commandToAction,
  detectBlockKind,
  detectActiveState,
} from "./format-actions";
export { default as MarkdownEditor } from "./MarkdownEditor";
export type {
  MarkdownEditorHandle,
  MarkdownEditorProps,
} from "./MarkdownEditor";
export { default as MarkdownPreview } from "./MarkdownPreview";
export { default as RichEditor } from "./RichEditor";
export type { RichEditorHandle } from "./RichEditor";
export {
  initAttachmentResolver,
  resolveAttachmentUrl,
  unresolveAttachmentUrl,
  resolveMarkdown,
  unresolveMarkdown,
  imageAttachmentUrl,
  fileAttachmentUrl,
} from "./attachment-url";
