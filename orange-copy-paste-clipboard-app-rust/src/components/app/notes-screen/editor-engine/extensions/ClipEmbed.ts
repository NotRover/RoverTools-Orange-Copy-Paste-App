// ── Tiptap node — Clip embed ──────────────────────────────────────────────
// Inline atom that round-trips as <span data-clip-embed="ID"></span>. Inside
// the editor it renders as a chip (label resolved against the entries list
// supplied through React context).

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
    };
  },

  parseHTML() {
    return [{ tag: "span[data-clip-embed]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), ""];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const id = (node.attrs.id as string) ?? "";
          state.write(`<span data-clip-embed="${escAttr(id)}"></span>`);
        },
        parse: { setup() {} },
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ClipEmbedView);
  },
});

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}