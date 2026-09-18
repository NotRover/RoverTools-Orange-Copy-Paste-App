// ── Tiptap node — Group chip ────────────────────────────────────────────
// Inline atom referencing a clipboard group by name. The chip carries the
// entry count; hovering shows the group card. The block counterpart is
// `groupCard`. The stored node name stays `groupRef` so older notes parse.

import React from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import type { ClipboardEntry } from "../../../../../types";
import { useEmbedContext } from "../embed-context";
import { AttachmentCard, GroupBody, groupInfo, useCopyEntry } from "./AttachmentCard";
import { groupMeta } from "./GroupCard";
import { HoverCard, useHoverCard } from "./HoverCard";

/** The chip itself. Shared with the read-only preview. */
export const GroupChip: React.FC<{
  name: string;
  entries: ClipboardEntry[];
  onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave?: () => void;
}> = ({ name, entries, onMouseEnter, onMouseLeave }) => {
  const info = groupInfo(name, entries);
  return (
    <span
      className={`ee-chip ${info.className ?? "ee-kind--group"}`}
      style={info.style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <info.Icon size={11} />
      <span className="ee-chip-label">{info.label}</span>
      {info.entries.length > 0 && (
        <span className="ee-chip-count">{info.entries.length}</span>
      )}
    </span>
  );
};

const GroupRefView: React.FC<NodeViewProps> = ({ node }) => {
  const { entries } = useEmbedContext();
  const name = (node.attrs.name as string) ?? "";
  const hover = useHoverCard();
  const [copied, copy] = useCopyEntry();
  const info = groupInfo(name, entries);

  return (
    <NodeViewWrapper as="span" className="ee-chip-wrap" data-group-ref={name} contentEditable={false}>
      <GroupChip
        name={name}
        entries={entries}
        onMouseEnter={hover.onEnter}
        onMouseLeave={hover.onLeave}
      />
      {hover.open && (
        <HoverCard anchor={hover.anchor} onEnter={hover.cardEnter} onLeave={hover.cardLeave}>
          <AttachmentCard
            kind="group"
            icon={<info.Icon size={12} />}
            kindClassName={info.className}
            kindStyle={info.style}
            title={info.label}
            meta={groupMeta(info.entries.length)}
          >
            <GroupBody info={info} onCopy={copy} copiedId={copied} />
          </AttachmentCard>
        </HoverCard>
      )}
    </NodeViewWrapper>
  );
};

export const GroupRef = Node.create({
  name: "groupRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      name: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-group-ref") ?? "",
        renderHTML: (attrs) => ({ "data-group-ref": attrs.name ?? "" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-group-ref]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), ""];
  },

  addNodeView() {
    return ReactNodeViewRenderer(GroupRefView);
  },
});
