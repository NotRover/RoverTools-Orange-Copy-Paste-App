// ── Prose Engine — Serialization ──────────────────────────────────────────
// NoteDoc AST ↔ HTML (contenteditable) ↔ JSON (storage).
// parseNote() accepts JSON v2 only; non-JSON input returns an empty doc.

import type {
  NoteDoc, BlockNode, InlineNode, Alignment, ListItem,
  ClipEmbedNode, GroupRefNode, ImageNode, LinkNode,
} from "./types";
import { isParaBlock, isListBlock, MAX_INDENT } from "./types";

// ── Storage ───────────────────────────────────────────────────────────────

export function emptyDoc(): NoteDoc {
  return { v: 2, nodes: [{ type: "p", children: [] }] };
}

export function parseNote(raw: string): NoteDoc {
  if (!raw || !raw.trim()) return emptyDoc();
  try {
    const p = JSON.parse(raw);
    if (p?.v === 2 && Array.isArray(p.nodes)) {
      const nodes = p.nodes.map(normalizeBlock).filter(Boolean) as BlockNode[];
      return { v: 2, nodes: nodes.length ? nodes : [{ type: "p", children: [] }] };
    }
  } catch {}
  return emptyDoc();
}

function clampIndent(n: unknown): number {
  const v = typeof n === "number" ? n : 0;
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(MAX_INDENT, Math.floor(v));
}

function normalizeBlock(node: any): BlockNode | null {
  if (!node || typeof node !== "object") return null;
  if (node.type === "ul" || node.type === "ol") {
    const items = Array.isArray(node.items) ? node.items : [];
    const norm: ListItem[] = items.map((it: any) =>
      Array.isArray(it)
        ? { children: it as InlineNode[], level: 0 }
        : {
            children: Array.isArray(it?.children) ? (it.children as InlineNode[]) : [],
            level: clampIndent(it?.level),
          }
    );
    return { type: node.type, items: norm.length ? norm : [{ children: [], level: 0 }] };
  }
  if (node.type === "hr") return { type: "hr" };
  if (!isParaBlock(node)) return null;
  const out: any = { type: node.type, children: Array.isArray(node.children) ? node.children : [] };
  if (node.type === "todo") out.checked = !!node.checked;
  const anyNode = node as any;
  if (anyNode.align) out.align = anyNode.align;
  if (anyNode.indent) out.indent = clampIndent(anyNode.indent);
  return out as BlockNode;
}

export function docPlainText(doc: NoteDoc): string {
  const parts: string[] = [];
  for (const node of doc.nodes) {
    if (node.type === "hr") continue;
    if (isListBlock(node)) {
      for (const it of node.items) inlineText(it.children, parts);
    } else {
      inlineText(node.children, parts);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function inlineText(inlines: InlineNode[], parts: string[]): void {
  for (const n of inlines) {
    if (n.type === "text" && n.text) parts.push(n.text);
    else if (n.type === "link" && n.text) parts.push(n.text);
  }
}

// ── Inline DOM → AST ─────────────────────────────────────────────────────

interface Marks {
  bold?:      true;
  italic?:    true;
  underline?: true;
  strike?:    true;
  code?:      true;
}

function addMarksFromTag(tag: string, m: Marks): Marks {
  const out = { ...m };
  if (tag === "strong" || tag === "b")                   out.bold      = true;
  if (tag === "em"     || tag === "i")                   out.italic    = true;
  if (tag === "u")                                       out.underline = true;
  if (tag === "s" || tag === "strike" || tag === "del")  out.strike    = true;
  if (tag === "code"   || tag === "kbd")                 out.code      = true;
  return out;
}

export function parseInlines(
  el: Element | DocumentFragment | HTMLElement,
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

    if ((elem as HTMLElement).hasAttribute("data-todo-check")) continue;

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

    result.push(...parseInlines(elem, addMarksFromTag(tag, inherited)));
  }
  return result;
}

// ── Block DOM → AST ───────────────────────────────────────────────────────

export function parseBlockEl(el: HTMLElement, type: BlockNode["type"]): BlockNode {
  const align = (el.getAttribute("data-align") || undefined) as Alignment | undefined;
  const indent = clampIndent(parseInt(el.getAttribute("data-indent") ?? "0", 10));

  if (type === "ul" || type === "ol") {
    const items: ListItem[] = Array.from(el.querySelectorAll(":scope > li")).map(li => {
      const level = clampIndent(parseInt((li as HTMLElement).getAttribute("data-level") ?? "0", 10));
      return { children: parseInlines(li as HTMLElement), level };
    });
    return { type, items: items.length ? items : [{ children: [], level: 0 }] };
  }

  if (type === "hr") return { type: "hr" };

  if (type === "todo") {
    const checked = el.querySelector("[data-todo-check]")?.getAttribute("data-checked") === "true";
    const node: any = { type: "todo", children: parseInlines(el), checked };
    if (align) node.align = align;
    if (indent) node.indent = indent;
    return node as BlockNode;
  }

  if (type === "code") {
    return { type: "code", children: parseInlines(el) };
  }

  const node: any = { type, children: parseInlines(el) };
  if (align) node.align = align;
  if (indent) node.indent = indent;
  return node as BlockNode;
}

// ── AST → HTML (for contenteditable) ─────────────────────────────────────

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
  if (node.type === "ul" || node.type === "ol") {
    return node.items.map(it => {
      const lvl = clampIndent(it.level);
      const cls = `ns-be-li ns-be-li-l${lvl}`;
      return `<li class="${cls}" data-level="${lvl}">${inlinesToHtml(it.children)}</li>`;
    }).join("");
  }
  if (node.type === "hr") return "";
  if (node.type === "todo") {
    const chk = `<span data-todo-check="true" contenteditable="false" class="ns-be-todo-check" data-checked="${node.checked}" aria-label="${node.checked ? "Checked" : "Unchecked"}"></span>`;
    return chk + inlinesToHtml(node.children);
  }
  if (isParaBlock(node)) return inlinesToHtml(node.children) || "";
  return "";
}

// ── Helpers ───────────────────────────────────────────────────────────────

function parseDim(val: string | null): number | undefined {
  if (!val) return undefined;
  const n = parseFloat(val);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
