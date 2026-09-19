import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { useSticky } from "../../../hooks/useSticky";
import { useSelectionSummary } from "../../../hooks/useSelectionSummary";
import BulkActionsBar from "../clipboard-screen/bulk-actions/BulkActionsBar";
import CardMenu from "../card-menu/CardMenu";
import {
  useSpaceShares,
  useRemoteEntryKeys,
} from "../../../hooks/useSpaceShares";
import { ActiveFilterStrip } from "../clipboard-screen/search-filter/FilterParts";
import {
  useEntrySyncStates,
  useSyncBadgesVisible,
} from "../../../hooks/useEntrySyncStates";
import { useEntryOwners } from "../../../hooks/useEntryOwners";
import { setCloudCopy } from "../../../hooks/cloudActions";
import NoteEditor from "./note-editor/NoteEditor";
import NoteCard from "./note-card/NoteCard";
import NotesFilterDropdown, {
  useNotesFilter,
} from "./notes-filter/NotesFilterDropdown";
import { deriveNoteTitle, isNoteExpandable } from "./notes-utils";
import "../clipboard-screen/search-filter/SearchFilter.css";
import "./NotesScreen.css";
import { invoke } from "@tauri-apps/api/core";

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
  onBulkDelete?: (ids: string[]) => void;
  onBulkPin?: (ids: string[]) => void;
  onBulkUnpin?: (ids: string[]) => void;
  onBulkAddGroup?: (ids: string[], group: string) => void;
  onBulkRemoveGroup?: (ids: string[], group: string) => void;
}

