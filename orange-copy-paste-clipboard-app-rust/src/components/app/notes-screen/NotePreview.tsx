// ── Note preview ──────────────────────────────────────────────────────────
// Thin wrapper around the markdown engine's preview, used inside note cards.

import React from "react";
import type { ClipboardEntry } from "../../../types";
import { MarkdownPreview } from "./editor-engine";

interface NotePreviewProps {
  markdown: string;
  entries: ClipboardEntry[];
}

const NotePreview: React.FC<NotePreviewProps> = ({ markdown, entries }) => (
  <MarkdownPreview markdown={markdown} entries={entries} className="ns-card-preview-md" />
);

export default NotePreview;
