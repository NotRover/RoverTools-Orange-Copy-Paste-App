import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Note, ClipboardEntry } from "../../../types";

import type { SortMode } from "../sort-options";
import Topbar, {
  SortDropdown,
  LayoutSegment,
  GroupsButton,
} from "../topbar/Topbar";
import type { ClipboardLayout } from "../topbar/Topbar";
import {
  NotesIcon,
  PlusIcon,
  PinIcon,
  SearchXIcon,
  ChevronRightIcon,
  MultiSelectIcon,
} from "../../icons";
import { useMultiSelect } from "../../../hooks/useMultiSelect";
import { useClickOutside } from "../../../hooks/useClickOutside";
import { useLayoutTransition } from "../../../hooks/useLayoutTransition";
import { useSelectionSummary } from "../../../hooks/useSelectionSummary";
import BulkActionsBar from "../clipboard-screen/bulk-actions/BulkActionsBar";
import CardMenu from "../card-menu/CardMenu";
import NoteEditor from "./note-editor/NoteEditor";
import NoteCard from "./note-card/NoteCard";
import NotesFilterDropdown, {
  useNotesFilter,
} from "./notes-filter/NotesFilterDropdown";
import { stripHtml, isNoteExpandable } from "./notes-utils";
import "../clipboard-screen/search-filter/SearchFilter.css";
import "./NotesScreen.css";

const NOTES_SPLIT_STORAGE_KEY = "ns-notes-list-width";
const NOTES_SPLIT_DEFAULT = 40;
const NOTES_SPLIT_MIN = 40;
const NOTES_SPLIT_MAX = 68;

// ═══════════════════════════════════════════════════════════════════════
// TESTING ONLY — dummy notes for feature preview. REMOVE this whole block
// (and the `notes` merge inside the component that references DUMMY_NOTES)
// when done. These seed notes exercise every note feature: pin, group tags,
// headings, text styles, bullet + ordered lists, checklists, tables, code
// blocks, images, links, blockquotes, and long/expandable content.
// ═══════════════════════════════════════════════════════════════════════
const DUMMY_NOW = Date.now();
const DUMMY_MIN = 60_000;

// note.content must be a stringified Tiptap ProseMirror doc (plain HTML/markdown
// renders blank). Tiny builders keep the docs below readable.
const _t = (text: string, marks?: any[]): any =>
  marks && marks.length ? { type: "text", text, marks } : { type: "text", text };
const _p = (...content: any[]): any => ({ type: "paragraph", content });
const _h = (level: number, text: string): any => ({ type: "heading", attrs: { level }, content: [_t(text)] });
const _li = (...content: any[]): any => ({ type: "listItem", content });
const _ul = (...items: any[]): any => ({ type: "bulletList", content: items });
const _ol = (...items: any[]): any => ({ type: "orderedList", content: items });
const _task = (checked: boolean, text: string): any => ({ type: "taskItem", attrs: { checked }, content: [_p(_t(text))] });
const _tasks = (...items: any[]): any => ({ type: "taskList", content: items });
const _quote = (...content: any[]): any => ({ type: "blockquote", content });
const _callout = (tone: string, ...content: any[]): any => ({ type: "callout", attrs: { tone }, content });
const _pre = (language: string, code: string): any => ({ type: "codeBlock", attrs: { language }, content: [_t(code)] });
const _hr = (): any => ({ type: "horizontalRule" });
const _img = (src: string, alt: string): any => ({ type: "image", attrs: { src, alt } });
const _th = (text: string): any => ({ type: "tableHeader", content: [_p(_t(text))] });
const _td = (text: string): any => ({ type: "tableCell", content: [_p(_t(text))] });
const _tr = (...cells: any[]): any => ({ type: "tableRow", content: cells });
const _table = (...rows: any[]): any => ({ type: "table", content: rows });
const _doc = (...content: any[]): string => JSON.stringify({ type: "doc", content });

