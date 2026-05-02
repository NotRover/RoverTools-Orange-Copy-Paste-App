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
  truncateText,
} from "../../../../types";
import {
  ImageIcon,
  FileIcon,
  TextLinesIcon,
  HtmlCodeIcon,
  VideoIcon,
  PinIcon,
  SaveStarIcon,
} from "../../../icons";

const SYSTEM_GROUP_META: Record<string, { label: string; bg: string; fg: string; Icon: React.FC<{ size?: number }> }> = {
  pinned: { label: "Pinned", bg: "var(--accent-dim)", fg: "var(--accent)", Icon: PinIcon },
  Saved: { label: "Saved", bg: "rgba(34, 197, 94, 0.12)", fg: "#22c55e", Icon: SaveStarIcon },
};
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

// ── Clip chip (preview — chip only, no expansion) ────────────────────────

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

const ClipChip: React.FC<{ id: string; entries: ClipboardEntry[] }> = ({
  id,
  entries,
}) => {
  const entry = entries.find((e) => e.id === id);
  const missing = !entry && !!id;
  const label = getLabel(id, entry);
  const kind = entry ? deriveDisplayKind(entry) : "text";

  return (
    <span className={`ee-clip-embed${missing ? " ee-clip-embed--missing" : ""}`}>
      <span className={`ee-clip-embed-inner ee-clip-embed-inner--${kind}`}>
        <span className="ee-clip-embed-icon">
          <ClipIcon entry={entry} />
        </span>
        <span className="ee-clip-embed-label">{label}</span>
      </span>
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

// ── Group chip (preview — chip only, no expansion) ───────────────────────

const GroupChip: React.FC<{ name: string; entries: ClipboardEntry[] }> = ({
  name,
  entries,
}) => {
  const sysMeta = SYSTEM_GROUP_META[name];
  const c = sysMeta ?? groupColor(name);
  const count = name === "pinned"
    ? entries.filter((e) => e.pinned).length
    : name === "Saved"
    ? entries.filter((e) => e.groups.includes("Saved")).length
    : entries.filter((e) => e.groups.includes(name)).length;
  const SysIcon = sysMeta?.Icon;
  const displayName = sysMeta?.label ?? name;

  return (
    <span className={`ee-group-chip${sysMeta ? " ee-group-chip--system" : ""}`}>
      <span className="ee-group-chip-inner" style={{ background: c.bg, color: c.fg }}>
        {SysIcon ? (
          <span className="ee-group-chip-sys-icon"><SysIcon size={10} /></span>
        ) : (
          <span className="ee-group-chip-dot" style={{ background: c.fg }} />
        )}
        {displayName}
        {count > 0 && <span className="ee-group-chip-count">{count}</span>}
      </span>
    </span>
  );
};
