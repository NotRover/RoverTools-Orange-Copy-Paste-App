// ── Utility functions for notes processing and formatting ──────────────────

import { truncateText } from "../../../types";
import { extractPlainText, hasRenderableContent } from "./editor-engine";

/** Plain text of an HTML clipboard entry. Parsed into a detached document:
 *  setting innerHTML on an element of the live document starts image loads
 *  and runs their inline handlers, and the HTML here is whatever page the
 *  user happened to copy from. */
export function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.textContent ?? "";
}

export function deriveNoteTitle(rawTitle: string, rawContent: string): string {
  const fromTitle = rawTitle.trim();
  if (fromTitle) return fromTitle;

  const fromContent = extractPlainText(rawContent ?? "");
  if (fromContent) return truncateText(fromContent, 54);

  return "New note";
}

/** Anything worth keeping: text, or an image, table, rule or embed. */
export function hasMeaningfulContent(rawContent: string): boolean {
  return hasRenderableContent(rawContent ?? "");
}

export function isNoteExpandable(note: { content: string }): boolean {
  return extractPlainText(note.content ?? "").length > 180;
}
