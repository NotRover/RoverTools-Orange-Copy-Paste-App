import React, { useEffect, useRef, useState } from "react";
import type { ClipboardEntry } from "../../../types";
import { EntryCard } from "./entry-card/EntryCard";
export { EntryCard };
import GroupManagerCard from "./group-manager/GroupManagerCard";
import { SORT_OPTIONS, sortableText } from "../sort-options";
import type { SortMode } from "../sort-options";
import {
  ClipboardIcon,
  MasonryIcon,
  ListIcon,
  ChevronDownIcon,
  TagIcon,
  TrashIcon,
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

  // Close sort dropdown on outside click
  useEffect(() => {
    if (!sortOpen) return;
    const handler = (e: MouseEvent) => {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
        setSortOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [sortOpen]);

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
      icon: <MasonryIcon />,
    },
    {
      id: "list",
      label: "List",
      icon: <ListIcon />,
    },
  ];

  const dayGroups = groupByDay(entries).map((g) => ({
    ...g,
    entries: applySortWithinGroup(g.entries, sort),
  }));

  return (
    <div className="clipboard-screen-root">
      {/*  Toolbar: sort + layout + clear  */}
      <div className="layout-toggle-wrap">
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

        {/* Groups manager */}
        <div className="groups-dropdown" ref={groupsRef}>
          <button
            className={`sort-dropdown-trigger${groupsOpen ? " sort-dropdown-trigger--open" : ""}`}
            onClick={() => setGroupsOpen((v) => !v)}
            data-tooltip="Manage groups"
            data-tooltip-pos="below"
          >
            <TagIcon size={12} strokeWidth={2} />
            <span className="layout-pill-label">
              Groups
              {availableGroups.length > 0 ? ` (${availableGroups.length})` : ""}
            </span>
            <ChevronDownIcon className="sort-chevron" />
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

        <div className="layout-switch" role="group" aria-label="Layout">
          {layouts.map((l) => (
            <button
              key={l.id}
              id={`layout-option-${l.id}`}
              className={`layout-switch-btn${layout === l.id ? " layout-switch-btn--active" : ""}`}
              onClick={() => selectLayout(l.id)}
              data-tooltip={l.label}
              data-tooltip-pos="below"
            >
              {l.icon}
              <span className="layout-pill-label">{l.label}</span>
            </button>
          ))}
        </div>

        {onClearAll && (
          <div className="layout-switch" role="group">
            <button
              className="layout-switch-btn layout-switch-btn--danger"
              onClick={onClearAll}
              data-tooltip="Clear all history"
              data-tooltip-pos="below"
            >
              <TrashIcon size={12} />
              <span className="layout-pill-label">Clear</span>
            </button>
          </div>
        )}
      </div>

      <div
        className={`layout-viewport${fading ? " layout-viewport--fading" : ""}`}
      >
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
                  <ChevronDownIcon className="timeline-day-chevron" size={10} strokeWidth={2.5} />
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
      </div>
    </div>
  );
};

export default ClipboardScreen;
