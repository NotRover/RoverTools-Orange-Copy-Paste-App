import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SquaresFour } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import type { ClipboardEntry, DisplayKind, Note, SyncGroup, SharingSession } from "../../../types";
import {
  timeAgo,
  truncateText,
  htmlPlainText,
  filePaths,
  fileNameFromPath,
  deriveDisplayKind,
} from "../../../types";
import { EntryTypePill } from "../../entry-types/EntryTypePill";
import {
  PinIcon as PinIconElement,
  SaveIcon as SaveIconElement,
  TYPE_ICONS,
  TYPE_LABELS,
} from "../../entry-types/EntryTypePill";
import Topbar, { SortDropdown, LayoutSegment } from "../topbar/Topbar";
import type { ClipboardLayout } from "../topbar/Topbar";
import type { SortMode } from "../sort-options";
import "../clipboard-screen/search-filter/SearchFilter.css";
import {
  PlusIcon,
  KeyIcon,
  UsersIcon,
  ShareIcon,
  CloseIcon,
  CheckIcon,
  LogOutIcon,
  CopyIcon,
  ChevronRightIcon,
  OnlineDotIcon,
  NotesIcon,
  FileIcon,
  SearchXIcon,
  ClipboardIcon,
  FilterIcon,
} from "../../icons";
import "./SyncScreen.css";

// ── Types ─────────────────────────────────────────────────────────────

type FeedFilter = "all" | "clipboard" | "notes";
type SelectedGroup =
  | { kind: "local"; name: string }
  | { kind: "sync"; group: SyncGroup }
  | { kind: "share"; session: SharingSession };
type FeedItem =
  | { kind: "clipboard"; entry: ClipboardEntry }
  | { kind: "note"; note: Note };

const ALL_DISPLAY_KINDS: DisplayKind[] = [
  "text", "url", "html", "image", "video", "document", "file", "folder",
];

const AVATAR_PALETTE = [
  "#ff3e1c", "#f59e0b", "#22c55e", "#3b82f6",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
];

function groupAvatarColor(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
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
        if (Array.isArray(node.content)) node.content.forEach((n) => walk(n as typeof node));
      };
      walk(doc as { text?: string; content?: unknown[] });
      return texts.join(" ").replace(/\s+/g, " ").trim();
    }
  } catch { /* legacy HTML */ }
  return content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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
    if (entry.type === "text") return entry.content.toLowerCase().includes(lower);
    if (entry.type === "html") return htmlPlainText(entry.content).toLowerCase().includes(lower);
    if (entry.type === "file") return entry.content.toLowerCase().includes(lower);
    return false;
  }
  return (
    item.note.title.toLowerCase().includes(lower) ||
    extractNoteText(item.note.content).toLowerCase().includes(lower)
  );
}

// ── Tiptap → React (read-only) ────────────────────────────────────────

type TiptapMark = { type: string };
type TiptapNode = {
  type: string; text?: string; content?: TiptapNode[];
  marks?: TiptapMark[]; attrs?: Record<string, unknown>;
};

function renderInline(node: TiptapNode, i: number): React.ReactNode {
  if (node.type === "hardBreak") return <br key={i} />;
  if (node.type !== "text") return null;
  let el: React.ReactNode = node.text ?? "";
  if (node.marks?.some((m) => m.type === "bold")) el = <strong key={`b${i}`}>{el}</strong>;
  if (node.marks?.some((m) => m.type === "italic")) el = <em key={`i${i}`}>{el}</em>;
  if (node.marks?.some((m) => m.type === "underline")) el = <u key={`u${i}`}>{el}</u>;
  if (node.marks?.some((m) => m.type === "strike")) el = <s key={`s${i}`}>{el}</s>;
  if (node.marks?.some((m) => m.type === "code"))
    el = <code key={`c${i}`} className="sync-detail-inline-code">{el}</code>;
  return <React.Fragment key={i}>{el}</React.Fragment>;
}

function renderTiptapNode(node: TiptapNode, i: number): React.ReactNode {
  const inline = node.content?.map(renderInline) ?? [];
  const block = node.content?.map((n, j) => renderTiptapNode(n, j)) ?? [];
  switch (node.type) {
    case "paragraph":
      return node.content?.length
        ? <p key={i} className="sync-detail-para">{inline}</p>
        : <div key={i} className="sync-detail-spacer" />;
    case "heading": {
      const lvl = Math.min(Number(node.attrs?.level ?? 1), 6);
      const Tag = `h${lvl}` as "h1"|"h2"|"h3"|"h4"|"h5"|"h6";
      return <Tag key={i} className={`sync-detail-h${lvl}`}>{inline}</Tag>;
    }
    case "bulletList":  return <ul key={i} className="sync-detail-list">{block}</ul>;
    case "orderedList": return <ol key={i} className="sync-detail-list sync-detail-list--ordered">{block}</ol>;
    case "listItem":    return <li key={i}>{node.content?.map((n, j) => renderTiptapNode(n, j))}</li>;
    case "blockquote":  return <blockquote key={i} className="sync-detail-blockquote">{block}</blockquote>;
    case "codeBlock":
      return <pre key={i} className="sync-detail-code"><code>{node.content?.map((n) => n.text ?? "").join("")}</code></pre>;
    case "horizontalRule": return <hr key={i} className="sync-detail-hr" />;
    case "text": return renderInline(node, i);
    default: return null;
  }
}

