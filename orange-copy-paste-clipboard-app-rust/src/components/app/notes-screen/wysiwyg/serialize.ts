// ── WYSIWYG Engine — Serialization ───────────────────────────────────────
// Converts between NoteDoc AST ↔ HTML (for contenteditable) ↔ JSON (for storage).
// parseNote() is the single entry point for loading stored content —
// it transparently handles both new JSON and legacy raw HTML.

import type {
  NoteDoc, BlockNode, InlineNode,
  ClipEmbedNode, GroupRefNode, ImageNode, LinkNode,
} from "./types";
import { isParaBlock, isListBlock } from "./types";

// ── Storage parse ─────────────────────────────────────────────────────────

export function emptyDoc(): NoteDoc {
  return { v: 2, nodes: [{ type: "p", children: [] }] };
}

export function parseNote(raw: string): NoteDoc {
  if (!raw || !raw.trim()) return emptyDoc();
  try {
    const p = JSON.parse(raw);
    if (p?.v === 2 && Array.isArray(p.nodes)) return p as NoteDoc;
  } catch {}
  return htmlToDoc(raw); // legacy HTML migration
}

export function docPlainText(doc: NoteDoc): string {
  const parts: string[] = [];
  for (const node of doc.nodes) {
    if (node.type === "hr") continue;
    const inlines: InlineNode[] = isListBlock(node)
      ? node.items.flat()
      : node.children;
    for (const n of inlines) {
      if (n.type === "text" && n.text) parts.push(n.text);
      else if (n.type === "link" && n.text) parts.push(n.text);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ── HTML → AST (migration + read-back from contenteditable) ──────────────

export function htmlToDoc(html: string): NoteDoc {
  if (!html || !html.trim()) return emptyDoc();
  const tmpl = document.createElement("template");
  tmpl.innerHTML = html;
  const nodes = parseBlocks(tmpl.content);
  return { v: 2, nodes: nodes.length ? nodes : [{ type: "p", children: [] }] };
}

interface Marks {
  bold?:      true;
  italic?:    true;
  underline?: true;
  strike?:    true;
  code?:      true;
}

function addMarksFromTag(tag: string, m: Marks): Marks {
  const out = { ...m };
  if (tag === "strong" || tag === "b") out.bold = true;
  if (tag === "em"     || tag === "i") out.italic = true;
  if (tag === "u")                     out.underline = true;
  if (tag === "s" || tag === "strike" || tag === "del") out.strike = true;
  if (tag === "code"   || tag === "kbd") out.code = true;
  return out;
}

const BLOCK_TAGS = new Set([
  "div","p","h1","h2","ul","ol","blockquote","hr","section","article","main","li",
]);

export function parseInlines(
  el: Element | DocumentFragment,
  inherited: Marks = {},
): InlineNode[] {
  const result: InlineNode[] = [];
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (text) result.push({ type: "text", text, ...inherited });
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const elem = node as Element;
    const tag  = elem.tagName.toLowerCase();

    // Embed nodes — recognised by data attribute, not by class
    if (elem.hasAttribute("data-clip-embed")) {
      const id = elem.getAttribute("data-clip-embed") ?? "";
      if (!id) continue;
      const mode   = (elem.getAttribute("data-embed-mode") ?? "inline") as "inline" | "block";
      const width  = parseDim(elem.getAttribute("data-embed-width"));
      const height = parseDim(elem.getAttribute("data-embed-height"));
      const n: ClipEmbedNode = { type: "clip_embed", id, mode };
      if (width)  n.width  = width;
      if (height) n.height = height;
      result.push(n);
      continue;
    }

    if (elem.hasAttribute("data-group-ref")) {
      const name = elem.getAttribute("data-group-ref") ?? "";
      if (!name) continue;
      const width  = parseDim(elem.getAttribute("data-embed-width"));
      const height = parseDim(elem.getAttribute("data-embed-height"));
      const n: GroupRefNode = { type: "group_ref", name };
      if (width)  n.width  = width;
      if (height) n.height = height;
      result.push(n);
      continue;
    }

    if (tag === "img") {
      const src = elem.getAttribute("src") ?? "";
      if (src) {
        const n: ImageNode = { type: "image", src };
        const alt = elem.getAttribute("alt");
        if (alt) n.alt = alt;
        result.push(n);
      }
      continue;
    }

    if (tag === "br") continue;

    if (tag === "a") {
      const href = elem.getAttribute("href") ?? "";
      const text = elem.textContent ?? "";
      if (href) result.push({ type: "link", href, text } as LinkNode);
      else if (text) result.push({ type: "text", text, ...inherited });
      continue;
    }

    const marks = addMarksFromTag(tag, inherited);
    // Flatten block tags appearing inside inline context
    result.push(...parseInlines(elem, marks));
  }
  return result;
}

function parseBlocks(el: Element | DocumentFragment): BlockNode[] {
  const result: BlockNode[] = [];
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) result.push({ type: "p", children: [{ type: "text", text }] });
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const elem = node as Element;
    const tag  = elem.tagName.toLowerCase();

    if (tag === "h1") {
      result.push({ type: "h1", children: parseInlines(elem) });
    } else if (tag === "h2") {
      result.push({ type: "h2", children: parseInlines(elem) });
    } else if (tag === "ul") {
      const items = Array.from(elem.querySelectorAll(":scope > li")).map(li => parseInlines(li));
      if (items.length) result.push({ type: "ul", items });
    } else if (tag === "ol") {
      const items = Array.from(elem.querySelectorAll(":scope > li")).map(li => parseInlines(li));
      if (items.length) result.push({ type: "ol", items });
    } else if (tag === "blockquote") {
      result.push({ type: "bq", children: parseInlines(elem) });
    } else if (tag === "hr") {
      result.push({ type: "hr" });
    } else if (
      tag === "div" || tag === "p" || tag === "span" ||
      tag === "section" || tag === "article"
    ) {
      const hasBlockChild = Array.from(elem.children).some(c =>
        BLOCK_TAGS.has(c.tagName.toLowerCase())
      );
      if (hasBlockChild) {
        result.push(...parseBlocks(elem));
      } else {
        const inner = elem.innerHTML.trim();
        if (!inner || inner === "<br>") {
          result.push({ type: "p", children: [] });
        } else {
          result.push({ type: "p", children: parseInlines(elem) });
        }
      }
    }
  }
  return result;
}

