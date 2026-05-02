// ── Editor Engine — Read-only preview for note cards ─────────────────────
// Walks Tiptap JSON and renders React elements directly. No editor instance.

import React, { useEffect, useMemo, useState } from "react";
import type { JSONContent } from "@tiptap/react";
import type { ClipboardEntry } from "../../../../types";
import {
  classifyFileEntry,
  deriveDisplayKind,
  filePaths,
  groupColor,
  isImageFile,
  resolveImageSrc,
  timeAgo,
  truncateText,
} from "../../../../types";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  ImageIcon,
  FileIcon,
  TextLinesIcon,
  HtmlCodeIcon,
  VideoIcon,
} from "../../../icons";
import { fileName, stripHtml } from "../notes-utils";
import {
  resolveAttachmentUrl,
  subscribeAttachmentResolver,
} from "./attachment-url";
import { parseStoredContent } from "./content-codec";
import "./markdown.css";

interface Props {
  content: string;
  entries: ClipboardEntry[];
  className?: string;
}

const NotionPreview: React.FC<Props> = ({ content, entries, className }) => {
  const [, setVersion] = useState(0);
  useEffect(
    () => subscribeAttachmentResolver(() => setVersion((v) => v + 1)),
    [],
  );
  const doc = useMemo(() => parseStoredContent(content), [content]);
  return (
    <div className={`ee-preview${className ? " " + className : ""}`}>
      {renderChildren(doc.content, entries, "r")}
    </div>
  );
};

export default NotionPreview;

// ── JSON renderer ────────────────────────────────────────────────────────

function renderChildren(
  nodes: JSONContent[] | undefined,
  entries: ClipboardEntry[],
  keyPrefix: string,
): React.ReactNode {
  if (!nodes) return null;
  return nodes.map((n, i) => renderNode(n, entries, `${keyPrefix}.${i}`));
}

function renderNode(
  node: JSONContent,
  entries: ClipboardEntry[],
  key: string,
): React.ReactNode {
  const align = (node.attrs?.textAlign as string) || undefined;
  const style =
    align && align !== "left" ? { textAlign: align as any } : undefined;

  switch (node.type) {
    case "paragraph":
      return (
        <p key={key} style={style}>
          {renderChildren(node.content, entries, key)}
        </p>
      );
    case "heading": {
      const level = (node.attrs?.level as number) || 1;
      const Tag = `h${Math.min(Math.max(level, 1), 6)}` as any;
      return (
        <Tag key={key} style={style}>
          {renderChildren(node.content, entries, key)}
        </Tag>
      );
    }
    case "blockquote":
      return (
        <blockquote key={key}>
          {renderChildren(node.content, entries, key)}
        </blockquote>
      );
    case "callout": {
      const tone = (node.attrs?.tone as string) || "info";
      return (
        <div key={key} className="ee-callout" data-callout={tone}>
          {renderChildren(node.content, entries, key)}
        </div>
      );
    }
    case "details":
      return (
        <details key={key} className="ee-details">
          {renderChildren(node.content, entries, key)}
        </details>
      );
    case "detailsSummary":
      return (
        <summary key={key}>
          {renderChildren(node.content, entries, key)}
        </summary>
      );
    case "detailsContent":
      return <div key={key}>{renderChildren(node.content, entries, key)}</div>;
    case "bulletList":
      return <ul key={key}>{renderChildren(node.content, entries, key)}</ul>;
    case "orderedList":
      return <ol key={key}>{renderChildren(node.content, entries, key)}</ol>;
    case "listItem":
      return <li key={key}>{renderChildren(node.content, entries, key)}</li>;
    case "taskList":
      return (
        <ul key={key} data-type="taskList">
          {renderChildren(node.content, entries, key)}
        </ul>
      );
    case "taskItem": {
      const checked = !!node.attrs?.checked;
      return (
        <li key={key} data-type="taskItem" data-checked={checked}>
          <label>
            <input type="checkbox" checked={checked} readOnly />
            <span>{renderChildren(node.content, entries, key)}</span>
          </label>
        </li>
      );
    }
    case "codeBlock": {
      const lang = (node.attrs?.language as string) || undefined;
      return (
        <pre key={key} className="ee-codeblock">
          <code className={lang ? `language-${lang}` : undefined}>
            {plainText(node.content)}
          </code>
        </pre>
      );
    }
    case "horizontalRule":
      return <hr key={key} />;
    case "image": {
      const src = (node.attrs?.src as string) || "";
      const alt = (node.attrs?.alt as string) || "";
      return <img key={key} src={resolveAttachmentUrl(src)} alt={alt} />;
    }
    case "table":
      return (
        <table key={key}>
          <tbody>{renderChildren(node.content, entries, key)}</tbody>
        </table>
      );
    case "tableRow":
      return <tr key={key}>{renderChildren(node.content, entries, key)}</tr>;
    case "tableCell":
      return <td key={key}>{renderChildren(node.content, entries, key)}</td>;
    case "tableHeader":
      return <th key={key}>{renderChildren(node.content, entries, key)}</th>;
    case "hardBreak":
      return <br key={key} />;
    case "clipEmbed":
      return (
        <ClipChip
          key={key}
          id={(node.attrs?.id as string) ?? ""}
          entries={entries}
        />
      );
    case "groupRef":
      return (
        <GroupChip
          key={key}
          name={(node.attrs?.name as string) ?? ""}
          entries={entries}
        />
      );
    case "text":
      return renderText(node, key);
    default:
      return (
        <React.Fragment key={key}>
          {renderChildren(node.content, entries, key)}
        </React.Fragment>
      );
  }
}

