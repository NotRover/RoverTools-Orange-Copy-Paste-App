// ── Attachment URL resolver ───────────────────────────────────────────────
// Notes save attachments to `app_data/note-attachments/{images,files}/` and
// reference them in stored content with the custom schemes
// `note-attachment://` (images) and `note-file://` (documents). The schemes
// keep the persisted JSON short and human-readable; this module resolves
// them to real `tauri-asset:` URLs at DOM render time only.
//
// Anything outside these two schemes is left untouched, so users can still
// paste plain http/https URLs, absolute paths, or `data:` URIs by hand.

import { invoke, convertFileSrc } from "@tauri-apps/api/core";

const IMAGE_SCHEME = "note-attachment://";
const FILE_SCHEME = "note-file://";

interface Resolver {
  imagesDir: string;
  filesDir: string;
}

let resolver: Resolver | null = null;
let initPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function subscribeAttachmentResolver(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initAttachmentResolver(): Promise<void> {
  if (resolver) return Promise.resolve();
  if (initPromise) return initPromise;
  initPromise = invoke<{ images: string; files: string }>(
    "get_note_attachments_dirs",
  )
    .then(({ images, files }) => {
      resolver = { imagesDir: images, filesDir: files };
      listeners.forEach((fn) => {
        try { fn(); } catch (e) { console.error(e); }
      });
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

/** Split an attachment URL into its store and filename; null for any other URL. */
export function attachmentFilename(
  url: string,
): { sub: "images" | "files"; filename: string } | null {
  if (url.startsWith(IMAGE_SCHEME)) {
    return { sub: "images", filename: decodeName(url, IMAGE_SCHEME) };
  }
  if (url.startsWith(FILE_SCHEME)) {
    return { sub: "files", filename: decodeName(url, FILE_SCHEME) };
  }
  return null;
}

/** True for a `note-file://` URL, the scheme documents attach under. */
export function isFileAttachmentUrl(url: string): boolean {
  return url.startsWith(FILE_SCHEME);
}

/** Build a `note-attachment://<filename>` URL for an image filename. */
export function imageAttachmentUrl(filename: string): string {
  return IMAGE_SCHEME + filename;
}

/** Build a `note-file://<filename>` URL for a document filename. */
export function fileAttachmentUrl(filename: string): string {
  return FILE_SCHEME + filename;
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
