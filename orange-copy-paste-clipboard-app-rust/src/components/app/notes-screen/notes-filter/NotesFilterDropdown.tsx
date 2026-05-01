import React, { useCallback, useMemo, useRef, useState } from "react";
import { groupColor } from "../../../../types";
import { CloseIcon, FilterIcon } from "../../../icons";
import { PinIcon as PinIconElement } from "../../../entry-types/EntryTypePill";
import "../../clipboard-screen/search-filter/SearchFilter.css";

// ── Notes filter state hook ──────────────────────────────────────────

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

export function useNotesFilter(): NotesFilterState {
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
    pinnedOnly,
    setPinnedOnly,
    selectedGroups,
    toggleGroup,
    activeFilterCount,
    clearAll,
    filtersOpen,
    setFiltersOpen,
    filterRef,
  };
}

// ── Notes Filter Dropdown Component ──────────────────────────────────

interface NotesFilterDropdownProps {
  nf: NotesFilterState;
  availableGroups: string[];
}

const NotesFilterDropdown: React.FC<NotesFilterDropdownProps> = ({
  nf,
  availableGroups,
}) => (
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
            <label
              className={`cs-type-option${nf.pinnedOnly ? " cs-type-option--on" : ""}`}
            >
              <input
                type="checkbox"
                checked={nf.pinnedOnly}
                onChange={() => nf.setPinnedOnly((v) => !v)}
                className="cs-type-cb"
              />
              <span
                className="cs-type-icon type-pill"
                style={{
                  background: "var(--accent-dim)",
                  color: "var(--accent)",
                }}
              >
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
                {nf.selectedGroups.size > 0 && (
                  <span className="cs-count">{nf.selectedGroups.size}</span>
                )}
              </div>
              <div className="cs-type-grid">
                {availableGroups.map((g) => {
                  const gc = groupColor(g);
                  return (
                    <label
                      key={g}
                      className={`cs-type-option${nf.selectedGroups.has(g) ? " cs-type-option--on" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={nf.selectedGroups.has(g)}
                        onChange={() => nf.toggleGroup(g)}
                        className="cs-type-cb"
                      />
                      <span
                        className="cs-type-icon type-pill"
                        style={{ background: gc.bg, color: gc.fg }}
                      >
                        <span
                          className="cs-color-dot"
                          style={{ background: gc.fg }}
                        />
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

export default NotesFilterDropdown;
