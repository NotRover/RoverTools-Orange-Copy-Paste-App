// ── Utility functions for notes processing and formatting ──────────────────

import { truncateText } from "../../../types";
import { markdownToPlainText } from "./editor-engine";

export function stripHtml(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent ?? tmp.innerText ?? "";
}

/** Extract plain text from raw note content (markdown OR legacy NoteDoc JSON). */
export function contentPlainText(raw: string): string {
  return markdownToPlainText(raw ?? "");
}

export function deriveNoteTitle(rawTitle: string, rawContent: string): string {
  const fromTitle = rawTitle.trim();
  if (fromTitle) return fromTitle;

  const fromContent = contentPlainText(rawContent);
  if (fromContent) return truncateText(fromContent, 54);

  return "New note";
}

export function hasMeaningfulContent(rawContent: string): boolean {
  return contentPlainText(rawContent).length > 0;
}

export function isNoteExpandable(note: { content: string }): boolean {
  return contentPlainText(note.content).length > 180;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