/** Settings key for the editor's full-screen preference. */
const NOTES_FULLSCREEN_KEY = "notes_editor_fullscreen";

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
  onBulkDelete,
  onBulkPin,
  onBulkUnpin,
  onBulkAddGroup,
  onBulkRemoveGroup,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useSticky("ns-f-search", "");
  const searchRef = useRef<HTMLInputElement>(null);

  const multiSelect = useMultiSelect();
  const spaceShares = useSpaceShares();
  // The menu needs these to say whether the note already has a server copy,
  // and the filters need them to answer "which notes have I not uploaded".
  const noteSyncStates = useEntrySyncStates();
  const noteOwners = useEntryOwners();
  const syncBadgesVisible = useSyncBadgesVisible();
  const remoteKeys = useRemoteEntryKeys();

  const cloudFilterContext = useMemo(
    () => ({
      syncStates: noteSyncStates,
      shares: spaceShares.shares,
      remoteKeys,
      spaces: spaceShares.spaces,
      signedIn: spaceShares.signedIn,
    }),
    [
      noteSyncStates,
      spaceShares.shares,
      remoteKeys,
      spaceShares.spaces,
      spaceShares.signedIn,
    ],
  );

  const nf = useNotesFilter(notes, search, cloudFilterContext);

  const [sort, setSort] = useState<SortMode>(() => {
    return (localStorage.getItem("ns-sort") as SortMode) ?? "newest";
  });
  const { layout, fading, selectLayout } = useLayoutTransition<ClipboardLayout>(
    "ns-layout",
    "tiles",
  );
  const [collapsedSections, setCollapsedSections] = useSticky(
    "ns-collapsed-sections",
    { pinned: false, notes: false },
  );
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
  // Whether the editor fills the window instead of sharing it with the list.
  // Persisted, because it is a way of working rather than a per-note choice.
  const [editorFullscreen, setEditorFullscreen] = useState(false);

  useEffect(() => {
    invoke<boolean | null>("get_setting", { key: NOTES_FULLSCREEN_KEY })
      .then((v) => setEditorFullscreen(v === true))
      .catch(() => setEditorFullscreen(false));
  }, []);

  const toggleEditorFullscreen = useCallback(() => {
    setEditorFullscreen((prev) => {
      const next = !prev;
      void invoke("set_setting", { key: NOTES_FULLSCREEN_KEY, value: next });
      return next;
    });
  }, []);
  const mainRef = useRef<HTMLDivElement>(null);

  // Close filter dropdown on outside click
  useClickOutside(nf.filterRef, nf.filtersOpen, () => nf.setFiltersOpen(false));

  // Sort memoised so it only recomputes when the filtered set or the mode
  // changes, not on every select-mode toggle / resize.
  const sortedNotes = useMemo(() => {
    return [...nf.filteredNotes].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      switch (sort) {
        case "oldest":
          return a.updated_at - b.updated_at;
        // Sorted by the title the cards show, so a note the user left
        // untitled sorts under its first line rather than piling in with
        // every other empty title.
        case "a-z":
          return deriveNoteTitle(a.title, a.content).localeCompare(
            deriveNoteTitle(b.title, b.content),
          );
        case "z-a":
          return deriveNoteTitle(b.title, b.content).localeCompare(
            deriveNoteTitle(a.title, a.content),
          );
        default:
          return b.updated_at - a.updated_at;
      }
    });
  }, [nf.filteredNotes, sort]);

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
  // Cloud actions only apply to notes we wrote - see ClipboardScreen for why.
  const selectedOwnIds = useMemo(
    () =>
      [...multiSelect.selectedIds].filter(
        (id) => !remoteKeys.has(`note:${id}`),
      ),
    [multiSelect.selectedIds, remoteKeys],
  );

  const { allPinned, commonGroups } = useSelectionSummary(
    notes,
    multiSelect.selectedIds,
  );

  // The editor filling the window is the one case where the notes list is not
  // on screen at all.
  const listHidden = !!editingNote && editorFullscreen;

  return (
    <div
      className={`notes-screen-root${editingNote ? " notes-screen-root--editing" : ""}`}
    >
      {/* A full-screen editor takes the list off the screen, so the list's
          controls go with it: searching, sorting, filtering and switching the
          layout of notes nobody can see is chrome with nothing behind it. In
          the split view the list is still there, so the bar stays. */}
      {!listHidden && (
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
            <LayoutSegment
              layout={layout}
              onLayoutChange={selectLayout}
              showSingle
            />

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
                  onBulkSync={() =>
                    void setCloudCopy(selectedOwnIds, "note", true)
                  }
                  onBulkUnsync={() =>
                    void setCloudCopy(selectedOwnIds, "note", false)
                  }
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
      )}

      {/* What the badge cannot say: which filters are on, and what they left. */}
      {!listHidden && (
        <ActiveFilterStrip
          names={nf.filterNames}
          matched={nf.filteredNotes.length}
          total={nf.totalCount}
          onClear={nf.clearAll}
        />
      )}

      <div
        ref={mainRef}
        className={`ns-main${editingNote ? " ns-main--editing" : ""}${isResizingSplit ? " ns-main--resizing" : ""}${editingNote && editorFullscreen ? " ns-main--fullscreen" : ""}`}
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
                    {nf.filterNames.length > 0 ? (
                      <> with {nf.filterNames.join(", ")}</>
                    ) : null}
                    .
                  </>
                ) : (
                  <>
                    No notes match{" "}
                    {nf.filterNames.join(", ") || "the current filters"}.
                  </>
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
                      syncState={
                        syncBadgesVisible
                          ? noteSyncStates[`note:${n.id}`]
                          : undefined
                      }
                      sharedSpaceNames={(
                        spaceShares.shares[`note:${n.id}`] ?? []
                      )
                        .map(
                          (id) =>
                            spaceShares.spaces.find((sp) => sp.id === id)?.name,
                        )
                        .filter((name): name is string => !!name)}
                      owner={noteOwners[`note:${n.id}`]}
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
                onBack={() => setEditingId(null)}
                fullscreen={editorFullscreen}
                onToggleFullscreen={toggleEditorFullscreen}
                readOnly={remoteKeys.has(`note:${editingNote.id}`)}
                ownerName={noteOwners[`note:${editingNote.id}`]?.display_name}
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
            spaces={spaceShares.spaces}
            signedIn={spaceShares.signedIn}
            itemSpaceIds={spaceShares.shares[`note:${menuNote.id}`]}
            onToggleSpace={
              remoteKeys.has(`note:${menuNote.id}`)
                ? undefined
                : (spaceId) => spaceShares.toggle("note", menuNote.id, spaceId)
            }
            inCloud={!!noteSyncStates[`note:${menuNote.id}`]}
            onToggleCloud={
              remoteKeys.has(`note:${menuNote.id}`)
                ? undefined
                : (upload) => {
                    void setCloudCopy([menuNote.id], "note", upload);
                  }
            }
            showCopy={false}
            showSave={false}
          />
        )}
      </div>
    </div>
  );
};

export default NotesScreen;
