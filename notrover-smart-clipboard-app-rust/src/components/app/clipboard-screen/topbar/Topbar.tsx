import React, { useRef, useState, useEffect } from "react";
import type { ClipboardEntry } from "../../../../types";
import type { SortMode } from "../../sort-options";
import { SORT_OPTIONS } from "../../sort-options";
import GroupManagerCard from "../group-manager/GroupManagerCard";
import BulkActionsBar from "../bulk-actions/BulkActionsBar";
import { FilterDropdown } from "../search-filter/SearchFilter";
import type { useSearchFilter } from "../search-filter/SearchFilter";
import type { useMultiSelect } from "../../../../hooks/useMultiSelect";
import {
  TilesIcon,
  ListIcon,
  ChevronDownIcon,
  TagIcon,
  TrashIcon,
  MultiSelectIcon,
  SearchIcon,
  CloseIcon,
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
  const [groupsOpen, setGroupsOpen] = useState(false);
  const groupsRef = useRef<HTMLDivElement>(null);
  // Close dropdowns on outside click
  useEffect(() => {
    if (!sortOpen && !sf.filtersOpen && !groupsOpen) return;
    const handler = (e: MouseEvent) => {
      if (sortOpen && sortRef.current && !sortRef.current.contains(e.target as Node)) setSortOpen(false);
      if (sf.filtersOpen && sf.filterRef.current && !sf.filterRef.current.contains(e.target as Node)) sf.setFiltersOpen(false);
      if (groupsOpen && groupsRef.current && !groupsRef.current.contains(e.target as Node)) setGroupsOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [sortOpen, sf.filtersOpen, groupsOpen]);

  return (
    <div className="layout-toggle-wrap">
      {/* Left: Sort + Filters */}
      <div className="cs-toolbar-left">
        <div className="sort-dropdown" ref={sortRef}>
          <button
            className={`cs-tb-btn${sortOpen ? " cs-tb-btn--open" : ""}`}
            onClick={() => {
              if (!sortOpen) document.dispatchEvent(new Event("tooltip:hide"));
              setSortOpen((v) => !v);
            }}
            data-tooltip={`Sort: ${SORT_OPTIONS.find((s) => s.id === sort)?.label}`}
            data-tooltip-pos="below"
          >
            {SORT_OPTIONS.find((s) => s.id === sort)?.icon}
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

      {/* Center: compact search */}
      <div className="cs-inline-search">
        <SearchIcon size={11} className="cs-inline-search-icon" />
        <input
          ref={sf.searchInputRef}
          type="text"
          className="cs-inline-search-input"
          placeholder="Search…"
          value={sf.searchQuery}
          onChange={(e) => sf.setSearchQuery(e.target.value)}
        />
        {sf.searchQuery && (
          <button
            className="cs-inline-search-clear"
            onClick={() => {
              sf.setSearchQuery("");
              sf.searchInputRef.current?.focus();
            }}
          >
            <CloseIcon size={8} />
          </button>
        )}
      </div>

      {/* Right: actions */}
      <div className="cs-toolbar-right">
        <div className="cs-layout-segment">
          <div
            className="cs-layout-slider"
            style={{ transform: layout === "list" ? "translateX(100%)" : "translateX(0)" }}
          />
          <button
            className={`cs-layout-seg-btn${layout === "tiles" ? " cs-layout-seg-btn--active" : ""}`}
            onClick={() => selectLayout("tiles")}
            data-tooltip="Tiles view"
            data-tooltip-pos="below"
          >
            <TilesIcon size={12} />
          </button>
          <button
            className={`cs-layout-seg-btn${layout === "list" ? " cs-layout-seg-btn--active" : ""}`}
            onClick={() => selectLayout("list")}
            data-tooltip="List view"
            data-tooltip-pos="below"
          >
            <ListIcon size={12} />
          </button>
        </div>

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
              <span className="cs-tb-badge">{multiSelect.selectedCount}</span>
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

        {/* Groups */}
        <div className="sort-dropdown" ref={groupsRef}>
          <button
            className={`cs-tb-btn${groupsOpen ? " cs-tb-btn--open" : ""}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              if (multiSelect.isSelecting) return;
              if (!groupsOpen) document.dispatchEvent(new Event("tooltip:hide"));
              setGroupsOpen((v) => !v);
            }}
            disabled={multiSelect.isSelecting}
            data-tooltip="Groups"
            data-tooltip-pos="below"
          >
            <TagIcon size={13} strokeWidth={2} />
            {availableGroups.length > 0 && (
              <span className="cs-tb-badge">{availableGroups.length}</span>
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
          <button
            className="cs-tb-btn cs-tb-btn--danger"
            onClick={onClearAll}
            disabled={multiSelect.isSelecting}
            data-tooltip="Clear history"
            data-tooltip-pos="below"
          >
            <TrashIcon size={11} />
          </button>
        )}
      </div>
    </div>
  );
};

export default Topbar;
