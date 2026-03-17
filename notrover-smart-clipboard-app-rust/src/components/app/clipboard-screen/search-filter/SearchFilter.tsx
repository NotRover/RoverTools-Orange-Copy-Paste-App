import React, { useCallback, useMemo, useRef, useState } from "react";
import type { ClipboardEntry, DisplayKind } from "../../../../types";
import { deriveDisplayKind, htmlPlainText, groupColor } from "../../../../types";
import {
  TYPE_ICONS,
  TYPE_LABELS,
  PinIcon as PinIconElement,
} from "../../../entry-types/EntryTypePill";
import {
  SearchIcon,
  CloseIcon,
  FilterIcon,
  SearchXIcon,
  SaveStarIcon,
  ChevronDownIcon,
} from "../../../icons";
import "./SearchFilter.css";

const ALL_DISPLAY_KINDS: DisplayKind[] = [
  "text", "url", "html", "image", "video", "document", "file", "folder",
];

function matchesQuery(entry: ClipboardEntry, q: string): boolean {
  const lower = q.toLowerCase();
  if (entry.type === "text") return entry.content.toLowerCase().includes(lower);
  if (entry.type === "html") return htmlPlainText(entry.content).toLowerCase().includes(lower);
  if (entry.type === "file") return entry.content.toLowerCase().includes(lower);
  return false;
}

// Hook

export interface SearchFilterState {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  selectedKinds: Set<DisplayKind>;
  toggleKind: (k: DisplayKind) => void;
  pinnedOnly: boolean;
  setPinnedOnly: React.Dispatch<React.SetStateAction<boolean>>;
  dateAfter: string;
  setDateAfter: (v: string) => void;
  dateBefore: string;
  setDateBefore: (v: string) => void;
  filtersOpen: boolean;
  setFiltersOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectedFilterGroups: Set<string>;
  toggleFilterGroup: (g: string) => void;
  activeFilterCount: number;
  clearAllFilters: () => void;
  filteredEntries: ClipboardEntry[];
  isFiltering: boolean;
  filterRef: React.RefObject<HTMLDivElement | null>;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

export function useSearchFilter(entries: ClipboardEntry[]): SearchFilterState {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedKinds, setSelectedKinds] = useState<Set<DisplayKind>>(new Set());
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [dateAfter, setDateAfter] = useState("");
  const [dateBefore, setDateBefore] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedFilterGroups, setSelectedFilterGroups] = useState<Set<string>>(new Set());
  const filterRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const toggleKind = useCallback((k: DisplayKind) => {
    setSelectedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const toggleFilterGroup = useCallback((g: string) => {
    setSelectedFilterGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }, []);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (selectedKinds.size > 0) n++;
    if (pinnedOnly) n++;
    if (dateAfter || dateBefore) n++;
    if (selectedFilterGroups.size > 0) n++;
    return n;
  }, [selectedKinds, pinnedOnly, dateAfter, dateBefore, selectedFilterGroups]);

  const clearAllFilters = useCallback(() => {
    setSelectedKinds(new Set());
    setPinnedOnly(false);
    setDateAfter("");
    setDateBefore("");
    setSelectedFilterGroups(new Set());
  }, []);

  const filteredEntries = useMemo(() => {
    let pool = entries;
    if (selectedKinds.size > 0) {
      pool = pool.filter((e) => selectedKinds.has(deriveDisplayKind(e)));
    }
    if (pinnedOnly) pool = pool.filter((e) => e.pinned);
    if (dateAfter) {
      const ts = new Date(dateAfter + "T00:00:00").getTime();
      pool = pool.filter((e) => e.timestamp >= ts);
    }
    if (dateBefore) {
      const ts = new Date(dateBefore + "T23:59:59.999").getTime();
      pool = pool.filter((e) => e.timestamp <= ts);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim();
      pool = pool.filter((e) => {
        if (e.type === "image") return true;
        return matchesQuery(e, q);
      });
    }
    if (selectedFilterGroups.size > 0) {
      pool = pool.filter(
        (e) => e.groups && e.groups.some((g) => selectedFilterGroups.has(g)),
      );
    }
    return pool;
  }, [entries, searchQuery, selectedKinds, pinnedOnly, dateAfter, dateBefore, selectedFilterGroups]);

  const isFiltering = searchQuery.trim().length > 0 || activeFilterCount > 0;

  return {
    searchQuery, setSearchQuery,
    selectedKinds, toggleKind,
    pinnedOnly, setPinnedOnly,
    dateAfter, setDateAfter,
    dateBefore, setDateBefore,
    filtersOpen, setFiltersOpen,
    selectedFilterGroups, toggleFilterGroup,
    activeFilterCount, clearAllFilters,
    filteredEntries, isFiltering,
    filterRef, searchInputRef,
  };
}

// Search bar component

interface SearchBarProps {
  sf: SearchFilterState;
}

export const SearchBar: React.FC<SearchBarProps> = ({ sf }) => (
  <div className="cs-searchbar">
    <SearchIcon size={13} className="cs-search-icon" />
    <input
      ref={sf.searchInputRef}
      type="text"
      className="cs-search-input"
      placeholder="Search…"
      value={sf.searchQuery}
      onChange={(e) => sf.setSearchQuery(e.target.value)}
    />
    {sf.searchQuery && (
      <button
        className="cs-search-clear"
        onClick={() => {
          sf.setSearchQuery("");
          sf.searchInputRef.current?.focus();
        }}
      >
        <CloseIcon size={9} />
      </button>
    )}
  </div>
);

// Filter dropdown component

interface FilterDropdownProps {
  sf: SearchFilterState;
  availableGroups: string[];
}

