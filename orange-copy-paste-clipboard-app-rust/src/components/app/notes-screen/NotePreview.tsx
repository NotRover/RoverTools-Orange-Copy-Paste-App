import React from "react";
import type { ClipboardEntry } from "../../../types";
import { classifyFileEntry, filePaths, truncateText } from "../../../types";
import type {
  NoteDoc,
  BlockNode,
  InlineNode,
  TextNode,
  ClipEmbedNode,
  GroupRefNode,
  LinkNode,
  ImageNode,
} from "./prose-engine";
import { fileName } from "./notes-utils";

// ── Embed chip label ──────────────────────────────────────────────────────

function clipLabel(node: ClipEmbedNode, entries: ClipboardEntry[]): string {
  const entry = entries.find((e) => e.id === node.id);
  if (!entry) return node.id ? "Missing clip" : "Clip";
  const paths = entry.type === "file" ? filePaths(entry.content) : [];
  const fileKind =
    entry.type === "file" ? classifyFileEntry(entry.content) : "file";
  return entry.type === "image"
    ? (entry.label ?? "Image")
    : entry.type === "file"
      ? fileKind === "image"
        ? "Image file"
        : paths[0]
          ? fileName(paths[0])
          : "File"
      : truncateText(
          (entry.type === "html"
            ? entry.content.replace(/<[^>]*>/g, "")
            : entry.content
          )
            .replace(/\s+/g, " ")
            .trim(),
          28,
        ) || "Clip";
}

// ── Inline renderer ───────────────────────────────────────────────────────

function InlineEl({
  node,
  entries,
}: {
  node: InlineNode;
  entries: ClipboardEntry[];
}) {
  switch (node.type) {
    case "text": {
      const n = node as TextNode;
      let el: React.ReactNode = n.text;
      if (n.code) el = <code className="ns-pv-code">{el}</code>;
      if (n.bold) el = <strong>{el}</strong>;
      if (n.italic) el = <em>{el}</em>;
      if (n.underline) el = <u>{el}</u>;
      if (n.strike) el = <s>{el}</s>;
      return <>{el}</>;
    }
    case "clip_embed": {
      const n = node as ClipEmbedNode;
      const entry = entries.find((e) => e.id === n.id);
      return (
        <span
          className={`ns-preview-embed-chip${!entry && n.id ? " ns-preview-embed-chip--missing" : ""}`}
        >
          {clipLabel(n, entries)}
        </span>
      );
    }
    case "group_ref": {
      const n = node as GroupRefNode;
      return <span className="ns-preview-group-chip">#{n.name}</span>;
    }
    case "link": {
      const n = node as LinkNode;
      return <span className="ns-pv-link">{n.text || n.href}</span>;
    }
    case "image": {
      const n = node as ImageNode;
      return <img className="ns-pv-image" src={n.src} alt={n.alt ?? ""} />;
    }
  }
}

function InlineList({
  nodes,
  entries,
}: {
  nodes: InlineNode[];
  entries: ClipboardEntry[];
}) {
  return (
    <>
      {nodes.map((n, i) => (
        <InlineEl key={i} node={n} entries={entries} />
      ))}
    </>
  );
}

// ── Block renderer ────────────────────────────────────────────────────────

function BlockEl({
  node,
  entries,
}: {
  node: BlockNode;
  entries: ClipboardEntry[];
}) {
  switch (node.type) {
    case "p":
      return node.children.length === 0 ? (
        <div className="ns-pv-line ns-pv-line--empty" />
      ) : (
        <div className="ns-pv-line">
          <InlineList nodes={node.children} entries={entries} />
        </div>
      );
    case "h1":
      return (
        <div className="ns-pv-line ns-pv-h1">
          <InlineList nodes={node.children} entries={entries} />
        </div>
      );
    case "h2":
      return (
        <div className="ns-pv-line ns-pv-h2">
          <InlineList nodes={node.children} entries={entries} />
        </div>
      );
    case "h3":
      return (
        <div className="ns-pv-line ns-pv-h3">
          <InlineList nodes={node.children} entries={entries} />
        </div>
      );
    case "ul":
      return (
        <ul className="ns-pv-ul">
          {node.items.map((item, i) => (
            <li key={i} className="ns-pv-li">
              <InlineList nodes={item} entries={entries} />
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="ns-pv-ol">
          {node.items.map((item, i) => (
            <li key={i} className="ns-pv-li">
              <InlineList nodes={item} entries={entries} />
            </li>
          ))}
        </ol>
      );
    case "bq":
      return (
        <div className="ns-pv-bq">
          <InlineList nodes={node.children} entries={entries} />
        </div>
      );
    case "todo":
      return (
        <div
          className={`ns-pv-todo${node.checked ? " ns-pv-todo--checked" : ""}`}
        >
          <span className="ns-pv-todo-check" />
          <InlineList nodes={node.children} entries={entries} />
        </div>
      );
    case "code":
      return (
        <pre className="ns-pv-code-block">
          <InlineList nodes={node.children} entries={entries} />
        </pre>
      );
    case "hr":
      return <div className="ns-pv-hr" />;
  }
}

// ── Public component ──────────────────────────────────────────────────────

interface NotePreviewProps {
  doc: NoteDoc;
  entries: ClipboardEntry[];
}

const NotePreview: React.FC<NotePreviewProps> = ({ doc, entries }) => (
  <div className="ns-pv">
    {doc.nodes.map((node, i) => (
      <BlockEl key={i} node={node} entries={entries} />
    ))}
  </div>
);

export default NotePreview;
