import React, { useEffect, useRef, useState } from "react";
import type { ClipboardEntry } from "../../../types";
import { filePaths } from "../../../types";
import { EntryCard } from "./entry-card/EntryCard";
export { EntryCard };
import GroupManagerCard from "./group-manager/GroupManagerCard";
import "./ClipboardScreen.css";

// Layout & sort types

type ClipboardLayout = "masonry" | "list";
type SortMode = "newest" | "oldest" | "a-z" | "z-a" | "type";

const SORT_OPTIONS: { id: SortMode; label: string; icon: React.ReactNode }[] = [
  {
    id: "newest",
    label: "Newest",
    icon: (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="17 11 12 6 7 11" />
        <line x1="12" y1="18" x2="12" y2="6" />
      </svg>
    ),
  },
  {
    id: "oldest",
    label: "Oldest",
    icon: (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="7 13 12 18 17 13" />
        <line x1="12" y1="6" x2="12" y2="18" />
      </svg>
    ),
  },
  {
    id: "a-z",
    label: "A \u2192 Z",
    icon: (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 6h7" />
        <path d="M3 12h5" />
        <path d="M3 18h3" />
        <path d="M16 6l4 12" />
        <path d="M20 6l-4 12" />
        <path d="M14.5 14h7" />
      </svg>
    ),
  },
  {
    id: "z-a",
    label: "Z \u2192 A",
    icon: (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 18h7" />
        <path d="M3 12h5" />
        <path d="M3 6h3" />
        <path d="M16 6l4 12" />
        <path d="M20 6l-4 12" />
        <path d="M14.5 14h7" />
      </svg>
    ),
  },
  {
    id: "type",
    label: "Type",
    icon: (
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
  },
];

function sortableText(e: ClipboardEntry): string {
  if (e.type === "text") return e.content.toLowerCase();
  if (e.type === "file") {
    const paths = filePaths(e.content);
    const name = (paths[0] ?? "").split(/[\\/]/).pop() ?? "";
    return name.toLowerCase();
  }
  return "";
}

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
  onPin: (id: string, shouldPin: boolean) => void;
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
        <svg
          className="empty-icon"
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
        </svg>
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
      icon: (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="7" height="9" rx="1" />
          <rect x="14" y="3" width="7" height="5" rx="1" />
          <rect x="14" y="12" width="7" height="9" rx="1" />
          <rect x="3" y="16" width="7" height="5" rx="1" />
        </svg>
      ),
    },
    {
      id: "list",
      label: "List",
      icon: (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      ),
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
            <svg
              className="sort-chevron"
              width="8"
              height="8"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
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
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
              <line x1="7" y1="7" x2="7.01" y2="7" />
            </svg>
            <span className="layout-pill-label">
              Groups
              {availableGroups.length > 0 ? ` (${availableGroups.length})` : ""}
            </span>
            <svg
              className="sort-chevron"
              width="8"
              height="8"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
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
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
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
                  <svg
                    className="timeline-day-chevron"
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
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
