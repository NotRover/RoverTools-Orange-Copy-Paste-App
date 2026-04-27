// ── Tiptap node view — Clip embed ───────────────────────────────────────

import React from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import {
  classifyFileEntry,
  filePaths,
  truncateText,
} from "../../../../../types";
import { fileName } from "../../notes-utils";
import { useEmbedContext } from "../embed-context";

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

export default ClipEmbedView;