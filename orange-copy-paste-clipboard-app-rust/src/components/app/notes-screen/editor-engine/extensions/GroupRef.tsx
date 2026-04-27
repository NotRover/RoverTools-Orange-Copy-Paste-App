// ── Tiptap node — Group reference ─────────────────────────────────────────

import React from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { groupColor } from "../../../../../types";

const GroupRefView: React.FC<NodeViewProps> = ({ node }) => {
  const name = (node.attrs.name as string) ?? "";
  const c = groupColor(name);
  return (
    <NodeViewWrapper
      as="span"
      className="ee-group-chip"
      style={{ background: c.bg, color: c.fg }}
      data-group-ref={name}
      contentEditable={false}
    >
      <span className="ee-group-chip-dot" style={{ background: c.fg }} />
      {name}
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

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const name = (node.attrs.name as string) ?? "";
          state.write(`<span data-group-ref="${escAttr(name)}"></span>`);
        },
        parse: { setup() {} },
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(GroupRefView);
  },
});

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
