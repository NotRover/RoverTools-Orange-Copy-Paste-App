// ── Editor Engine — Public API ────────────────────────────────────────────

export type {
  EditorCommand,
  ActiveState,
  BlockKind,
  AlignValue,
  CalloutTone,
  EditorContent,
} from "./types";

export {
  extractPlainText,
  hasRenderableContent,
  noteToMarkdown,
} from "./content-codec";

export { default as NotionEditor } from "./NotionEditor";
export type {
  NotionEditorHandle,
  NotionEditorProps,
  EditorStats,
} from "./NotionEditor";

export { default as NotionPreview } from "./NotionPreview";

export {
  initAttachmentResolver,
  imageAttachmentUrl,
  fileAttachmentUrl,
} from "./attachment-url";
