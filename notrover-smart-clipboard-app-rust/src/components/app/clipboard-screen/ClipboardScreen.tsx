import React, { useEffect, useRef, useState } from "react";
import type { ClipboardEntry } from "../../../types";
import { EntryCard } from "./entry-card/EntryCard";
export { EntryCard };
import "./ClipboardScreen.css";

// Layout types 

type ClipboardLayout = "masonry" | "list";

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
}

const ClipboardScreen: React.FC<ClipboardScreenProps> = ({
  entries,
  onCopy,
  onDelete,
  onPin,
  onClearAll,
}) => {
  const [layout, setLayout] = useState<ClipboardLayout>(() => {
    return (localStorage.getItem("sc-layout") as ClipboardLayout) ?? "masonry";
  });
  const [fading, setFading] = useState(false);
  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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

  const dayGroups = groupByDay(entries);

  return (
    <div className="clipboard-screen-root">
      {/*  Layout segmented switch  */}
      <div className="layout-toggle-wrap">
        <div className="layout-switch" role="group" aria-label="Layout">
          {layouts.map((l) => (
            <button
              key={l.id}
              id={`layout-option-${l.id}`}
              className={`layout-switch-btn${layout === l.id ? " layout-switch-btn--active" : ""}`}
              onClick={() => selectLayout(l.id)}
              title={l.label}
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
              title="Clear all history"
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
                    <span className="timeline-day-count">{group.entries.length}</span>
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
                <div className={`timeline-group-body${collapsed.has(group.key) ? " timeline-group-body--collapsed" : ""}`}>
                  <div className="timeline-group-body__inner">
                    <div
                      className={layout === "masonry" ? "entry-grid" : "entry-list"}
                    >
                      {group.entries.map((entry) => (
                        <EntryCard
                          key={entry.id}
                          entry={entry}
                          onCopy={onCopy}
                          onDelete={onDelete}
                          onPin={onPin}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {/* End of timeline marker */}
            <div className="timeline-end">
              <span className="timeline-end-text">You&rsquo;re all caught up</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ClipboardScreen;