function TiptapView({ content }: { content: string }) {
  const nodes = useMemo((): React.ReactNode => {
    try {
      const doc = JSON.parse(content) as TiptapNode;
      if (doc.type === "doc" && Array.isArray(doc.content))
        return doc.content.map((n, i) => renderTiptapNode(n, i));
    } catch { /* legacy */ }
    const plain = extractNoteText(content);
    return plain ? <p className="sync-detail-para">{plain}</p> : null;
  }, [content]);
  return <div className="sync-detail-rich">{nodes}</div>;
}

// ── Filter dropdown ───────────────────────────────────────────────────

interface SyncFilterState {
  pinnedOnly: boolean; setPinnedOnly: React.Dispatch<React.SetStateAction<boolean>>;
  savedOnly: boolean;  setSavedOnly:  React.Dispatch<React.SetStateAction<boolean>>;
  selectedKinds: Set<DisplayKind>; toggleKind: (k: DisplayKind) => void;
  dateAfter: string; setDateAfter: (v: string) => void;
  dateBefore: string; setDateBefore: (v: string) => void;
  activeFilterCount: number; clearAll: () => void;
  filtersOpen: boolean; setFiltersOpen: React.Dispatch<React.SetStateAction<boolean>>;
  filterRef: React.RefObject<HTMLDivElement | null>;
}

