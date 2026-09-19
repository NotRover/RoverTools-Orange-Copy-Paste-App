// ── Attachment card — the one shape every note attachment shares ────────
// A clipboard entry, a group and a file all render through this component:
// a 36px header (kind tile, title, meta, hover-only actions with Remove last)
// over a body that is whatever the attachment is. Node views own the actions;
// the read-only preview renders the same header compact, with no actions.
// Colours come from the `.ee-kind--*` classes in markdown.css, so a chip, a
// tile and a list row of the same kind always match.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  ImageIcon,
  FileIcon,
  TextLinesIcon,
  HtmlCodeIcon,
  VideoIcon,
  LinkIcon,
  DocumentIcon,
  FolderIcon,
  TagIcon,
  PinIcon,
  SaveStarIcon,
  CopyIcon,
  CheckIcon,
  CloseIcon,
  FilePageIcon,
} from "../../../../icons";
import {
  classifyFileEntry,
  deriveDisplayKind,
  fileNameFromPath,
  filePaths,
  groupColor,
  isImageFile,
  resolveImageSrc,
  truncateText,
  type ClipboardEntry,
  type DisplayKind,
} from "../../../../../types";
import { timeAgoFor } from "../../../../../hooks/useRelativeTime";
import { stripHtml } from "../../notes-utils";

export type Kind = DisplayKind | "group" | "missing";

// ── Kind helpers ─────────────────────────────────────────────────────────

export function entryKind(entry: ClipboardEntry | undefined): Kind {
  return entry ? deriveDisplayKind(entry) : "missing";
}

export function KindIcon({ kind, size = 12 }: { kind: Kind; size?: number }) {
  switch (kind) {
    case "image": return <ImageIcon size={size} />;
    case "video": return <VideoIcon size={size} />;
    case "html": return <HtmlCodeIcon size={size} />;
    case "url": return <LinkIcon size={size} />;
    case "document": return <DocumentIcon size={size} />;
    case "folder": return <FolderIcon size={size} />;
    case "file": return <FileIcon size={size} />;
    case "group": return <TagIcon size={size} />;
    default: return <TextLinesIcon size={size} />;
  }
}

export function kindLabel(kind: Kind): string {
  switch (kind) {
    case "image": return "Image";
    case "video": return "Video";
    case "html": return "HTML";
    case "url": return "Link";
    case "document": return "Document";
    case "folder": return "Folder";
    case "file": return "File";
    case "group": return "Group";
    case "missing": return "Missing";
    default: return "Text";
  }
}

const MISSING_TITLE = "Removed from clipboard";

/** One-line title for an entry. `max` is the character budget. */
export function entryTitle(entry: ClipboardEntry | undefined, max = 60): string {
  if (!entry) return MISSING_TITLE;
  if (entry.type === "image") return entry.label ?? "Image";
  if (entry.type === "file") {
    const paths = filePaths(entry.content);
    if (paths.length > 1) return `${paths.length} files`;
    return paths[0] ? fileNameFromPath(paths[0]) : "File";
  }
  const raw = entry.type === "html" ? stripHtml(entry.content) : entry.content;
  return truncateText(raw.replace(/\s+/g, " ").trim(), max) || "Clip";
}

/** Plain text of a text-like entry, for the card body. */
function entryText(entry: ClipboardEntry): string {
  return (entry.type === "html" ? stripHtml(entry.content) : entry.content).trim();
}

// ── Groups ───────────────────────────────────────────────────────────────

const SYSTEM_GROUPS: Record<
  string,
  { label: string; Icon: React.FC<{ size?: number }>; className: string }
> = {
  pinned: { label: "Pinned", Icon: PinIcon, className: "ee-kind--pinned" },
  Saved: { label: "Saved", Icon: SaveStarIcon, className: "ee-kind--saved" },
};

export interface GroupInfo {
  name: string;
  label: string;
  Icon: React.FC<{ size?: number }>;
  /** Colour class for system groups. */
  className?: string;
  /** Inline --k-bg/--k-fg for user groups, whose hue is derived from the name. */
  style?: React.CSSProperties;
  entries: ClipboardEntry[];
}

