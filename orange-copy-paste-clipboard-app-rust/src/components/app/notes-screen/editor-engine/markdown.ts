// ── Editor Engine — Markdown utilities ────────────────────────────────────
// `note.content` is plain markdown. These helpers provide a plain-text
// projection for titles / search and a tiny constructor for empty notes.

import type { NoteContent } from "./types";

export function emptyContent(): NoteContent {
  return { v: 3, markdown: "" };
}

/** Read raw note content into a markdown string. */
export function parseNoteContent(raw: string): string {
  return raw ?? "";
}

/** Strip markdown to plain text for titles, search, previews. */
export function markdownToPlainText(md: string): string {
  if (!md) return "";
  let s = md;
  s = s.replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").replace(/```/g, ""));
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/^\s{0,3}(#{1,6})\s+/gm, "");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, "");
  s = s.replace(/^\s*\d+\.\s+/gm, "");
  s = s.replace(/^\s*([-*_])\s*\1\s*\1[\s\S]*$/gm, "");
  s = s.replace(/(\*\*|__)(.*?)\1/g, "$2");
  s = s.replace(/(\*|_)(.*?)\1/g, "$2");
  s = s.replace(/~~(.*?)~~/g, "$1");
  return s.replace(/\s+/g, " ").trim();
}

