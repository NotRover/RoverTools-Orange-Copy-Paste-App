import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ClipboardEntry,
  DisplayKind,
  Note,
  SendFilter,
  Space,
  SyncInvite,
  SyncInviteList,
} from "../../../types";
import {
  timeAgo,
  truncateText,
  htmlPlainText,
  htmlFragment,
  resolveImageSrc,
  filePaths,
  fileNameFromPath,
  deriveDisplayKind,
  groupColor,
} from "../../../types";
import { UserAvatar } from "../../UserAvatar";
import { EntryTypePill } from "../../entry-types/EntryTypePill";
import { TYPE_ICONS, TYPE_LABELS } from "../../entry-types/EntryTypePill";
import Topbar, { SortDropdown, LayoutSegment } from "../topbar/Topbar";
import { RowsIcon } from "../../icons";
import type { ClipboardLayout } from "../topbar/Topbar";
import type { SortMode } from "../sort-options";
import "../clipboard-screen/search-filter/SearchFilter.css";
import {
  Plus,
  Key,
  Users,
  ShareNetwork,
  X,
  Check,
  Copy,
  CaretRight,
  CaretDown,
  Circle,
  Envelope,
  Note as NoteIcon,
  File,
  MagnifyingGlass,
  Clipboard,
  Funnel,
  PushPin,
  ArrowsOutSimple,
  SquaresFour,
  ArrowDownLeft,
  ArrowUpRight,
} from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import "../card-menu/CardMenu.css";
import NotionPreview from "../notes-screen/editor-engine/NotionPreview";
import { deriveNoteTitle } from "../notes-screen/notes-utils";
import "../notes-screen/note-card/note-card.css";
import "../clipboard-screen/entry-card/EntryCard.css";
import "./SpacesScreen.css";

// ── Types ─────────────────────────────────────────────────────────────

type FeedFilter = "all" | "clipboard" | "notes";
type FeedItem =
  | { kind: "clipboard"; entry: ClipboardEntry }
  | { kind: "note"; note: Note };

const ALL_DISPLAY_KINDS: DisplayKind[] = [
  "text",
  "url",
  "html",
  "image",
  "video",
  "document",
  "file",
  "folder",
];

const CONTENT_OPTIONS: { value: SendFilter["content"]; label: string }[] = [
  { value: "clipboard", label: "Clipboard" },
  { value: "notes", label: "Notes" },
  { value: "both", label: "Both" },
];

const AVATAR_PALETTE = [
  "#ff3e1c",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];

