// ── Editor Engine — Markdown preview ──────────────────────────────────────
// Renders markdown to React via react-markdown. GFM gives us tables, task
// lists, strikethrough and autolinks. rehype-raw lets users embed inline HTML
// (the GitHub-readme experience), and rehype-sanitize keeps it safe by
// applying a strict allow-list. Clip / group embeds round-trip as <span> tags
// with data-* attributes — we resolve those at render time to chip nodes.

import React, { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { ClipboardEntry } from "../../../../types";
import {
  classifyFileEntry,
  filePaths,
  groupColor,
  truncateText,
} from "../../../../types";
import { fileName } from "../notes-utils";
import {
  resolveAttachmentUrl,
  subscribeAttachmentResolver,
} from "./attachment-url";
import "./markdown.css";

// ── Sanitize schema — GitHub-ish allow-list ──────────────────────────────

const schema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "details", "summary", "kbd", "sub", "sup", "mark",
    "video", "source", "u", "s", "del", "ins",
    "span", "div",
  ],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    "*": [
      ...((defaultSchema.attributes && defaultSchema.attributes["*"]) ?? []),
      "className", "style", "align",
      ["data*"],
    ],
    span: [
      ["data-clip-embed"],
      ["data-group-ref"],
      ["data-embed-mode"],
      ["data-embed-width"],
      ["data-embed-height"],
      "className", "style",
    ],
    img: [
      ...((defaultSchema.attributes && (defaultSchema.attributes as any).img) ?? []),
      "src", "alt", "title", "width", "height", "loading",
    ],
    a: [
      ...((defaultSchema.attributes && (defaultSchema.attributes as any).a) ?? []),
      "href", "title", "target", "rel",
    ],
  },
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    src:  ["http", "https", "data", "tauri-asset", "asset", "note-attachment", "note-file"],
    href: ["http", "https", "mailto", "tel", "#", "/", "note-attachment", "note-file"],
  },
};

// ── Embed chip ───────────────────────────────────────────────────────────

function clipLabel(id: string, entries: ClipboardEntry[]): string {
  const entry = entries.find((e) => e.id === id);
  if (!entry) return id ? "Missing clip" : "Clip";
  const paths = entry.type === "file" ? filePaths(entry.content) : [];
  const fileKind = entry.type === "file" ? classifyFileEntry(entry.content) : "file";
  if (entry.type === "image") return entry.label ?? "Image";
  if (entry.type === "file")
    return fileKind === "image" ? "Image file" : paths[0] ? fileName(paths[0]) : "File";
  const text = entry.type === "html" ? entry.content.replace(/<[^>]*>/g, "") : entry.content;
  return truncateText(text.replace(/\s+/g, " ").trim(), 28) || "Clip";
}

// ── Component ────────────────────────────────────────────────────────────

interface Props {
  markdown: string;
  entries: ClipboardEntry[];
  className?: string;
}

const MarkdownPreview: React.FC<Props> = ({ markdown, entries, className }) => {
  const [, setVersion] = useState(0);
  useEffect(
    () => subscribeAttachmentResolver(() => setVersion((v) => v + 1)),
    [],
  );
  const components = useMemo(() => ({
    // Map our embed spans to chip nodes.
    span: (props: React.HTMLAttributes<HTMLSpanElement> & {
      "data-clip-embed"?: string;
      "data-group-ref"?: string;
    }) => {
      const clipId = props["data-clip-embed"];
      if (clipId !== undefined) {
        const entry = entries.find((e) => e.id === clipId);
        const missing = !entry && !!clipId;
        return (
          <span className={`ee-clip-chip${missing ? " ee-clip-chip--missing" : ""}`}>
            {clipLabel(clipId, entries)}
          </span>
        );
      }
      const groupName = props["data-group-ref"];
      if (groupName !== undefined) {
        const c = groupColor(groupName);
        return (
          <span className="ee-group-chip" style={{ background: c.bg, color: c.fg }}>
            <span className="ee-group-chip-dot" style={{ background: c.fg }} />
            {groupName}
          </span>
        );
      }
      return <span {...props} />;
    },
    a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
      <a
        {...props}
        href={props.href ? resolveAttachmentUrl(props.href) : props.href}
        target="_blank"
        rel="noopener noreferrer"
      />
    ),
    img: (props: React.ImgHTMLAttributes<HTMLImageElement>) => (
      <img
        {...props}
        src={props.src ? resolveAttachmentUrl(props.src) : props.src}
      />
    ),
  }), [entries]);

  return (
    <div className={`ee-preview${className ? " " + className : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
        components={components as any}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
};

export default MarkdownPreview;
