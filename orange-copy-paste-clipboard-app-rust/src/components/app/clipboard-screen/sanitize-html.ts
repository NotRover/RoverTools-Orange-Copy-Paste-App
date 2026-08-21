/**
 * Allow-list sanitiser for rich-text clipboard content.
 *
 * Clipboard HTML comes from whatever app the user copied from, so it is
 * untrusted: everything outside the allow-list below is stripped, including
 * every script vector and every `javascript:` URI. Local image paths are
 * rewritten to Tauri asset URLs so a fragment copied from a document still
 * shows its pictures.
 *
 * Shared by the card preview and the full viewer, which must agree - a tag the
 * preview strips and the viewer renders would be a hole opened by the click
 * that opens the viewer.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

// Allow-list based HTML sanitiser for safe rendering of rich-text clipboard
// content.  Strips all tags/attributes except a safe subset.
const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "b",
  "i",
  "u",
  "em",
  "strong",
  "s",
  "sub",
  "sup",
  "span",
  "div",
  "a",
  "img",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "pre",
  "code",
  "hr",
]);
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
  span: new Set(["style"]),
  div: new Set(["style"]),
  p: new Set(["style"]),
};
// Only allow safe CSS properties in inline styles
const SAFE_STYLE_PROPS = new Set([
  "color",
  "background-color",
  "background",
  "font-weight",
  "font-style",
  "font-size",
  "text-decoration",
  "text-align",
  "margin",
  "padding",
  "border",
  "display",
]);

function sanitizeStyle(style: string): string {
  return style
    .split(";")
    .map((decl) => decl.trim())
    .filter((decl) => {
      const prop = decl.split(":")[0]?.trim().toLowerCase() ?? "";
      return SAFE_STYLE_PROPS.has(prop);
    })
    .join("; ");
}

function normalizeImageSrc(src: string): string | null {
  const value = src.trim();
  if (!value) return null;

  // Safe URI schemes that the webview can render directly.
  if (/^(https?:|data:|blob:|asset:)/i.test(value)) {
    return value;
  }

  // Convert file:// URLs (common in clipboard HTML fragments) to Tauri asset URLs.
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol.toLowerCase() !== "file:") return null;
      const pathname = decodeURIComponent(url.pathname || "");
      if (!pathname) return null;
      const windowsPath = /^[A-Za-z]:/.test(pathname.slice(1))
        ? pathname.slice(1)
        : pathname;
      const normalizedPath = windowsPath.replace(/\//g, "\\");
      return convertFileSrc(normalizedPath);
    } catch {
      return null;
    }
  }

  // Absolute Windows paths pasted directly into src.
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return convertFileSrc(value.replace(/\//g, "\\"));
  }

  return null;
}

export function sanitizeHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  function walk(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      // Escape text content
      const text = node.textContent ?? "";
      return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    // Recurse into children
    let inner = "";
    for (const child of Array.from(el.childNodes)) {
      inner += walk(child);
    }

    if (!ALLOWED_TAGS.has(tag)) return inner; // strip tag but keep children

    // Build allowed attributes
    const allowedSet = ALLOWED_ATTRS[tag];
    let attrs = "";
    if (allowedSet) {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (!allowedSet.has(name)) continue;
        let value = attr.value;
        // Prevent javascript: URIs
        if (
          (name === "href" || name === "src") &&
          /^\s*javascript:/i.test(value)
        )
          continue;
        // img src: normalize local file paths and keep only renderable schemes
        if (tag === "img" && name === "src") {
          const normalized = normalizeImageSrc(value);
          if (!normalized) continue;
          value = normalized;
        } else if (
          name === "src" &&
          !/^(https?:|data:|blob:|asset:)/i.test(value)
        ) {
          continue;
        }
        if (name === "style") value = sanitizeStyle(value);
        attrs += ` ${name}="${value.replace(/"/g, "&quot;")}"`;
      }
    }

    // Self-closing tags
    if (tag === "br" || tag === "hr" || tag === "img") {
      return `<${tag}${attrs} />`;
    }

    return `<${tag}${attrs}>${inner}</${tag}>`;
  }

  let result = "";
  for (const child of Array.from(doc.body.childNodes)) {
    result += walk(child);
  }
  return result;
}
