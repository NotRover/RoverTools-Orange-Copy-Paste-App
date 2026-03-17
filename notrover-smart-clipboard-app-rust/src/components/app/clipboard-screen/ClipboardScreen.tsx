import React, { useEffect, useRef, useState } from "react";
import type { ClipboardEntry } from "../../../types";
import { EntryCard } from "./entry-card/EntryCard";
export { EntryCard };
import GroupManagerCard from "./group-manager/GroupManagerCard";
import BulkActionsBar from "./bulk-actions/BulkActionsBar";
import { useSearchFilter, SearchBar, FilterDropdown, NoResults } from "./search-filter/SearchFilter";
import { useMultiSelect } from "../../../hooks/useMultiSelect";
import { SORT_OPTIONS, sortableText } from "../sort-options";
import type { SortMode } from "../sort-options";
import {
  ClipboardIcon,
  MasonryIcon,
  ListIcon,
  ChevronDownIcon,
  TagIcon,
  TrashIcon,
  MultiSelectIcon,
  PinIcon,
  SaveStarIcon,
  SlidersIcon,
} from "../../icons";
import "./ClipboardScreen.css";

// Layout & sort types

type ClipboardLayout = "masonry" | "list";

const TYPE_ORDER: Record<string, number> = { text: 0, file: 1, image: 2 };

function applySortWithinGroup(
  entries: ClipboardEntry[],
  sort: SortMode,
): ClipboardEntry[] {
  if (sort === "newest") return entries;
  const sorted = [...entries];
  switch (sort) {
    case "oldest":
      sorted.sort((a, b) => a.timestamp - b.timestamp);
      break;
    case "a-z":
      sorted.sort((a, b) => sortableText(a).localeCompare(sortableText(b)));
      break;
    case "z-a":
      sorted.sort((a, b) => sortableText(b).localeCompare(sortableText(a)));
      break;
    case "type":
      sorted.sort(
        (a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9),
      );
      break;
  }
  return sorted;
}

// Day grouping helpers

function toLocalDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(key: string): string {
  const todayKey = toLocalDateKey(Date.now());
  const yesterdayKey = toLocalDateKey(Date.now() - 86_400_000);
  if (key === todayKey) return "Today";
  if (key === yesterdayKey) return "Yesterday";
  const [year, month, day] = key.split("-").map(Number);
  const d = new Date(year, month, day);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function daySubtitle(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  const d = new Date(year, month, day);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface DayGroup {
  key: string;
  label: string;
  subtitle: string;
  entries: ClipboardEntry[];
}

function groupByDay(entries: ClipboardEntry[]): DayGroup[] {
  const map = new Map<string, ClipboardEntry[]>();
  for (const e of entries) {
    const k = toLocalDateKey(e.timestamp);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(e);
  }
  return Array.from(map.entries()).map(([key, entries]) => ({
    key,
    label: dayLabel(key),
    subtitle: daySubtitle(key),
    entries,
  }));
}

// Clipboard Screen

interface ClipboardScreenProps {
  entries: ClipboardEntry[];
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string, shouldPin: boolean) => Promise<boolean>;
  onClearAll?: () => void;
  /** User-defined group names. */
  availableGroups: string[];
  onAddGroup: (name: string) => void;
  onDeleteGroup: (name: string) => void;
  onRenameGroup: (oldName: string, newName: string) => void;
  onSetGroups: (id: string, groups: string[]) => void;
  /** Bulk operations */
  onBulkDelete?: (ids: string[]) => void;
  onBulkPin?: (ids: string[]) => void;
  onBulkUnpin?: (ids: string[]) => void;
  onBulkSave?: (ids: string[]) => void;
  onBulkUnsave?: (ids: string[]) => void;
  onBulkAddGroup?: (ids: string[], group: string) => void;
  onBulkRemoveGroup?: (ids: string[], group: string) => void;
}

const ClipboardScreen: React.FC<ClipboardScreenProps> = ({
  entries,
  onCopy,
  onDelete,
  onPin,
  onClearAll,
  availableGroups,
  onAddGroup,
  onDeleteGroup,
  onRenameGroup,
  onSetGroups,
  onBulkDelete,
  onBulkPin,
  onBulkUnpin,
  onBulkSave,
  onBulkUnsave,
  onBulkAddGroup,
  onBulkRemoveGroup,
}) => {
  const [layout, setLayout] = useState<ClipboardLayout>(() => {
    return (localStorage.getItem("sc-layout") as ClipboardLayout) ?? "masonry";
  });
  const [sort, setSort] = useState<SortMode>(() => {
    return (localStorage.getItem("sc-sort") as SortMode) ?? "newest";
  });
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const [fading, setFading] = useState(false);
  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [groupsOpen, setGroupsOpen] = useState(false);
  const groupsRef = useRef<HTMLDivElement>(null);

  // Search & filter (delegated to sub-component)
  const sf = useSearchFilter(entries);

  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);

  // Multi-select state
  const multiSelect = useMultiSelect();

  // Flat list of all visible entry IDs (respecting sort order) for range selection
  const dayGroups = groupByDay(sf.filteredEntries).map((g) => ({
    ...g,
    entries: applySortWithinGroup(g.entries, sort),
  }));
  const allVisibleIds = dayGroups.flatMap((g) => g.entries.map((e) => e.id));

  // Prune stale selections when entries change
  useEffect(() => {
    if (!multiSelect.isSelecting) return;
    const activeIds = new Set(entries.map((e) => e.id));
    multiSelect.pruneStaleIds(activeIds);
  }, [entries, multiSelect.isSelecting]);

  // Exit multi-select on Escape key
  useEffect(() => {
    if (!multiSelect.isSelecting) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") multiSelect.exitSelectMode();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [multiSelect.isSelecting]);

  // Compute groups common to ALL selected entries (for bulk group toggle UI)
  const commonGroups = (() => {
    if (multiSelect.selectedCount === 0) return [] as string[];
    const selectedEntries = entries.filter((e) =>
      multiSelect.selectedIds.has(e.id),
    );
    if (selectedEntries.length === 0) return [] as string[];
    const first = new Set(selectedEntries[0].groups);
    return [...first].filter((g) =>
      selectedEntries.every((e) => e.groups.includes(g)),
    );
  })();

  // Compute whether ALL selected entries are pinned / saved
  const allPinned = (() => {
    if (multiSelect.selectedCount === 0) return false;
    return entries
      .filter((e) => multiSelect.selectedIds.has(e.id))
      .every((e) => e.pinned);
  })();

  const allSaved = (() => {
    if (multiSelect.selectedCount === 0) return false;
    return entries
      .filter((e) => multiSelect.selectedIds.has(e.id))
      .every((e) => e.groups.includes("Saved"));
  })();

  // Close sort/filter/options dropdowns on outside click
  useEffect(() => {
    if (!sortOpen && !sf.filtersOpen && !optionsOpen) return;
    const handler = (e: MouseEvent) => {
      if (sortOpen && sortRef.current && !sortRef.current.contains(e.target as Node)) setSortOpen(false);
      if (sf.filtersOpen && sf.filterRef.current && !sf.filterRef.current.contains(e.target as Node)) sf.setFiltersOpen(false);
      if (optionsOpen && optionsRef.current && !optionsRef.current.contains(e.target as Node)) setOptionsOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [sortOpen, sf.filtersOpen, optionsOpen]);

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    return () => {
      if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
    };
  }, []);

  const selectLayout = (l: ClipboardLayout) => {
    if (l === layout) return;
    setFading(true);
    if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
    layoutTimerRef.current = setTimeout(() => {
      setLayout(l);
      localStorage.setItem("sc-layout", l);
      setFading(false);
    }, 160);
  };

  if (entries.length === 0) {
    return (
      <div className="empty-state">
        <ClipboardIcon size={48} strokeWidth={1.2} className="empty-icon" />
        <p className="empty-title">No clipboard history yet</p>
        <p className="empty-subtitle">
          Press <strong>Ctrl+Shift+C</strong> to capture anything here.
        </p>
      </div>
    );
  }

  const layouts: {
    id: ClipboardLayout;
    label: string;
    icon: React.ReactNode;
  }[] = [
    {
      id: "masonry",
      label: "Masonry",
      icon: <MasonryIcon size={10} />,
    },
    {
      id: "list",
      label: "List",
      icon: <ListIcon size={10} />,
    },
  ];

  return (
    <div className="clipboard-screen-root">
      {/* Toolbar: [Sort] [Filter] — Search — [Select] [Options] */}
      <div className="layout-toggle-wrap">
        {/* Left side: Sort + Filters */}
        <div className="cs-toolbar-left">
          {/* Sort dropdown */}
          <div className="sort-dropdown" ref={sortRef}>
            <button
              className={`sort-dropdown-trigger${sortOpen ? " sort-dropdown-trigger--open" : ""}`}
              onClick={() => {
                if (!sortOpen) document.dispatchEvent(new Event("tooltip:hide"));
                setSortOpen((v) => !v);
              }}
              data-tooltip="Sort order"
              data-tooltip-pos="below"
            >
              {SORT_OPTIONS.find((s) => s.id === sort)?.icon}
              <span className="layout-pill-label">
                {SORT_OPTIONS.find((s) => s.id === sort)?.label}
              </span>
              <ChevronDownIcon className="sort-chevron" />
            </button>
            {sortOpen && (
              <div className="sort-dropdown-menu">
                {SORT_OPTIONS.map((s) => (
                  <button
                    key={s.id}
                    className={`sort-dropdown-item${sort === s.id ? " sort-dropdown-item--active" : ""}`}
                    onClick={() => {
                      setSort(s.id);
                      localStorage.setItem("sc-sort", s.id);
                      setSortOpen(false);
                    }}
                  >
                    {s.icon}
                    <span>{s.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Filter dropdown */}
          <FilterDropdown sf={sf} availableGroups={availableGroups} />
        </div>

        {/* Center: Search bar */}
        <SearchBar sf={sf} />

        {/* Right side: Select + Options */}
        <div className="cs-toolbar-right">
          {/* Select mode button — bulk actions popup anchors here */}
          <div className="bulk-select-wrap">
            <button
              className={`sort-dropdown-trigger${multiSelect.isSelecting ? " sort-dropdown-trigger--open" : ""}`}
              onClick={() =>
                multiSelect.isSelecting
                  ? multiSelect.exitSelectMode()
                  : multiSelect.enterSelectMode()
              }
              data-tooltip="Select entries"
              data-tooltip-pos="below"
            >
              <MultiSelectIcon size={12} />
              <span className="layout-pill-label">
                {multiSelect.isSelecting
                  ? multiSelect.selectedCount > 0
                    ? `${multiSelect.selectedCount} selected`
                    : "Select"
                  : "Select"}
              </span>
              {multiSelect.isSelecting && allPinned && (
                <span style={{ color: "var(--accent)", display: "inline-flex", alignItems: "center", marginLeft: 1 }}>
                  <PinIcon size={10} filled={true} />
                </span>
              )}
              {multiSelect.isSelecting && allSaved && (
                <span style={{ color: "#22c55e", display: "inline-flex", alignItems: "center", marginLeft: 1 }}>
                  <SaveStarIcon size={10} filled={true} />
                </span>
              )}
            </button>

            {/* Bulk actions popup — floats below this wrapper */}
            {multiSelect.isSelecting && (
              <BulkActionsBar
                selectedCount={multiSelect.selectedCount}
                totalCount={entries.length}
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
                    if (onBulkUnpin) onBulkUnpin([...multiSelect.selectedIds]);
                  } else {
                    if (onBulkPin) onBulkPin([...multiSelect.selectedIds]);
                  }
                }}
                allSaved={allSaved}
                onBulkToggleSave={() => {
                  if (allSaved) {
                    if (onBulkUnsave) onBulkUnsave([...multiSelect.selectedIds]);
                  } else {
                    if (onBulkSave) onBulkSave([...multiSelect.selectedIds]);
                  }
                }}
                onBulkAddGroup={(group) => {
                  if (onBulkAddGroup) {
                    onBulkAddGroup([...multiSelect.selectedIds], group);
                  }
                }}
                onBulkRemoveGroup={(group) => {
                  if (onBulkRemoveGroup) {
                    onBulkRemoveGroup([...multiSelect.selectedIds], group);
                  }
                }}
                availableGroups={availableGroups}
                commonGroups={commonGroups}
              />
            )}
          </div>

          {/* Options button — reveals layout, groups, clear in a card */}
          <div className="sort-dropdown" ref={optionsRef}>
            <button
              className={`sort-dropdown-trigger${optionsOpen ? " sort-dropdown-trigger--open" : ""}`}
              onClick={() => setOptionsOpen((v) => !v)}
              data-tooltip="Options"
              data-tooltip-pos="below"
              style={
                multiSelect.isSelecting
                  ? { opacity: 0.35, pointerEvents: "none" }
                  : undefined
              }
            >
              <SlidersIcon size={12} />
              <span className="layout-pill-label">Options</span>
            </button>
            {optionsOpen && !multiSelect.isSelecting && (
              <div className="cs-options-card">
                {/* Layout section */}
                <div className="cs-card-section">
                  <div className="cs-section-label">Layout</div>
                  <div className="cs-layout-switch">
                    {layouts.map((l) => (
                      <button
                        key={l.id}
                        className={`cs-layout-btn${layout === l.id ? " cs-layout-btn--active" : ""}`}
                        onClick={() => {
                          selectLayout(l.id);
                        }}
                      >
                        {l.icon}
                        <span>{l.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Groups section */}
                <div className="cs-card-section">
                  <div className="cs-section-label">
                    Groups
                    {availableGroups.length > 0 && (
                      <span className="cs-count">{availableGroups.length}</span>
                    )}
                  </div>
                  <div className="groups-dropdown" ref={groupsRef}>
                    <button
                      className={`cs-options-btn${groupsOpen ? " cs-options-btn--open" : ""}`}
                      onClick={() => setGroupsOpen((v) => !v)}
                    >
                      <TagIcon size={10} strokeWidth={2} />
                      <span>Manage Groups</span>
                      <ChevronDownIcon className="sort-chevron" size={9} />
                    </button>
                    {groupsOpen && (
                      <GroupManagerCard
                        groups={availableGroups}
                        entries={entries}
                        onAddGroup={onAddGroup}
                        onDeleteGroup={onDeleteGroup}
                        onRenameGroup={onRenameGroup}
                        onClose={() => setGroupsOpen(false)}
                      />
                    )}
                  </div>
                </div>

                {/* Clear history */}
                {onClearAll && (
                  <div className="cs-card-section">
                    <button
                      className="cs-card-clear-btn cs-card-clear-btn--danger"
                      onClick={() => {
                        onClearAll();
                        setOptionsOpen(false);
                      }}
                    >
                      <TrashIcon size={10} />
                      Clear History
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        className={`layout-viewport${fading ? " layout-viewport--fading" : ""}`}
      >
        {sf.isFiltering && sf.filteredEntries.length === 0 ? (
          <NoResults sf={sf} />
        ) : (
        <div className="timeline-wrap">
          <div className="timeline-groups">
            {dayGroups.map((group, idx) => (
              <div
                key={group.key}
                className={`timeline-group${
                  dayGroups.length === 1
                    ? " timeline-group--only"
                    : idx === dayGroups.length - 1
                      ? " timeline-group--last"
                      : ""
                }`}
              >
                {/* Day marker — click to collapse/expand */}
                <button
                  className={`timeline-day-row${collapsed.has(group.key) ? " timeline-day-row--collapsed" : ""}`}
                  onClick={() => toggleGroup(group.key)}
                >
                  <div className="timeline-day-dot" />
                  <span className="timeline-day-label">{group.label}</span>
                  {group.label !== group.subtitle && (
                    <span className="timeline-day-subtitle">
                      {group.subtitle}
                    </span>
                  )}
                  {collapsed.has(group.key) && (
                    <span className="timeline-day-count">
                      {group.entries.length}
                    </span>
                  )}
                  <ChevronDownIcon
                    className="timeline-day-chevron"
                    size={10}
                    strokeWidth={2.5}
                  />
                </button>

                {/* Cards for this day — collapses via grid-template-rows */}
                <div
                  className={`timeline-group-body${collapsed.has(group.key) ? " timeline-group-body--collapsed" : ""}`}
                >
                  <div className="timeline-group-body__inner">
                    <div
                      className={
                        layout === "masonry" ? "entry-grid" : "entry-list"
                      }
                    >
                      {group.entries.map((entry) => (
                        <EntryCard
                          key={entry.id}
                          entry={entry}
                          onCopy={onCopy}
                          onDelete={onDelete}
                          onPin={onPin}
                          availableGroups={availableGroups}
                          onSetGroups={onSetGroups}
                          isSelecting={multiSelect.isSelecting}
                          isSelected={multiSelect.selectedIds.has(entry.id)}
                          onToggleSelect={multiSelect.toggleSelect}
                          onRangeSelect={(id) =>
                            multiSelect.selectRange(id, allVisibleIds)
                          }
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {/* End of timeline marker */}
            <div className="timeline-end">
              <span className="timeline-end-text">
                You&rsquo;re all caught up
              </span>
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
};

export default ClipboardScreen;
