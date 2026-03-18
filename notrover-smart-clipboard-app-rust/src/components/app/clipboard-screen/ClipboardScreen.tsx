import React, { useEffect, useRef, useState } from "react";
import type { ClipboardEntry } from "../../../types";
import { EntryCard } from "./entry-card/EntryCard";
export { EntryCard };
import { useSearchFilter, NoResults } from "./search-filter/SearchFilter";
import { useMultiSelect } from "../../../hooks/useMultiSelect";
import { sortableText } from "../sort-options";
import type { SortMode } from "../sort-options";
import Topbar from "./topbar/Topbar";
import type { ClipboardLayout } from "./topbar/Topbar";
import {
  ClipboardIcon,
  ChevronDownIcon,
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
    return (localStorage.getItem("sc-layout") as ClipboardLayout) ?? "tiles";
  });
  const [sort, setSort] = useState<SortMode>(() => {
    return (localStorage.getItem("sc-sort") as SortMode) ?? "newest";
  });
  const [fading, setFading] = useState(false);
  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Search & filter (delegated to sub-component)
  const sf = useSearchFilter(entries);

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

  return (
    <div className="clipboard-screen-root">
      <Topbar
        entries={entries}
        sort={sort}
        setSort={setSort}
        layout={layout}
        selectLayout={selectLayout}
        sf={sf}
        multiSelect={multiSelect}
        allVisibleIds={allVisibleIds}
        allPinned={allPinned}
        allSaved={allSaved}
        commonGroups={commonGroups}
        availableGroups={availableGroups}
        onAddGroup={onAddGroup}
        onDeleteGroup={onDeleteGroup}
        onRenameGroup={onRenameGroup}
        onBulkDelete={onBulkDelete}
        onBulkPin={onBulkPin}
        onBulkUnpin={onBulkUnpin}
        onBulkSave={onBulkSave}
        onBulkUnsave={onBulkUnsave}
        onBulkAddGroup={onBulkAddGroup}
        onBulkRemoveGroup={onBulkRemoveGroup}
        onClearAll={onClearAll}
      />

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
                        layout === "tiles" ? "entry-grid" : "entry-list"
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
