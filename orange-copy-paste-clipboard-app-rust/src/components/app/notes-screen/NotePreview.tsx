// ── Note preview ──────────────────────────────────────────────────────────
// Thin wrapper around the editor engine's preview, used inside note cards.

import React from "react";
import type { ClipboardEntry } from "../../../types";
import { NotionPreview } from "./editor-engine";

interface NotePreviewProps {
  /** Stored note content — Tiptap JSON or legacy markdown. */
  content: string;
  entries: ClipboardEntry[];
}

const NotePreview: React.FC<NotePreviewProps> = ({ content, entries }) => (
  <NotionPreview content={content} entries={entries} className="ns-card-preview-md" />
);

export default NotePreview;