const _b = { type: "bold" };
const _i = { type: "italic" };
const _u = { type: "underline" };
const _strike = { type: "strike" };
const _codeMark = { type: "code" };
const _link = (href: string): any => ({ type: "link", attrs: { href } });
const _hl = (color: string): any => ({ type: "highlight", attrs: { color } });
const _color = (color: string): any => ({ type: "textStyle", attrs: { color } });

const DUMMY_SWATCH =
  "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22240%22 height=%22100%22%3E%3Crect width=%22240%22 height=%22100%22 rx=%2210%22 fill=%22%23ff5535%22/%3E%3Crect x=%2214%22 y=%2214%22 width=%2272%22 height=%2272%22 rx=%228%22 fill=%22%23181818%22/%3E%3C/svg%3E";

const DUMMY_NOTES: Note[] = [
  {
    id: "dummy-welcome",
    title: "Welcome & text styles",
    content: _doc(
      _h(2, "Welcome 👋"),
      _p(
        _t("This shows "),
        _t("bold", [_b]),
        _t(", "),
        _t("italic", [_i]),
        _t(", "),
        _t("underline", [_u]),
        _t(", "),
        _t("strikethrough", [_strike]),
        _t(", "),
        _t("inline code", [_codeMark]),
        _t(", "),
        _t("highlight", [_hl("#ffd43b")]),
        _t(", "),
        _t("colored text", [_color("#ff5535")]),
        _t(", and "),
        _t("a link", [_link("https://example.com")]),
        _t("."),
      ),
      _ul(
        _li(_p(_t("First bullet"))),
        _li(_p(_t("Second bullet"))),
        _li(_p(_t("Nested:")), _ul(_li(_p(_t("Child one"))), _li(_p(_t("Child two"))))),
      ),
      _hr(),
      _p(_t("Everything here is dummy data for testing.")),
    ),
    created_at: DUMMY_NOW - 4 * DUMMY_MIN,
    updated_at: DUMMY_NOW - 4 * DUMMY_MIN,
    pinned: true,
    groups: ["Work"],
  },
  {
    id: "dummy-table",
    title: "Roadmap (table)",
    content: _doc(
      _h(3, "Q3 roadmap"),
      _table(
        _tr(_th("Feature"), _th("Owner"), _th("Status")),
        _tr(_td("Sync engine"), _td("Sal"), _td("Done")),
        _tr(_td("Live share"), _td("Team"), _td("In progress")),
        _tr(_td("Grid layout"), _td("Sal"), _td("Shipping")),
      ),
      _p(_t("Last-write-wins on updated_at; tombstones always win.")),
    ),
    created_at: DUMMY_NOW - 20 * DUMMY_MIN,
    updated_at: DUMMY_NOW - 8 * DUMMY_MIN,
    pinned: true,
    groups: ["Work", "Planning"],
  },
  {
    id: "dummy-code",
    title: "Code snippet",
    content: _doc(
      _p(_t("Derive the wrapping key, then unwrap the UMK:")),
      _pre(
        "ts",
        "const kek = argon2id(password, kdf_salt);\nconst umk = aesGcmUnwrap(pw_wrapped_umk, kek);\n// umk stays in memory only (Zeroizing)",
      ),
      _p(_t("Use "), _t("umk", [_codeMark]), _t(" for AES-256-GCM content encryption.")),
    ),
    created_at: DUMMY_NOW - 60 * DUMMY_MIN,
    updated_at: DUMMY_NOW - 55 * DUMMY_MIN,
    pinned: false,
    groups: ["Dev"],
  },
  {
    id: "dummy-image",
    title: "Design reference (image, quote, callout)",
    content: _doc(
      _p(_t("Accent swatch:")),
      _img(DUMMY_SWATCH, "Accent swatch"),
      _quote(_p(_t("Good design is as little design as possible."))),
      _callout("info", _p(_t("Keep the flat dark theme with the orange accent."))),
    ),
    created_at: DUMMY_NOW - 90 * DUMMY_MIN,
    updated_at: DUMMY_NOW - 90 * DUMMY_MIN,
    pinned: false,
    groups: ["Ideas"],
  },
  {
    id: "dummy-long",
    title: "Meeting notes (long / expandable)",
    content: _doc(
      _h(3, "Sync sprint kickoff"),
      _p(_t("We reviewed the end-to-end encryption contract and agreed the server never sees plaintext.")),
      _ol(
        _li(_p(_t("Confirm the bootstrap salt flow"))),
        _li(_p(_t("Register device public keys"))),
        _li(_p(_t("Push encrypted entries (last-write-wins)"))),
        _li(_p(_t("Fan out live updates over the websocket"))),
      ),
      _p(
        _t(
          "Open questions: group-key rotation when a member leaves, tombstone vs re-add ordering, blob quotas, and short-lived presigned URLs. This paragraph is intentionally long so the card overflows and shows the expand affordance and bounded scroll in the new layouts. The identity keypair is derived deterministically from the UMK, so it is the same on every device and never stored server-side.",
        ),
      ),
    ),
    created_at: DUMMY_NOW - 2 * 24 * 60 * DUMMY_MIN,
    updated_at: DUMMY_NOW - 120 * DUMMY_MIN,
    pinned: false,
    groups: ["Work"],
  },
  {
    id: "dummy-checklist",
    title: "Release checklist (tasks)",
    content: _doc(
      _h(3, "Before shipping"),
      _tasks(
        _task(true, "Build passes"),
        _task(true, "Layouts verified"),
        _task(false, "Smoke-test on device"),
        _task(false, "Update changelog"),
      ),
    ),
    created_at: DUMMY_NOW - 6 * 60 * DUMMY_MIN,
    updated_at: DUMMY_NOW - 30 * DUMMY_MIN,
    pinned: false,
    groups: ["Personal"],
  },
  {
    id: "dummy-mixed",
    title: "Mixed blocks & callouts",
    content: _doc(
      _callout("warning", _p(_t("Heads up: this note mixes many block types."))),
      _h(2, "Heading two"),
      _p(_t("A paragraph, then a quote:")),
      _quote(_p(_t("Simplicity is the ultimate sophistication."))),
      _h(4, "Heading four"),
      _pre("bash", "bun run tauri dev"),
      _hr(),
      _p(_t("End of the mixed note.")),
    ),
    created_at: DUMMY_NOW - 45 * DUMMY_MIN,
    updated_at: DUMMY_NOW - 12 * DUMMY_MIN,
    pinned: false,
    groups: ["Ideas", "Dev"],
  },
  {
    id: "dummy-short",
    title: "Quick idea",
    content: _doc(_p(_t("Add a keyboard shortcut to jump straight to search."))),
    created_at: DUMMY_NOW - 3 * 60 * DUMMY_MIN,
    updated_at: DUMMY_NOW - 3 * 60 * DUMMY_MIN,
    pinned: false,
    groups: [],
  },
  {
    id: "dummy-tags",
    title: "Many tags (chip overflow)",
    content: _doc(_p(_t("Several group tags to show chip layout and overflow."))),
    created_at: DUMMY_NOW - 10 * 60 * DUMMY_MIN,
    updated_at: DUMMY_NOW - 10 * 60 * DUMMY_MIN,
    pinned: false,
    groups: ["Work", "Ideas", "Personal", "Urgent", "Planning"],
  },
];
// ═══════════════════════════════════════════════════════════════════════
// END TESTING dummy notes
// ═══════════════════════════════════════════════════════════════════════