export const FilterDropdown: React.FC<FilterDropdownProps> = ({ sf, availableGroups }) => (
  <div className="sort-dropdown" ref={sf.filterRef}>
    <button
      className={`sort-dropdown-trigger${sf.filtersOpen ? " sort-dropdown-trigger--open" : ""}`}
      onClick={() => sf.setFiltersOpen((v) => !v)}
      data-tooltip="Filters"
      data-tooltip-pos="below"
    >
      <FilterIcon />
      <span className="layout-pill-label">
        Filters{sf.activeFilterCount > 0 ? ` (${sf.activeFilterCount})` : ""}
      </span>
      <ChevronDownIcon className="sort-chevron" />
    </button>
    {sf.filtersOpen && (
      <div className="cs-filter-card">
        {/* System section */}
        <div className="cs-card-section">
          <div className="cs-section-label">
            System
            {((sf.pinnedOnly ? 1 : 0) + (sf.selectedFilterGroups.has("Saved") ? 1 : 0)) > 0 && (
              <span className="cs-count">
                {(sf.pinnedOnly ? 1 : 0) + (sf.selectedFilterGroups.has("Saved") ? 1 : 0)}
              </span>
            )}
          </div>
          <div className="cs-type-grid">
            <label className={`cs-type-option${sf.pinnedOnly ? " cs-type-option--on" : ""}`}>
              <input type="checkbox" checked={sf.pinnedOnly} onChange={() => sf.setPinnedOnly((v) => !v)} className="cs-type-cb" />
              <span className="cs-type-icon type-pill" style={{ background: "var(--accent-dim)", color: "var(--accent)" }}>
                {PinIconElement}
              </span>
              <span className="cs-type-name">Pinned</span>
            </label>
            <label className={`cs-type-option${sf.selectedFilterGroups.has("Saved") ? " cs-type-option--on" : ""}`}>
              <input type="checkbox" checked={sf.selectedFilterGroups.has("Saved")} onChange={() => sf.toggleFilterGroup("Saved")} className="cs-type-cb" />
              <span className="cs-type-icon type-pill" style={{ background: "rgba(34, 197, 94, 0.12)", color: "#22c55e" }}>
                <SaveStarIcon size={9} filled />
              </span>
              <span className="cs-type-name">Saved</span>
            </label>
          </div>
        </div>

        {/* Types section */}
        <div className="cs-card-divider" />
        <div className="cs-card-section">
          <div className="cs-section-label">
            Types
            {sf.selectedKinds.size > 0 && <span className="cs-count">{sf.selectedKinds.size}</span>}
          </div>
          <div className="cs-type-grid">
            {ALL_DISPLAY_KINDS.map((k) => (
              <label key={k} className={`cs-type-option${sf.selectedKinds.has(k) ? " cs-type-option--on" : ""}`}>
                <input type="checkbox" checked={sf.selectedKinds.has(k)} onChange={() => sf.toggleKind(k)} className="cs-type-cb" />
                <span className={`cs-type-icon type-pill type-pill--${k}`}>{TYPE_ICONS[k]}</span>
                <span className="cs-type-name">{TYPE_LABELS[k]}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Groups section */}
        {availableGroups.filter((g) => g !== "Saved").length > 0 && (
          <>
            <div className="cs-card-divider" />
            <div className="cs-card-section">
              <div className="cs-section-label">
                Groups
                {sf.selectedFilterGroups.size > 0 && <span className="cs-count">{sf.selectedFilterGroups.size}</span>}
              </div>
              <div className="cs-type-grid">
                {availableGroups.filter((g) => g !== "Saved").map((g) => {
                  const gc = groupColor(g);
                  return (
                    <label key={g} className={`cs-type-option${sf.selectedFilterGroups.has(g) ? " cs-type-option--on" : ""}`}>
                      <input type="checkbox" checked={sf.selectedFilterGroups.has(g)} onChange={() => sf.toggleFilterGroup(g)} className="cs-type-cb" />
                      <span className="cs-type-icon type-pill" style={{ background: gc.bg, color: gc.fg }}>
                        <span className="cs-color-dot" style={{ background: gc.fg }} />
                      </span>
                      <span className="cs-type-name">{g}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </>
        )}

        <div className="cs-card-divider" />

        {/* Date section */}
        <div className="cs-card-section">
          <div className="cs-section-label">
            Date
            {(sf.dateAfter || sf.dateBefore) && <span className="cs-count">1</span>}
          </div>
          <div className="cs-date-row">
            <input type="date" className="cs-date-input" value={sf.dateAfter} onChange={(e) => sf.setDateAfter(e.target.value)} title="After" />
            <span className="cs-date-sep">–</span>
            <input type="date" className="cs-date-input" value={sf.dateBefore} onChange={(e) => sf.setDateBefore(e.target.value)} title="Before" />
          </div>
        </div>

        {/* Clear filters button */}
        {sf.activeFilterCount > 0 && (
          <>
            <div className="cs-card-divider" />
            <button className="cs-card-clear-btn" onClick={sf.clearAllFilters}>
              <CloseIcon size={12} />
              Clear Filters
            </button>
          </>
        )}
      </div>
    )}
  </div>
);

// No results component

interface NoResultsProps {
  sf: SearchFilterState;
}

export const NoResults: React.FC<NoResultsProps> = ({ sf }) => (
  <div className="cs-no-results">
    <SearchXIcon size={44} className="cs-no-results-icon" />
    <p className="cs-no-results-title">No results</p>
    <p className="cs-no-results-subtitle">
      {sf.searchQuery.trim()
        ? <>Nothing matches &ldquo;{sf.searchQuery.trim()}&rdquo;{sf.activeFilterCount > 0 ? " with the current filters" : ""}.</>
        : <>No entries match the current filters.</>}
    </p>
  </div>
);
