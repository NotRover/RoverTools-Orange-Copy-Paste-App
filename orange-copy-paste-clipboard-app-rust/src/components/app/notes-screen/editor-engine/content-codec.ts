// ── Editor Engine — Content codec ─────────────────────────────────────────
// `note.content` is a string holding a serialised Tiptap ProseMirror document.

import type { JSONContent } from "@tiptap/react";

const EMPTY_DOC: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

/** Parse a stored note string into a Tiptap doc. Returns an empty doc on failure. */
export function parseStoredContent(raw: string): JSONContent {
  const text = (raw ?? "").trim();
  if (!text) return emptyDoc();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.type === "doc") {
      return parsed as JSONContent;
    }
  } catch {
    // fall through
  }
  return emptyDoc();
}

/** Serialize a Tiptap JSON doc as a stable string for persistence. */
export function serializeDoc(doc: JSONContent): string {
  return JSON.stringify(doc);
}

/** Empty Tiptap document literal. */
function emptyDoc(): JSONContent {
  return JSON.parse(JSON.stringify(EMPTY_DOC));
}

// ── Plain-text projection ────────────────────────────────────────────────

/** Extract plain text from a stored note string. Used for titles and search. */
export function extractPlainText(raw: string): string {
  if (!raw) return "";
  const doc = parseStoredContent(raw);
  const out: string[] = [];
  walk(doc, out);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function walk(node: JSONContent | undefined, out: string[]): void {
  if (!node) return;
  if (typeof (node as any).text === "string") {
    out.push((node as any).text);
  }
  if (node.type === "clipEmbed") {
    const id = (node.attrs?.id as string) ?? "";
    if (id) out.push(`[clip:${id}]`);
  } else if (node.type === "groupRef") {
    const name = (node.attrs?.name as string) ?? "";
    if (name) out.push(`[group:${name}]`);
  }
  const children = (node as any).content as JSONContent[] | undefined;
  if (Array.isArray(children)) for (const c of children) walk(c, out);
}

// ── Markdown export ──────────────────────────────────────────────────────

/** Convert a stored note string to Markdown text for export. */
export function noteToMarkdown(raw: string): string {
  const doc = parseStoredContent(raw);
  const lines: string[] = [];
  mdNodes(doc.content, lines, "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function mdNodes(
  nodes: JSONContent[] | undefined,
  out: string[],
  indent: string,
): void {
  if (!nodes) return;
  for (const n of nodes) mdNode(n, out, indent);
}

function mdNode(node: JSONContent, out: string[], indent: string): void {
  switch (node.type) {
    case "paragraph": {
      const t = mdInline(node.content);
      out.push(indent + (t || ""));
      out.push("");
      break;
    }
    case "heading": {
      const lvl = Math.min(Math.max((node.attrs?.level as number) ?? 1, 1), 6);
      out.push(indent + "#".repeat(lvl) + " " + mdInline(node.content));
      out.push("");
      break;
    }
    case "blockquote": {
      const inner: string[] = [];
      mdNodes(node.content, inner, "");
      for (const l of inner) out.push("> " + l);
      out.push("");
      break;
    }
    case "callout": {
      const tone = (node.attrs?.tone as string) ?? "info";
      out.push(`> [!${tone.toUpperCase()}]`);
      const inner: string[] = [];
      mdNodes(node.content, inner, "");
      for (const l of inner) out.push("> " + l);
      out.push("");
      break;
    }
    case "bulletList": {
      for (const item of node.content ?? []) mdListItem(item, out, indent, "-");
      out.push("");
      break;
    }
    case "orderedList": {
      let i = 1;
      for (const item of node.content ?? [])
        mdListItem(item, out, indent, `${i++}.`);
      out.push("");
      break;
    }
    case "taskList": {
      for (const item of node.content ?? []) {
        const checked = !!item.attrs?.checked;
        mdListItem(item, out, indent, checked ? "- [x]" : "- [ ]");
      }
      out.push("");
      break;
    }
    case "codeBlock": {
      const lang = (node.attrs?.language as string) ?? "";
      const code = mdPlainText(node.content);
      out.push("```" + lang);
      out.push(code);
      out.push("```");
      out.push("");
      break;
    }
    case "horizontalRule":
      out.push("---");
      out.push("");
      break;
    case "image": {
      const src = (node.attrs?.src as string) ?? "";
      const alt = (node.attrs?.alt as string) ?? "";
      out.push(`![${alt}](${src})`);
      out.push("");
      break;
    }
    case "table":
      mdTable(node, out);
      out.push("");
      break;
    case "details":
      mdNodes(node.content, out, indent);
      break;
    case "detailsSummary":
      out.push("▸ " + mdInline(node.content));
      break;
    case "detailsContent": {
      const inner: string[] = [];
      mdNodes(node.content, inner, "  ");
      out.push(...inner);
      break;
    }
    case "clipEmbed": {
      const id = (node.attrs?.id as string) ?? "";
      out.push(`[📎 Clip: ${id}]`);
      out.push("");
      break;
    }
    case "groupRef": {
      const name = (node.attrs?.name as string) ?? "";
      out.push(`[🏷 Group: ${name}]`);
      break;
    }
    default:
      mdNodes(node.content, out, indent);
      break;
  }
}

function mdListItem(
  node: JSONContent,
  out: string[],
  indent: string,
  bullet: string,
): void {
  const inner: string[] = [];
  mdNodes(node.content, inner, "  ");
  if (inner.length === 0) {
    out.push(`${indent}${bullet} `);
    return;
  }
  out.push(`${indent}${bullet} ${inner[0].trim()}`);
  for (let i = 1; i < inner.length; i++) {
    if (inner[i] !== "") out.push(`  ${inner[i]}`);
  }
}

function mdInline(nodes: JSONContent[] | undefined): string {
  if (!nodes) return "";
  return nodes.map(mdInlineNode).join("");
}

function mdInlineNode(node: JSONContent): string {
  if (node.type === "hardBreak") return "  \n";
  if (node.type === "clipEmbed")
    return `[📎 ${(node.attrs?.id as string) ?? "clip"}]`;
  if (node.type === "groupRef")
    return `[🏷 ${(node.attrs?.name as string) ?? ""}]`;
  if (node.type !== "text") return mdInline(node.content);

  let text = ((node as any).text as string) ?? "";
  const marks = ((node as any).marks ?? []) as { type: string; attrs?: any }[];
  for (const m of marks) {
    switch (m.type) {
      case "bold":
        text = `**${text}**`;
        break;
      case "italic":
        text = `_${text}_`;
        break;
      case "strike":
        text = `~~${text}~~`;
        break;
      case "code":
        text = `\`${text}\``;
        break;
      case "link":
        text = `[${text}](${m.attrs?.href ?? ""})`;
        break;
      case "underline":
        text = `<u>${text}</u>`;
        break;
    }
  }
  return text;
}

function mdTable(node: JSONContent, out: string[]): void {
  const rows = node.content ?? [];
  if (rows.length === 0) return;
  const renderRow = (row: JSONContent) => {
    const cells = (row.content ?? []).map((cell) => {
      const inner: string[] = [];
      mdNodes(cell.content, inner, "");
      return inner.join(" ").trim().replace(/\|/g, "\\|");
    });
    return "| " + cells.join(" | ") + " |";
  };
  out.push(renderRow(rows[0]));
  const colCount = (rows[0].content ?? []).length;
  out.push("| " + Array(colCount).fill("---").join(" | ") + " |");
  for (const row of rows.slice(1)) out.push(renderRow(row));
}

function mdPlainText(nodes: JSONContent[] | undefined): string {
  if (!nodes) return "";
  let out = "";
  for (const n of nodes) {
    if (typeof (n as any).text === "string") out += (n as any).text;
    else if (n.content) out += mdPlainText(n.content);
  }
  return out;
}