export function spaceAvatarColor(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

/** Show an invite code as XXXX-XXXX when it is a plain 8-char code. */
function formatInviteCode(code: string): string {
  const c = code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : code;
}

const DEFAULT_FILTER: SendFilter = {
  enabled: false,
  kinds: [],
  groups: [],
  content: "both",
};

/** How many narrowing rules a filter carries, for the header badge. */
function filterRuleCount(f: SendFilter | undefined): number {
  if (!f?.enabled) return 0;
  let n = 1; // the filter itself is on
  if (f.kinds.length > 0) n++;
  if (f.groups.length > 0) n++;
  return n;
}

// ── Helpers ───────────────────────────────────────────────────────────

function extractNoteText(content: string): string {
  if (!content) return "";
  try {
    const doc = JSON.parse(content) as { type?: string; content?: unknown[] };
    if (doc.type === "doc") {
      const texts: string[] = [];
      const walk = (node: { text?: string; content?: unknown[] }) => {
        if (typeof node.text === "string") texts.push(node.text);
        if (Array.isArray(node.content))
          node.content.forEach((n) => walk(n as typeof node));
      };
      walk(doc as { text?: string; content?: unknown[] });
      return texts.join(" ").replace(/\s+/g, " ").trim();
    }
  } catch {
    /* legacy HTML */
  }
  return content
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function matchesSearch(item: FeedItem, q: string): boolean {
  const lower = q.toLowerCase();
  if (item.kind === "clipboard") {
    const { entry } = item;
    if (entry.type === "text")
      return entry.content.toLowerCase().includes(lower);
    if (entry.type === "html")
      return htmlPlainText(entry.content).toLowerCase().includes(lower);
    if (entry.type === "file")
      return entry.content.toLowerCase().includes(lower);
    return false;
  }
  return (
    item.note.title.toLowerCase().includes(lower) ||
    extractNoteText(item.note.content).toLowerCase().includes(lower)
  );
}

// ── Feed context menu ─────────────────────────────────────────────────

interface MenuPos {
  x: number;
  y: number;
}

const FeedCardMenu: React.FC<{
  pos: MenuPos | null;
  onClose: () => void;
  copied: boolean;
  onCopy?: () => void;
  onOpen: () => void;
}> = ({ pos, onClose, copied, onCopy, onOpen }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onEsc);
    };
  }, [pos, onClose]);

  useEffect(() => {
    if (!pos || !ref.current) return;
    const el = ref.current;
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    const r = el.getBoundingClientRect();
    let x = pos.x,
      y = pos.y;
    if (r.right > window.innerWidth) x = Math.max(0, pos.x - r.width);
    if (r.bottom > window.innerHeight) y = Math.max(0, pos.y - r.height);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [pos]);

  if (!pos) return null;

  const closeAfter = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return createPortal(
    <div
      ref={ref}
      className="card-menu-dropdown"
      style={{ position: "fixed", left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {onCopy && (
        <button
          className={`card-menu-item card-menu-item--copy${copied ? " card-menu-item--success" : ""}`}
          onClick={closeAfter(onCopy)}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? "Copied!" : "Copy"}</span>
        </button>
      )}
      <button className="card-menu-item" onClick={closeAfter(onOpen)}>
        <ArrowsOutSimple size={13} />
        <span>Open</span>
      </button>
    </div>,
    document.body,
  );
};

// ── Feed filter dropdown ──────────────────────────────────────────────

interface FeedFilterState {
  selectedKinds: Set<DisplayKind>;
  toggleKind: (k: DisplayKind) => void;
  dateAfter: string;
  setDateAfter: (v: string) => void;
  dateBefore: string;
  setDateBefore: (v: string) => void;
  activeFilterCount: number;
  clearAll: () => void;
  filtersOpen: boolean;
  setFiltersOpen: React.Dispatch<React.SetStateAction<boolean>>;
  filterRef: React.RefObject<HTMLDivElement | null>;
}

const FeedFilterDropdown: React.FC<{
  sf: FeedFilterState;
  feedFilter: FeedFilter;
}> = ({ sf, feedFilter }) => {
  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);
  const dateActive = !!(
    sf.dateAfter ||
    (sf.dateBefore && sf.dateBefore !== todayStr)
  );

  return (
    <div className="sort-dropdown" ref={sf.filterRef}>
      <button
        className={`cs-tb-btn${sf.filtersOpen ? " cs-tb-btn--open" : ""}`}
        onClick={() => {
          if (!sf.filtersOpen)
            document.dispatchEvent(new Event("tooltip:hide"));
          sf.setFiltersOpen((v) => !v);
        }}
        data-tooltip="Filters"
        data-tooltip-pos="below"
      >
        <Funnel size={12} />
        {sf.activeFilterCount > 0 && (
          <span className="cs-tb-badge">{sf.activeFilterCount}</span>
        )}
      </button>
      {sf.filtersOpen && (
        <div className="cs-filter-card">
          {feedFilter !== "notes" && (
            <div className="cs-card-section">
              <div className="cs-section-label">
                Clipboard Types
                {sf.selectedKinds.size > 0 && (
                  <span className="cs-count">{sf.selectedKinds.size}</span>
                )}
              </div>
              <div className="cs-type-grid">
                {ALL_DISPLAY_KINDS.map((k) => (
                  <label
                    key={k}
                    className={`cs-type-option${sf.selectedKinds.has(k) ? " cs-type-option--on" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={sf.selectedKinds.has(k)}
                      onChange={() => sf.toggleKind(k)}
                      className="cs-type-cb"
                    />
                    <span className={`cs-type-icon type-pill type-pill--${k}`}>
                      {TYPE_ICONS[k]}
                    </span>
                    <span className="cs-type-name">{TYPE_LABELS[k]}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {feedFilter !== "notes" && <div className="cs-card-divider" />}
          <div className="cs-card-section">
            <div className="cs-section-label">
              Date{dateActive && <span className="cs-count">1</span>}
            </div>
            <div className="cs-date-row">
              <input
                type="date"
                className="cs-date-input"
                value={sf.dateAfter}
                onChange={(e) => sf.setDateAfter(e.target.value)}
                title="After"
              />
              <span className="cs-date-sep">-</span>
              <input
                type="date"
                className="cs-date-input"
                value={sf.dateBefore}
                onChange={(e) => sf.setDateBefore(e.target.value)}
                title="Before"
              />
            </div>
          </div>
          {sf.activeFilterCount > 0 && (
            <>
              <div className="cs-card-divider" />
              <button className="cs-card-clear-btn" onClick={sf.clearAll}>
                <X size={12} />
                Clear Filters
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

// ── Clipboard detail body ─────────────────────────────────────────────

function ClipDetailBody({ entry }: { entry: ClipboardEntry }) {
  if (entry.type === "html") {
    return (
      <div
        className="sp-detail-html-preview"
        dangerouslySetInnerHTML={{ __html: htmlFragment(entry.content) }}
      />
    );
  }
  if (entry.type === "image") {
    return (
      <div className="sp-detail-image-wrap">
        <img
          src={resolveImageSrc(entry.content, convertFileSrc)}
          alt={entry.label ?? "Image"}
          className="sp-detail-image-img"
        />
        {entry.label && (
          <p className="sp-detail-image-caption">{entry.label}</p>
        )}
      </div>
    );
  }
  if (entry.type === "file") {
    const paths = filePaths(entry.content);
    return (
      <div className="sp-detail-file-list">
        {paths.map((p) => (
          <div key={p} className="sp-detail-file-row">
            <File size={11} />
            <span>{fileNameFromPath(p)}</span>
          </div>
        ))}
      </div>
    );
  }
  return <p className="sp-detail-entry-text">{entry.content}</p>;
}

// ── Clipboard detail panel ────────────────────────────────────────────

const DetailPanel: React.FC<{
  entry: ClipboardEntry;
  onClose: () => void;
  onCopy: (id: string) => void;
}> = ({ entry, onClose, onCopy }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback(() => {
    onCopy(entry.id);
    if (timer.current) clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }, [entry.id, onCopy]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const dk = deriveDisplayKind(entry);

  return (
    <div className="sp-detail-panel">
      <div className="sp-detail-toolbar">
        <button className="sp-detail-back" onClick={onClose}>
          <CaretRight size={11} className="sp-detail-back-chevron" />
          Back
        </button>
        <div className="sp-detail-toolbar-right">
          <EntryTypePill kind={dk} />
          <span className="sp-detail-time">{timeAgo(entry.timestamp)}</span>
          <button
            className={`sp-detail-copy-btn${copied ? " sp-detail-copy-btn--done" : ""}`}
            onClick={handleCopy}
          >
            {copied ? (
              <>
                <Check size={11} weight="bold" /> Copied!
              </>
            ) : (
              <>
                <Copy size={11} /> Copy
              </>
            )}
          </button>
        </div>
      </div>
      <div className="sp-detail-scroll">
        <ClipDetailBody entry={entry} />
      </div>
    </div>
  );
};

// ── Direction badge ───────────────────────────────────────────────────

/** Which way an item travelled, using the same arrows as the Incoming and
 *  Outgoing blocks in space settings, so a row points back at the rule that
 *  put it there. Rows only: a card already shows a preview and its chips. */
const DirectionBadge: React.FC<{ incoming: boolean }> = ({ incoming }) => (
  <span
    className={`sp-list-dir sp-list-dir--${incoming ? "in" : "out"}`}
    data-tooltip={incoming ? "Shared by a member" : "Shared from this account"}
    data-tooltip-pos="right"
  >
    {incoming ? (
      <ArrowDownLeft size={11} weight="bold" />
    ) : (
      <ArrowUpRight size={11} weight="bold" />
    )}
  </span>
);

// ── Clipboard feed card ───────────────────────────────────────────────

const ClipFeedCard: React.FC<{
  entry: ClipboardEntry;
  onCopy: (id: string) => void;
  onView: (entry: ClipboardEntry) => void;
  layout: ClipboardLayout;
  showSourceBadge?: boolean;
  incoming: boolean;
}> = ({ entry, onCopy, onView, layout, showSourceBadge, incoming }) => {
  const [copied, setCopied] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markCopied = useCallback(() => {
    onCopy(entry.id);
    if (timer.current) clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, [entry.id, onCopy]);
  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      markCopied();
    },
    [markCopied],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const dk = deriveDisplayKind(entry);

  // ── List mode ──────────────────────────────────────────────────────
  if (layout === "list") {
    const text =
      entry.type === "text"
        ? entry.content
        : entry.type === "html"
          ? htmlPlainText(entry.content)
          : entry.type === "file"
            ? filePaths(entry.content).map(fileNameFromPath).join(", ")
            : (entry.label ?? "");
    return (
      <div
        className="sp-list-card"
        onClick={() => onView(entry)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
      >
        <DirectionBadge incoming={incoming} />
        {showSourceBadge && (
          <span className="sp-list-source-badge sp-list-source-badge--clip">
            <Clipboard size={10} />
          </span>
        )}
        <span className="sp-list-type-wrap">
          <EntryTypePill kind={dk} />
        </span>
        <span className="sp-list-text">{truncateText(text, 100)}</span>
        <span className="sp-list-time">{timeAgo(entry.timestamp)}</span>
        <button
          className={`sp-list-action${copied ? " sp-list-action--done" : ""}`}
          onClick={handleCopy}
        >
          {copied ? <Check size={10} weight="bold" /> : <Copy size={10} />}
        </button>
      </div>
    );
  }

  // ── Tiles mode ─────────────────────────────────────────────────────
  let mediaSection: React.ReactNode = null;
  let preview: React.ReactNode = null;

  if (entry.type === "text") {
    preview = <p className="card-text">{truncateText(entry.content, 180)}</p>;
  } else if (entry.type === "html") {
    preview = (
      <div
        className="card-html-preview"
        dangerouslySetInnerHTML={{ __html: htmlFragment(entry.content) }}
      />
    );
  } else if (entry.type === "image") {
    mediaSection = (
      <div className="card-media">
        <img
          src={resolveImageSrc(entry.content, convertFileSrc)}
          alt={entry.label ?? "Image"}
          className="card-media-img"
        />
      </div>
    );
    preview = (
      <p className="card-text card-text--image-name">
        {entry.label ?? "Image"}
      </p>
    );
  } else if (entry.type === "file") {
    const paths = filePaths(entry.content);
    preview = (
      <div className="card-file-preview">
        {paths.slice(0, 3).map((p) => (
          <div key={p} className="card-file-preview-item">
            <File size={9} />
            <span className="card-file-preview-name">
              {fileNameFromPath(p)}
            </span>
          </div>
        ))}
        {paths.length > 3 && (
          <p className="card-file-preview-more">+{paths.length - 3} more</p>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        className="entry-card sp-feed-entry-card"
        onClick={() => onView(entry)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
      >
        {mediaSection}
        <div className="card-body">
          {preview}
          <div className="card-footer">
            <div className="card-chips">
              {showSourceBadge && (
                <span className="card-type-chip sp-source-chip--clip">
                  <Clipboard size={9} weight="bold" />
                  <span className="card-type-label">Clipboard</span>
                </span>
              )}
              <EntryTypePill kind={dk} />
            </div>
            {copied ? (
              <span className="card-time card-time--copied">
                <Check size={9} weight="bold" />
                Copied
              </span>
            ) : (
              <span className="card-time">{timeAgo(entry.timestamp)}</span>
            )}
            <button
              className="sp-card-copy-btn"
              onClick={handleCopy}
              data-tooltip="Copy"
              data-tooltip-pos="top"
            >
              <Copy size={10} />
            </button>
          </div>
        </div>
      </div>
      <FeedCardMenu
        pos={menuPos}
        onClose={() => setMenuPos(null)}
        copied={copied}
        onCopy={markCopied}
        onOpen={() => onView(entry)}
      />
    </>
  );
};

// ── Note feed card ────────────────────────────────────────────────────

const NoteFeedCard: React.FC<{
  note: Note;
  entries: ClipboardEntry[];
  onView: (note: Note) => void;
  layout: ClipboardLayout;
  showSourceBadge?: boolean;
  incoming: boolean;
}> = ({ note, entries, onView, layout, showSourceBadge, incoming }) => {
  const plain = extractNoteText(note.content);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const openMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  // ── List mode ──────────────────────────────────────────────────────
  if (layout === "list") {
    return (
      <>
        <div
          className="sp-list-card sp-list-card--note"
          onClick={() => onView(note)}
          onContextMenu={openMenu}
        >
          <DirectionBadge incoming={incoming} />
          <span className="sp-list-note-badge">
            <NoteIcon size={12} />
          </span>
          <div className="sp-list-note-content">
            <span className="sp-list-title">
              {note.title || "(Untitled note)"}
            </span>
            {plain && (
              <span className="sp-list-preview">{truncateText(plain, 70)}</span>
            )}
          </div>
          <span className="sp-list-time">{timeAgo(note.updated_at)}</span>
        </div>
        <FeedCardMenu
          pos={menuPos}
          onClose={() => setMenuPos(null)}
          copied={false}
          onOpen={() => onView(note)}
        />
      </>
    );
  }

  // ── Tiles mode: mirrors NoteCard markup so the chip row is ours ─────
  const content = note.content ?? "";
  return (
    <>
      <div
        className="ns-card"
        onClick={() => onView(note)}
        onContextMenu={openMenu}
      >
        <div className="ns-card-body">
          <div className="ns-card-title">
            {deriveNoteTitle(note.title, note.content)}
          </div>
          {content && (
            <div className="ns-card-preview">
              <NotionPreview
                content={content}
                entries={entries}
                className="ns-card-preview-md"
              />
            </div>
          )}
          <div className="ns-card-footer">
            <div className="ns-card-chips">
              {showSourceBadge && (
                <span className="card-type-chip sp-source-chip--note">
                  <NoteIcon size={9} />
                  <span className="card-type-label">Note</span>
                </span>
              )}
              {note.groups.map((g) => {
                const c = groupColor(g);
                return (
                  <span
                    key={g}
                    className="ns-chip"
                    style={{ background: c.bg, color: c.fg }}
                  >
                    <span className="ns-chip-dot" />
                    <span className="ns-chip-label">{g}</span>
                  </span>
                );
              })}
            </div>
            <span
              className={`ns-card-time${note.pinned ? " ns-card-time--pinned" : ""}`}
            >
              {note.pinned && <PushPin size={8} weight="fill" />}
              {timeAgo(note.updated_at)}
            </span>
          </div>
        </div>
      </div>
      <FeedCardMenu
        pos={menuPos}
        onClose={() => setMenuPos(null)}
        copied={false}
        onOpen={() => onView(note)}
      />
    </>
  );
};

// ── Read-only note detail panel ───────────────────────────────────────

const ReadOnlyNotePanel: React.FC<{
  note: Note;
  entries: ClipboardEntry[];
  onClose: () => void;
}> = ({ note, entries, onClose }) => (
  <div className="sp-detail-panel">
    <div className="sp-detail-toolbar">
      <button className="sp-detail-back" onClick={onClose}>
        <CaretRight size={11} className="sp-detail-back-chevron" />
        Back
      </button>
      <div className="sp-detail-toolbar-right">
        <span className="sp-readonly-badge">Read-only</span>
        <span className="sp-detail-time">{timeAgo(note.updated_at)}</span>
      </div>
    </div>
    <div className="sp-detail-scroll">
      {note.title && <h1 className="sp-detail-note-title">{note.title}</h1>}
      <NotionPreview content={note.content} entries={entries} />
    </div>
  </div>
);

// ── Create / join forms ───────────────────────────────────────────────

const CreateForm: React.FC<{
  onSubmit: (name: string, shareHistory: boolean) => void;
  onCancel: () => void;
  loading: boolean;
}> = ({ onSubmit, onCancel, loading }) => {
  const [name, setName] = useState("");
  const [shareHistory, setShareHistory] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const submit = () => {
    if (name.trim()) onSubmit(name.trim(), shareHistory);
  };
  return (
    <div className="sp-inline-form">
      <input
        ref={inputRef}
        className="sp-inline-input"
        placeholder="Space name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      {/* Fixed per member at join time, so turning it off later never takes
          history away from someone who already has it. */}
      <label className="sp-inline-check">
        <input
          type="checkbox"
          checked={shareHistory}
          onChange={(e) => setShareHistory(e.target.checked)}
        />
        <span>New members can read earlier items</span>
      </label>
      <div className="sp-inline-form-actions">
        <button
          className="sp-inline-btn sp-inline-btn--primary"
          disabled={!name.trim() || loading}
          onClick={submit}
        >
          {loading ? "Creating..." : "Create"}
        </button>
        <button className="sp-inline-btn" onClick={onCancel}>
          <X size={10} />
        </button>
      </div>
    </div>
  );
};

const JoinForm: React.FC<{
  onSubmit: (code: string) => void;
  onCancel: () => void;
  loading: boolean;
}> = ({ onSubmit, onCancel, loading }) => {
  const [code, setCode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div className="sp-inline-form">
      <input
        ref={inputRef}
        className="sp-inline-input"
        placeholder="Paste an invite code or link"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && code.trim()) onSubmit(code.trim());
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="sp-inline-form-actions">
        <button
          className="sp-inline-btn sp-inline-btn--primary"
          disabled={!code.trim() || loading}
          onClick={() => code.trim() && onSubmit(code.trim())}
        >
          {loading ? "Joining..." : "Join"}
        </button>
        <button className="sp-inline-btn" onClick={onCancel}>
          <X size={10} />
        </button>
      </div>
    </div>
  );
};

// ── Space settings panel ──────────────────────────────────────────────

const SpaceSettings: React.FC<{
  space: Space;
  selfUserId: string | null;
  autocopy: boolean;
  onAutocopy: (enabled: boolean) => void;
  filter: SendFilter;
  onFilter: (next: SendFilter) => void;
  availableGroups: string[];
  onInvite: (email: string) => Promise<void>;
  onRemoveMember: (userId: string) => void;
  onLeave: () => void;
  onDelete: () => void;
  error: string | null;
}> = ({
  space,
  selfUserId,
  autocopy,
  onAutocopy,
  filter,
  onFilter,
  availableGroups,
  onInvite,
  onRemoveMember,
  onLeave,
  onDelete,
  error,
}) => {
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current);
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copy = (key: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setCopied(key);
    copyTimer.current = setTimeout(() => setCopied(null), 1600);
  };

  const sendInvite = async () => {
    if (!email.trim()) return;
    setInviting(true);
    try {
      await onInvite(email.trim());
      setEmail("");
    } finally {
      setInviting(false);
    }
  };

  const armDelete = () => {
    if (!armed) {
      setArmed(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    setArmed(false);
    onDelete();
  };

  const toggleKind = (k: DisplayKind) => {
    const kinds = filter.kinds.includes(k)
      ? filter.kinds.filter((x) => x !== k)
      : [...filter.kinds, k];
    onFilter({ ...filter, kinds });
  };

  const toggleGroup = (g: string) => {
    const groups = filter.groups.includes(g)
      ? filter.groups.filter((x) => x !== g)
      : [...filter.groups, g];
    onFilter({ ...filter, groups });
  };

  return (
    <div className="sp-settings">
      {/* The column used to open on a bare "Incoming" label, so nothing said
          which space you were editing once the list scrolled. */}
      <header className="sp-rules-head">
        <span
          className="sp-rules-avatar"
          style={{ background: spaceAvatarColor(space.id) }}
        >
          {space.name.slice(0, 2).toUpperCase()}
        </span>
        <span className="sp-rules-head-text">
          <span className="sp-rules-name">{space.name}</span>
          <span className="sp-rules-sub">
            {space.member_count} member{space.member_count === 1 ? "" : "s"}
            {space.is_owner ? " - you own it" : ""}
          </span>
        </span>
      </header>

      <div className="sp-rules-body">
        {error && <span className="sp-settings-error">{error}</span>}

        {/* Rules: what the space does with items, in and out. */}
        <div className="sp-settings-block">
          <div className="sp-settings-label">
            Rules
            {filter.enabled && <span className="sp-settings-count">auto</span>}
          </div>
          <label className="sp-toggle-row">
            <span className="sp-toggle-text">
              <span className="sp-toggle-title">Copy new items in</span>
              <span className="sp-toggle-desc">
                {autocopy
                  ? "Anything shared here lands on your clipboard as it arrives."
                  : "Items still appear in this space, they just do not touch your clipboard."}
              </span>
            </span>
            <input
              type="checkbox"
              className="sp-switch"
              checked={autocopy}
              onChange={(e) => onAutocopy(e.target.checked)}
            />
          </label>
          <label className="sp-toggle-row">
            <span className="sp-toggle-text">
              <span className="sp-toggle-title">Share new items out</span>
              <span className="sp-toggle-desc">
                {filter.enabled
                  ? "New items that match the rules below are shared here. Older items are untouched."
                  : "Off. Only items you share by hand go into this space."}
              </span>
            </span>
            <input
              type="checkbox"
              className="sp-switch"
              checked={filter.enabled}
              onChange={(e) =>
                onFilter({ ...filter, enabled: e.target.checked })
              }
            />
          </label>

          {filter.enabled && (
            <div className="sp-filter-body">
              <div className="sp-filter-section">
                <div className="sp-filter-label">Content</div>
                <div className="sp-pill-row">
                  {CONTENT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`sp-pill${filter.content === opt.value ? " sp-pill--on" : ""}`}
                      onClick={() =>
                        onFilter({ ...filter, content: opt.value })
                      }
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {filter.content !== "notes" && (
                <div className="sp-filter-section">
                  <div className="sp-filter-label">
                    Clipboard types
                    {filter.kinds.length > 0 ? (
                      <span className="sp-settings-count">
                        {filter.kinds.length}
                      </span>
                    ) : (
                      <span className="sp-filter-hint">all types</span>
                    )}
                  </div>
                  <div className="cs-type-grid">
                    {ALL_DISPLAY_KINDS.map((k) => (
                      <label
                        key={k}
                        className={`cs-type-option${filter.kinds.includes(k) ? " cs-type-option--on" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={filter.kinds.includes(k)}
                          onChange={() => toggleKind(k)}
                          className="cs-type-cb"
                        />
                        <span
                          className={`cs-type-icon type-pill type-pill--${k}`}
                        >
                          {TYPE_ICONS[k]}
                        </span>
                        <span className="cs-type-name">{TYPE_LABELS[k]}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="sp-filter-section">
                <div className="sp-filter-label">
                  Groups
                  {filter.groups.length > 0 ? (
                    <span className="sp-settings-count">
                      {filter.groups.length}
                    </span>
                  ) : (
                    <span className="sp-filter-hint">any group</span>
                  )}
                </div>
                {availableGroups.length === 0 ? (
                  <p className="sp-filter-empty">
                    You have no groups yet. Tag items with a group to filter by
                    it.
                  </p>
                ) : (
                  <div className="sp-chip-row">
                    {availableGroups.map((g) => {
                      const on = filter.groups.includes(g);
                      const c = groupColor(g);
                      return (
                        <button
                          key={g}
                          type="button"
                          className={`sp-group-chip${on ? " sp-group-chip--on" : ""}`}
                          style={
                            on ? { background: c.bg, color: c.fg } : undefined
                          }
                          onClick={() => toggleGroup(g)}
                        >
                          <span className="sp-group-chip-dot" />
                          {g}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* People: who is here, and how to add more. */}
        <div className="sp-settings-block">
          <div className="sp-settings-label">
            People
            <span className="sp-settings-count">{space.member_count}</span>
          </div>
          <div className="sp-member-list">
            {space.members.length === 0 ? (
              <p className="sp-filter-empty">Just you so far.</p>
            ) : (
              space.members.map((m) => (
                <div key={m.user_id} className="sp-member-row">
                  <UserAvatar
                    className="sp-member-pic"
                    url={m.avatar_url}
                    label={m.display_name || ""}
                    glyphSize={10}
                  />
                  <span className="sp-member-name">
                    {m.user_id === selfUserId
                      ? "You"
                      : m.display_name || "Member"}
                  </span>
                  {m.role === "owner" && (
                    <span className="sp-badge sp-badge--owner">owner</span>
                  )}
                  {!m.has_space_key && (
                    <span className="sp-badge sp-badge--warn">
                      waiting for key
                    </span>
                  )}
                  <Circle
                    size={6}
                    weight="fill"
                    color={m.online ? "#22c55e" : "#6b7280"}
                  />
                  {space.is_owner && m.user_id !== selfUserId && (
                    <button
                      type="button"
                      className="sp-btn sp-btn--danger"
                      onClick={() => onRemoveMember(m.user_id)}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Two rows of the same width, both ending in an action, so the
            column reads as one block instead of four loose controls. */}
          <div className="sp-invite-box">
            {space.invite_code && (
              <div className="sp-invite-row">
                <code className="sp-invite-code">
                  {formatInviteCode(space.invite_code)}
                </code>
                <button
                  type="button"
                  className="sp-btn sp-btn--icon"
                  onClick={() => copy("code", space.invite_code!)}
                  data-tooltip="Copy code"
                  data-tooltip-pos="top"
                >
                  {copied === "code" ? <Check size={12} /> : <Copy size={12} />}
                  <span className="sp-btn-label">
                    {copied === "code" ? "Copied" : "Copy code"}
                  </span>
                </button>
                <button
                  type="button"
                  className="sp-btn sp-btn--icon"
                  onClick={() =>
                    copy("link", `orange://join?code=${space.invite_code}`)
                  }
                  data-tooltip="Copy invite link"
                  data-tooltip-pos="top"
                >
                  {copied === "link" ? (
                    <Check size={12} />
                  ) : (
                    <ShareNetwork size={12} />
                  )}
                  <span className="sp-btn-label">
                    {copied === "link" ? "Copied" : "Copy link"}
                  </span>
                </button>
              </div>
            )}
            <div className="sp-invite-row">
              <input
                className="sp-inline-input"
                type="email"
                placeholder="Invite by email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendInvite();
                }}
              />
              <button
                type="button"
                className="sp-btn"
                onClick={sendInvite}
                disabled={inviting || !email.trim()}
              >
                {inviting ? "..." : "Send"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Pinned, so the one destructive control sits on the column edge instead
          of trailing the scroll with empty space under it. */}
      <footer className="sp-rules-foot">
        {space.is_owner ? (
          <button
            type="button"
            className="sp-btn sp-btn--danger"
            onClick={armDelete}
            onBlur={() => setArmed(false)}
          >
            {armed ? "Confirm delete?" : "Delete space"}
          </button>
        ) : (
          <button
            type="button"
            className="sp-btn sp-btn--danger"
            onClick={onLeave}
          >
            Leave space
          </button>
        )}
        <span className="sp-danger-note">
          {space.is_owner
            ? "Stops sharing for everyone. Items already on their devices stay."
            : "Stops new items reaching you. What you already have stays."}
        </span>
      </footer>
    </div>
  );
};

// ── Rules column placeholder ──────────────────────────────────────────

/** The column keeps its shape with no space selected: the rules are per space,
 *  so there is nothing to set yet, but showing what lives here beats an empty
 *  gutter that reads as a missing feature. */
const RulesPlaceholder: React.FC<{ hasSpaces: boolean }> = ({ hasSpaces }) => (
  <div className="sp-settings">
    <header className="sp-rules-head">
      <span className="sp-rules-avatar sp-rules-avatar--ghost" />
      <span className="sp-rules-head-text">
        <span className="sp-rules-name">No space selected</span>
        <span className="sp-rules-sub">
          {hasSpaces ? "Pick one from the list" : "Create or join one to start"}
        </span>
      </span>
    </header>

    <div className="sp-rules-body">
      <div className="sp-settings-block">
        <div className="sp-settings-label">Rules</div>
        <p className="sp-rules-ghost-row">
          Copy new items to your clipboard as they arrive, on this device only.
        </p>
        <p className="sp-rules-ghost-row">
          Share new items out automatically, narrowed by clipboard type and
          group. Off by default, so only what you share by hand goes out.
        </p>
      </div>
      <div className="sp-settings-block">
        <div className="sp-settings-label">People</div>
        <p className="sp-rules-ghost-row">
          Who is in the space, who is online, and the invite code.
        </p>
      </div>
    </div>
  </div>
);

// ── Cross-visit cache ─────────────────────────────────────────────────

/** The screen unmounts when you switch away, so every visit used to start
 *  from empty and paint "No spaces yet" until the first round trip came back.
 *  This keeps the last answer so a return visit renders it immediately and
 *  the fetch only corrects it. */
const cache: {
  loaded: boolean;
  spaces: Space[];
  selfUserId: string | null;
  shares: Record<string, string[]>;
  remote: string[];
  invites: SyncInviteList;
  filters: Record<string, SendFilter>;
  autocopy: Record<string, boolean>;
} = {
  loaded: false,
  spaces: [],
  selfUserId: null,
  shares: {},
  remote: [],
  invites: { sent: [], received: [] },
  filters: {},
  autocopy: {},
};

const SELECTED_KEY = "spaces-selected";

// ── Resizable side panels ─────────────────────────────────────────────

/** Both panels resize within a range rather than freely: the feed in the
 *  middle is the point of the screen, and a space card stops being readable
 *  under ~190px. */
interface PaneSize {
  key: string;
  min: number;
  max: number;
  def: number;
}

const LIST_PANE: PaneSize = {
  key: "spaces-list-width",
  // The floor is where "1 member - 1 online" still fits beside the avatar and
  // the owner badge. Below it the meta line wraps and cards go double height.
  min: 244,
  max: 380,
  def: 252,
};
const RULES_PANE: PaneSize = {
  key: "spaces-rules-width",
  min: 240,
  max: 420,
  def: 272,
};

/** Below this the invite code needs the whole row, so its actions are icons. */
const RULES_LABEL_WIDTH = 336;

const clampWidth = (pane: PaneSize, px: number) =>
  Math.min(pane.max, Math.max(pane.min, Math.round(px)));

const readWidth = (pane: PaneSize) => {
  const raw = Number(localStorage.getItem(pane.key));
  return Number.isFinite(raw) && raw > 0 ? clampWidth(pane, raw) : pane.def;
};

// ── Props ─────────────────────────────────────────────────────────────

interface SpacesScreenProps {
  entries: ClipboardEntry[];
  notes: Note[];
  syncConnected: boolean | null;
  availableGroups: string[];
  onCopyEntry: (id: string) => void;
}

// ── Main screen ───────────────────────────────────────────────────────

const SpacesScreen: React.FC<SpacesScreenProps> = ({
  entries,
  notes,
  syncConnected,
  availableGroups,
  onCopyEntry,
}) => {
  const [spaces, setSpaces] = useState<Space[]>(cache.spaces);
  const [loaded, setLoaded] = useState(cache.loaded);
  const screenRef = useRef<HTMLDivElement>(null);
  const [listWidth, setListWidth] = useState(() => readWidth(LIST_PANE));
  const [rulesWidth, setRulesWidth] = useState(() => readWidth(RULES_PANE));
  const [dragging, setDragging] = useState<"list" | "rules" | null>(null);
  const [selfUserId, setSelfUserId] = useState<string | null>(cache.selfUserId);
  // Auth, not connectivity: a signed-in device that is offline can still be
  // shown its spaces, but nothing that needs the server should be offered.
  const signedIn = selfUserId !== null;
  // "clipboard:{id}" / "note:{id}" -> space ids the item is shared into.
  const [entryShares, setEntryShares] = useState<Record<string, string[]>>(
    cache.shares,
  );
  // Same keys, for the items another member wrote. Anything absent went out
  // from this account, which is also the right answer while sync is off.
  const [remoteKeys, setRemoteKeys] = useState<Set<string>>(
    () => new Set(cache.remote),
  );
  // Reopens on the space you left, which is usually the one you want again.
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    localStorage.getItem(SELECTED_KEY),
  );
  const [invites, setInvites] = useState<SyncInviteList>(cache.invites);
  const [sendFilters, setSendFilters] = useState<Record<string, SendFilter>>(
    cache.filters,
  );
  const [autocopy, setAutocopy] = useState<Record<string, boolean>>(
    cache.autocopy,
  );
  const [spaceError, setSpaceError] = useState<string | null>(null);
  const [feedFilter, setFeedFilter] = useState<FeedFilter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>(
    () => (localStorage.getItem("spaces-sort") as SortMode) ?? "newest",
  );
  const [layout, setLayout] = useState<ClipboardLayout>(
    () => (localStorage.getItem("spaces-layout") as ClipboardLayout) ?? "tiles",
  );
  const [detailItem, setDetailItem] = useState<FeedItem | null>(null);
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set());
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Feed filter state
  const [selectedKinds, setSelectedKinds] = useState<Set<DisplayKind>>(
    new Set(),
  );
  const [dateAfter, setDateAfter] = useState("");
  const [dateBefore, setDateBefore] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => spaces.find((s) => s.id === selectedId) ?? null,
    [spaces, selectedId],
  );

  // Sections only appear when they split something: a solo account has nobody
  // else online anywhere, and one "Quiet" header over the whole list says
  // nothing. Your own presence does not count - it is true everywhere.
  const spaceGroups = useMemo(() => {
    const live = (s: Space) =>
      s.members.some((m) => m.online && m.user_id !== selfUserId);
    const active = spaces.filter(live);
    const quiet = spaces.filter((s) => !live(s));
    if (active.length === 0 || quiet.length === 0)
      return [{ title: "All", spaces }];
    return [
      { title: "Active now", spaces: active },
      { title: "Quiet", spaces: quiet },
    ];
  }, [spaces, selfUserId]);

  // Panel drag. Widths are measured off the screen box rather than the panel
  // so a fast drag that outruns the pointer still tracks it.
  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      const rect = screenRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      if (dragging === "list") {
        setListWidth(clampWidth(LIST_PANE, e.clientX - rect.left));
      } else {
        setRulesWidth(clampWidth(RULES_PANE, rect.right - e.clientX));
      }
    };
    const onUp = () => setDragging(null);

    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  useEffect(() => {
    localStorage.setItem(LIST_PANE.key, String(listWidth));
  }, [listWidth]);

  useEffect(() => {
    localStorage.setItem(RULES_PANE.key, String(rulesWidth));
  }, [rulesWidth]);

  // Tauri commands reject with the Rust error string, which reads like
  // `create space 401: {...}`. Translate the cases a user can act on and let
  // the caller's fallback cover the rest - never show the raw string.
  const errMsg = (e: unknown, fallback: string) => {
    const raw = typeof e === "string" ? e : "";
    if (raw.includes("not authenticated"))
      return "Sign in on the Account screen first.";
    if (/\b401\b/.test(raw))
      return "Your session expired. Sign in again on the Account screen.";
    if (/\b403\b/.test(raw))
      return "This account does not have access to that.";
    return fallback;
  };

  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (selectedKinds.size > 0) n++;
    if (dateAfter || (dateBefore && dateBefore !== todayStr)) n++;
    return n;
  }, [selectedKinds, dateAfter, dateBefore, todayStr]);

  const clearAllFilters = useCallback(() => {
    setSelectedKinds(new Set());
    setDateAfter("");
    setDateBefore(todayStr);
  }, [todayStr]);

  const toggleDay = useCallback((label: string) => {
    setCollapsedDays((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  const toggleKind = useCallback((k: DisplayKind) => {
    setSelectedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const sf: FeedFilterState = {
    selectedKinds,
    toggleKind,
    dateAfter,
    setDateAfter,
    dateBefore,
    setDateBefore,
    activeFilterCount,
    clearAll: clearAllFilters,
    filtersOpen,
    setFiltersOpen,
    filterRef,
  };

  useEffect(() => {
    if (!filtersOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node))
        setFiltersOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [filtersOpen]);

  // Both maps move together - a merge changes where an item is and where it
  // came from - so they share one refresh and one set of listeners.
  const refreshShares = useCallback(() => {
    invoke<Record<string, string[]>>("sync_get_entry_shares")
      .then(setEntryShares)
      .catch(() => {});
    invoke<string[]>("sync_get_remote_entries")
      .then((keys) => setRemoteKeys(new Set(keys)))
      .catch(() => {});
  }, []);

  const refreshInvites = useCallback(() => {
    invoke<SyncInviteList>("sync_list_invites")
      .then(setInvites)
      .catch(() => {});
  }, []);

  // Reads the server and recovers keyrings on the way, so it is the mount
  // path and the answer to a real membership change - not to presence ticks.
  const reloadSpaces = useCallback(() => {
    invoke<Space[]>("spaces_list")
      .then((list) => {
        setSpaces(list);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(() => {
    // First visit of the launch: the local list lands in one call, while
    // spaces_list goes to the server and recovers keyrings on the way.
    if (!cache.loaded) {
      invoke<Space[]>("spaces_cached")
        .then((list) => {
          if (list.length > 0)
            setSpaces((cur) => (cur.length > 0 ? cur : list));
        })
        .catch(() => {});
    }
    reloadSpaces();
    refreshShares();
    refreshInvites();
    invoke<Record<string, SendFilter>>("space_get_send_filters")
      .then(setSendFilters)
      .catch(() => {});
    invoke<{ user_id: string } | null>("sync_get_user")
      .then((u) => setSelfUserId(u?.user_id ?? null))
      .catch(() => setSelfUserId(null));
  }, [syncConnected, reloadSpaces, refreshShares, refreshInvites]);

  // Auto-copy is per device, so it is read from local settings per space.
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      spaces.map((s) =>
        invoke<boolean | null>("get_setting", { key: `space_autocopy:${s.id}` })
          .then((v) => [s.id, v === true] as const)
          .catch(() => [s.id, false] as const),
      ),
    ).then((pairs) => {
      if (!cancelled) setAutocopy(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [spaces]);

  // Where an item went lives outside the item model, so it needs its own
  // refresh whenever something is pushed or merged.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    for (const event of [
      "sync:history-merged",
      "sync:notes-merged",
      "sync:entry-synced",
      "sync:note-synced",
    ]) {
      listen(event, refreshShares).then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      });
    }
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [refreshShares]);

  // Space events. Presence only moved a dot, so it re-reads the cached list
  // instead of paying for a full reconcile.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    const track = (p: Promise<() => void>) => {
      p.then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      });
    };
    track(
      listen("space:presence-changed", () => {
        invoke<Space[]>("spaces_cached")
          .then(setSpaces)
          .catch(() => {});
      }),
    );
    track(listen("space:membership-changed", reloadSpaces));
    track(listen("space:key-received", reloadSpaces));
    track(
      listen<SyncInvite>("sync:invite-received", (event) => {
        setInvites((prev) => ({
          ...prev,
          received: [
            event.payload,
            ...prev.received.filter((i) => i.id !== event.payload.id),
          ],
        }));
      }),
    );
    track(
      listen("sync:invite-updated", () => {
        refreshInvites();
        reloadSpaces();
      }),
    );
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [reloadSpaces, refreshInvites]);

  useEffect(() => {
    setDetailItem(null);
    setSpaceError(null);
  }, [selectedId]);

  // Keep the next visit's starting point current. Assignments only, so it can
  // run every render without a dependency list to keep in sync.
  useEffect(() => {
    cache.loaded = loaded;
    cache.spaces = spaces;
    cache.selfUserId = selfUserId;
    cache.shares = entryShares;
    cache.remote = [...remoteKeys];
    cache.invites = invites;
    cache.filters = sendFilters;
    cache.autocopy = autocopy;
  });

  useEffect(() => {
    if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId);
    else localStorage.removeItem(SELECTED_KEY);
  }, [selectedId]);

  // The remembered space may have been deleted or left from another device.
  // Only judge that once the list is real, or a restore would drop itself.
  useEffect(() => {
    if (!loaded || !selectedId) return;
    if (!spaces.some((s) => s.id === selectedId)) setSelectedId(null);
  }, [loaded, spaces, selectedId]);

  // Membership is server truth: an item is in a space when the share record
  // says so. Local group names are tags, and tagging shares nothing.
  const allFeedItems = useMemo((): FeedItem[] => {
    if (!selected) return [];
    const inSpace = (shareKey: string) =>
      !!entryShares[shareKey]?.includes(selected.id);
    const items: FeedItem[] = [];
    if (feedFilter !== "notes")
      for (const entry of entries)
        if (inSpace(`clipboard:${entry.id}`))
          items.push({ kind: "clipboard", entry });
    if (feedFilter !== "clipboard")
      for (const note of notes)
        if (inSpace(`note:${note.id}`)) items.push({ kind: "note", note });
    return items;
  }, [selected, feedFilter, entries, notes, entryShares]);

  const feedItems = useMemo((): FeedItem[] => {
    let pool = allFeedItems;
    if (selectedKinds.size > 0)
      pool = pool.filter(
        (item) =>
          item.kind === "note" ||
          selectedKinds.has(deriveDisplayKind(item.entry)),
      );
    if (dateAfter) {
      const ts = new Date(dateAfter + "T00:00:00").getTime();
      pool = pool.filter(
        (item) =>
          (item.kind === "clipboard"
            ? item.entry.timestamp
            : item.note.updated_at) >= ts,
      );
    }
    if (dateBefore) {
      const ts = new Date(dateBefore + "T23:59:59.999").getTime();
      pool = pool.filter(
        (item) =>
          (item.kind === "clipboard"
            ? item.entry.timestamp
            : item.note.updated_at) <= ts,
      );
    }
    if (search.trim())
      pool = pool.filter((item) => matchesSearch(item, search.trim()));

    const sorted = [...pool];
    const getTs = (item: FeedItem) =>
      item.kind === "clipboard" ? item.entry.timestamp : item.note.updated_at;
    const getText = (item: FeedItem) =>
      item.kind === "clipboard"
        ? extractNoteText(item.entry.content)
        : item.note.title || "";
    switch (sort) {
      case "oldest":
        sorted.sort((a, b) => getTs(a) - getTs(b));
        break;
      case "a-z":
        sorted.sort((a, b) => getText(a).localeCompare(getText(b)));
        break;
      case "z-a":
        sorted.sort((a, b) => getText(b).localeCompare(getText(a)));
        break;
      case "type":
        sorted.sort((a, b) => {
          const ka =
            a.kind === "note" ? "zzz-note" : deriveDisplayKind(a.entry);
          const kb =
            b.kind === "note" ? "zzz-note" : deriveDisplayKind(b.entry);
          return ka.localeCompare(kb);
        });
        break;
      default:
        sorted.sort((a, b) => getTs(b) - getTs(a));
    }
    return sorted;
  }, [allFeedItems, selectedKinds, dateAfter, dateBefore, search, sort]);

  const feedByDay = useMemo(() => {
    const days: { label: string; items: FeedItem[] }[] = [];
    let current: { label: string; items: FeedItem[] } | null = null;
    for (const item of feedItems) {
      const ts =
        item.kind === "clipboard" ? item.entry.timestamp : item.note.updated_at;
      const label = dayLabel(ts);
      if (!current || current.label !== label) {
        current = { label, items: [] };
        days.push(current);
      }
      current.items.push(item);
    }
    return days;
  }, [feedItems]);

  // ── Space actions ───────────────────────────────────────────────────

  const handleCreate = useCallback(
    async (name: string, shareHistory: boolean) => {
      setFormLoading(true);
      setSpaceError(null);
      try {
        const space = await invoke<Space>("space_create", {
          name,
          shareHistory,
        });
        setSpaces((prev) => [...prev, space]);
        setSelectedId(space.id);
        setShowCreate(false);
      } catch (e) {
        setSpaceError(errMsg(e, "Could not create the space."));
      } finally {
        setFormLoading(false);
      }
    },
    [],
  );

  const handleJoin = useCallback(
    async (inviteCode: string) => {
      setFormLoading(true);
      setSpaceError(null);
      try {
        await invoke("space_join", { inviteCode });
        setShowJoin(false);
        reloadSpaces();
      } catch (e) {
        setSpaceError(errMsg(e, "Could not join with that code."));
      } finally {
        setFormLoading(false);
      }
    },
    [reloadSpaces],
  );

  const handleLeave = useCallback(async (spaceId: string) => {
    setSpaceError(null);
    try {
      await invoke("space_leave", { spaceId });
      setSpaces((prev) => prev.filter((s) => s.id !== spaceId));
      setSelectedId((cur) => (cur === spaceId ? null : cur));
    } catch (e) {
      setSpaceError(errMsg(e, "Could not leave the space."));
    }
  }, []);

  const handleDelete = useCallback(async (spaceId: string) => {
    setSpaceError(null);
    try {
      await invoke("space_delete", { spaceId });
      setSpaces((prev) => prev.filter((s) => s.id !== spaceId));
      setSelectedId((cur) => (cur === spaceId ? null : cur));
    } catch (e) {
      setSpaceError(errMsg(e, "Could not delete the space."));
    }
  }, []);

  const handleRemoveMember = useCallback(
    async (spaceId: string, memberUserId: string) => {
      setSpaceError(null);
      try {
        await invoke("space_remove_member", { spaceId, memberUserId });
        reloadSpaces();
      } catch (e) {
        setSpaceError(errMsg(e, "Could not remove the member."));
      }
    },
    [reloadSpaces],
  );

  const handleInvite = useCallback(
    async (spaceId: string, email: string) => {
      setSpaceError(null);
      try {
        await invoke("sync_send_invite", { spaceId, email });
        refreshInvites();
      } catch (e) {
        setSpaceError(errMsg(e, "Could not send the invite."));
      }
    },
    [refreshInvites],
  );

  const handleSetAutocopy = useCallback(
    async (spaceId: string, enabled: boolean) => {
      setAutocopy((prev) => ({ ...prev, [spaceId]: enabled }));
      try {
        await invoke("space_set_autocopy", { spaceId, enabled });
      } catch (e) {
        setAutocopy((prev) => ({ ...prev, [spaceId]: !enabled }));
        setSpaceError(errMsg(e, "Could not change auto-copy."));
      }
    },
    [],
  );

  const handleSetFilter = useCallback(
    async (spaceId: string, filter: SendFilter) => {
      const previous = sendFilters[spaceId];
      setSendFilters((prev) => ({ ...prev, [spaceId]: filter }));
      try {
        await invoke("space_set_send_filter", { spaceId, filter });
      } catch (e) {
        setSendFilters((prev) => {
          const next = { ...prev };
          if (previous) next[spaceId] = previous;
          else delete next[spaceId];
          return next;
        });
        setSpaceError(errMsg(e, "Could not save the filter."));
      }
    },
    [sendFilters],
  );

  const handleAcceptInvite = useCallback(
    async (inviteId: string) => {
      setSpaceError(null);
      try {
        await invoke("sync_accept_invite", { inviteId });
        refreshInvites();
        reloadSpaces();
      } catch (e) {
        setSpaceError(errMsg(e, "Could not accept the invite."));
      }
    },
    [refreshInvites, reloadSpaces],
  );

  const handleDeclineInvite = useCallback(
    async (inviteId: string) => {
      try {
        await invoke("sync_decline_invite", { inviteId });
        refreshInvites();
      } catch (e) {
        setSpaceError(errMsg(e, "Could not decline the invite."));
      }
    },
    [refreshInvites],
  );

  const handleRevokeInvite = useCallback(
    async (inviteId: string) => {
      try {
        await invoke("sync_revoke_invite", { inviteId });
        refreshInvites();
      } catch (e) {
        setSpaceError(errMsg(e, "Could not revoke the invite."));
      }
    },
    [refreshInvites],
  );

  const receivedPending = invites.received.filter(
    (i) => i.status === "pending",
  );
  const sentPending = invites.sent.filter((i) => i.status === "pending");

  const isFiltering = search.trim().length > 0 || activeFilterCount > 0;
  const feedFilterIndex =
    feedFilter === "all" ? 0 : feedFilter === "clipboard" ? 1 : 2;

  const selectedFilter = selected
    ? (sendFilters[selected.id] ?? DEFAULT_FILTER)
    : DEFAULT_FILTER;
  const selectedRules = filterRuleCount(sendFilters[selected?.id ?? ""]);

  const leftSlot = (
    <div className="sp-filter-tabs">
      <div className="sp-feed-segment">
        <div
          className="sp-feed-segment-slider"
          style={{ transform: `translateX(${feedFilterIndex * 100}%)` }}
        />
        <button
          className={`sp-feed-seg-btn${feedFilter === "all" ? " sp-feed-seg-btn--active" : ""}`}
          onClick={() => setFeedFilter("all")}
          data-tooltip="All items"
          data-tooltip-pos="below"
        >
          <SquaresFour size={12} weight="regular" />
        </button>
        <button
          className={`sp-feed-seg-btn${feedFilter === "clipboard" ? " sp-feed-seg-btn--active" : ""}`}
          onClick={() => setFeedFilter("clipboard")}
          data-tooltip="Clipboard only"
          data-tooltip-pos="below"
        >
          <Clipboard size={11} />
        </button>
        <button
          className={`sp-feed-seg-btn${feedFilter === "notes" ? " sp-feed-seg-btn--active" : ""}`}
          onClick={() => setFeedFilter("notes")}
          data-tooltip="Notes only"
          data-tooltip-pos="below"
        >
          <NoteIcon size={11} />
        </button>
      </div>
      <div className="cs-toolbar-sep" />
      <SortDropdown
        sort={sort}
        onSortChange={(s) => {
          setSort(s);
          localStorage.setItem("spaces-sort", s);
        }}
      />
      <FeedFilterDropdown sf={sf} feedFilter={feedFilter} />
    </div>
  );

  const rightSlot = (
    <LayoutSegment
      layout={layout}
      onLayoutChange={(l) => {
        setLayout(l);
        localStorage.setItem("spaces-layout", l);
      }}
      tilesLabel="Cards"
      listLabel="Rows"
      listIcon={<RowsIcon size={12} />}
    />
  );

  return (
    <div
      className={`sp-screen${dragging ? " sp-screen--dragging" : ""}`}
      ref={screenRef}
    >
      <div className="sp-feed-panel">
        <Topbar
          leftSlot={leftSlot}
          rightSlot={rightSlot}
          searchQuery={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search in space..."
          searchInputRef={searchRef}
        />

        {selected ? (
          <>
            <div className="sp-feed-header">
              <div className="sp-feed-header-left">
                <span className="sp-feed-space-name">{selected.name}</span>
                <span className="sp-feed-member-count">
                  <Users size={10} />
                  {selected.member_count} member
                  {selected.member_count === 1 ? "" : "s"}
                </span>
                <span className="sp-feed-item-count">
                  {feedItems.length} item{feedItems.length === 1 ? "" : "s"}
                  {isFiltering && allFeedItems.length !== feedItems.length && (
                    <span className="sp-feed-filtered-hint">
                      {" "}
                      of {allFeedItems.length}
                    </span>
                  )}
                </span>
                {autocopy[selected.id] && (
                  <span className="sp-feed-flag">
                    <Clipboard size={9} />
                    auto-copy on
                  </span>
                )}
                {selectedRules > 0 && (
                  <span className="sp-feed-flag">
                    <Funnel size={9} />
                    auto-share on
                  </span>
                )}
              </div>
            </div>

            {detailItem ? (
              detailItem.kind === "note" ? (
                <ReadOnlyNotePanel
                  key={detailItem.note.id}
                  note={detailItem.note}
                  entries={entries}
                  onClose={() => setDetailItem(null)}
                />
              ) : (
                <DetailPanel
                  entry={detailItem.entry}
                  onClose={() => setDetailItem(null)}
                  onCopy={onCopyEntry}
                />
              )
            ) : (
              <div className="sp-feed-scroll">
                {feedItems.length === 0 ? (
                  <div className="sp-feed-empty">
                    <MagnifyingGlass size={38} />
                    <span className="sp-feed-empty-title">
                      {isFiltering ? "No results" : "Nothing shared yet"}
                    </span>
                    <span className="sp-feed-empty-sub">
                      {search.trim()
                        ? `Nothing matches "${search.trim()}"${activeFilterCount > 0 ? " with current filters" : ""}`
                        : activeFilterCount > 0
                          ? "No items match the current filters"
                          : feedFilter !== "all"
                            ? `No ${feedFilter} items in this space`
                            : "Right-click an item and pick Share to space, or turn on auto-share in space settings."}
                    </span>
                    {activeFilterCount > 0 && (
                      <button
                        className="sp-clear-filters-btn"
                        onClick={clearAllFilters}
                      >
                        Clear filters
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="sp-timeline-wrap">
                    <div className="sp-timeline-groups">
                      {feedByDay.map(({ label, items }, idx) => (
                        <div
                          key={label}
                          className={`sp-timeline-group${
                            feedByDay.length === 1
                              ? " sp-timeline-group--only"
                              : idx === feedByDay.length - 1
                                ? " sp-timeline-group--last"
                                : ""
                          }`}
                        >
                          <button
                            className={`sp-timeline-day-row${collapsedDays.has(label) ? " sp-timeline-day-row--collapsed" : ""}`}
                            onClick={() => toggleDay(label)}
                          >
                            <div className="sp-timeline-day-dot" />
                            <span className="sp-timeline-day-label">
                              {label}
                            </span>
                            {collapsedDays.has(label) && (
                              <span className="sp-timeline-day-count">
                                {items.length}
                              </span>
                            )}
                            <CaretDown
                              className="sp-timeline-day-chevron"
                              size={10}
                            />
                          </button>
                          <div
                            className={`sp-timeline-group-body${collapsedDays.has(label) ? " sp-timeline-group-body--collapsed" : ""}`}
                          >
                            <div className="sp-timeline-group-body__inner">
                              <div
                                className={
                                  layout === "tiles"
                                    ? "sp-feed-card-grid"
                                    : "sp-feed-card-list"
                                }
                              >
                                {items.map((item) =>
                                  item.kind === "clipboard" ? (
                                    <ClipFeedCard
                                      key={item.entry.id}
                                      entry={item.entry}
                                      onCopy={onCopyEntry}
                                      onView={(e) =>
                                        setDetailItem({
                                          kind: "clipboard",
                                          entry: e,
                                        })
                                      }
                                      layout={layout}
                                      showSourceBadge={feedFilter === "all"}
                                      incoming={remoteKeys.has(
                                        `clipboard:${item.entry.id}`,
                                      )}
                                    />
                                  ) : (
                                    <NoteFeedCard
                                      key={item.note.id}
                                      note={item.note}
                                      entries={entries}
                                      onView={(n) =>
                                        setDetailItem({ kind: "note", note: n })
                                      }
                                      layout={layout}
                                      showSourceBadge={feedFilter === "all"}
                                      incoming={remoteKeys.has(
                                        `note:${item.note.id}`,
                                      )}
                                    />
                                  ),
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                      <div className="sp-timeline-end">
                        <span className="sp-timeline-end-text">
                          You are all caught up
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="sp-no-selection">
            <div className="sp-no-selection-inner">
              <Users size={40} />
              <span className="sp-no-selection-title">
                {spaces.length === 0 ? "No spaces yet" : "Pick a space"}
              </span>
              <span className="sp-no-selection-sub">
                {spaces.length === 0
                  ? "A space shares clipboard items and notes with other people, live and end-to-end encrypted. Create one, or join with an invite code."
                  : "Choose a space on the right to see what is shared in it."}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Rules column: what this space does with items, in and out. Pinned
          rather than collapsible - these are the settings a member checks
          while reading the feed, not a dialog they open once. */}
      {/* Past this width the invite actions have room to say what they do, so
          they stop being icon-only. */}
      <aside
        className={`sp-rules${rulesWidth >= RULES_LABEL_WIDTH ? " sp-rules--wide" : ""}`}
        style={{ width: rulesWidth }}
      >
        <button
          type="button"
          className={`sp-resizer sp-resizer--left${
            dragging === "rules" ? " sp-resizer--active" : ""
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            setDragging("rules");
          }}
          onDoubleClick={() => setRulesWidth(RULES_PANE.def)}
          aria-label="Resize the rules panel"
          data-tooltip="Drag to resize"
          data-tooltip-pos="left"
        />
        {selected ? (
          <SpaceSettings
            space={selected}
            selfUserId={selfUserId}
            autocopy={autocopy[selected.id] === true}
            onAutocopy={(enabled) => handleSetAutocopy(selected.id, enabled)}
            filter={selectedFilter}
            onFilter={(next) => handleSetFilter(selected.id, next)}
            availableGroups={availableGroups}
            onInvite={(email) => handleInvite(selected.id, email)}
            onRemoveMember={(uid) => handleRemoveMember(selected.id, uid)}
            onLeave={() => handleLeave(selected.id)}
            onDelete={() => handleDelete(selected.id)}
            error={spaceError}
          />
        ) : (
          <RulesPlaceholder hasSpaces={spaces.length > 0} />
        )}
      </aside>

      {/* Space list */}
      <aside className="sp-panel-right" style={{ width: listWidth }}>
        <button
          type="button"
          className={`sp-resizer sp-resizer--right${
            dragging === "list" ? " sp-resizer--active" : ""
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            setDragging("list");
          }}
          onDoubleClick={() => setListWidth(LIST_PANE.def)}
          aria-label="Resize the space list"
          data-tooltip="Drag to resize"
          data-tooltip-pos="right"
        />
        <div className="sp-panel-header">
          <span className="sp-panel-title">Spaces</span>
          <span
            className={`sp-conn-chip sp-conn-chip--${
              !signedIn
                ? "idle"
                : syncConnected === true
                  ? "on"
                  : syncConnected === false
                    ? "off"
                    : "idle"
            }`}
          >
            <span className="sp-conn-dot" />
            {/* Account first: a socket state left over from an earlier session
                said "Live" on a signed-out device. */}
            {!signedIn
              ? "Signed out"
              : syncConnected === true
                ? "Live"
                : syncConnected === false
                  ? "Offline"
                  : "Inactive"}
          </span>
        </div>

        <div className="sp-panel-scroll">
          {receivedPending.length > 0 && (
            <div className="sp-invite-strip">
              {receivedPending.map((inv) => (
                <div key={inv.id} className="sp-invite-card">
                  <Envelope size={14} className="sp-invite-icon" />
                  <span className="sp-invite-text">
                    <strong>{inv.inviter_name || "Someone"}</strong> invited you
                    to {inv.space_name}
                  </span>
                  <div className="sp-invite-actions">
                    <button
                      className="sp-btn sp-btn--primary"
                      onClick={() => handleAcceptInvite(inv.id)}
                    >
                      Accept
                    </button>
                    <button
                      className="sp-btn"
                      onClick={() => handleDeclineInvite(inv.id)}
                    >
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {spaceError && (
            <span className="sp-settings-error">{spaceError}</span>
          )}

          {/* Nothing until the first read answers: "No spaces yet" is a claim,
              and flashing it at someone who has spaces reads as data loss. */}
          {spaces.length === 0 && !loaded ? null : spaces.length === 0 ? (
            <div className="sp-panel-empty">
              <span className="sp-panel-empty-icon">
                <Users size={22} />
              </span>
              <span className="sp-panel-empty-title">
                {!signedIn
                  ? "Not signed in"
                  : syncConnected === false
                    ? "Offline"
                    : "No spaces yet"}
              </span>
              <span className="sp-panel-empty-sub">
                {!signedIn
                  ? "Sign in on the Account screen to share."
                  : syncConnected === false
                    ? "Reconnecting..."
                    : "Create a space, or join one with an invite code."}
              </span>
            </div>
          ) : (
            <div className="sp-space-section">
              {spaceGroups.map((group) => (
                <React.Fragment key={group.title}>
                  {spaceGroups.length > 1 && (
                    <div className="sp-space-group">
                      {group.title}
                      <span className="sp-space-group-n">
                        {group.spaces.length}
                      </span>
                      <span className="sp-space-group-rule" />
                    </div>
                  )}
                  {group.spaces.map((space) => {
                const isActive = space.id === selectedId;
                const online = space.members.filter((m) => m.online).length;
                const rules = filterRuleCount(sendFilters[space.id]);
                return (
                  <button
                    key={space.id}
                    className={`sp-space-card${isActive ? " active" : ""}`}
                    onClick={() => setSelectedId(space.id)}
                  >
                    <span
                      className="sp-space-avatar"
                      style={{ background: spaceAvatarColor(space.id) }}
                    >
                      {space.name.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="sp-space-card-body">
                      <span className="sp-space-card-name">{space.name}</span>
                      <span className="sp-space-card-meta">
                        {space.member_count} member
                        {space.member_count === 1 ? "" : "s"}
                        {space.members.length > 0 ? ` - ${online} online` : ""}
                      </span>
                    </span>
                    <span className="sp-space-card-flags">
                      {space.is_owner && (
                        <span className="sp-badge sp-badge--owner">owner</span>
                      )}
                      {autocopy[space.id] && (
                        <span
                          className="sp-flag-dot"
                          data-tooltip="Copies new items to your clipboard"
                          data-tooltip-pos="left"
                        >
                          <Clipboard size={9} />
                        </span>
                      )}
                      {rules > 0 && (
                        <span
                          className="sp-flag-dot"
                          data-tooltip="Shares matching new items automatically"
                          data-tooltip-pos="left"
                        >
                          <Funnel size={9} />
                        </span>
                      )}
                    </span>
                  </button>
                );
                  })}
                </React.Fragment>
              ))}

              {sentPending.length > 0 && (
                <div className="sp-sent-list">
                  {sentPending.map((inv) => (
                    <div key={inv.id} className="sp-sent-row">
                      <Envelope size={12} />
                      <span className="sp-sent-text">
                        {inv.invitee_email} invited to {inv.space_name}
                      </span>
                      <button
                        className="sp-linkbtn"
                        onClick={() => handleRevokeInvite(inv.id)}
                      >
                        Revoke
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="sp-panel-actions">
          {showCreate && (
            <CreateForm
              onSubmit={handleCreate}
              onCancel={() => setShowCreate(false)}
              loading={formLoading}
            />
          )}
          {showJoin && (
            <JoinForm
              onSubmit={handleJoin}
              onCancel={() => setShowJoin(false)}
              loading={formLoading}
            />
          )}
          {!showCreate && !showJoin && (
            <div className="sp-panel-btns">
              <button
                className="sp-action-btn sp-action-btn--primary"
                disabled={!signedIn}
                onClick={() => {
                  setShowCreate(true);
                  setShowJoin(false);
                  setSpaceError(null);
                }}
                data-tooltip={
                  signedIn
                    ? "Create a new space"
                    : "Sign in on the Account screen first"
                }
                data-tooltip-pos="top"
              >
                <Plus size={11} />
                Create
              </button>
              <button
                className="sp-action-btn"
                disabled={!signedIn}
                onClick={() => {
                  setShowJoin(true);
                  setShowCreate(false);
                  setSpaceError(null);
                }}
                data-tooltip={
                  signedIn
                    ? "Join with an invite code"
                    : "Sign in on the Account screen first"
                }
                data-tooltip-pos="top"
              >
                <Key size={11} />
                Join
              </button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
};

export default SpacesScreen;
