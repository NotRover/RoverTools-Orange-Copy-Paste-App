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
export function emptyDoc(): JSONContent {
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