function renderText(node: JSONContent, key: string): React.ReactNode {
  let el: React.ReactNode = (node as any).text ?? "";
  const marks = (node as any).marks as
    | { type: string; attrs?: any }[]
    | undefined;
  if (!marks || marks.length === 0)
    return <React.Fragment key={key}>{el}</React.Fragment>;
  for (const m of marks) {
    switch (m.type) {
      case "bold":
        el = <strong>{el}</strong>;
        break;
      case "italic":
        el = <em>{el}</em>;
        break;
      case "underline":
        el = <u>{el}</u>;
        break;
      case "strike":
        el = <s>{el}</s>;
        break;
      case "code":
        el = <code>{el}</code>;
        break;
      case "link":
        el = (
          <a
            href={resolveAttachmentUrl(m.attrs?.href ?? "")}
            target="_blank"
            rel="noopener noreferrer"
          >
            {el}
          </a>
        );
        break;
      case "textStyle":
        if (m.attrs?.color)
          el = <span style={{ color: m.attrs.color }}>{el}</span>;
        break;
      case "highlight":
        if (m.attrs?.color)
          el = <mark style={{ backgroundColor: m.attrs.color }}>{el}</mark>;
        break;
    }
  }
  return <React.Fragment key={key}>{el}</React.Fragment>;
}

function plainText(nodes: JSONContent[] | undefined): string {
  if (!nodes) return "";
  let out = "";
  for (const n of nodes) {
    if (typeof (n as any).text === "string") out += (n as any).text;
    else if (n.content) out += plainText(n.content);
  }
  return out;
}

// ── Shared caret SVG ─────────────────────────────────────────────────────

