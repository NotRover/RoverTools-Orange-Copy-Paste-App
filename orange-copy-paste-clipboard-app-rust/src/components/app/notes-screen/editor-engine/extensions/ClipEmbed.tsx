// ── Tiptap node — Clip embed ──────────────────────────────────────────────
// Inline atom that round-trips as <span data-clip-embed="ID"></span>. Inside
// the editor it renders as a chip (label resolved against the entries list
// supplied through React context).

import React from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import {
  classifyFileEntry,
  filePaths,
  truncateText,
} from "../../../../../types";
import { fileName } from "../../notes-utils";
import { useEmbedContext } from "../embed-context";

// ── NodeView ──────────────────────────────────────────────────────────────

const ClipEmbedView: React.FC<NodeViewProps> = ({ node }) => {
  const { entries } = useEmbedContext();
  const id = (node.attrs.id as string) ?? "";
  const entry = entries.find((e) => e.id === id);
  const missing = !entry && !!id;
  const label = (() => {
    if (!entry) return id ? "Missing clip" : "Clip";
    const paths = entry.type === "file" ? filePaths(entry.content) : [];
    const fileKind = entry.type === "file" ? classifyFileEntry(entry.content) : "file";
    if (entry.type === "image") return entry.label ?? "Image";
    if (entry.type === "file")
      return fileKind === "image" ? "Image file" : paths[0] ? fileName(paths[0]) : "File";
    const text = entry.type === "html" ? entry.content.replace(/<[^>]*>/g, "") : entry.content;
    return truncateText(text.replace(/\s+/g, " ").trim(), 28) || "Clip";
  })();

  return (
    <NodeViewWrapper
      as="span"
      className={`ee-clip-chip${missing ? " ee-clip-chip--missing" : ""}`}
      data-clip-embed={id}
      contentEditable={false}
    >
      {label}
    </NodeViewWrapper>
  );
};

// ── Extension ─────────────────────────────────────────────────────────────

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
