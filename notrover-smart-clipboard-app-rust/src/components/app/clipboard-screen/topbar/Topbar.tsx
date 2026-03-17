import React, { useRef, useState, useEffect } from "react";
import type { ClipboardEntry } from "../../../../types";
import type { SortMode } from "../../sort-options";
import { SORT_OPTIONS } from "../../sort-options";
import GroupManagerCard from "../group-manager/GroupManagerCard";
import BulkActionsBar from "../bulk-actions/BulkActionsBar";
import { SearchBar, FilterDropdown } from "../search-filter/SearchFilter";
import type { useSearchFilter } from "../search-filter/SearchFilter";
import type { useMultiSelect } from "../../../../hooks/useMultiSelect";
import {
  TilesIcon,
  ListIcon,
  ChevronDownIcon,
  TagIcon,
  TrashIcon,
  MultiSelectIcon,
  PinIcon,
  SaveStarIcon,
  SlidersIcon,
} from "../../../icons";
import "./Topbar.css";

export type ClipboardLayout = "tiles" | "list";

interface TopbarProps {
  entries: ClipboardEntry[];
  // Sort
  sort: SortMode;
  setSort: (s: SortMode) => void;
  // Layout
  layout: ClipboardLayout;
  selectLayout: (l: ClipboardLayout) => void;
  // Search & filter
  sf: ReturnType<typeof useSearchFilter>;
  // Multi-select
  multiSelect: ReturnType<typeof useMultiSelect>;
  allVisibleIds: string[];
  allPinned: boolean;
  allSaved: boolean;
  commonGroups: string[];
  // Groups
  availableGroups: string[];
  onAddGroup: (name: string) => void;
  onDeleteGroup: (name: string) => void;
  onRenameGroup: (oldName: string, newName: string) => void;
  // Bulk
  onBulkDelete?: (ids: string[]) => void;
  onBulkPin?: (ids: string[]) => void;
  onBulkUnpin?: (ids: string[]) => void;
  onBulkSave?: (ids: string[]) => void;
  onBulkUnsave?: (ids: string[]) => void;
  onBulkAddGroup?: (ids: string[], group: string) => void;
  onBulkRemoveGroup?: (ids: string[], group: string) => void;
  // Clear
  onClearAll?: () => void;
}

const LAYOUTS: { id: ClipboardLayout; label: string; icon: React.ReactNode }[] = [
  { id: "tiles", label: "Tiles", icon: <TilesIcon size={10} /> },
  { id: "list", label: "List", icon: <ListIcon size={10} /> },
];

const Topbar: React.FC<TopbarProps> = ({
  entries,
  sort,
  setSort,
  layout,
  selectLayout,
  sf,
  multiSelect,
  allVisibleIds,
  allPinned,
  allSaved,
  commonGroups,
  availableGroups,
  onAddGroup,
  onDeleteGroup,
  onRenameGroup,
  onBulkDelete,
  onBulkPin,
  onBulkUnpin,
  onBulkSave,
  onBulkUnsave,
  onBulkAddGroup,
  onBulkRemoveGroup,
  onClearAll,
}) => {
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const groupsRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
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

  return (
    <div className="layout-toggle-wrap">
      {/* Left: Sort + Filters */}
      <div className="cs-toolbar-left">
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

        <FilterDropdown sf={sf} availableGroups={availableGroups} />
      </div>

      {/* Center: Search */}
      <SearchBar sf={sf} />

      {/* Right: Select + Options */}
      <div className="cs-toolbar-right">
        {/* Select mode button */}
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
                if (onBulkAddGroup) onBulkAddGroup([...multiSelect.selectedIds], group);
              }}
              onBulkRemoveGroup={(group) => {
                if (onBulkRemoveGroup) onBulkRemoveGroup([...multiSelect.selectedIds], group);
              }}
              availableGroups={availableGroups}
              commonGroups={commonGroups}
            />
          )}
        </div>

        {/* Options button */}
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
              {/* Layout toggle */}
              <div className="cs-layout-switch">
                <div
                  className="cs-layout-slider"
                  style={{ transform: layout === "list" ? "translateX(100%)" : "translateX(0)" }}
                />
                {LAYOUTS.map((l) => (
                  <button
                    key={l.id}
                    className={`cs-layout-btn${layout === l.id ? " cs-layout-btn--active" : ""}`}
                    onClick={() => selectLayout(l.id)}
                  >
                    {l.icon}
                    <span>{l.label}</span>
                  </button>
                ))}
              </div>

              {/* Groups */}
              <div className="groups-dropdown" ref={groupsRef}>
                <button
                  className={`cs-groups-btn${groupsOpen ? " cs-groups-btn--open" : ""}`}
                  onMouseDown={(e) => { if (groupsOpen) e.stopPropagation(); }}
                  onClick={() => setGroupsOpen((v) => !v)}
                >
                  <TagIcon size={10} strokeWidth={2} />
                  <span>Groups</span>
                  {availableGroups.length > 0 && (
                    <span className="cs-groups-count">{availableGroups.length}</span>
                  )}
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

              {/* Clear history */}
              {onClearAll && (
                <>
                  <div className="cs-options-divider" />
                  <button
                    className="cs-clear-btn"
                    onClick={() => {
                      onClearAll();
                      setOptionsOpen(false);
                    }}
                  >
                    <TrashIcon size={10} />
                    <span>Clear History</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Topbar;