const Caret: React.FC<{ expanded: boolean }> = ({ expanded }) => (
  <svg
    width="9"
    height="9"
    viewBox="0 0 10 10"
    style={{
      display: "block",
      transition: "transform 0.18s cubic-bezier(0.4,0,0.2,1)",
      transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
    }}
  >
    <path
      d="M2 3.8L5 6.8L8 3.8"
      stroke="currentColor"
      strokeWidth="1.6"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// ── Expandable Clip chip ──────────────────────────────────────────────────

function getLabel(id: string, entry: ClipboardEntry | undefined): string {
  if (!entry) return id ? "Missing entry" : "Clip";
  if (entry.type === "image") return entry.label ?? "Image";
  if (entry.type === "file") {
    const paths = filePaths(entry.content);
    const kind = classifyFileEntry(entry.content);
    return kind === "image" ? "Image file" : paths[0] ? fileName(paths[0]) : "File";
  }
  const raw =
    entry.type === "html" ? stripHtml(entry.content) : entry.content;
  return truncateText(raw.replace(/\s+/g, " ").trim(), 38) || "Clip";
}

function getTypeLabel(entry: ClipboardEntry): string {
  if (entry.type === "image") return "Image";
  if (entry.type === "html") return "HTML";
  if (entry.type === "file") {
    const k = classifyFileEntry(entry.content);
    return k === "image" ? "Image" : k === "video" ? "Video" : "File";
  }
  return "Text";
}

function TypeBadge({ entry }: { entry: ClipboardEntry }) {
  return (
    <span className="ee-embed-panel-type">
      {getTypeLabel(entry)}
    </span>
  );
}

const ClipChip: React.FC<{ id: string; entries: ClipboardEntry[] }> = ({
  id,
  entries,
}) => {
  const [expanded, setExpanded] = useState(false);
  const entry = entries.find((e) => e.id === id);
  const missing = !entry && !!id;
  const label = getLabel(id, entry);
  const kind = entry ? deriveDisplayKind(entry) : "text";

  return (
    <span
      className={[
        "ee-clip-embed",
        missing && "ee-clip-embed--missing",
        expanded && "ee-clip-embed--open",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span
        className={`ee-clip-embed-inner ee-clip-embed-inner--${kind}`}
        onClick={entry ? (e) => { e.stopPropagation(); setExpanded((p) => !p); } : undefined}
      >
        <span className="ee-clip-embed-icon">
          <ClipIcon entry={entry} />
        </span>
        <span className="ee-clip-embed-label">{label}</span>
      </span>

      {expanded && entry && (
        <span
          className="ee-embed-panel"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Meta */}
          <span className="ee-embed-panel-meta">
            <TypeBadge entry={entry} />
            <span className="ee-embed-panel-time">{timeAgo(entry.timestamp)}</span>
          </span>
          {/* Body */}
          <span className="ee-embed-panel-body">
            <ClipPanelBody entry={entry} />
          </span>
        </span>
      )}
    </span>
  );
};

function ClipIcon({ entry }: { entry: ClipboardEntry | undefined }) {
  const sz = 11;
  if (!entry) return <TextLinesIcon size={sz} />;
  if (entry.type === "image") return <ImageIcon size={sz} />;
  if (entry.type === "html") return <HtmlCodeIcon size={sz} />;
  if (entry.type === "file") {
    const k = classifyFileEntry(entry.content);
    if (k === "image") return <ImageIcon size={sz} />;
    if (k === "video") return <VideoIcon size={sz} />;
    return <FileIcon size={sz} />;
  }
  return <TextLinesIcon size={sz} />;
}

function ClipPanelBody({ entry }: { entry: ClipboardEntry }) {
  if (entry.type === "image") {
    const src = resolveImageSrc(entry.content, convertFileSrc);
    return (
      <>
        <img className="ee-embed-panel-img" src={src} alt={entry.label ?? ""} />
        {entry.label && (
          <div className="ee-embed-panel-img-caption">{entry.label}</div>
        )}
      </>
    );
  }

  if (entry.type === "file") {
    const paths = filePaths(entry.content);
    const imgPaths = paths.filter(isImageFile);
    const otherPaths = paths.filter((p) => !isImageFile(p));
    return (
      <>
        {imgPaths.map((p) => (
          <img
            key={p}
            className="ee-embed-panel-img"
            src={convertFileSrc(p)}
            alt={fileName(p)}
          />
        ))}
        {otherPaths.length > 0 && (
          <div className="ee-embed-panel-files">
            {otherPaths.map((p) => (
              <div key={p} className="ee-embed-panel-path">
                <FileIcon size={11} />
                {p}
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  const text = (
    entry.type === "html" ? stripHtml(entry.content) : entry.content
  )
    .replace(/\s+/g, " ")
    .trim();

  return (
    <div className="ee-embed-panel-text">{text.slice(0, 600) || "—"}</div>
  );
}

// ── Expandable Group chip ─────────────────────────────────────────────────

function groupRowThumb(entry: ClipboardEntry): string | null {
  if (entry.type === "image")
    return resolveImageSrc(entry.content, convertFileSrc);
  if (entry.type === "file") {
    const imgPaths = filePaths(entry.content).filter(isImageFile);
    return imgPaths[0] ? convertFileSrc(imgPaths[0]) : null;
  }
  return null;
}

function groupRowLabel(entry: ClipboardEntry): string {
  if (entry.type === "image") return entry.label ?? "Image";
  if (entry.type === "file") {
    const paths = filePaths(entry.content);
    return paths[0] ? fileName(paths[0]) : "File";
  }
  const raw =
    entry.type === "html" ? stripHtml(entry.content) : entry.content;
  return truncateText(raw.replace(/\s+/g, " ").trim(), 52) || "—";
}

const GroupChip: React.FC<{ name: string; entries: ClipboardEntry[] }> = ({
  name,
  entries,
}) => {
  const [expanded, setExpanded] = useState(false);
  const c = groupColor(name);
  const groupEntries = entries.filter((e) => e.groups.includes(name));

  return (
    <span
      className={`ee-group-chip${expanded ? " ee-group-chip--open" : ""}`}
    >
      <span
        className="ee-group-chip-inner"
        style={{ background: c.bg, color: c.fg }}
        onClick={(e) => { e.stopPropagation(); setExpanded((p) => !p); }}
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
          <span className="ee-group-panel-header">
            <span
              className="ee-group-panel-header-dot"
              style={{ background: c.fg }}
            />
            <span style={{ color: c.fg }}>{name}</span>
            <span className="ee-group-panel-count">
              {groupEntries.length} entr
              {groupEntries.length === 1 ? "y" : "ies"}
            </span>
          </span>

          <span className="ee-group-panel-body">
            {groupEntries.length === 0 ? (
              <span className="ee-group-panel-empty">No entries in this group</span>
            ) : (
              groupEntries.slice(0, 10).map((entry) => {
                const thumb = groupRowThumb(entry);
                const label = groupRowLabel(entry);
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
                        {entry.type === "html" ? <HtmlCodeIcon size={11} /> : <TextLinesIcon size={11} />}
                      </span>
                    )}
                    <span className="ee-group-panel-row-label">{label}</span>
                  </span>
                );
              })
            )}
            {groupEntries.length > 10 && (
              <span className="ee-group-panel-more">
                +{groupEntries.length - 10} more
              </span>
            )}
          </span>
        </span>
      )}
    </span>
  );
};
