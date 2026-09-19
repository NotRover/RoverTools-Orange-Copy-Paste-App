// ── Editor Engine — Public API ────────────────────────────────────────────

export type {
  EditorCommand,
  ActiveState,
  AlignValue,
  CalloutTone,
  EmbedForm,
} from "./types";

export {
  extractPlainText,
  hasRenderableContent,
  noteToMarkdown,
} from "./content-codec";

export { default as NotionEditor } from "./NotionEditor";
export type {
  NotionEditorHandle,
  EditorStats,
} from "./NotionEditor";

export { default as NotionPreview } from "./NotionPreview";

export {
  initAttachmentResolver,
  imageAttachmentUrl,
  fileAttachmentUrl,
} from "./attachment-url";

// Pieces the note toolbar's insert picker renders to preview exactly what a
// clip or a group will look like once it is in the note. Shared with the
// node views and the read-only preview on purpose: a look-alike would drift.
export {
  AttachmentCard,
  EntryBody,
  GroupBody,
  KindIcon,
  entryKind,
  entryMeta,
  entryTitle,
  groupInfo,
  type GroupInfo,
} from "./extensions/AttachmentCard";
export { ClipChip } from "./extensions/ClipEmbed";
export { GroupChip } from "./extensions/GroupRef";
export { groupMeta } from "./extensions/GroupCard";
