// ── Tiptap node — Clip embed ──────────────────────────────────────────────
// Inline atom referencing a clipboard entry. Stored as a node in ProseMirror
// JSON and rendered as a chip via React. Label is resolved against the
// entries list supplied through React context.

import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import ClipEmbedView from "./ClipEmbedView";

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
      expanded: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-expanded") === "true",
        renderHTML: (attrs) => attrs.expanded ? { "data-expanded": "true" } : {},
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