// ── Serialize a live block element back to AST ────────────────────────────

export function parseBlockEl(el: HTMLElement, type: BlockNode["type"]): BlockNode {
  if (type === "ul" || type === "ol") {
    const listEl = el.querySelector(":scope > ul, :scope > ol") ?? el;
    const items = Array.from(listEl.querySelectorAll(":scope > li")).map(li =>
      parseInlines(li as HTMLElement)
    );
    return { type, items: items.length ? items : [[]] };
  }
  if (type === "hr") return { type: "hr" };
  return { type, children: parseInlines(el) } as BlockNode;
}

// ── AST → HTML (for loading into contenteditable) ─────────────────────────

export function docToHtml(doc: NoteDoc): string {
  return doc.nodes.map(blockToHtml).join("");
}

export function inlinesToHtml(nodes: InlineNode[]): string {
  return nodes.map(n => {
    switch (n.type) {
      case "text": {
        let s = esc(n.text);
        if (n.code)      s = `<code>${s}</code>`;
        if (n.bold)      s = `<strong>${s}</strong>`;
        if (n.italic)    s = `<em>${s}</em>`;
        if (n.underline) s = `<u>${s}</u>`;
        if (n.strike)    s = `<s>${s}</s>`;
        return s;
      }
      case "clip_embed": {
        const mode  = n.mode ?? "inline";
        const wAttr = n.width  ? ` data-embed-width="${n.width}"`   : "";
        const hAttr = n.height ? ` data-embed-height="${n.height}"` : "";
        return `<span data-clip-embed="${esc(n.id)}" data-embed-mode="${mode}"${wAttr}${hAttr} contenteditable="false"></span>`;
      }
      case "group_ref": {
        const wAttr = n.width  ? ` data-embed-width="${n.width}"`   : "";
        const hAttr = n.height ? ` data-embed-height="${n.height}"` : "";
        return `<span data-group-ref="${esc(n.name)}"${wAttr}${hAttr} contenteditable="false"></span>`;
      }
      case "link":
        return `<a href="${esc(n.href)}" target="_blank" rel="noopener noreferrer">${esc(n.text)}</a>`;
      case "image":
        return `<img src="${esc(n.src)}"${n.alt ? ` alt="${esc(n.alt)}"` : ""} style="max-width:100%;border-radius:6px;display:block;margin:6px 0;" />`;
    }
  }).join("");
}

export function getBlockHtml(node: BlockNode): string {
  if (node.type === "ul") return `<ul>${node.items.map(i => `<li>${inlinesToHtml(i)}</li>`).join("")}</ul>`;
  if (node.type === "ol") return `<ol>${node.items.map(i => `<li>${inlinesToHtml(i)}</li>`).join("")}</ol>`;
  if (isParaBlock(node)) return inlinesToHtml(node.children) || "";
  return "";
}

function blockToHtml(node: BlockNode): string {
  switch (node.type) {
    case "p":  return node.children.length === 0 ? "<div><br></div>" : `<div>${inlinesToHtml(node.children)}</div>`;
    case "h1": return `<h1>${inlinesToHtml(node.children)}</h1>`;
    case "h2": return `<h2>${inlinesToHtml(node.children)}</h2>`;
    case "ul": return `<ul>${node.items.map(i => `<li>${inlinesToHtml(i)}</li>`).join("")}</ul>`;
    case "ol": return `<ol>${node.items.map(i => `<li>${inlinesToHtml(i)}</li>`).join("")}</ol>`;
    case "bq": return `<blockquote>${inlinesToHtml(node.children)}</blockquote>`;
    case "hr": return "<hr>";
  }
}

function parseDim(val: string | null): number | undefined {
  if (!val) return undefined;
  const n = parseFloat(val);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function esc(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// Legacy export aliases kept for note-doc.ts shim
export { htmlToDoc as _htmlToDoc };