export function groupInfo(name: string, entries: ClipboardEntry[]): GroupInfo {
  const sys = SYSTEM_GROUPS[name];
  const list =
    name === "pinned"
      ? entries.filter((e) => e.pinned)
      : entries.filter((e) => e.groups.includes(name));
  if (sys) return { name, label: sys.label, Icon: sys.Icon, className: sys.className, entries: list };
  const c = groupColor(name);
  return {
    name,
    label: name,
    Icon: TagIcon,
    style: { "--k-bg": c.bg, "--k-fg": c.fg } as React.CSSProperties,
    entries: list,
  };
}

// ── Copy with in-place feedback ──────────────────────────────────────────

/** Copies a clipboard entry and reports which id was copied for a moment. */
export function useCopyEntry(): [copied: string | null, copy: (id: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const copy = useCallback((id: string) => {
    invoke<boolean>("copy_entry", { id })
      .then((ok) => {
        if (!ok) return;
        setCopied(id);
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(null), 1200);
      })
      .catch(console.error);
  }, []);
  return [copied, copy];
}

// ── Actions ──────────────────────────────────────────────────────────────

export interface CardAction {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  /** Swap the icon for a check while true (copy feedback). */
  done?: boolean;
}

const ActionButton: React.FC<CardAction> = ({ label, icon, onClick, done }) => (
  <button
    type="button"
    className={`ee-card-act${done ? " ee-card-act--done" : ""}`}
    onMouseDown={(e) => e.preventDefault()}
    onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
    data-tooltip={done ? "Copied" : label}
    data-tooltip-pos="below"
    aria-label={label}
  >
    {done ? <CheckIcon size={12} /> : icon}
  </button>
);

export const copyAction = (onClick: () => void, done: boolean): CardAction => ({
  label: "Copy", icon: <CopyIcon size={12} />, onClick, done,
});
export const removeAction = (onClick: () => void): CardAction => ({
  label: "Remove", icon: <CloseIcon size={12} />, onClick,
});

// ── Card ─────────────────────────────────────────────────────────────────

export interface AttachmentCardProps {
  kind: Kind;
  icon?: React.ReactNode;
  /** Colour class or inline colours for the tile; defaults to the kind. */
  kindClassName?: string;
  kindStyle?: React.CSSProperties;
  title: string;
  /** "Text, 7h ago", "6 entries", "PDF, 184 KB". */
  meta?: string;
  actions?: CardAction[];
  /** Header only. Files, missing entries and the read-only preview. */
  compact?: boolean;
  missing?: boolean;
  children?: React.ReactNode;
}

export const AttachmentCard: React.FC<AttachmentCardProps> = ({
  kind, icon, kindClassName, kindStyle, title, meta, actions, compact, missing, children,
}) => (
  <div
    className={[
      "ee-card",
      compact && "ee-card--compact",
      missing && "ee-card--missing",
    ].filter(Boolean).join(" ")}
  >
    <div className="ee-card-head">
      <span className={`ee-card-tile ${kindClassName ?? `ee-kind--${kind}`}`} style={kindStyle}>
        {icon ?? <KindIcon kind={kind} />}
      </span>
      <span className="ee-card-title" title={title}>{title}</span>
      {meta && <span className="ee-card-meta">{meta}</span>}
      {actions && actions.length > 0 && (
        <span className="ee-card-acts">
          {actions.map((a) => <ActionButton key={a.label} {...a} />)}
        </span>
      )}
    </div>
    {!compact && children && <div className="ee-card-body">{children}</div>}
  </div>
);

/** "Text, 7h ago" for an entry header. */
export function entryMeta(entry: ClipboardEntry): string {
  return `${kindLabel(entryKind(entry))}, ${timeAgoFor(entry.timestamp, `clipboard:${entry.id}`)}`;
}

// ── Bodies ───────────────────────────────────────────────────────────────

const TEXT_PREVIEW_CHARS = 600;

