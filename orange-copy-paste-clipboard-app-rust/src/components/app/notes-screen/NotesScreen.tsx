import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Note, ClipboardEntry } from "../../../types";
import { groupColor, timeAgo, truncateText } from "../../../types";
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
  CloseIcon,
  TrashIcon,
  PinIcon,
  BoldIcon,
  ItalicIcon,
  UnderlineIcon,
  StrikethroughIcon,
  HeadingIcon,
  BulletListIcon,
  OrderedListIcon,
  QuoteIcon,
  EmbedClipIcon,
  CheckIcon,
  ChevronRightIcon,
  FilterIcon,
} from "../../icons";
import { PinIcon as PinIconElement } from "../../entry-types/EntryTypePill";
import "../clipboard-screen/search-filter/SearchFilter.css";
import "./NotesScreen.css";

// ── Helpers ──────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent ?? tmp.innerText ?? "";
}

// ── Formatting state (active toolbar buttons) ───────────────────────

interface FormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  unorderedList: boolean;
  orderedList: boolean;
}

function queryFormatState(): FormatState {
  return {
    bold: document.queryCommandState("bold"),
    italic: document.queryCommandState("italic"),
    underline: document.queryCommandState("underline"),
    strikethrough: document.queryCommandState("strikeThrough"),
    unorderedList: document.queryCommandState("insertUnorderedList"),
    orderedList: document.queryCommandState("insertOrderedList"),
  };
}

// ── NoteEditor ──────────────────────────────────────────────────────

interface NoteEditorProps {
  note: Note;
  entries: ClipboardEntry[];
  availableGroups: string[];
  onUpdate: (id: string, title: string, content: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string, pin: boolean) => void;
  onSetGroups: (id: string, groups: string[]) => void;
  onCopyEntry?: (id: string) => void;
  onBack: () => void;
}