const SyncFilterDropdown: React.FC<{ sf: SyncFilterState; feedFilter: FeedFilter }> = ({ sf, feedFilter }) => {
  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);
  const dateActive = !!(sf.dateAfter || (sf.dateBefore && sf.dateBefore !== todayStr));

  return (
    <div className="sort-dropdown" ref={sf.filterRef}>
      <button
        className={`cs-tb-btn${sf.filtersOpen ? " cs-tb-btn--open" : ""}`}
        onClick={() => { if (!sf.filtersOpen) document.dispatchEvent(new Event("tooltip:hide")); sf.setFiltersOpen((v) => !v); }}
        data-tooltip="Filters" data-tooltip-pos="below"
      >
        <FilterIcon size={12} />
        {sf.activeFilterCount > 0 && <span className="cs-tb-badge">{sf.activeFilterCount}</span>}
      </button>
      {sf.filtersOpen && (
        <div className="cs-filter-card">
          {/* System */}
          <div className="cs-card-section">
            <div className="cs-section-label">
              System
              {((sf.pinnedOnly ? 1 : 0) + (sf.savedOnly ? 1 : 0)) > 0 && (
                <span className="cs-count">{(sf.pinnedOnly ? 1 : 0) + (sf.savedOnly ? 1 : 0)}</span>
              )}
            </div>
            <div className="cs-type-grid">
              <label className={`cs-type-option${sf.pinnedOnly ? " cs-type-option--on" : ""}`}>
                <input type="checkbox" checked={sf.pinnedOnly} onChange={() => sf.setPinnedOnly((v) => !v)} className="cs-type-cb" />
                <span className="cs-type-icon type-pill" style={{ background: "var(--accent-dim)", color: "var(--accent)" }}>{PinIconElement}</span>
                <span className="cs-type-name">Pinned</span>
              </label>
              {feedFilter !== "notes" && (
                <label className={`cs-type-option${sf.savedOnly ? " cs-type-option--on" : ""}`}>
                  <input type="checkbox" checked={sf.savedOnly} onChange={() => sf.setSavedOnly((v) => !v)} className="cs-type-cb" />
                  <span className="cs-type-icon type-pill" style={{ background: "rgba(34,197,94,0.12)", color: "#22c55e" }}>{SaveIconElement}</span>
                  <span className="cs-type-name">Saved</span>
                </label>
              )}
            </div>
          </div>
          {/* Clipboard types */}
          {feedFilter !== "notes" && (
            <>
              <div className="cs-card-divider" />
              <div className="cs-card-section">
                <div className="cs-section-label">
                  Clipboard Types
                  {sf.selectedKinds.size > 0 && <span className="cs-count">{sf.selectedKinds.size}</span>}
                </div>
                <div className="cs-type-grid">
                  {ALL_DISPLAY_KINDS.map((k) => (
                    <label key={k} className={`cs-type-option${sf.selectedKinds.has(k) ? " cs-type-option--on" : ""}`}>
                      <input type="checkbox" checked={sf.selectedKinds.has(k)} onChange={() => sf.toggleKind(k)} className="cs-type-cb" />
                      <span className={`cs-type-icon type-pill type-pill--${k}`}>{TYPE_ICONS[k]}</span>
                      <span className="cs-type-name">{TYPE_LABELS[k]}</span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
          {/* Date */}
          <div className="cs-card-divider" />
          <div className="cs-card-section">
            <div className="cs-section-label">Date{dateActive && <span className="cs-count">1</span>}</div>
            <div className="cs-date-row">
              <input type="date" className="cs-date-input" value={sf.dateAfter} onChange={(e) => sf.setDateAfter(e.target.value)} title="After" />
              <span className="cs-date-sep">–</span>
              <input type="date" className="cs-date-input" value={sf.dateBefore} onChange={(e) => sf.setDateBefore(e.target.value)} title="Before" />
            </div>
          </div>
          {sf.activeFilterCount > 0 && (
            <><div className="cs-card-divider" />
            <button className="cs-card-clear-btn" onClick={sf.clearAll}><CloseIcon size={12} />Clear Filters</button></>
          )}
        </div>
      )}
    </div>
  );
};

// ── Clipboard detail body ─────────────────────────────────────────────

function ClipDetailBody({ entry }: { entry: ClipboardEntry }) {
  if (entry.type === "text" || entry.type === "html") {
    const text = entry.type === "html" ? htmlPlainText(entry.content) : entry.content;
    return <p className="sync-detail-entry-text">{text}</p>;
  }
  if (entry.type === "image")
    return <div className="sync-detail-entry-file"><span className="sync-detail-file-name">{entry.label ?? "Image"}</span></div>;
  if (entry.type === "file") {
    const paths = filePaths(entry.content);
    return (
      <div className="sync-detail-file-list">
        {paths.map((p) => (
          <div key={p} className="sync-detail-file-row"><FileIcon size={11} /><span>{fileNameFromPath(p)}</span></div>
        ))}
      </div>
    );
  }
  return <p className="sync-detail-entry-text">{entry.content}</p>;
}

// ── Detail panel ──────────────────────────────────────────────────────

const DetailPanel: React.FC<{ item: FeedItem; onClose: () => void; onCopy: (id: string) => void }> = ({ item, onClose, onCopy }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback(() => {
    if (item.kind !== "clipboard") return;
    onCopy(item.entry.id);
    if (timer.current) clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }, [item, onCopy]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const isNote = item.kind === "note";
  const ts = isNote ? item.note.updated_at : item.entry.timestamp;
  const dk = !isNote ? deriveDisplayKind(item.entry) : null;

  return (
    <div className="sync-detail-panel">
      <div className="sync-detail-toolbar">
        <button className="sync-detail-back" onClick={onClose}>
          <ChevronRightIcon size={11} strokeWidth={2.6} className="sync-detail-back-chevron" />
          Back
        </button>
        <div className="sync-detail-toolbar-right">
          {isNote
            ? <span className="sync-detail-kind-badge sync-detail-kind-badge--note"><NotesIcon size={10} />Note</span>
            : dk && <EntryTypePill kind={dk} />}
          <span className="sync-detail-time">{timeAgo(ts)}</span>
          {!isNote && (
            <button className={`sync-detail-copy-btn${copied ? " sync-detail-copy-btn--done" : ""}`} onClick={handleCopy}>
              {copied ? <><CheckIcon size={11} strokeWidth={2.5} /> Copied!</> : <><CopyIcon size={11} /> Copy</>}
            </button>
          )}
        </div>
      </div>
      <div className="sync-detail-scroll">
        {isNote && <h2 className="sync-detail-note-title">{item.note.title || "(Untitled note)"}</h2>}
        {isNote ? <TiptapView content={item.note.content} /> : <ClipDetailBody entry={item.entry} />}
      </div>
    </div>
  );
};

// ── Clipboard feed card ───────────────────────────────────────────────

const ClipFeedCard: React.FC<{
  entry: ClipboardEntry;
  onCopy: (id: string) => void;
  onView: (entry: ClipboardEntry) => void;
  layout: ClipboardLayout;
}> = ({ entry, onCopy, onView, layout }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onCopy(entry.id);
    if (timer.current) clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, [entry.id, onCopy]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const dk = deriveDisplayKind(entry);

  // ── List mode ──────────────────────────────────────────────────────
  if (layout === "list") {
    const text =
      entry.type === "text" ? entry.content :
      entry.type === "html" ? htmlPlainText(entry.content) :
      entry.type === "file" ? filePaths(entry.content).map(fileNameFromPath).join(", ") :
      entry.label ?? "";
    return (
      <div className="sync-list-card" onClick={() => onView(entry)}>
        <span className="sync-list-type-wrap">
          <EntryTypePill kind={dk} />
        </span>
        <span className="sync-list-text">{truncateText(text, 100)}</span>
        <span className="sync-list-time">{timeAgo(entry.timestamp)}</span>
        <button className={`sync-list-action${copied ? " sync-list-action--done" : ""}`} onClick={handleCopy}>
          {copied ? <CheckIcon size={10} strokeWidth={2.5} /> : <CopyIcon size={10} />}
        </button>
      </div>
    );
  }

  // ── Tiles mode ─────────────────────────────────────────────────────
  let preview: React.ReactNode = null;
  if (entry.type === "text") {
    preview = <p className="card-text">{truncateText(entry.content, 180)}</p>;
  } else if (entry.type === "html") {
    preview = <p className="card-text">{truncateText(htmlPlainText(entry.content) || entry.content, 180)}</p>;
  } else if (entry.type === "image") {
    preview = <p className="card-text--image-name">{entry.label ?? "Image"}</p>;
  } else if (entry.type === "file") {
    const paths = filePaths(entry.content);
    preview = (
      <div className="card-file-preview">
        {paths.slice(0, 3).map((p) => (
          <div key={p} className="card-file-preview-item"><FileIcon size={9} /><span className="card-file-preview-name">{fileNameFromPath(p)}</span></div>
        ))}
        {paths.length > 3 && <p className="card-file-preview-more">+{paths.length - 3} more</p>}
      </div>
    );
  }

  return (
    <div className="entry-card sync-feed-entry-card" onClick={() => onView(entry)}>
      <div className="card-body">
        {preview}
        <div className="card-footer">
          <div className="card-chips"><EntryTypePill kind={dk} /></div>
          <span className="card-time">{timeAgo(entry.timestamp)}</span>
          <button className={`sync-copy-btn${copied ? " sync-copy-btn--done" : ""}`} onClick={handleCopy}>
            {copied ? <CheckIcon size={10} strokeWidth={2.5} /> : <CopyIcon size={10} />}
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Note feed card ────────────────────────────────────────────────────

const NoteFeedCard: React.FC<{
  note: Note;
  onView: (note: Note) => void;
  layout: ClipboardLayout;
}> = ({ note, onView, layout }) => {
  const plain = extractNoteText(note.content);

  // ── List mode ──────────────────────────────────────────────────────
  if (layout === "list") {
    return (
      <div className="sync-list-card sync-list-card--note" onClick={() => onView(note)}>
        <span className="sync-list-note-badge">
          <NotesIcon size={12} />
        </span>
        <div className="sync-list-note-content">
          <span className="sync-list-title">{note.title || "(Untitled note)"}</span>
          {plain && <span className="sync-list-preview">{truncateText(plain, 70)}</span>}
        </div>
        <span className="sync-list-time">{timeAgo(note.updated_at)}</span>
      </div>
    );
  }

  // ── Tiles mode ─────────────────────────────────────────────────────
  return (
    <div className="ns-card sync-feed-note-card" onClick={() => onView(note)}>
      <div className="ns-card-body">
        <p className="ns-card-title">{note.title || "(Untitled note)"}</p>
        {plain && <div className="ns-card-preview">{truncateText(plain, 140)}</div>}
        <div className="ns-card-footer">
          <div className="ns-card-chips">
            <span className="card-type-chip" style={{ background: "var(--accent-dim)", color: "var(--accent)" }}>
              <NotesIcon size={9} /><span className="card-type-label">Note</span>
            </span>
          </div>
          <span className="ns-card-time">{timeAgo(note.updated_at)}</span>
        </div>
      </div>
    </div>
  );
};

// ── Inline form ───────────────────────────────────────────────────────

const InlineForm: React.FC<{ mode: "create"|"join"; onSubmit: (v: string) => void; onCancel: () => void; loading: boolean }> = ({ mode, onSubmit, onCancel, loading }) => {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  return (
    <div className="sync-inline-form">
      <input ref={inputRef} className="sync-inline-input" placeholder={mode === "create" ? "Group name…" : "Invite code…"}
        value={value} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) onSubmit(value.trim()); if (e.key === "Escape") onCancel(); }} />
      <div className="sync-inline-form-actions">
        <button className="sync-inline-btn sync-inline-btn--primary" disabled={!value.trim() || loading} onClick={() => value.trim() && onSubmit(value.trim())}>
          {loading ? "…" : mode === "create" ? "Create" : "Join"}
        </button>
        <button className="sync-inline-btn" onClick={onCancel}><CloseIcon size={10} /></button>
      </div>
    </div>
  );
};


// ── Props ─────────────────────────────────────────────────────────────

interface SyncScreenProps {
  entries: ClipboardEntry[];
  notes: Note[];
  availableGroups: string[];
  syncConnected: boolean | null;
  onCopyEntry: (id: string) => void;
}

// ── Main screen ───────────────────────────────────────────────────────

const SyncScreen: React.FC<SyncScreenProps> = ({ entries, notes, syncConnected, onCopyEntry }) => {
  const [syncGroups, setSyncGroups] = useState<SyncGroup[]>([]);
  const [sessions, setSessions] = useState<SharingSession[]>([]);
  const [selected, setSelected] = useState<SelectedGroup | null>(null);
  const [feedFilter, setFeedFilter] = useState<FeedFilter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>(() => (localStorage.getItem("sync-sort") as SortMode) ?? "newest");
  const [layout, setLayout] = useState<ClipboardLayout>(() => (localStorage.getItem("sync-layout") as ClipboardLayout) ?? "tiles");
  const [detailItem, setDetailItem] = useState<FeedItem | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [inviteCopied, setInviteCopied] = useState<string | null>(null);
  const inviteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Advanced filter state
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [savedOnly, setSavedOnly] = useState(false);
  const [selectedKinds, setSelectedKinds] = useState<Set<DisplayKind>>(new Set());
  const [dateAfter, setDateAfter] = useState("");
  const [dateBefore, setDateBefore] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (pinnedOnly) n++;
    if (savedOnly) n++;
    if (selectedKinds.size > 0) n++;
    if (dateAfter || (dateBefore && dateBefore !== todayStr)) n++;
    return n;
  }, [pinnedOnly, savedOnly, selectedKinds, dateAfter, dateBefore, todayStr]);

  const clearAllFilters = useCallback(() => {
    setPinnedOnly(false); setSavedOnly(false);
    setSelectedKinds(new Set()); setDateAfter(""); setDateBefore(todayStr);
  }, [todayStr]);

  const toggleKind = useCallback((k: DisplayKind) => {
    setSelectedKinds((prev) => { const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next; });
  }, []);

  const sf: SyncFilterState = {
    pinnedOnly, setPinnedOnly, savedOnly, setSavedOnly,
    selectedKinds, toggleKind, dateAfter, setDateAfter, dateBefore, setDateBefore,
    activeFilterCount, clearAll: clearAllFilters, filtersOpen, setFiltersOpen, filterRef,
  };

  // Close filter on outside click
  useEffect(() => {
    if (!filtersOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFiltersOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [filtersOpen]);


  useEffect(() => {
    invoke<SyncGroup[]>("sync_get_groups").then(setSyncGroups).catch(() => setSyncGroups([]));
    invoke<SharingSession[]>("sharing_get_sessions").then(setSessions).catch(() => setSessions([]));
  }, [syncConnected]);

  useEffect(() => { setDetailItem(null); }, [selected]);

  // Base feed items (group + type filter)
  const allFeedItems = useMemo((): FeedItem[] => {
    if (!selected) return [];
    const matchesGroup = (groups: string[]) => {
      if (selected.kind === "local") return groups.includes(selected.name);
      if (selected.kind === "sync") return groups.includes(selected.group.id);
      return groups.includes(selected.session.share_group_id);
    };
    const items: FeedItem[] = [];
    if (feedFilter !== "notes") for (const entry of entries) if (matchesGroup(entry.groups)) items.push({ kind: "clipboard", entry });
    if (feedFilter !== "clipboard") for (const note of notes) if (matchesGroup(note.groups)) items.push({ kind: "note", note });
    return items;
  }, [selected, feedFilter, entries, notes]);

  // Apply search + advanced filters + sort
  const feedItems = useMemo((): FeedItem[] => {
    let pool = allFeedItems;
    if (pinnedOnly) pool = pool.filter((item) => item.kind === "clipboard" ? item.entry.pinned : item.note.pinned);
    if (savedOnly) pool = pool.filter((item) => item.kind === "clipboard" ? item.entry.groups.includes("Saved") : true);
    if (selectedKinds.size > 0) pool = pool.filter((item) => item.kind === "note" || selectedKinds.has(deriveDisplayKind(item.entry)));
    if (dateAfter) {
      const ts = new Date(dateAfter + "T00:00:00").getTime();
      pool = pool.filter((item) => (item.kind === "clipboard" ? item.entry.timestamp : item.note.updated_at) >= ts);
    }
    if (dateBefore) {
      const ts = new Date(dateBefore + "T23:59:59.999").getTime();
      pool = pool.filter((item) => (item.kind === "clipboard" ? item.entry.timestamp : item.note.updated_at) <= ts);
    }
    if (search.trim()) pool = pool.filter((item) => matchesSearch(item, search.trim()));

    const sorted = [...pool];
    const getTs = (item: FeedItem) => item.kind === "clipboard" ? item.entry.timestamp : item.note.updated_at;
    const getText = (item: FeedItem) => item.kind === "clipboard" ? extractNoteText(item.entry.content) : (item.note.title || "");
    switch (sort) {
      case "oldest": sorted.sort((a, b) => getTs(a) - getTs(b)); break;
      case "a-z":    sorted.sort((a, b) => getText(a).localeCompare(getText(b))); break;
      case "z-a":    sorted.sort((a, b) => getText(b).localeCompare(getText(a))); break;
      case "type":
        sorted.sort((a, b) => {
          const ka = a.kind === "note" ? "zzz-note" : deriveDisplayKind(a.entry);
          const kb = b.kind === "note" ? "zzz-note" : deriveDisplayKind(b.entry);
          return ka.localeCompare(kb);
        });
        break;
      default: sorted.sort((a, b) => getTs(b) - getTs(a));
    }
    return sorted;
  }, [allFeedItems, pinnedOnly, savedOnly, selectedKinds, dateAfter, dateBefore, search, sort]);

  const feedByDay = useMemo(() => {
    const days: { label: string; items: FeedItem[] }[] = [];
    let current: { label: string; items: FeedItem[] } | null = null;
    for (const item of feedItems) {
      const ts = item.kind === "clipboard" ? item.entry.timestamp : item.note.updated_at;
      const label = dayLabel(ts);
      if (!current || current.label !== label) { current = { label, items: [] }; days.push(current); }
      current.items.push(item);
    }
    return days;
  }, [feedItems]);

  const handleCreate = useCallback(async (name: string) => {
    setFormLoading(true);
    try { const group = await invoke<SyncGroup>("sync_create_group", { name }); setSyncGroups((prev) => [...prev, group]); setSelected({ kind: "sync", group }); setShowCreate(false); }
    catch { /* no-op */ } finally { setFormLoading(false); }
  }, []);

  const handleJoin = useCallback(async (inviteCode: string) => {
    setFormLoading(true);
    try { await invoke("sync_join_group", { inviteCode }); setSyncGroups(await invoke<SyncGroup[]>("sync_get_groups")); setShowJoin(false); }
    catch { /* no-op */ } finally { setFormLoading(false); }
  }, []);

  const handleLeaveGroup = useCallback(async (groupId: string) => {
    try { await invoke("sync_leave_group", { groupId }); setSyncGroups((prev) => prev.filter((g) => g.id !== groupId)); if (selected?.kind === "sync" && selected.group.id === groupId) setSelected(null); }
    catch { /* no-op */ }
  }, [selected]);

  const handleLeaveSession = useCallback(async (shareGroupId: string) => {
    try { await invoke("sharing_leave_session", { shareGroupId }); setSessions((prev) => prev.filter((s) => s.share_group_id !== shareGroupId)); if (selected?.kind === "share" && selected.session.share_group_id === shareGroupId) setSelected(null); }
    catch { /* no-op */ }
  }, [selected]);

  const handleCopyInvite = useCallback((code: string) => {
    navigator.clipboard.writeText(code).catch(() => {});
    if (inviteTimer.current) clearTimeout(inviteTimer.current);
    setInviteCopied(code);
    inviteTimer.current = setTimeout(() => setInviteCopied(null), 2000);
  }, []);

  useEffect(() => () => { if (inviteTimer.current) clearTimeout(inviteTimer.current); }, []);

  const selectedLabel =
    selected?.kind === "local" ? selected.name :
    selected?.kind === "sync" ? selected.group.name :
    selected?.session.name ?? "";

  const selectedMemberInfo =
    selected?.kind === "sync"
      ? `${selected.group.member_count} member${selected.group.member_count === 1 ? "" : "s"}`
      : selected?.kind === "share"
        ? `${selected.session.members.length} member${selected.session.members.length === 1 ? "" : "s"}`
        : null;

  const isFiltering = search.trim().length > 0 || activeFilterCount > 0;

  const feedFilterIndex = feedFilter === "all" ? 0 : feedFilter === "clipboard" ? 1 : 2;

  const leftSlot = (
    <div className="sync-filter-tabs">
      <div className="sync-feed-segment">
        <div
          className="sync-feed-segment-slider"
          style={{ transform: `translateX(${feedFilterIndex * 100}%)` }}
        />
        <button
          className={`sync-feed-seg-btn${feedFilter === "all" ? " sync-feed-seg-btn--active" : ""}`}
          onClick={() => setFeedFilter("all")}
          data-tooltip="All items"
          data-tooltip-pos="below"
        >
          <SquaresFour size={12} weight="regular" />
        </button>
        <button
          className={`sync-feed-seg-btn${feedFilter === "clipboard" ? " sync-feed-seg-btn--active" : ""}`}
          onClick={() => setFeedFilter("clipboard")}
          data-tooltip="Clipboard only"
          data-tooltip-pos="below"
        >
          <ClipboardIcon size={11} strokeWidth={1.8} />
        </button>
        <button
          className={`sync-feed-seg-btn${feedFilter === "notes" ? " sync-feed-seg-btn--active" : ""}`}
          onClick={() => setFeedFilter("notes")}
          data-tooltip="Notes only"
          data-tooltip-pos="below"
        >
          <NotesIcon size={11} />
        </button>
      </div>
      <div className="cs-toolbar-sep" />
      <SortDropdown sort={sort} onSortChange={(s) => { setSort(s); localStorage.setItem("sync-sort", s); }} />
      <SyncFilterDropdown sf={sf} feedFilter={feedFilter} />
    </div>
  );

  const rightSlot = (
    <LayoutSegment layout={layout} onLayoutChange={(l) => { setLayout(l); localStorage.setItem("sync-layout", l); }} />
  );

  return (
    <div className="sync-screen">
      <div className="sync-feed-panel">
        <Topbar leftSlot={leftSlot} rightSlot={rightSlot}
          searchQuery={search} onSearchChange={setSearch}
          searchPlaceholder="Search in group…" searchInputRef={searchRef}
        />

        {selected ? (
          <>
            {/* Group header */}
            <div className="sync-feed-header">
              <div className="sync-feed-header-left">
                <span className="sync-feed-group-name">{selectedLabel}</span>
                {selectedMemberInfo && (
                  <span className="sync-feed-member-count"><UsersIcon size={10} />{selectedMemberInfo}</span>
                )}
                <span className="sync-feed-item-count">
                  {feedItems.length} item{feedItems.length === 1 ? "" : "s"}
                  {isFiltering && allFeedItems.length !== feedItems.length && (
                    <span className="sync-feed-filtered-hint"> of {allFeedItems.length}</span>
                  )}
                </span>
              </div>
              <div className="sync-feed-header-right">
                {selected.kind === "sync" && selected.group.invite_code && (
                  <button
                    className={`sync-feed-action-btn${inviteCopied === selected.group.invite_code ? " sync-feed-action-btn--done" : ""}`}
                    onClick={() => handleCopyInvite(selected.group.invite_code!)}
                  >
                    {inviteCopied === selected.group.invite_code ? <><CheckIcon size={11} /> Copied!</> : <><ShareIcon size={11} /> Copy Invite</>}
                  </button>
                )}
                {selected.kind === "sync" && (
                  <button className="sync-feed-action-btn sync-feed-action-btn--danger"
                    onClick={() => handleLeaveGroup(selected.group.id)} data-tooltip="Leave this group" data-tooltip-pos="top">
                    <LogOutIcon size={11} />Leave
                  </button>
                )}
                {selected.kind === "share" && (
                  <button className="sync-feed-action-btn sync-feed-action-btn--danger"
                    onClick={() => handleLeaveSession(selected.session.share_group_id)}
                    data-tooltip={selected.session.is_owner ? "End session" : "Leave session"} data-tooltip-pos="top">
                    <LogOutIcon size={11} />{selected.session.is_owner ? "End" : "Leave"}
                  </button>
                )}
              </div>
            </div>

            {/* Live Share members */}
            {selected.kind === "share" && selected.session.members.length > 0 && (
              <div className="sync-members-bar">
                {selected.session.members.map((m) => (
                  <div key={m.user_id} className="sync-member-chip">
                    <OnlineDotIcon online={m.online} size={6} />
                    <span>{m.display_name}</span>
                    <span className="sync-member-scope">{m.scope}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Detail or feed */}
            {detailItem ? (
              <DetailPanel item={detailItem} onClose={() => setDetailItem(null)} onCopy={onCopyEntry} />
            ) : (
              <div className="sync-feed-scroll">
                {feedItems.length === 0 ? (
                  <div className="sync-feed-empty">
                    <SearchXIcon size={38} />
                    <span className="sync-feed-empty-title">{isFiltering ? "No results" : "Nothing here yet"}</span>
                    <span className="sync-feed-empty-sub">
                      {search.trim() ? `Nothing matches "${search.trim()}"${activeFilterCount > 0 ? " with current filters" : ""}` :
                       activeFilterCount > 0 ? "No items match the current filters" :
                       feedFilter !== "all" ? `No ${feedFilter} items in this group` :
                       selected.kind === "local" ? `Tag items as "${selectedLabel}" to see them here` :
                       "Items shared to this group will appear here"}
                    </span>
                    {activeFilterCount > 0 && (
                      <button className="sync-clear-filters-btn" onClick={clearAllFilters}>Clear filters</button>
                    )}
                  </div>
                ) : (
                  feedByDay.map(({ label, items }) => (
                    <div key={label} className="sync-feed-day-group">
                      <div className="sync-feed-day-label">{label}</div>
                      <div className={layout === "tiles" ? "sync-feed-card-grid" : "sync-feed-card-list"}>
                        {items.map((item) =>
                          item.kind === "clipboard" ? (
                            <ClipFeedCard key={item.entry.id} entry={item.entry}
                              onCopy={onCopyEntry} onView={(e) => setDetailItem({ kind: "clipboard", entry: e })} layout={layout} />
                          ) : (
                            <NoteFeedCard key={item.note.id} note={item.note}
                              onView={(n) => setDetailItem({ kind: "note", note: n })} layout={layout} />
                          )
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        ) : (
          <div className="sync-no-selection">
            <div className="sync-no-selection-inner">
              {syncGroups.length === 0 && sessions.length === 0 ? (
                <><UsersIcon size={40} strokeWidth={1.3} /><span className="sync-no-selection-title">No groups yet</span>
                <span className="sync-no-selection-sub">Create a sync group or join one with an invite code.</span></>
              ) : (
                <><UsersIcon size={40} strokeWidth={1.3} /><span className="sync-no-selection-title">Select a group</span>
                <span className="sync-no-selection-sub">Pick a group from the right to view its shared content.</span></>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Right groups panel */}
      <aside className="sync-panel-right">
        {/* Header with connection status */}
        <div className="sync-panel-header">
          <span className="sync-panel-title">Groups</span>
          <span className={`sync-conn-chip sync-conn-chip--${syncConnected === true ? "on" : syncConnected === false ? "off" : "idle"}`}>
            <span className="sync-conn-dot" />
            {syncConnected === true ? "Connected" : syncConnected === false ? "Offline" : "Inactive"}
          </span>
        </div>

        <div className="sync-panel-scroll">
          {/* Sync groups */}
          <div className="sync-group-section">
            {syncGroups.length > 0 && (
              <div className="sync-section-row">
                <span className="sync-section-label-text">Sync</span>
                <span className="sync-section-badge">{syncGroups.length}</span>
              </div>
            )}
            {syncGroups.length === 0 ? (
              <p className="sync-group-empty-hint">
                {syncConnected === null ? "Not signed in" :
                 syncConnected === false ? "Offline — reconnecting…" : "No sync groups yet"}
              </p>
            ) : syncGroups.map((group) => {
              const isActive = selected?.kind === "sync" && selected.group.id === group.id;
              const color = groupAvatarColor(group.id);
              const initials = group.name.slice(0, 2).toUpperCase();
              return (
                <button key={group.id} className={`sync-group-card${isActive ? " active" : ""}`}
                  onClick={() => setSelected({ kind: "sync", group })}>
                  <span className="sync-group-avatar" style={{ background: color }}>{initials}</span>
                  <span className="sync-group-card-body">
                    <span className="sync-group-card-name">{group.name}</span>
                    <span className="sync-group-card-meta">
                      {group.member_count} member{group.member_count === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* Live share sessions */}
          {sessions.length > 0 && (
            <div className="sync-group-section">
              <div className="sync-section-row">
                <span className="sync-section-label-text">Live Share</span>
                <span className="sync-section-badge">{sessions.length}</span>
              </div>
              {sessions.map((session) => {
                const isActive = selected?.kind === "share" && selected.session.share_group_id === session.share_group_id;
                const onlineCount = session.members.filter((m) => m.online).length;
                return (
                  <button key={session.share_group_id} className={`sync-group-card sync-group-card--live${isActive ? " active" : ""}`}
                    onClick={() => setSelected({ kind: "share", session })}>
                    <span className="sync-group-live-avatar">
                      <span className="sync-group-live-dot" />
                    </span>
                    <span className="sync-group-card-body">
                      <span className="sync-group-card-name">{session.name}</span>
                      <span className="sync-group-card-meta">{onlineCount}/{session.members.length} online</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="sync-panel-actions">
          {showCreate && <InlineForm mode="create" onSubmit={handleCreate} onCancel={() => setShowCreate(false)} loading={formLoading} />}
          {showJoin && <InlineForm mode="join" onSubmit={handleJoin} onCancel={() => setShowJoin(false)} loading={formLoading} />}
          {!showCreate && !showJoin && (
            <div className="sync-panel-btns">
              <button className="sync-action-btn" onClick={() => { setShowCreate(true); setShowJoin(false); }} data-tooltip="Create a new sync group" data-tooltip-pos="top">
                <PlusIcon size={11} />Create
              </button>
              <button className="sync-action-btn" onClick={() => { setShowJoin(true); setShowCreate(false); }} data-tooltip="Join via invite code" data-tooltip-pos="top">
                <KeyIcon size={11} />Join
              </button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
};

export default SyncScreen;
