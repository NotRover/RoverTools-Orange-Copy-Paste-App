// ── Tiptap node — Group reference ─────────────────────────────────────────

import React from "react";
import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import {
  ImageIcon,
  FileIcon,
  TextLinesIcon,
  HtmlCodeIcon,
  TagIcon,
  PinIcon,
  SaveStarIcon,
} from "../../../../icons";
import {
  groupColor,
  filePaths,
  truncateText,
  deriveDisplayKind,
} from "../../../../../types";

const SYSTEM_GROUP_META: Record<string, { label: string; bg: string; fg: string; Icon: React.FC<{ size?: number }> }> = {
  pinned: { label: "Pinned", bg: "var(--accent-dim)", fg: "var(--accent)", Icon: PinIcon },
  Saved: { label: "Saved", bg: "rgba(34, 197, 94, 0.12)", fg: "#22c55e", Icon: SaveStarIcon },
};
import { stripHtml } from "../../notes-utils";
import { useEmbedContext } from "../embed-context";

type EntryType = "text" | "image" | "file" | "html";

function EntryIcon({ type }: { type: EntryType }) {
  const sz = 11;
  if (type === "image") return <ImageIcon size={sz} />;
  if (type === "html") return <HtmlCodeIcon size={sz} />;
  if (type === "file") return <FileIcon size={sz} />;
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


const GroupRefView: React.FC<NodeViewProps> = ({ node, updateAttributes }) => {
  const { entries } = useEmbedContext();
  const name = (node.attrs.name as string) ?? "";
  const expanded = !!(node.attrs.expanded as boolean);
  const sysMeta = SYSTEM_GROUP_META[name];
  const c = sysMeta ?? groupColor(name);
  const groupEntries = name === "pinned"
    ? entries.filter((e) => e.pinned)
    : name === "Saved"
    ? entries.filter((e) => e.groups.includes("Saved"))
    : entries.filter((e) => e.groups.includes(name));

  const handleToggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    updateAttributes({ expanded: !expanded });
  };

  const SysIcon = sysMeta?.Icon;
  const displayName = sysMeta?.label ?? name;

  return (
    <NodeViewWrapper
      as="span"
      className={`ee-group-chip${sysMeta ? " ee-group-chip--system" : ""}${expanded ? " ee-group-chip--open" : ""}`}
      data-group-ref={name}
      contentEditable={false}
    >
      <span
        className="ee-group-chip-inner"
        style={{ background: c.bg, color: c.fg }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleToggle}
        data-tooltip={expanded ? "Click to collapse" : "Click to expand"}
        data-tooltip-pos="below"
      >
        {SysIcon ? (
          <span className="ee-group-chip-sys-icon"><SysIcon size={10} /></span>
        ) : (
          <span className="ee-group-chip-dot" style={{ background: c.fg }} />
        )}
        {displayName}
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
            {SysIcon ? <SysIcon size={9} /> : <TagIcon size={9} strokeWidth={2.5} />}
            <span style={{ color: c.fg }}>{displayName}</span>
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
                const label = rowLabel(entry);
                const kind = deriveDisplayKind(entry);
                return (
                  <span key={entry.id} className="ee-group-panel-row">
                    <span className={`ee-group-panel-row-icon ee-group-panel-row-icon--${kind}`}>
                      <EntryIcon type={entry.type} />
                    </span>
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
      expanded: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-expanded") === "true",
        renderHTML: (attrs) => attrs.expanded ? { "data-expanded": "true" } : {},
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
