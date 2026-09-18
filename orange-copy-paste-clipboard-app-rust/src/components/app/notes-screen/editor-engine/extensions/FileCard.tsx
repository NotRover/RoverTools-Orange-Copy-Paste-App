// ── Tiptap node — File card ─────────────────────────────────────────────
// Inline atom for a document attached to the note: a compact card with the
// filename, kind and size, and Open / Show in folder actions. Replaces the
// bare `note-file://` link older notes used; the codec lifts those into
// this node on parse.

import React from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { invoke } from "@tauri-apps/api/core";
import { FolderIcon, ExpandIcon } from "../../../../icons";
import { attachmentFilename } from "../attachment-url";
import {
  AttachmentCard,
  fileKindFromName,
  fileMeta,
  removeAction,
  type CardAction,
} from "./AttachmentCard";

/** Open an attachment with the default app, or reveal it in its folder. */
export function openAttachment(url: string, reveal: boolean): void {
  const target = attachmentFilename(url);
  if (!target) return;
  invoke("open_note_attachment", { sub: target.sub, filename: target.filename, reveal })
    .catch((err) => console.error("[notes] open attachment failed", err));
}

const FileCardView: React.FC<NodeViewProps> = ({ node, deleteNode }) => {
  const href = (node.attrs.href as string) ?? "";
  const name = (node.attrs.name as string) || "File";
  const size = node.attrs.size as number | null;
  const canOpen = !!attachmentFilename(href);

  const actions: CardAction[] = [];
  if (canOpen) {
    actions.push(
      { label: "Open", icon: <ExpandIcon size={12} />, onClick: () => openAttachment(href, false) },
      { label: "Show in folder", icon: <FolderIcon size={12} />, onClick: () => openAttachment(href, true) },
    );
  }
  actions.push(removeAction(deleteNode));

  return (
    <NodeViewWrapper as="span" className="ee-embed" data-file-card={href} contentEditable={false}>
      <AttachmentCard
        kind={fileKindFromName(name)}
        title={name}
        meta={fileMeta(name, size)}
        actions={actions}
        compact
      />
    </NodeViewWrapper>
  );
};

export const FileCard = Node.create({
  name: "fileCard",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  // Not draggable: a draggable node turns a press-and-drag that starts on a
  // card into a native drag, so a range could never begin on one. ProseMirror
  // still drags a card that is already selected, so click-then-drag moves it.
  draggable: false,

  addAttributes() {
    return {
      href: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-file-card") ?? "",
        renderHTML: (attrs) => ({ "data-file-card": attrs.href ?? "" }),
      },
      name: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-name") ?? "",
        renderHTML: (attrs) => ({ "data-name": attrs.name ?? "" }),
      },
      size: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = Number(el.getAttribute("data-size"));
          return Number.isFinite(v) && v > 0 ? v : null;
        },
        renderHTML: (attrs) => (attrs.size != null ? { "data-size": String(attrs.size) } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-file-card]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), ""];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileCardView);
  },
});
