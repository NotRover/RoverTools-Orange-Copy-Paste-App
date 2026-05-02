// ── Tiptap node — Group reference ─────────────────────────────────────────

import React, { useState } from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ImageIcon,
  FileIcon,
  TextLinesIcon,
  HtmlCodeIcon,
  TagIcon,
  ChevronDownIcon,
} from "../../../../icons";
import {
  groupColor,
  isImageFile,
  filePaths,
  resolveImageSrc,
  truncateText,
} from "../../../../../types";
import { stripHtml } from "../../notes-utils";
import { useEmbedContext } from "../embed-context";

type EntryType = "text" | "image" | "file" | "html";

function EntryIcon({ type, content }: { type: EntryType; content: string }) {
  const sz = 11;
  if (type === "image") return <ImageIcon size={sz} />;
  if (type === "html") return <HtmlCodeIcon size={sz} />;
  if (type === "file") {
    const paths = filePaths(content);
    if (paths.some(isImageFile)) return <ImageIcon size={sz} />;
    return <FileIcon size={sz} />;
  }
  return <TextLinesIcon size={sz} />;
}

function rowLabel(entry: { type: EntryType; content: string; label?: string }): string {
  if (entry.type === "image") return entry.label ?? "Image";
  if (entry.type === "file") {
    const paths = filePaths(entry.content);
    return paths[0] ? paths[0].split(/[\\/]/).pop() ?? paths[0] : "File";
  }
  const raw = entry.type === "html" ? stripHtml(entry.content) : entry.content;
  return truncateText(raw.replace(/\s+/g, " ").trim(), 52) || "—";
}

function rowThumb(
  entry: { type: EntryType; content: string; label?: string },
): string | null {
  if (entry.type === "image") {
    return resolveImageSrc(entry.content, convertFileSrc);
  }
  if (entry.type === "file") {
    const paths = filePaths(entry.content).filter(isImageFile);
    return paths[0] ? convertFileSrc(paths[0]) : null;
  }
  return null;
}

const Caret: React.FC<{ expanded: boolean }> = ({ expanded: _ }) => (
  <ChevronDownIcon size={10} />
);

const GroupRefView: React.FC<NodeViewProps> = ({ node }) => {
  const { entries } = useEmbedContext();
  const [expanded, setExpanded] = useState(false);
  const name = (node.attrs.name as string) ?? "";
  const c = groupColor(name);
  const groupEntries = entries.filter((e) => e.groups.includes(name));

  const handleToggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setExpanded((p) => !p);
  };

  return (
    <NodeViewWrapper
      as="span"
      className={`ee-group-chip${expanded ? " ee-group-chip--open" : ""}`}
      data-group-ref={name}
      contentEditable={false}
    >
      <span
        className="ee-group-chip-inner"
        style={{ background: c.bg, color: c.fg }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleToggle}
      >
        <span className="ee-group-chip-dot" style={{ background: c.fg }} />
        {name}
        {groupEntries.length > 0 && (
          <span className="ee-group-chip-count">{groupEntries.length}</span>
        )}
      </span>

      {expanded && (
        <span
          className="ee-group-panel"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <span className="ee-group-panel-header">
            <TagIcon size={9} strokeWidth={2.5} />
            <span style={{ color: c.fg }}>{name}</span>
            <span className="ee-group-panel-count">
              {groupEntries.length} entr{groupEntries.length === 1 ? "y" : "ies"}
            </span>
          </span>

          {/* Entry list */}
          <span className="ee-group-panel-body">
            {groupEntries.length === 0 ? (
              <span className="ee-group-panel-empty">No entries in this group</span>
            ) : (
              groupEntries.slice(0, 10).map((entry) => {
                const thumb = rowThumb(entry);
                const label = rowLabel(entry);
                return (
                  <span key={entry.id} className="ee-group-panel-row">
                    {thumb ? (
                      <img
                        className="ee-group-panel-row-thumb"
                        src={thumb}
                        alt=""
                      />
                    ) : (
                      <span className="ee-group-panel-row-icon">
                        <EntryIcon type={entry.type} content={entry.content} />
                      </span>
                    )}
                    <span className="ee-group-panel-row-label">{label}</span>
                  </span>
                );
              })
            )}
            {groupEntries.length > 10 && (
              <span className="ee-group-panel-more">
                +{groupEntries.length - 10} more entries
              </span>
            )}
          </span>
        </span>
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
