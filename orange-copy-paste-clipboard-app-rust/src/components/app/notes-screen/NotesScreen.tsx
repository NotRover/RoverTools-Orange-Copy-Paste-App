import React, { useCallback, useEffect, useRef, useState } from "react";
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
  notes,
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [fading, setFading] = useState(false);
  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const nf = useNotesFilter();

  const multiSelect = useMultiSelect();

  const [sort, setSort] = useState<SortMode>(() => {
    return (localStorage.getItem("ns-sort") as SortMode) ?? "newest";
  });
  const [layout, setLayout] = useState<ClipboardLayout>(() => {
    return (localStorage.getItem("ns-layout") as ClipboardLayout) ?? "tiles";
  });
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
  useEffect(() => {
    if (!nf.filtersOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        nf.filterRef.current &&
        !nf.filterRef.current.contains(e.target as Node)
      )
        nf.setFiltersOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [nf.filtersOpen]);

  const filteredNotes = notes.filter((n) => {
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

  const sortedNotes = [...filteredNotes].sort((a, b) => {
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

  useEffect(
    () => () => {
      if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
    },
    [],
  );

  const selectLayout = useCallback(
    (l: ClipboardLayout) => {
      if (l === layout) return;
      setFading(true);
      if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
      layoutTimerRef.current = setTimeout(() => {
        setLayout(l);
        localStorage.setItem("ns-layout", l);
        setFading(false);
      }, 160);
    },
    [layout],
  );

  const pinnedCount = sortedNotes.filter((n) => n.pinned).length;
  const showSections = pinnedCount > 0 && pinnedCount < sortedNotes.length;
  const visibleNotes = showSections
    ? sortedNotes.filter((n) => {
        if (n.pinned && collapsedSections.pinned) return false;
        if (!n.pinned && collapsedSections.notes) return false;
        return true;
      })
    : sortedNotes;
  const allVisibleIds = visibleNotes.map((n) => n.id);

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

  // Compute bulk state
  const allPinned =
    multiSelect.selectedCount > 0 &&
    notes
      .filter((n) => multiSelect.selectedIds.has(n.id))
      .every((n) => n.pinned);
  const commonGroups = (() => {
    if (multiSelect.selectedCount === 0) return [] as string[];
    const sel = notes.filter((n) => multiSelect.selectedIds.has(n.id));
    if (sel.length === 0) return [] as string[];
    const first = new Set(sel[0].groups);
    return [...first].filter((g) => sel.every((n) => n.groups.includes(g)));
  })();

  return (
    <div
      className={`notes-screen-root${editingNote ? " notes-screen-root--editing" : ""}`}
    >
      <Topbar
        searchQuery={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search notes…"
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
            <LayoutSegment layout={layout} onLayoutChange={selectLayout} />

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
              className={`ns-grid${layout === "list" ? " ns-grid--list" : ""}`}
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
                      onToggleSelect={(shiftKey) => {
                        if (shiftKey) {
                          multiSelect.selectRange(n.id, allVisibleIds);
                        } else {
                          multiSelect.toggleSelect(n.id);
                        }
                      }}
                      onOpen={() => setEditingId(n.id)}
                      onDelete={(e) => {
                        e.stopPropagation();
                        handleDelete(n.id);
                      }}
                      onContextMenu={(e) => {
                        if (multiSelect.isSelecting) return;
                        e.preventDefault();
                        e.stopPropagation();
                        setMenuState({ id: n.id, x: e.clientX, y: e.clientY });
                      }}
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
