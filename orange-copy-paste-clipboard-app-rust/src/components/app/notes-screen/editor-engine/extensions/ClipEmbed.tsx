// ── Tiptap node — Clip chip ─────────────────────────────────────────────
// Inline atom referencing a clipboard entry. Chip-sized forever: hovering
// shows the entry as a card in a popover, nothing in the document changes.
// The block counterpart is `clipCard`. The stored node name stays
// `clipEmbed` so older notes keep parsing.

import React from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import type { ClipboardEntry } from "../../../../../types";
import { useEmbedContext } from "../embed-context";
import {
  AttachmentCard,
  EntryBody,
  KindIcon,
  copyAction,
  entryKind,
  entryMeta,
  entryTitle,
  useCopyEntry,
} from "./AttachmentCard";
import { HoverCard, useHoverCard } from "./HoverCard";

/** The chip itself. Shared with the read-only preview. */
export const ClipChip: React.FC<{
  entry: ClipboardEntry | undefined;
  onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave?: () => void;
}> = ({ entry, onMouseEnter, onMouseLeave }) => {
  const kind = entryKind(entry);
  return (
    <span
      className={`ee-chip ee-kind--${kind}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <KindIcon kind={kind} size={11} />
      <span className="ee-chip-label">{entryTitle(entry, 48)}</span>
    </span>
  );
};

const ClipEmbedView: React.FC<NodeViewProps> = ({ node }) => {
  const { entries } = useEmbedContext();
  const id = (node.attrs.id as string) ?? "";
  const entry = entries.find((e) => e.id === id);
  const hover = useHoverCard();
  const [copied, copy] = useCopyEntry();

  return (
    <NodeViewWrapper as="span" className="ee-chip-wrap" data-clip-embed={id} contentEditable={false}>
      <ClipChip
        entry={entry}
        onMouseEnter={entry ? hover.onEnter : undefined}
        onMouseLeave={entry ? hover.onLeave : undefined}
      />
      {hover.open && entry && (
        <HoverCard anchor={hover.anchor} onEnter={hover.cardEnter} onLeave={hover.cardLeave}>
          <AttachmentCard
            kind={entryKind(entry)}
            title={entryTitle(entry)}
            meta={entryMeta(entry)}
            actions={[copyAction(() => copy(entry.id), copied === entry.id)]}
          >
            <EntryBody entry={entry} />
          </AttachmentCard>
        </HoverCard>
      )}
    </NodeViewWrapper>
  );
};

export const ClipEmbed = Node.create({
  name: "clipEmbed",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-clip-embed") ?? "",
        renderHTML: (attrs) => ({ "data-clip-embed": attrs.id ?? "" }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-clip-embed]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), ""];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ClipEmbedView);
  },
});
