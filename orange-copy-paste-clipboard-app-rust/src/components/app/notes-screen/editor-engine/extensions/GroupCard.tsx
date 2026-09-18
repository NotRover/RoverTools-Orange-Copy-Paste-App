// ── Tiptap node — Group card ────────────────────────────────────────────
// Inline atom embedding a clipboard group as a card: header with the entry
// count, body with the newest entries as copyable rows. The inline
// counterpart is the `groupRef` chip.

import React from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEmbedContext } from "../embed-context";
import {
  AttachmentCard,
  GroupBody,
  groupInfo,
  removeAction,
  useCopyEntry,
} from "./AttachmentCard";

export function groupMeta(count: number): string {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}

const GroupCardView: React.FC<NodeViewProps> = ({ node, deleteNode }) => {
  const { entries } = useEmbedContext();
  const name = (node.attrs.name as string) ?? "";
  const info = groupInfo(name, entries);
  const [copied, copy] = useCopyEntry();

  return (
    <NodeViewWrapper as="span" className="ee-embed" data-group-card={name} contentEditable={false}>
      <AttachmentCard
        kind="group"
        icon={<info.Icon size={12} />}
        kindClassName={info.className}
        kindStyle={info.style}
        title={info.label}
        meta={groupMeta(info.entries.length)}
        actions={[removeAction(deleteNode)]}
      >
        <GroupBody info={info} onCopy={copy} copiedId={copied} />
      </AttachmentCard>
    </NodeViewWrapper>
  );
};

export const GroupCard = Node.create({
  name: "groupCard",
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
      name: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-group-card") ?? "",
        renderHTML: (attrs) => ({ "data-group-card": attrs.name ?? "" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-group-card]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), ""];
  },

  addNodeView() {
    return ReactNodeViewRenderer(GroupCardView);
  },
});
