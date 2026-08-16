import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEntry } from "../../../types";
import { EntryCard } from "./entry-card/EntryCard";
import { useSearchFilter, FilterDropdown, NoResults } from "./search-filter/SearchFilter";
import { useEntrySyncStates } from "../../../hooks/useEntrySyncStates";
import { useSpaceShares } from "../../../hooks/useSpaceShares";
import { useMultiSelect } from "../../../hooks/useMultiSelect";
import { useClickOutside } from "../../../hooks/useClickOutside";
import { useLayoutTransition } from "../../../hooks/useLayoutTransition";
import { useSelectionSummary } from "../../../hooks/useSelectionSummary";
import BulkActionsBar from "./bulk-actions/BulkActionsBar";
import { sortableText } from "../sort-options";
import type { SortMode } from "../sort-options";
import Topbar, { SortDropdown, LayoutSegment, GroupsButton } from "../topbar/Topbar";
import type { ClipboardLayout } from "../topbar/Topbar";
import {
  ClipboardIcon,
  ChevronDownIcon,
  MultiSelectIcon,
  TrashIcon,
} from "../../icons";
import "./ClipboardScreen.css";

// Layout & sort types

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

// Start-of-day timestamp for a day key — used to order the day buckets.
function dayStartMs(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month, day).getTime();
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