// ── NotesScreen ─────────────────────────────────────────────────────

interface NotesScreenProps {
  notes: Note[];
  entries: ClipboardEntry[];
  availableGroups: string[];
  onAddGroup: (name: string) => void;
  onDeleteGroup: (name: string) => void;
  onRenameGroup: (oldName: string, newName: string) => void;
  onCreate: () => Promise<Note> | Note;
  onUpdate: (id: string, title: string, content: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string, pin: boolean) => void;
  onSetGroups: (id: string, groups: string[]) => void;
  onCopyEntry?: (id: string) => void;
  onBulkDelete?: (ids: string[]) => void;
  onBulkPin?: (ids: string[]) => void;
  onBulkUnpin?: (ids: string[]) => void;
  onBulkAddGroup?: (ids: string[], group: string) => void;
  onBulkRemoveGroup?: (ids: string[], group: string) => void;
}

const NotesScreen: React.FC<NotesScreenProps> = ({
  notes: incomingNotes,
  entries,
  availableGroups,
  onAddGroup,
  onDeleteGroup,
  onRenameGroup,
  onCreate,
  onUpdate,
  onDelete,
  onPin,
  onSetGroups,
  onCopyEntry,
  onBulkDelete,
  onBulkPin,
  onBulkUnpin,
  onBulkAddGroup,
  onBulkRemoveGroup,
}) => {
  // TESTING ONLY — merge dummy notes ahead of real ones. Remove with the
  // DUMMY_NOTES block above when done.
  const notes = useMemo(
    () => [...DUMMY_NOTES, ...incomingNotes],
    [incomingNotes],
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const nf = useNotesFilter();

  const multiSelect = useMultiSelect();

  const [sort, setSort] = useState<SortMode>(() => {
    return (localStorage.getItem("ns-sort") as SortMode) ?? "newest";
  });
  const { layout, fading, selectLayout } = useLayoutTransition<ClipboardLayout>(
    "ns-layout",
    "tiles",
  );
  const [collapsedSections, setCollapsedSections] = useState({
    pinned: false,
    notes: false,
  });
  const [expandedNoteIds, setExpandedNoteIds] = useState<Set<string>>(
    new Set(),
  );
  const [menuState, setMenuState] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [notesListWidthPct, setNotesListWidthPct] = useState<number>(() => {
    const raw = Number(localStorage.getItem(NOTES_SPLIT_STORAGE_KEY));
    if (!Number.isFinite(raw)) return NOTES_SPLIT_DEFAULT;
    return Math.min(NOTES_SPLIT_MAX, Math.max(NOTES_SPLIT_MIN, raw));
  });
  const [isResizingSplit, setIsResizingSplit] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);

  // Close filter dropdown on outside click
  useClickOutside(nf.filterRef, nf.filtersOpen, () => nf.setFiltersOpen(false));

  // Filter + sort memoised so they only recompute when inputs change, not on
  // every keystroke / select-mode toggle / resize.
  const sortedNotes = useMemo(() => {
    const filtered = notes.filter((n) => {
      if (nf.pinnedOnly && !n.pinned) return false;
      if (
        nf.selectedGroups.size > 0 &&
        !n.groups.some((g) => nf.selectedGroups.has(g))
      )
        return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !n.title.toLowerCase().includes(q) &&
          !stripHtml(n.content).toLowerCase().includes(q)
        )
          return false;
      }
      return true;
    });
    return filtered.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      switch (sort) {
        case "oldest":
          return a.updated_at - b.updated_at;
        case "a-z":
          return (a.title || "").localeCompare(b.title || "");
        case "z-a":
          return (b.title || "").localeCompare(a.title || "");
        default:
          return b.updated_at - a.updated_at;
      }
    });
  }, [notes, nf.pinnedOnly, nf.selectedGroups, search, sort]);

  const editingNote = editingId
    ? (notes.find((n) => n.id === editingId) ?? null)
    : null;
  const menuNote = menuState
    ? (notes.find((n) => n.id === menuState.id) ?? null)
    : null;

  useEffect(() => {
    if (editingId && !notes.some((n) => n.id === editingId)) setEditingId(null);
  }, [notes, editingId]);

  useEffect(() => {
    if (menuState && !notes.some((n) => n.id === menuState.id)) {
      setMenuState(null);
    }
  }, [notes, menuState]);

  useEffect(() => {
    localStorage.setItem(NOTES_SPLIT_STORAGE_KEY, notesListWidthPct.toFixed(2));
  }, [notesListWidthPct]);

  useEffect(() => {
    if (!isResizingSplit) return;

    const onMove = (e: MouseEvent) => {
      const container = mainRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(NOTES_SPLIT_MAX, Math.max(NOTES_SPLIT_MIN, pct));
      setNotesListWidthPct(clamped);
    };

    const onUp = () => {
      setIsResizingSplit(false);
    };

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
  }, [isResizingSplit]);

  const handleCreate = useCallback(async () => {
    const note = await onCreate();
    setEditingId(note.id);
  }, [onCreate]);

  const handleDelete = useCallback(
    (id: string) => {
      onDelete(id);
      setExpandedNoteIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (editingId === id) setEditingId(null);
    },
    [onDelete, editingId],
  );

  const pinnedCount = useMemo(
    () => sortedNotes.filter((n) => n.pinned).length,
    [sortedNotes],
  );
  const showSections = pinnedCount > 0 && pinnedCount < sortedNotes.length;
  const visibleNotes = useMemo(
    () =>
      showSections
        ? sortedNotes.filter((n) => {
            if (n.pinned && collapsedSections.pinned) return false;
            if (!n.pinned && collapsedSections.notes) return false;
            return true;
          })
        : sortedNotes,
    [sortedNotes, showSections, collapsedSections],
  );
  const allVisibleIds = useMemo(
    () => visibleNotes.map((n) => n.id),
    [visibleNotes],
  );

  // Stable, id-based NoteCard callbacks so memoised cards don't re-render on
  // every parent update. allVisibleIds is read through a ref to keep identity
  // fixed across filter changes.
  const allVisibleIdsRef = useRef(allVisibleIds);
  allVisibleIdsRef.current = allVisibleIds;
  const handleToggleSelect = useCallback(
    (id: string, shiftKey: boolean) => {
      if (shiftKey) multiSelect.selectRange(id, allVisibleIdsRef.current);
      else multiSelect.toggleSelect(id);
    },
    [multiSelect.selectRange, multiSelect.toggleSelect],
  );
  const handleOpen = useCallback((id: string) => setEditingId(id), []);
  const handleContextMenu = useCallback(
    (id: string, x: number, y: number) => setMenuState({ id, x, y }),
    [],
  );

  // Prune stale selections when notes change
  useEffect(() => {
    if (!multiSelect.isSelecting) return;
    const activeIds = new Set(notes.map((n) => n.id));
    multiSelect.pruneStaleIds(activeIds);
  }, [notes, multiSelect.isSelecting]);

  // Exit multi-select on Escape
  useEffect(() => {
    if (!multiSelect.isSelecting) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") multiSelect.exitSelectMode();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [multiSelect.isSelecting]);

  // Bulk-selection state (notes have no "Saved" concept, so allSaved is unused).
  const { allPinned, commonGroups } = useSelectionSummary(
    notes,
    multiSelect.selectedIds,
  );

  return (
    <div
      className={`notes-screen-root${editingNote ? " notes-screen-root--editing" : ""}`}
    >
      <Topbar
        searchQuery={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search notes..."
        searchInputRef={searchRef}
        leftSlot={
          <>
            <button
              className="cs-tb-btn"
              onClick={handleCreate}
              data-tooltip="New note"
              data-tooltip-pos="below"
            >
              <PlusIcon size={13} />
            </button>

            <div className="cs-toolbar-sep" />

            <SortDropdown
              sort={sort}
              onSortChange={(s) => {
                setSort(s);
                localStorage.setItem("ns-sort", s);
              }}
            />
            <NotesFilterDropdown nf={nf} availableGroups={availableGroups} />
          </>
        }
        rightSlot={
          <>
            <LayoutSegment layout={layout} onLayoutChange={selectLayout} showSingle />

            <div className="cs-toolbar-sep" />

            {/* Select mode */}
            <div className="bulk-select-wrap">
              <button
                className={`cs-tb-btn${multiSelect.isSelecting ? " cs-tb-btn--active" : ""}`}
                onClick={() => {
                  document.dispatchEvent(new Event("tooltip:hide"));
                  multiSelect.isSelecting
                    ? multiSelect.exitSelectMode()
                    : multiSelect.enterSelectMode();
                }}
                data-tooltip={
                  multiSelect.isSelecting
                    ? multiSelect.selectedCount > 0
                      ? `${multiSelect.selectedCount} selected`
                      : "Exit selection"
                    : "Select notes"
                }
                data-tooltip-pos="below"
              >
                <MultiSelectIcon size={13} />
                {multiSelect.isSelecting && multiSelect.selectedCount > 0 && (
                  <span className="cs-tb-badge">
                    {multiSelect.selectedCount}
                  </span>
                )}
              </button>

              {multiSelect.isSelecting && (
                <BulkActionsBar
                  selectedCount={multiSelect.selectedCount}
                  totalCount={notes.length}
                  onSelectAll={() => multiSelect.selectAll(allVisibleIds)}
                  onDeselectAll={multiSelect.deselectAll}
                  onExitSelectMode={multiSelect.exitSelectMode}
                  onBulkDelete={() => {
                    if (onBulkDelete) {
                      onBulkDelete([...multiSelect.selectedIds]);
                      multiSelect.exitSelectMode();
                    }
                  }}
                  allPinned={allPinned}
                  onBulkTogglePin={() => {
                    if (allPinned) {
                      if (onBulkUnpin)
                        onBulkUnpin([...multiSelect.selectedIds]);
                    } else {
                      if (onBulkPin) onBulkPin([...multiSelect.selectedIds]);
                    }
                  }}
                  allSaved={false}
                  onBulkToggleSave={() => {}}
                  onBulkAddGroup={(group) => {
                    if (onBulkAddGroup)
                      onBulkAddGroup([...multiSelect.selectedIds], group);
                  }}
                  onBulkRemoveGroup={(group) => {
                    if (onBulkRemoveGroup)
                      onBulkRemoveGroup([...multiSelect.selectedIds], group);
                  }}
                  availableGroups={availableGroups}
                  commonGroups={commonGroups}
                />
              )}
            </div>

            <GroupsButton
              availableGroups={availableGroups}
              entries={entries}
              onAddGroup={onAddGroup}
              onDeleteGroup={onDeleteGroup}
              onRenameGroup={onRenameGroup}
              disabled={multiSelect.isSelecting}
            />
          </>
        }
      />

      <div
        ref={mainRef}
        className={`ns-main${editingNote ? " ns-main--editing" : ""}${isResizingSplit ? " ns-main--resizing" : ""}`}
      >
        {/* ── Masonry grid ── */}
        <div
          className={`ns-viewport${fading ? " ns-viewport--fading" : ""}`}
          style={
            editingNote
              ? {
                  flex: "0 0 auto",
                  width: `${notesListWidthPct}%`,
                }
              : undefined
          }
        >
          {notes.length === 0 ? (
            <div className="ns-empty">
              <NotesIcon size={36} className="ns-empty-icon" />
              <h3 className="ns-empty-title">No notes yet</h3>
              <p className="ns-empty-subtitle">
                Click the compose button to create your first note.
              </p>
            </div>
          ) : sortedNotes.length === 0 ? (
            <div className="cs-no-results">
              <SearchXIcon size={44} className="cs-no-results-icon" />
              <p className="cs-no-results-title">No matching notes</p>
              <p className="cs-no-results-subtitle">
                {search.trim() ? (
                  <>
                    Nothing matches &ldquo;{search.trim()}&rdquo;
                    {nf.activeFilterCount > 0
                      ? " with the current filters"
                      : ""}
                    .
                  </>
                ) : (
                  <>No notes match the current filters.</>
                )}
              </p>
            </div>
          ) : (
            <div
              className={`ns-grid${layout === "list" ? " ns-grid--grid" : layout === "single" ? " ns-grid--single" : ""}`}
            >
              {sortedNotes.map((n, idx) => (
                <React.Fragment key={n.id}>
                  {showSections && idx === 0 && (
                    <button
                      type="button"
                      className="ns-section-label"
                      onClick={() =>
                        setCollapsedSections((prev) => ({
                          ...prev,
                          pinned: !prev.pinned,
                        }))
                      }
                      aria-expanded={!collapsedSections.pinned}
                    >
                      <PinIcon size={9} />
                      Pinned
                      <ChevronRightIcon
                        size={10}
                        className={`ns-section-chevron${collapsedSections.pinned ? "" : " ns-section-chevron--open"}`}
                      />
                    </button>
                  )}
                  {showSections && idx === pinnedCount && (
                    <button
                      type="button"
                      className="ns-section-label"
                      onClick={() =>
                        setCollapsedSections((prev) => ({
                          ...prev,
                          notes: !prev.notes,
                        }))
                      }
                      aria-expanded={!collapsedSections.notes}
                    >
                      <NotesIcon size={10} />
                      Notes
                      <ChevronRightIcon
                        size={10}
                        className={`ns-section-chevron${collapsedSections.notes ? "" : " ns-section-chevron--open"}`}
                      />
                    </button>
                  )}
                  {(!showSections ||
                    (n.pinned && !collapsedSections.pinned) ||
                    (!n.pinned && !collapsedSections.notes)) && (
                    <NoteCard
                      note={n}
                      entries={entries}
                      isSelecting={multiSelect.isSelecting}
                      isSelected={multiSelect.selectedIds.has(n.id)}
                      isExpanded={expandedNoteIds.has(n.id)}
                      onToggleSelect={handleToggleSelect}
                      onOpen={handleOpen}
                      onDelete={handleDelete}
                      onContextMenu={handleContextMenu}
                    />
                  )}
                </React.Fragment>
              ))}
            </div>
          )}
        </div>

        {editingNote && (
          <>
            <div className="ns-splitter" aria-hidden="true">
              <button
                type="button"
                className="ns-splitter-handle"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setIsResizingSplit(true);
                }}
                aria-label="Resize notes list and editor"
                data-tooltip="Drag to resize"
                data-tooltip-pos="left"
              />
            </div>

            <div className="ns-editor-dock">
              <NoteEditor
                key={editingNote.id}
                note={editingNote}
                entries={entries}
                availableGroups={availableGroups}
                onUpdate={onUpdate}
                onDelete={handleDelete}
                onPin={onPin}
                onSetGroups={onSetGroups}
                onCopyEntry={onCopyEntry}
                onBack={() => setEditingId(null)}
              />
            </div>
          </>
        )}

        {menuNote && menuState && (
          <CardMenu
            open={true}
            anchorX={menuState.x}
            anchorY={menuState.y}
            onClose={() => setMenuState(null)}
            isPinned={menuNote.pinned}
            isSaved={false}
            copied={false}
            onCopy={() => {}}
            onDelete={() => handleDelete(menuNote.id)}
            onPin={(shouldPin) => onPin(menuNote.id, shouldPin)}
            onToggleSave={() => {}}
            availableGroups={availableGroups}
            entryGroups={menuNote.groups}
            onToggleGroup={(group) => {
              const next = menuNote.groups.includes(group)
                ? menuNote.groups.filter((g) => g !== group)
                : [...menuNote.groups, group];
              onSetGroups(menuNote.id, next);
            }}
            isExpandable={isNoteExpandable(menuNote)}
            isExpanded={expandedNoteIds.has(menuNote.id)}
            onToggleExpand={() => {
              setExpandedNoteIds((prev) => {
                const next = new Set(prev);
                if (next.has(menuNote.id)) next.delete(menuNote.id);
                else next.add(menuNote.id);
                return next;
              });
            }}
            showCopy={false}
            showSave={false}
          />
        )}
      </div>
    </div>
  );
};

export default NotesScreen;
