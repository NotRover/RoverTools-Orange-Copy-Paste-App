import React, { useRef, useState } from "react";
import { useClickOutside } from "../../../hooks/useClickOutside";
import type { ClipboardEntry } from "../../../types";
import type { SortMode } from "../sort-options";
import { SORT_OPTIONS } from "../sort-options";
import GroupManagerCard from "../clipboard-screen/group-manager/GroupManagerCard";
import {
  TilesIcon,
  SingleColumnIcon,
  GridIcon,
  ChevronDownIcon,
  TagIcon,
  SearchIcon,
  CloseIcon,
} from "../../icons";
import "./Topbar.css";

export type ClipboardLayout = "tiles" | "single" | "list";

// Shell

interface TopbarProps {
  leftSlot?: React.ReactNode;
  rightSlot?: React.ReactNode;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
}

const Topbar: React.FC<TopbarProps> = ({
  leftSlot,
  rightSlot,
  searchQuery,
  onSearchChange,
  searchPlaceholder = "Search…",
  searchInputRef: externalRef,
}) => {
  const internalRef = useRef<HTMLInputElement>(null);
  const inputRef = externalRef ?? internalRef;

  return (
    <div className="layout-toggle-wrap">
      <div className="cs-toolbar-left cs-toolbar-slot">
        {leftSlot}
      </div>

      <div className="cs-inline-search">
        <SearchIcon size={11} className="cs-inline-search-icon" />
        <input
          ref={inputRef}
          type="text"
          className="cs-inline-search-input"
          placeholder={searchPlaceholder}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {searchQuery && (
          <button
            className="cs-inline-search-clear"
            onClick={() => {
              onSearchChange("");
              inputRef.current?.focus();
            }}
          >
            <CloseIcon size={8} />
          </button>
        )}
      </div>

      <div className="cs-toolbar-right cs-toolbar-slot">
        {rightSlot}
      </div>
    </div>
  );
};

export default Topbar;

// Reusable sub-components

export const SortDropdown: React.FC<{
  sort: SortMode;
  onSortChange: (s: SortMode) => void;
}> = ({ sort, onSortChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, open, () => setOpen(false));

  return (
    <div className="sort-dropdown" ref={ref}>
      <button
        className={`cs-tb-btn${open ? " cs-tb-btn--open" : ""}`}
        onClick={() => {
          if (!open) document.dispatchEvent(new Event("tooltip:hide"));
          setOpen((v) => !v);
        }}
        data-tooltip={`Sort: ${SORT_OPTIONS.find((s) => s.id === sort)?.label}`}
        data-tooltip-pos="below"
      >
        {SORT_OPTIONS.find((s) => s.id === sort)?.icon}
        <ChevronDownIcon className="sort-chevron" />
      </button>
      {open && (
        <div className="sort-dropdown-menu">
          {SORT_OPTIONS.map((s) => (
            <button
              key={s.id}
              className={`sort-dropdown-item${sort === s.id ? " sort-dropdown-item--active" : ""}`}
              onClick={() => {
                onSortChange(s.id);
                setOpen(false);
              }}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const LayoutSegment: React.FC<{
  layout: ClipboardLayout;
  onLayoutChange: (l: ClipboardLayout) => void;
  /** Show the single-column option (clipboard screen only). */
  showSingle?: boolean;
}> = ({ layout, onLayoutChange, showSingle }) => {
  const sliderTransform = showSingle
    ? layout === "single"
      ? "translateX(200%)"
      : layout === "list"
        ? "translateX(100%)"
        : "translateX(0)"
    : layout === "list"
      ? "translateX(100%)"
      : "translateX(0)";

  return (
    <div className={`cs-layout-segment${showSingle ? " cs-layout-segment--3" : ""}`}>
      <div className="cs-layout-slider" style={{ transform: sliderTransform }} />
      <button
        className={`cs-layout-seg-btn${layout === "tiles" ? " cs-layout-seg-btn--active" : ""}`}
        onClick={() => onLayoutChange("tiles")}
        data-tooltip="Tiles view"
        data-tooltip-pos="below"
      >
        <TilesIcon size={12} />
      </button>
      <button
        className={`cs-layout-seg-btn${layout === "list" ? " cs-layout-seg-btn--active" : ""}`}
        onClick={() => onLayoutChange("list")}
        data-tooltip="Grid view"
        data-tooltip-pos="below"
      >
        <GridIcon size={12} />
      </button>
      {showSingle && (
        <button
          className={`cs-layout-seg-btn${layout === "single" ? " cs-layout-seg-btn--active" : ""}`}
          onClick={() => onLayoutChange("single")}
          data-tooltip="Single column"
          data-tooltip-pos="below"
        >
          <SingleColumnIcon size={12} />
        </button>
      )}
    </div>
  );
};

export const GroupsButton: React.FC<{
  availableGroups: string[];
  entries: ClipboardEntry[];
  onAddGroup: (name: string) => void;
  onDeleteGroup: (name: string) => void;
  onRenameGroup: (oldName: string, newName: string) => void;
  disabled?: boolean;
}> = ({
  availableGroups,
  entries,
  onAddGroup,
  onDeleteGroup,
  onRenameGroup,
  disabled,
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, open, () => setOpen(false));

  return (
    <div className="sort-dropdown" ref={ref}>
      <button
        className={`cs-tb-btn${open ? " cs-tb-btn--open" : ""}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => {
          if (disabled) return;
          if (!open) document.dispatchEvent(new Event("tooltip:hide"));
          setOpen((v) => !v);
        }}
        disabled={disabled}
        data-tooltip="Groups"
        data-tooltip-pos="below"
      >
        <TagIcon size={13} strokeWidth={2} />
        {availableGroups.length > 0 && (
          <span className="cs-tb-badge">{availableGroups.length}</span>
        )}
      </button>
      {open && (
        <GroupManagerCard
          groups={availableGroups}
          entries={entries}
          onAddGroup={onAddGroup}
          onDeleteGroup={onDeleteGroup}
          onRenameGroup={onRenameGroup}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
};