// Progressive rendering keeps the DOM light with large histories instead of
// mounting every entry up front. Render a solid first screenful, then grow in
// small steps as the user scrolls (smaller steps feel smoother than big jumps).
const RENDER_INITIAL_COUNT = 200;
const RENDER_PAGE_SIZE = 50;

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
  /** ID of the entry currently in the OS clipboard. */
  activeClipboardId?: string;
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
  activeClipboardId,
}) => {
  const { layout, fading, selectLayout } = useLayoutTransition<ClipboardLayout>(
    "sc-layout",
    "tiles",
  );
  const [sort, setSort] = useState<SortMode>(() => {
    return (localStorage.getItem("sc-sort") as SortMode) ?? "newest";
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Progressive rendering window (see RENDER_INITIAL_COUNT / RENDER_PAGE_SIZE).
  const [visibleCount, setVisibleCount] = useState(RENDER_INITIAL_COUNT);
  const viewportRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Search & filter (delegated to sub-component)
  const sf = useSearchFilter(entries);

  // Multi-select state
  const multiSelect = useMultiSelect();

  // Cloud badge state, keyed "clipboard:{id}". Kept out of the entry model.
  const entrySyncStates = useEntrySyncStates();
  const spaceShares = useSpaceShares();

  // Day groups: entries sorted within each day, and the day buckets themselves
  // ordered by date — oldest-first only for the "oldest" sort, newest-first for
  // every other mode. Memoised so grouping/sorting only recomputes when the
  // filtered set or sort mode changes.
  const dayGroups = useMemo(() => {
    const groups = groupByDay(sf.filteredEntries).map((g) => ({
      ...g,
      entries: applySortWithinGroup(g.entries, sort),
    }));
    const dir = sort === "oldest" ? 1 : -1;
    groups.sort((a, b) => (dayStartMs(a.key) - dayStartMs(b.key)) * dir);
    return groups;
  }, [sf.filteredEntries, sort]);

  // Flat list of all filtered entry IDs (respecting sort order) for range /
  // select-all. Covers the whole filtered set, not just the rendered window.
  const allVisibleIds = useMemo(
    () => dayGroups.flatMap((g) => g.entries.map((e) => e.id)),
    [dayGroups],
  );

  // Apply the render window across day groups in order. Groups beyond the
  // budget are dropped entirely; the group straddling the boundary is sliced.
  const { windowedGroups, hasMore } = useMemo(() => {
    let budget = visibleCount;
    const out: DayGroup[] = [];
    for (const g of dayGroups) {
      if (budget <= 0) break;
      if (g.entries.length <= budget) {
        out.push(g);
        budget -= g.entries.length;
      } else {
        out.push({ ...g, entries: g.entries.slice(0, budget) });
        budget = 0;
      }
    }
    const shown = out.reduce((n, g) => n + g.entries.length, 0);
    return { windowedGroups: out, hasMore: shown < allVisibleIds.length };
  }, [dayGroups, visibleCount, allVisibleIds.length]);

  // Reset the window (and scroll to top) when the view changes — a new search,
  // filter, or sort. Data-only updates (new copies, pin toggles) don't reset it,
  // so the user's scrolled position and loaded window are preserved.
  const viewKey = useMemo(
    () =>
      JSON.stringify([
        sf.searchQuery.trim(),
        [...sf.selectedKinds],
        sf.pinnedOnly,
        sf.dateAfter,
        sf.dateBefore,
        [...sf.selectedFilterGroups],
        sort,
      ]),
    [
      sf.searchQuery,
      sf.selectedKinds,
      sf.pinnedOnly,
      sf.dateAfter,
      sf.dateBefore,
      sf.selectedFilterGroups,
      sort,
    ],
  );
  useEffect(() => {
    setVisibleCount(RENDER_INITIAL_COUNT);
    viewportRef.current?.scrollTo({ top: 0 });
  }, [viewKey]);

  // Grow the window when the sentinel scrolls near the viewport bottom. The
  // windowedGroups dependency re-arms the observer after each growth, so a
  // viewport that isn't full yet keeps loading until it is (or all are shown).
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (obs) => {
        if (obs.some((o) => o.isIntersecting)) {
          setVisibleCount((c) => c + RENDER_PAGE_SIZE);
        }
      },
      { root: viewportRef.current, rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, windowedGroups]);

  // Stable range-select handler: reads the latest id list from a ref so the
  // callback identity never changes (keeps EntryCard's memoisation intact).
  const allVisibleIdsRef = useRef(allVisibleIds);
  allVisibleIdsRef.current = allVisibleIds;
  const handleRangeSelect = useCallback(
    (id: string) => multiSelect.selectRange(id, allVisibleIdsRef.current),
    [multiSelect.selectRange],
  );

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

  // Bulk-selection state (common groups, all-pinned, all-saved) for the toolbar.
  const { allPinned, allSaved, commonGroups } = useSelectionSummary(
    entries,
    multiSelect.selectedIds,
  );

  // Spaces every selected entry is already in, so one click can share the
  // whole selection or take it back out.
  const commonSpaceIds = useMemo(() => {
    const ids = [...multiSelect.selectedIds];
    if (ids.length === 0) return [];
    const first = spaceShares.shares[`clipboard:${ids[0]}`] ?? [];
    return first.filter((spaceId) =>
      ids.every((id) =>
        (spaceShares.shares[`clipboard:${id}`] ?? []).includes(spaceId),
      ),
    );
  }, [multiSelect.selectedIds, spaceShares.shares]);

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Close filter dropdown on outside click
  useClickOutside(sf.filterRef, sf.filtersOpen, () => sf.setFiltersOpen(false));

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

  return (
    <div className="clipboard-screen-root">
      <Topbar
        searchQuery={sf.searchQuery}
        onSearchChange={sf.setSearchQuery}
        searchInputRef={sf.searchInputRef}
        leftSlot={
          <>
            <SortDropdown
              sort={sort}
              onSortChange={(s) => {
                setSort(s);
                localStorage.setItem("sc-sort", s);
              }}
            />
            <FilterDropdown sf={sf} availableGroups={availableGroups} />
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
                    : "Select entries"
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
                      if (onBulkUnpin)
                        onBulkUnpin([...multiSelect.selectedIds]);
                    } else {
                      if (onBulkPin) onBulkPin([...multiSelect.selectedIds]);
                    }
                  }}
                  allSaved={allSaved}
                  onBulkToggleSave={() => {
                    if (allSaved) {
                      if (onBulkUnsave)
                        onBulkUnsave([...multiSelect.selectedIds]);
                    } else {
                      if (onBulkSave) onBulkSave([...multiSelect.selectedIds]);
                    }
                  }}
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
                  spaces={spaceShares.spaces}
                  commonSpaceIds={commonSpaceIds}
                  onBulkToggleSpace={(spaceId, share) =>
                    spaceShares.bulkToggle(
                      "clipboard",
                      [...multiSelect.selectedIds],
                      spaceId,
                      share,
                    )
                  }
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

            {/* Clear history */}
            {onClearAll && (
              <button
                className="cs-tb-btn cs-tb-btn--danger"
                onClick={onClearAll}
                disabled={multiSelect.isSelecting}
                data-tooltip="Clear history"
                data-tooltip-pos="below"
              >
                <TrashIcon size={13} />
              </button>
            )}
          </>
        }
      />

      <div
        ref={viewportRef}
        className={`layout-viewport${fading ? " layout-viewport--fading" : ""}`}
      >
        {sf.isFiltering && sf.filteredEntries.length === 0 ? (
          <NoResults sf={sf} />
        ) : (
        <div className="timeline-wrap">
          <div className="timeline-groups">
            {windowedGroups.map((group, idx) => (
              <div
                key={group.key}
                className={`timeline-group${
                  windowedGroups.length === 1
                    ? " timeline-group--only"
                    : idx === windowedGroups.length - 1
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
                        layout === "tiles"
                          ? "entry-grid"
                          : layout === "single"
                            ? "entry-single"
                            : "entry-list"
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
                          onRangeSelect={handleRangeSelect}
                          isInClipboard={entry.id === activeClipboardId}
                          syncState={entrySyncStates[`clipboard:${entry.id}`]}
                          spaces={spaceShares.spaces}
                          itemSpaceIds={spaceShares.shares[`clipboard:${entry.id}`]}
                          sharedSpaceNames={spaceShares.namesFor("clipboard", entry.id)}
                          onToggleSpace={(entryId, spaceId) =>
                            spaceShares.toggle("clipboard", entryId, spaceId)
                          }
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {/* Load-more sentinel while more entries remain, else the end marker */}
            {hasMore ? (
              <div ref={sentinelRef} className="timeline-sentinel" aria-hidden />
            ) : (
              <div className="timeline-end">
                <span className="timeline-end-text">
                  You&rsquo;re all caught up
                </span>
              </div>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
};

export default ClipboardScreen;
