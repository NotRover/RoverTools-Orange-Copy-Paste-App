// ── Tiptap node view — Clip embed ───────────────────────────────────────

import React from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ImageIcon,
  FileIcon,
  TextLinesIcon,
  HtmlCodeIcon,
  VideoIcon,
  FilePageIcon,
} from "../../../../icons";
import {
  classifyFileEntry,
  deriveDisplayKind,
  fileNameFromPath,
  filePaths,
  isImageFile,
  resolveImageSrc,
  timeAgo,
  truncateText,
} from "../../../../../types";
import { stripHtml } from "../../notes-utils";
import { useEmbedContext } from "../embed-context";

type EntryType = "text" | "image" | "file" | "html";

function TypeIcon({ type, fileKind }: { type: EntryType; fileKind?: string }) {
  const sz = 11;
  if (type === "image" || fileKind === "image") return <ImageIcon size={sz} />;
  if (fileKind === "video") return <VideoIcon size={sz} />;
  if (type === "html") return <HtmlCodeIcon size={sz} />;
  if (type === "file") return <FileIcon size={sz} />;
  return <TextLinesIcon size={sz} />;
}

function typeLabel(type: EntryType, fileKind?: string) {
  if (type === "image" || fileKind === "image") return "Image";
  if (fileKind === "video") return "Video";
  if (type === "html") return "HTML";
  if (type === "file") return "File";
  return "Text";
}

function entryLabel(
  id: string,
  entry: { type: EntryType; content: string; label?: string } | undefined,
): string {
  if (!entry) return id ? "Missing entry" : "Clip";
  if (entry.type === "image") return entry.label ?? "Image";
  if (entry.type === "file") {
    const paths = filePaths(entry.content);
    const kind = classifyFileEntry(entry.content);
    return kind === "image" ? "Image file" : paths[0] ? fileNameFromPath(paths[0]) : "File";
  }
  const raw =
    entry.type === "html" ? stripHtml(entry.content) : entry.content;
  return truncateText(raw.replace(/\s+/g, " ").trim(), 38) || "Clip";
}

// ── Expanded content ────────────────────────────────────────────────────

const PanelContent: React.FC<{
  entry: { type: EntryType; content: string; label?: string; timestamp: number };
}> = ({ entry }) => {
  const meta = (
    <div className="ee-embed-panel-meta">
      <span className="ee-embed-panel-type">
        <TypeIcon
          type={entry.type}
          fileKind={
            entry.type === "file" ? classifyFileEntry(entry.content) : undefined
          }
        />
        {typeLabel(
          entry.type,
          entry.type === "file" ? classifyFileEntry(entry.content) : undefined,
        )}
      </span>
      <span className="ee-embed-panel-time">{timeAgo(entry.timestamp)}</span>
    </div>
  );

  if (entry.type === "image") {
    const src = resolveImageSrc(entry.content, convertFileSrc);
    return (
      <>
        {meta}
        <div className="ee-embed-panel-body">
          <img className="ee-embed-panel-img" src={src} alt={entry.label ?? "Image"} />
          {entry.label && (
            <div className="ee-embed-panel-img-caption">{entry.label}</div>
          )}
        </div>
      </>
    );
  }

  if (entry.type === "file") {
    const paths = filePaths(entry.content);
    const imageFiles = paths.filter(isImageFile);
    const otherFiles = paths.filter((p) => !isImageFile(p));
    return (
      <>
        {meta}
        <div className="ee-embed-panel-body">
          {imageFiles.map((p) => (
            <img
              key={p}
              className="ee-embed-panel-img"
              src={convertFileSrc(p)}
              alt={fileNameFromPath(p)}
            />
          ))}
          {otherFiles.length > 0 && (
            <div className="ee-embed-panel-files">
              {otherFiles.map((p) => (
                <div key={p} className="ee-embed-panel-path">
                  <FilePageIcon size={11} />
                  {p}
                </div>
              ))}
            </div>
          )}
        </div>
      </>
    );
  }

  const text = (
    entry.type === "html" ? stripHtml(entry.content) : entry.content
  )
    .replace(/\s+/g, " ")
    .trim();

  return (
    <>
      {meta}
      <div className="ee-embed-panel-body">
        <div className="ee-embed-panel-text">
          {text.slice(0, 700) || "—"}
        </div>
      </div>
    </>
  );
};

// ── Node view ───────────────────────────────────────────────────────────

const ClipEmbedView: React.FC<NodeViewProps> = ({ node, updateAttributes }) => {
  const { entries } = useEmbedContext();
  const id = (node.attrs.id as string) ?? "";
  const expanded = !!(node.attrs.expanded as boolean);
  const entry = entries.find((e) => e.id === id);
  const missing = !entry && !!id;
  const label = entryLabel(id, entry);
  const fileKind =
    entry?.type === "file" ? classifyFileEntry(entry.content) : undefined;
  const kind = entry ? deriveDisplayKind(entry as any) : "text";

  const handleToggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!entry) return;
    updateAttributes({ expanded: !expanded });
  };

  return (
    <NodeViewWrapper
      as="span"
      className={[
        "ee-clip-embed",
        missing && "ee-clip-embed--missing",
        expanded && "ee-clip-embed--open",
      ]
        .filter(Boolean)
        .join(" ")}
      data-clip-embed={id}
      contentEditable={false}
    >
      <span
        className={`ee-clip-embed-inner ee-clip-embed-inner--${kind}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={entry ? handleToggle : undefined}
        data-tooltip={entry ? (expanded ? "Click to collapse" : "Click to expand") : undefined}
        data-tooltip-pos="below"
      >
        <span className="ee-clip-embed-icon">
          <TypeIcon type={entry?.type ?? "text"} fileKind={fileKind} />
        </span>
        <span className="ee-clip-embed-label">{label}</span>
      </span>
      {expanded && entry && (
        <span
          className="ee-embed-panel"
          onClick={(e) => e.stopPropagation()}
        >
          <PanelContent entry={entry} />
        </span>
      )}
    </NodeViewWrapper>
  );
};

export default ClipEmbedView;