const NoteEditor: React.FC<NoteEditorProps> = ({
  note,
  entries,
  availableGroups,
  onUpdate,
  onDelete,
  onPin,
  onSetGroups,
  onCopyEntry,
  onBack,
}) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showGroupDropdown, setShowGroupDropdown] = useState(false);
  const groupDropdownRef = useRef<HTMLDivElement>(null);
  const [formatState, setFormatState] = useState<FormatState>(queryFormatState);
  const currentNoteIdRef = useRef(note.id);

  // ── Format state tracking via selectionchange ──

  useEffect(() => {
    const update = () => setFormatState(queryFormatState());
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  // Render clipboard embed placeholders.
  useEffect(() => {
    if (!editorRef.current) return;
    const placeholders =
      editorRef.current.querySelectorAll("[data-clip-embed]");
    placeholders.forEach((el) => {
      const embedId = el.getAttribute("data-clip-embed");
      if (!embedId || el.getAttribute("data-rendered")) return;
      el.setAttribute("data-rendered", "1");

      const entry = entries.find((e) => e.id === embedId);
      const label = entry
        ? entry.type === "image"
          ? (entry.label ?? "Image")
          : truncateText(
              entry.type === "html" ? stripHtml(entry.content) : entry.content,
              60,
            )
        : `Clip #${embedId} not found`;

      el.className = "clip-embed";
      el.innerHTML = `<span style="flex-shrink:0;color:var(--accent)">📋</span><span class="${entry ? "clip-embed-text" : "clip-embed-missing"}">${label}</span>`;

      if (entry && onCopyEntry) {
        (el as HTMLElement).onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          onCopyEntry(entry.id);
        };
      }
    });
  });

  // Load content when note changes.
  useEffect(() => {
    if (currentNoteIdRef.current !== note.id) {
      currentNoteIdRef.current = note.id;
      if (editorRef.current) editorRef.current.innerHTML = note.content;
    }
  }, [note.id, note.content]);

  // Set initial content.
  useEffect(() => {
    if (editorRef.current && editorRef.current.innerHTML !== note.content) {
      editorRef.current.innerHTML = note.content;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus title for new empty notes.
  useEffect(() => {
    if (!note.title && !note.content && titleRef.current)
      titleRef.current.focus();
  }, [note.id]);

  // Close group dropdown on outside click.
  useEffect(() => {
    if (!showGroupDropdown) return;
    const handler = (e: MouseEvent) => {
      if (
        groupDropdownRef.current &&
        !groupDropdownRef.current.contains(e.target as Node)
      )
        setShowGroupDropdown(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showGroupDropdown]);

  // Debounced auto-save.
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (!editorRef.current) return;
      onUpdate(
        note.id,
        titleRef.current?.value ?? "",
        editorRef.current.innerHTML,
      );
    }, 500);
  }, [note.id, onUpdate]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  // Flush before leaving.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        if (editorRef.current && titleRef.current) {
          onUpdate(
            currentNoteIdRef.current,
            titleRef.current.value,
            editorRef.current.innerHTML,
          );
        }
      }
    };
  }, [note.id]);

  const execCmd = useCallback(
    (cmd: string, value?: string) => {
      editorRef.current?.focus();
      document.execCommand(cmd, false, value);
      scheduleSave();
      setTimeout(() => setFormatState(queryFormatState()), 0);
    },
    [scheduleSave],
  );

  const insertEmbed = useCallback(() => {
    const id = prompt("Enter clipboard entry ID:");
    if (!id) return;
    editorRef.current?.focus();
    document.execCommand(
      "insertHTML",
      false,
      `<span data-clip-embed="${id}" contenteditable="false">[clip:${id}]</span>&nbsp;`,
    );
    scheduleSave();
  }, [scheduleSave]);

  const toggleGroup = useCallback(
    (group: string) => {
      const next = note.groups.includes(group)
        ? note.groups.filter((g) => g !== group)
        : [...note.groups, group];
      onSetGroups(note.id, next);
    },
    [note.id, note.groups, onSetGroups],
  );

  const updateFormat = () => setFormatState(queryFormatState());

  return (
    <div className="ns-editor-overlay">
      <div className="ns-editor">
        {/* Header */}
        <div className="ns-editor-header">
          <button
            className="ns-back-btn"
            onClick={onBack}
            data-tooltip="Back to notes"
            data-tooltip-pos="right"
          >
            <ChevronRightIcon size={12} className="ns-back-chevron" />
          </button>
          <input
            ref={titleRef}
            className="ns-title-input"
            placeholder="Untitled Note"
            defaultValue={note.title}
            key={note.id}
            onChange={scheduleSave}
          />
          <div className="ns-editor-actions">
            <button
              className={`ns-tb-btn${note.pinned ? " ns-tb-btn--active" : ""}`}
              onClick={() => onPin(note.id, !note.pinned)}
              data-tooltip={note.pinned ? "Unpin" : "Pin"}
              data-tooltip-pos="below"
            >
              <PinIcon size={12} filled={note.pinned} />
            </button>
            <button
              className="ns-tb-btn"
              onClick={() => {
                onDelete(note.id);
                onBack();
              }}
              data-tooltip="Delete"
              data-tooltip-pos="below"
            >
              <TrashIcon size={11} />
            </button>
          </div>
        </div>

        {/* Group chips */}
        <div className="ns-editor-groups">
          {note.groups.map((g) => {
            const c = groupColor(g);
            return (
              <button
                key={g}
                className="ns-editor-group-chip"
                style={{ background: c.bg, color: c.fg }}
                onClick={() => toggleGroup(g)}
                title={`Remove from "${g}"`}
              >
                {g}
              </button>
            );
          })}
          <div style={{ position: "relative" }} ref={groupDropdownRef}>
            <button
              className="ns-add-group-btn"
              onClick={() => setShowGroupDropdown((p) => !p)}
              title="Add to group"
            >
              <PlusIcon size={9} />
            </button>
            {showGroupDropdown && (
              <div className="ns-group-dropdown">
                {availableGroups.length === 0 ? (
                  <div
                    className="ns-group-dropdown-item"
                    style={{ color: "var(--text-muted)", cursor: "default" }}
                  >
                    No groups yet
                  </div>
                ) : (
                  availableGroups.map((g) => {
                    const c = groupColor(g);
                    const isIn = note.groups.includes(g);
                    return (
                      <button
                        key={g}
                        className="ns-group-dropdown-item"
                        onClick={() => toggleGroup(g)}
                      >
                        <span
                          className="ns-group-dropdown-dot"
                          style={{ background: c.fg }}
                        />
                        {g}
                        {isIn && (
                          <CheckIcon
                            size={11}
                            className="ns-group-dropdown-check"
                          />
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>

        {/* Formatting toolbar */}
        <div className="ns-format-bar">
          <button
            className={`ns-fmt-btn${formatState.bold ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execCmd("bold")}
            data-tooltip="Bold (Ctrl+B)"
            data-tooltip-pos="below"
          >
            <BoldIcon size={13} />
          </button>
          <button
            className={`ns-fmt-btn${formatState.italic ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execCmd("italic")}
            data-tooltip="Italic (Ctrl+I)"
            data-tooltip-pos="below"
          >
            <ItalicIcon size={13} />
          </button>
          <button
            className={`ns-fmt-btn${formatState.underline ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execCmd("underline")}
            data-tooltip="Underline (Ctrl+U)"
            data-tooltip-pos="below"
          >
            <UnderlineIcon size={13} />
          </button>
          <button
            className={`ns-fmt-btn${formatState.strikethrough ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execCmd("strikethrough")}
            data-tooltip="Strikethrough"
            data-tooltip-pos="below"
          >
            <StrikethroughIcon size={13} />
          </button>

          <span className="ns-fmt-sep" />

          <button
            className="ns-fmt-btn"
            onClick={() => execCmd("formatBlock", "h1")}
            data-tooltip="Heading 1"
            data-tooltip-pos="below"
          >
            <HeadingIcon size={14} />
          </button>
          <button
            className="ns-fmt-btn"
            onClick={() => execCmd("formatBlock", "h2")}
            data-tooltip="Heading 2"
            data-tooltip-pos="below"
            style={{ opacity: 0.7 }}
          >
            <HeadingIcon size={11} />
          </button>

          <span className="ns-fmt-sep" />

          <button
            className={`ns-fmt-btn${formatState.unorderedList ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execCmd("insertUnorderedList")}
            data-tooltip="Bullet list"
            data-tooltip-pos="below"
          >
            <BulletListIcon size={13} />
          </button>
          <button
            className={`ns-fmt-btn${formatState.orderedList ? " ns-fmt-btn--active" : ""}`}
            onClick={() => execCmd("insertOrderedList")}
            data-tooltip="Numbered list"
            data-tooltip-pos="below"
          >
            <OrderedListIcon size={13} />
          </button>
          <button
            className="ns-fmt-btn"
            onClick={() => execCmd("formatBlock", "blockquote")}
            data-tooltip="Quote"
            data-tooltip-pos="below"
          >
            <QuoteIcon size={13} />
          </button>

          <span className="ns-fmt-sep" />

          <button
            className="ns-fmt-btn"
            onClick={insertEmbed}
            data-tooltip="Embed clipboard entry"
            data-tooltip-pos="below"
          >
            <EmbedClipIcon size={13} />
          </button>
        </div>

        {/* Richtext editor */}
        <div className="ns-editor-content">
          <div
            ref={editorRef}
            className="ns-richtext"
            contentEditable
            suppressContentEditableWarning
            onInput={() => {
              scheduleSave();
              updateFormat();
            }}
            onKeyUp={updateFormat}
            onMouseUp={updateFormat}
            onPaste={(e) => {
              e.preventDefault();
              const html =
                e.clipboardData.getData("text/html") ||
                e.clipboardData.getData("text/plain");
              document.execCommand("insertHTML", false, html);
              scheduleSave();
            }}
          />
        </div>

        {/* Footer */}
        <div className="ns-editor-footer">
          <span className="ns-editor-footer-text">
            Updated {timeAgo(note.updated_at)}
          </span>
        </div>
      </div>
    </div>
  );
};

// ── Notes filter dropdown ───────────────────────────────────────────

interface NotesFilterState {
  pinnedOnly: boolean;
  setPinnedOnly: React.Dispatch<React.SetStateAction<boolean>>;
  selectedGroups: Set<string>;
  toggleGroup: (g: string) => void;
  activeFilterCount: number;
  clearAll: () => void;
  filtersOpen: boolean;
  setFiltersOpen: React.Dispatch<React.SetStateAction<boolean>>;
  filterRef: React.RefObject<HTMLDivElement | null>;
}

function useNotesFilter(): NotesFilterState {
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  const toggleGroup = useCallback((g: string) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }, []);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (pinnedOnly) n++;
    if (selectedGroups.size > 0) n++;
    return n;
  }, [pinnedOnly, selectedGroups]);

  const clearAll = useCallback(() => {
    setPinnedOnly(false);
    setSelectedGroups(new Set());
  }, []);

  return {
    pinnedOnly, setPinnedOnly,
    selectedGroups, toggleGroup,
    activeFilterCount, clearAll,
    filtersOpen, setFiltersOpen,
    filterRef,
  };
}

const NotesFilterDropdown: React.FC<{
  nf: NotesFilterState;
  availableGroups: string[];
}> = ({ nf, availableGroups }) => (
  <div className="sort-dropdown" ref={nf.filterRef}>
    <button
      className={`cs-tb-btn${nf.filtersOpen ? " cs-tb-btn--open" : ""}`}
      onClick={() => {
        if (!nf.filtersOpen) document.dispatchEvent(new Event("tooltip:hide"));
        nf.setFiltersOpen((v) => !v);
      }}
      data-tooltip="Filters"
      data-tooltip-pos="below"
    >
      <FilterIcon size={12} />
      {nf.activeFilterCount > 0 && (
        <span className="cs-tb-badge">{nf.activeFilterCount}</span>
      )}
    </button>
    {nf.filtersOpen && (
      <div className="cs-filter-card">
        {/* System section */}
        <div className="cs-card-section">
          <div className="cs-section-label">System</div>
          <div className="cs-type-grid">
            <label className={`cs-type-option${nf.pinnedOnly ? " cs-type-option--on" : ""}`}>
              <input type="checkbox" checked={nf.pinnedOnly} onChange={() => nf.setPinnedOnly((v) => !v)} className="cs-type-cb" />
              <span className="cs-type-icon type-pill" style={{ background: "var(--accent-dim)", color: "var(--accent)" }}>
                {PinIconElement}
              </span>
              <span className="cs-type-name">Pinned</span>
            </label>
          </div>
        </div>

        {/* Groups section */}
        {availableGroups.length > 0 && (
          <>
            <div className="cs-card-divider" />
            <div className="cs-card-section">
              <div className="cs-section-label">
                Groups
                {nf.selectedGroups.size > 0 && <span className="cs-count">{nf.selectedGroups.size}</span>}
              </div>
              <div className="cs-type-grid">
                {availableGroups.map((g) => {
                  const gc = groupColor(g);
                  return (
                    <label key={g} className={`cs-type-option${nf.selectedGroups.has(g) ? " cs-type-option--on" : ""}`}>
                      <input type="checkbox" checked={nf.selectedGroups.has(g)} onChange={() => nf.toggleGroup(g)} className="cs-type-cb" />
                      <span className="cs-type-icon type-pill" style={{ background: gc.bg, color: gc.fg }}>
                        <span className="cs-color-dot" style={{ background: gc.fg }} />
                      </span>
                      <span className="cs-type-name">{g}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* Clear filters button */}
        {nf.activeFilterCount > 0 && (
          <>
            <div className="cs-card-divider" />
            <button className="cs-card-clear-btn" onClick={nf.clearAll}>
              <CloseIcon size={12} />
              Clear Filters
            </button>
          </>
        )}
      </div>
    )}
  </div>
);

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
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const nf = useNotesFilter();

  const [sort, setSort] = useState<SortMode>(() => {
    return (localStorage.getItem("ns-sort") as SortMode) ?? "newest";
  });
  const [layout, setLayout] = useState<ClipboardLayout>(() => {
    return (localStorage.getItem("ns-layout") as ClipboardLayout) ?? "tiles";
  });

  // Close filter dropdown on outside click
  useEffect(() => {
    if (!nf.filtersOpen) return;
    const handler = (e: MouseEvent) => {
      if (nf.filterRef.current && !nf.filterRef.current.contains(e.target as Node))
        nf.setFiltersOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [nf.filtersOpen]);

  const filteredNotes = notes.filter((n) => {
    if (nf.pinnedOnly && !n.pinned) return false;
    if (nf.selectedGroups.size > 0 && !n.groups.some((g) => nf.selectedGroups.has(g))) return false;
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

  useEffect(() => {
    if (editingId && !notes.some((n) => n.id === editingId)) setEditingId(null);
  }, [notes, editingId]);

  const handleCreate = useCallback(async () => {
    const note = await onCreate();
    setEditingId(note.id);
  }, [onCreate]);

  const handleDelete = useCallback(
    (id: string) => {
      onDelete(id);
      if (editingId === id) setEditingId(null);
    },
    [onDelete, editingId],
  );

  const selectLayout = useCallback((l: ClipboardLayout) => {
    setLayout(l);
    localStorage.setItem("ns-layout", l);
  }, []);

  return (
    <div className="notes-screen-root">
      <Topbar
        searchQuery={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search notes…"
        searchInputRef={searchRef}
        leftSlot={
          <>
            <SortDropdown
              sort={sort}
              onSortChange={(s) => {
                setSort(s);
                localStorage.setItem("ns-sort", s);
              }}
            />
            <NotesFilterDropdown nf={nf} availableGroups={availableGroups} />
            <button className="ns-new-btn" onClick={handleCreate}>
              <PlusIcon size={11} />
              <span>New</span>
            </button>
          </>
        }
        rightSlot={
          <>
            <LayoutSegment layout={layout} onLayoutChange={selectLayout} />

            <div className="cs-toolbar-sep" />

            <GroupsButton
              availableGroups={availableGroups}
              entries={entries}
              onAddGroup={onAddGroup}
              onDeleteGroup={onDeleteGroup}
              onRenameGroup={onRenameGroup}
            />
          </>
        }
      />

      {/* ── Masonry grid ── */}
      <div className="ns-viewport">
        {sortedNotes.length === 0 ? (
          <div className="ns-empty">
            <NotesIcon size={36} className="ns-empty-icon" />
            <h3 className="ns-empty-title">
              {notes.length === 0 ? "No notes yet" : "No matching notes"}
            </h3>
            <p className="ns-empty-subtitle">
              {notes.length === 0
                ? 'Click "New" to create your first note.'
                : "Try a different search or group filter."}
            </p>
          </div>
        ) : (
          <div className={`ns-grid${layout === "list" ? " ns-grid--list" : ""}`}>
            {sortedNotes.map((n) => (
              <div
                key={n.id}
                className="ns-card"
                onClick={() => setEditingId(n.id)}
              >
                <div className="ns-card-body">
                  <div
                    className={`ns-card-title${!n.title ? " ns-card-title--untitled" : ""}`}
                  >
                    {n.title || "Untitled Note"}
                  </div>
                  {n.content && (
                    <div className="ns-card-preview">
                      {truncateText(stripHtml(n.content), 200)}
                    </div>
                  )}
                  <div className="ns-card-footer">
                    <div className="ns-card-chips">
                      {n.groups.map((g) => {
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
                      className={`ns-card-time${n.pinned ? " ns-card-time--pinned" : ""}`}
                    >
                      {n.pinned && <PinIcon size={8} />}
                      {timeAgo(n.updated_at)}
                    </span>
                  </div>
                </div>
                <button
                  className="ns-card-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(n.id);
                  }}
                  data-tooltip="Delete"
                  data-tooltip-pos="left"
                >
                  <TrashIcon size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Editor overlay ── */}
      {editingNote && (
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
      )}
    </div>
  );
};

export default NotesScreen;