/** What a clipboard entry is: text in mono, a picture, or its file paths. */
export const EntryBody: React.FC<{ entry: ClipboardEntry }> = ({ entry }) => {
  const [showAll, setShowAll] = useState(false);

  if (entry.type === "image") {
    return (
      <img
        className="ee-card-img"
        src={resolveImageSrc(entry.content, convertFileSrc)}
        alt={entry.label ?? "Image"}
        draggable={false}
      />
    );
  }

  if (entry.type === "file") {
    const paths = filePaths(entry.content);
    const images = paths.filter(isImageFile);
    const others = paths.filter((p) => !isImageFile(p));
    return (
      <>
        {images.map((p) => (
          <img key={p} className="ee-card-img" src={convertFileSrc(p)} alt={fileNameFromPath(p)} draggable={false} />
        ))}
        {others.length > 0 && (
          <div className="ee-card-paths">
            {others.map((p) => (
              <div key={p} className="ee-card-path" title={p}>
                <FilePageIcon size={11} />
                <span>{p}</span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  const text = entryText(entry);
  const long = text.length > TEXT_PREVIEW_CHARS;
  return (
    <>
      <div className="ee-card-text">
        {long && !showAll ? text.slice(0, TEXT_PREVIEW_CHARS).trimEnd() + "..." : text || "-"}
      </div>
      {long && (
        <button
          type="button"
          className="ee-card-more"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.stopPropagation(); setShowAll((v) => !v); }}
        >
          {showAll ? "Show less" : `Show all (${text.length.toLocaleString()} characters)`}
        </button>
      )}
    </>
  );
};

const GROUP_ROWS = 3;

/** Newest entries of a group as 30px rows. Clicking a row copies it. */
export const GroupBody: React.FC<{
  info: GroupInfo;
  onCopy?: (id: string) => void;
  copiedId?: string | null;
}> = ({ info, onCopy, copiedId }) => {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? info.entries : info.entries.slice(0, GROUP_ROWS);
  const rest = info.entries.length - rows.length;

  if (info.entries.length === 0) {
    return <div className="ee-card-empty">No entries in this group yet</div>;
  }
  return (
    <>
      <div className="ee-card-rows">
        {rows.map((entry) => {
          const kind = entryKind(entry);
          const copied = copiedId === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              className="ee-card-row"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => { e.stopPropagation(); onCopy?.(entry.id); }}
              disabled={!onCopy}
              data-tooltip={onCopy ? (copied ? "Copied" : "Click to copy") : undefined}
              data-tooltip-pos="below"
            >
              <span className={`ee-card-tile ee-card-tile--sm ee-kind--${kind}`}><KindIcon kind={kind} size={10} /></span>
              <span className="ee-card-row-title">{entryTitle(entry, 80)}</span>
              <span className={`ee-card-meta${copied ? " ee-card-meta--done" : ""}`}>
                {copied ? <CheckIcon size={11} /> : timeAgoFor(entry.timestamp, `clipboard:${entry.id}`)}
              </span>
            </button>
          );
        })}
      </div>
      {info.entries.length > GROUP_ROWS && (
        <button
          type="button"
          className="ee-card-more"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.stopPropagation(); setShowAll((v) => !v); }}
        >
          {showAll ? "Show fewer" : `${rest} more in the clipboard`}
        </button>
      )}
    </>
  );
};

// ── File helpers ─────────────────────────────────────────────────────────

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** "PDF", "DOCX" from a filename; null without an extension. */
function fileExtLabel(name: string): string | null {
  const base = fileNameFromPath(name);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toUpperCase().slice(0, 6);
}

const DOCUMENT_EXTS = new Set([
  "pdf", "doc", "docx", "txt", "md", "rtf", "odt", "xls", "xlsx", "csv", "ppt", "pptx",
]);

/** Kind for a file card, from the filename alone. */
export function fileKindFromName(name: string): Kind {
  const kind = classifyFileEntry(name);
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  const ext = fileExtLabel(name)?.toLowerCase();
  return ext && DOCUMENT_EXTS.has(ext) ? "document" : "file";
}

/** "PDF, 184 KB" or whichever half is known. */
export function fileMeta(name: string, size: number | null | undefined): string | undefined {
  return [fileExtLabel(name), formatBytes(size)].filter(Boolean).join(", ") || undefined;
}
