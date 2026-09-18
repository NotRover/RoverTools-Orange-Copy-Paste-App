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
      return migrate(parsed as JSONContent);
    }
  } catch {
    // fall through
  }
  return emptyDoc();
}

// Images used to be block nodes. They are inline now, so an image sitting
// directly in a block container is wrapped in a paragraph. Idempotent, and
// cheap enough to run on every parse.
const INLINE_PARENTS = new Set(["paragraph", "heading"]);
const LIST_ITEMS = new Set(["listItem", "taskItem"]);
// Inline atoms that may only live inside a textblock; a stored doc that has
// one directly under a block container gets it wrapped in a paragraph.
const INLINE_ATOMS = new Set(["image", "clipCard", "groupCard", "fileCard"]);
const FILE_SCHEME = "note-file://";

// Normalise a stored doc into what the current schema expects, in one pass.
// Cards and images are inline, so:
//   - a card or image sitting at block level (older notes, or the JSON a
//     block-era build wrote) is wrapped in a paragraph;
//   - inside a textblock, an older `expanded` chip becomes the matching inline
//     card, a `note-file://` link becomes an inline file card, and any leftover
//     `expanded` attr is dropped.
// Idempotent: a current doc comes back unchanged in shape.
function migrate(node: JSONContent): JSONContent {
  if (!Array.isArray(node.content)) return node;
  if (INLINE_PARENTS.has(node.type ?? "")) {
    return { ...node, content: node.content.map(inlineNode) };
  }
  const out: JSONContent[] = [];
  for (const child of node.content) {
    if (INLINE_ATOMS.has(child.type ?? "")) {
      out.push({ type: "paragraph", content: [inlineNode(child)] });
    } else {
      out.push(migrate(child));
    }
  }
  if (LIST_ITEMS.has(node.type ?? "") && out[0]?.type !== "paragraph") {
    out.unshift({ type: "paragraph" });
  }
  return { ...node, content: out };
}

// Transform one inline child: lift an older reference to its card form, drop a
// stray `expanded` attr, leave everything else alone.
function inlineNode(inline: JSONContent): JSONContent {
  if (inline.type === "clipEmbed" && inline.attrs?.expanded === true) {
    return { type: "clipCard", attrs: { id: inline.attrs.id ?? "" } };
  }
  if (inline.type === "groupRef" && inline.attrs?.expanded === true) {
    return { type: "groupCard", attrs: { name: inline.attrs.name ?? "" } };
  }
  if (inline.type === "clipEmbed" || inline.type === "groupRef") {
    if (inline.attrs && "expanded" in inline.attrs) {
      const { expanded: _drop, ...attrs } = inline.attrs;
      return { ...inline, attrs };
    }
    return inline;
  }
  if (inline.type === "text") {
    const href = (inline.marks ?? []).find((m) => m.type === "link")?.attrs?.href;
    if (typeof href === "string" && href.startsWith(FILE_SCHEME)) {
      const text = ((inline as { text?: string }).text ?? "").trim();
      return {
        type: "fileCard",
        attrs: { href, name: text || href.slice(FILE_SCHEME.length), size: null },
      };
    }
  }
  return inline;
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

/** True when the note holds anything a reader would miss: text, an embed, an
 *  image, a table or a rule. Decides whether closing an untitled note deletes
 *  it. A text-only check threw away notes that were nothing but a pasted
 *  screenshot. */
export function hasRenderableContent(raw: string): boolean {
  if (!raw) return false;
  return nodeHasContent(parseStoredContent(raw));
}

const CONTENT_NODES = new Set([
  "image",
  "table",
  "horizontalRule",
  "clipEmbed",
  "groupRef",
  "clipCard",
  "groupCard",
  "fileCard",
]);

function nodeHasContent(node: JSONContent | undefined): boolean {
  if (!node) return false;
  const text = (node as any).text;
  if (typeof text === "string" && text.trim()) return true;
  if (node.type && CONTENT_NODES.has(node.type)) return true;
  return (node.content ?? []).some(nodeHasContent);
}

function walk(node: JSONContent | undefined, out: string[]): void {
  if (!node) return;
  if (typeof (node as any).text === "string") {
    out.push((node as any).text);
  }
  if (node.type === "clipEmbed" || node.type === "clipCard") {
    const id = (node.attrs?.id as string) ?? "";
    if (id) out.push(`[clip:${id}]`);
  } else if (node.type === "groupRef" || node.type === "groupCard") {
    const name = (node.attrs?.name as string) ?? "";
    if (name) out.push(`[group:${name}]`);
  } else if (node.type === "fileCard") {
    const name = (node.attrs?.name as string) ?? "";
    if (name) out.push(name);
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
    case "clipEmbed":
    case "clipCard": {
      const id = (node.attrs?.id as string) ?? "";
      out.push(`[clip: ${id}]`);
      out.push("");
      break;
    }
    case "groupRef":
    case "groupCard": {
      const name = (node.attrs?.name as string) ?? "";
      out.push(`[group: ${name}]`);
      out.push("");
      break;
    }
    case "fileCard": {
      const name = (node.attrs?.name as string) ?? "";
      const href = (node.attrs?.href as string) ?? "";
      out.push(`[${name}](${href})`);
      out.push("");
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
    return `[clip: ${(node.attrs?.id as string) ?? ""}]`;
  if (node.type === "groupRef")
    return `[group: ${(node.attrs?.name as string) ?? ""}]`;
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
