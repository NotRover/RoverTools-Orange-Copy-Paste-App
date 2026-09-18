// ── Tiptap node — Clip card ─────────────────────────────────────────────
// Block atom embedding a clipboard entry as a full card: header plus the
// entry's content. The inline counterpart is the `clipEmbed` chip. Nothing
// about the card's display state is stored; "Show all" is local.

import React from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEmbedContext } from "../embed-context";
import {
  AttachmentCard,
  EntryBody,
  copyAction,
  entryKind,
  entryMeta,
  entryTitle,
  kindLabel,
  removeAction,
  useCopyEntry,
} from "./AttachmentCard";

const ClipCardView: React.FC<NodeViewProps> = ({ node, deleteNode }) => {
  const { entries } = useEmbedContext();
  const id = (node.attrs.id as string) ?? "";
  const entry = entries.find((e) => e.id === id);
  const [copied, copy] = useCopyEntry();

  return (
    <NodeViewWrapper as="span" className="ee-embed" data-clip-card={id} contentEditable={false}>
      {entry ? (
        <AttachmentCard
          kind={entryKind(entry)}
          title={entryTitle(entry)}
          meta={entryMeta(entry)}
          actions={[copyAction(() => copy(entry.id), copied === entry.id), removeAction(deleteNode)]}
        >
          <EntryBody entry={entry} />
        </AttachmentCard>
      ) : (
        <AttachmentCard
          kind="missing"
          title={entryTitle(undefined)}
          meta={`was ${kindLabel("text")}`}
          actions={[removeAction(deleteNode)]}
          compact
          missing
        />
      )}
    </NodeViewWrapper>
  );
};

export const ClipCard = Node.create({
  name: "clipCard",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-clip-card") ?? "",
        renderHTML: (attrs) => ({ "data-clip-card": attrs.id ?? "" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-clip-card]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), ""];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ClipCardView);
  },
});
