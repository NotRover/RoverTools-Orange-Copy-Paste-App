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
  parseStoredContent,
  serializeDoc,
  emptyDoc,
  extractPlainText,
} from "./content-codec";

export { default as NotionEditor } from "./NotionEditor";
export type {
  NotionEditorHandle,
  NotionEditorProps,
} from "./NotionEditor";

export { default as NotionPreview } from "./NotionPreview";

export {
  initAttachmentResolver,
  resolveAttachmentUrl,
  unresolveAttachmentUrl,
  imageAttachmentUrl,
  fileAttachmentUrl,
} from "./attachment-url";
