// ── Attachment URL resolver ───────────────────────────────────────────────
// Notes save attachments to `app_data/note-attachments/{images,files}/` and
// reference them in markdown with the custom schemes `note-attachment://` (for
// images) and `note-file://` (for documents). The schemes keep the markdown
// source short and human-readable; this module resolves them to real
// `tauri-asset:` URLs for display, and reverses the mapping when serializing
// markdown back from the rich editor so the source stays clean.
//
// Anything outside these two schemes is left untouched, so users can still
// paste plain http/https URLs, absolute paths, or `data:` URIs by hand.

import { invoke, convertFileSrc } from "@tauri-apps/api/core";

const IMAGE_SCHEME = "note-attachment://";
const FILE_SCHEME = "note-file://";

interface Resolver {
  imagesDir: string;
  filesDir: string;
  imagesAssetPrefix: string;
  filesAssetPrefix: string;
}

let resolver: Resolver | null = null;
let initPromise: Promise<void> | null = null;

export function initAttachmentResolver(): Promise<void> {
  if (resolver) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = invoke<{ images: string; files: string }>(
    "get_note_attachments_dirs",
  )
    .then(({ images, files }) => {
      resolver = {
        imagesDir: images,
        filesDir: files,
        imagesAssetPrefix: assetDirPrefix(images),
        filesAssetPrefix: assetDirPrefix(files),
      };
    })
    .catch((err) => {
      console.error("[notes] failed to init attachment resolver", err);
      resolver = null;
      initPromise = null;
    });
  return initPromise;
}

/** Convert a single URL from custom-scheme form to a displayable asset URL. */
export function resolveAttachmentUrl(url: string): string {
  if (!resolver) return url;
  if (url.startsWith(IMAGE_SCHEME)) {
    return convertFileSrc(joinPath(resolver.imagesDir, decodeName(url, IMAGE_SCHEME)));
  }
  if (url.startsWith(FILE_SCHEME)) {
    return convertFileSrc(joinPath(resolver.filesDir, decodeName(url, FILE_SCHEME)));
  }
  return url;
}

/** Reverse: collapse a resolved asset URL back to the custom scheme. */
export function unresolveAttachmentUrl(url: string): string {
  if (!resolver) return url;
  if (url.startsWith(resolver.imagesAssetPrefix)) {
    return IMAGE_SCHEME + decodeURIComponent(url.slice(resolver.imagesAssetPrefix.length));
  }
  if (url.startsWith(resolver.filesAssetPrefix)) {
    return FILE_SCHEME + decodeURIComponent(url.slice(resolver.filesAssetPrefix.length));
  }
  return url;
}

/** Build a `note-attachment://<filename>` URL for an image filename. */
export function imageAttachmentUrl(filename: string): string {
  return IMAGE_SCHEME + filename;
}

/** Build a `note-file://<filename>` URL for a document filename. */
export function fileAttachmentUrl(filename: string): string {
  return FILE_SCHEME + filename;
}

/**
 * Rewrite all attachment URLs inside a markdown string to their resolved /
 * unresolved form. We target `(url)` in `![alt](url)` / `[text](url)` and
 * `src="..."` / `href="..."` inside inline HTML — the only places the schemes
 * legitimately appear in note markdown.
 */
export function resolveMarkdown(md: string): string {
  return rewriteMarkdown(md, resolveAttachmentUrl);
}

export function unresolveMarkdown(md: string): string {
  return rewriteMarkdown(md, unresolveAttachmentUrl);
}

function rewriteMarkdown(md: string, fn: (url: string) => string): string {
  if (!md) return md;
  // Markdown link/image targets: ](url) or ](url "title")
  let out = md.replace(/\]\(([^)\s]+)([^)]*)\)/g, (_, url: string, rest: string) => {
    return `](${fn(url)}${rest})`;
  });
  // Inline HTML attrs
  out = out.replace(/(\s(?:src|href)=)"([^"]+)"/gi, (_, head: string, url: string) => {
    return `${head}"${fn(url)}"`;
  });
  out = out.replace(/(\s(?:src|href)=)'([^']+)'/gi, (_, head: string, url: string) => {
    return `${head}'${fn(url)}'`;
  });
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  if (dir.endsWith("/") || dir.endsWith("\\")) return dir + name;
  return dir + sep + name;
}

function decodeName(url: string, scheme: string): string {
  return decodeURIComponent(url.slice(scheme.length));
}

/**
 * `convertFileSrc` URL-encodes the absolute path. To detect URLs that point
 * inside our attachment dirs, we precompute the encoded prefix (with a
 * trailing separator) so prefix matching is straightforward.
 */
function assetDirPrefix(dir: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const withSep = dir.endsWith(sep) ? dir : dir + sep;
  return convertFileSrc(withSep);
}
