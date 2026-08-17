import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  ShareNetwork,
  CloudCheck,
  CloudSlash,
  ArrowDown,
} from "@phosphor-icons/react";
import type { ClipboardEntry, DisplayKind, Space } from "../../../../types";
import {
  deriveDisplayKind,
  htmlPlainText,
  groupColor,
  imageDisplayName,
} from "../../../../types";
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
} from "../../../icons";
import "./SearchFilter.css";

const ALL_DISPLAY_KINDS: DisplayKind[] = [
  "text",
  "url",
  "html",
  "image",
  "video",
  "document",
  "file",
  "folder",
];

function matchesQuery(entry: ClipboardEntry, q: string): boolean {
  const lower = q.toLowerCase();
  if (entry.type === "text") return entry.content.toLowerCase().includes(lower);
  if (entry.type === "html")
    return htmlPlainText(entry.content).toLowerCase().includes(lower);
  if (entry.type === "file") return entry.content.toLowerCase().includes(lower);
  if (entry.type === "image")
    return imageDisplayName(entry).toLowerCase().includes(lower);
  return false;
}

// Hook

/** Cloud/space context the filters read. Supplied by the screen, which already
 *  holds these for the cards, so the hook stays free of Tauri calls. */
export interface CloudFilterContext {
  /** Entry keys (`"clipboard:{id}"`) with a copy on the server. */
  syncStates: Record<string, unknown>;
  /** Space ids per entry key. */
  shares: Record<string, string[]>;
  /** Entry keys another member wrote. */
  remoteKeys: Set<string>;
  /** Spaces this account belongs to, for the per-space rows. */
  spaces: Space[];
  /** False when no account is signed in, which hides the whole section. */
  signedIn: boolean;
}

/** Server-copy filter: either state, only uploaded, or only local. */
export type CloudFilter = "any" | "in" | "out";
/** Sharing filter: either state, in at least one space, or in none. */
export type ShareFilter = "any" | "shared" | "private";

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
  cloudFilter: CloudFilter;
  setCloudFilter: React.Dispatch<React.SetStateAction<CloudFilter>>;
  shareFilter: ShareFilter;
  setShareFilter: React.Dispatch<React.SetStateAction<ShareFilter>>;
  selectedSpaceIds: Set<string>;
  toggleSpaceFilter: (id: string) => void;
  receivedOnly: boolean;
  setReceivedOnly: React.Dispatch<React.SetStateAction<boolean>>;
  cloud: CloudFilterContext | null;
  activeFilterCount: number;
  clearAllFilters: () => void;
  filteredEntries: ClipboardEntry[];
  isFiltering: boolean;
  filterRef: React.RefObject<HTMLDivElement | null>;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

export function useSearchFilter(
  entries: ClipboardEntry[],
  cloud: CloudFilterContext | null = null,
): SearchFilterState {
  const [searchQuery, setSearchQuery] = useState("");
  const [cloudFilter, setCloudFilter] = useState<CloudFilter>("any");
  const [shareFilter, setShareFilter] = useState<ShareFilter>("any");
  const [selectedSpaceIds, setSelectedSpaceIds] = useState<Set<string>>(
    new Set(),
  );
  const [receivedOnly, setReceivedOnly] = useState(false);
  const [selectedKinds, setSelectedKinds] = useState<Set<DisplayKind>>(
    new Set(),
  );
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [dateAfter, setDateAfter] = useState("");
  const [dateBefore, setDateBefore] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedFilterGroups, setSelectedFilterGroups] = useState<Set<string>>(
    new Set(),
  );
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

  const toggleSpaceFilter = useCallback((id: string) => {
    setSelectedSpaceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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

  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (selectedKinds.size > 0) n++;
    if (pinnedOnly) n++;
    if (dateAfter || (dateBefore && dateBefore !== todayStr)) n++;
    if (selectedFilterGroups.size > 0) n++;
    if (cloudFilter !== "any") n++;
    if (shareFilter !== "any") n++;
    if (selectedSpaceIds.size > 0) n++;
    if (receivedOnly) n++;
    return n;
  }, [
    selectedKinds,
    pinnedOnly,
    dateAfter,
    dateBefore,
    selectedFilterGroups,
    todayStr,
    cloudFilter,
    shareFilter,
    selectedSpaceIds,
    receivedOnly,
  ]);

  const clearAllFilters = useCallback(() => {
    setSelectedKinds(new Set());
    setPinnedOnly(false);
    setDateAfter("");
    setDateBefore(todayStr);
    setSelectedFilterGroups(new Set());
    setCloudFilter("any");
    setShareFilter("any");
    setSelectedSpaceIds(new Set());
    setReceivedOnly(false);
  }, [todayStr]);

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
      pool = pool.filter((e) => matchesQuery(e, q));
    }
    if (selectedFilterGroups.size > 0) {
      pool = pool.filter(
        (e) => e.groups && e.groups.some((g) => selectedFilterGroups.has(g)),
      );
    }
    // Cloud and space filters read Rust-owned bookkeeping keyed by entry id,
    // not fields on the entry, so they all resolve through the same key.
    if (cloud) {
      const key = (e: ClipboardEntry) => `clipboard:${e.id}`;
      if (cloudFilter !== "any") {
        const want = cloudFilter === "in";
        pool = pool.filter((e) => !!cloud.syncStates[key(e)] === want);
      }
      if (shareFilter !== "any") {
        const want = shareFilter === "shared";
        pool = pool.filter(
          (e) => (cloud.shares[key(e)]?.length ?? 0) > 0 === want,
        );
      }
      if (selectedSpaceIds.size > 0) {
        pool = pool.filter((e) =>
          (cloud.shares[key(e)] ?? []).some((id) => selectedSpaceIds.has(id)),
        );
      }
      if (receivedOnly) pool = pool.filter((e) => cloud.remoteKeys.has(key(e)));
    }
    return pool;
  }, [
    entries,
    searchQuery,
    selectedKinds,
    pinnedOnly,
    dateAfter,
    dateBefore,
    selectedFilterGroups,
    cloud,
    cloudFilter,
    shareFilter,
    selectedSpaceIds,
    receivedOnly,
  ]);

  const isFiltering = searchQuery.trim().length > 0 || activeFilterCount > 0;

  return {
    searchQuery,
    setSearchQuery,
    selectedKinds,
    toggleKind,
    pinnedOnly,
    setPinnedOnly,
    dateAfter,
    setDateAfter,
    dateBefore,
    setDateBefore,
    filtersOpen,
    setFiltersOpen,
    selectedFilterGroups,
    toggleFilterGroup,
    cloudFilter,
    setCloudFilter,
    shareFilter,
    setShareFilter,
    selectedSpaceIds,
    toggleSpaceFilter,
    receivedOnly,
    setReceivedOnly,
    cloud,
    activeFilterCount,
    clearAllFilters,
    filteredEntries,
    isFiltering,
    filterRef,
    searchInputRef,
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
      placeholder="Search..."
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

export const FilterDropdown: React.FC<FilterDropdownProps> = ({
  sf,
  availableGroups,
}) => (
  <div className="sort-dropdown" ref={sf.filterRef}>
    <button
      className={`cs-tb-btn${sf.filtersOpen ? " cs-tb-btn--open" : ""}`}
      onClick={() => {
        if (!sf.filtersOpen) document.dispatchEvent(new Event("tooltip:hide"));
        sf.setFiltersOpen((v) => !v);
      }}
      data-tooltip="Filters"
      data-tooltip-pos="below"
    >
      <FilterIcon size={12} />
      {sf.activeFilterCount > 0 && (
        <span className="cs-tb-badge">{sf.activeFilterCount}</span>
      )}
    </button>
    {sf.filtersOpen && (
      <div className="cs-filter-card">
        {/* System section */}
        <div className="cs-card-section">
          <div className="cs-section-label">
            System
            {(sf.pinnedOnly ? 1 : 0) +
              (sf.selectedFilterGroups.has("Saved") ? 1 : 0) >
              0 && (
              <span className="cs-count">
                {(sf.pinnedOnly ? 1 : 0) +
                  (sf.selectedFilterGroups.has("Saved") ? 1 : 0)}
              </span>
            )}
          </div>
          <div className="cs-type-grid">
            <label
              className={`cs-type-option${sf.pinnedOnly ? " cs-type-option--on" : ""}`}
            >
              <input
                type="checkbox"
                checked={sf.pinnedOnly}
                onChange={() => sf.setPinnedOnly((v) => !v)}
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
            <label
              className={`cs-type-option${sf.selectedFilterGroups.has("Saved") ? " cs-type-option--on" : ""}`}
            >
              <input
                type="checkbox"
                checked={sf.selectedFilterGroups.has("Saved")}
                onChange={() => sf.toggleFilterGroup("Saved")}
                className="cs-type-cb"
              />
              <span
                className="cs-type-icon type-pill"
                style={{
                  background: "rgba(34, 197, 94, 0.12)",
                  color: "#22c55e",
                }}
              >
                <SaveStarIcon size={9} filled />
              </span>
              <span className="cs-type-name">Saved</span>
            </label>
          </div>
        </div>

        {/* Cloud section. Hidden entirely when signed out, where every answer
            would be the same. */}
        {sf.cloud?.signedIn && (
          <>
            <div className="cs-card-divider" />
            <div className="cs-card-section">
              <div className="cs-section-label">
                Cloud
                {(sf.cloudFilter !== "any" ? 1 : 0) +
                  (sf.shareFilter !== "any" ? 1 : 0) +
                  (sf.receivedOnly ? 1 : 0) +
                  (sf.selectedSpaceIds.size > 0 ? 1 : 0) >
                  0 && (
                  <span className="cs-count">
                    {(sf.cloudFilter !== "any" ? 1 : 0) +
                      (sf.shareFilter !== "any" ? 1 : 0) +
                      (sf.receivedOnly ? 1 : 0) +
                      (sf.selectedSpaceIds.size > 0 ? 1 : 0)}
                  </span>
                )}
              </div>

              {/* Three-way toggles: the two states are opposites, so a pair of
                  checkboxes would let you ask for both at once and get nothing. */}
              <div className="cs-seg">
                <button
                  className={`cs-seg-btn${sf.cloudFilter === "any" ? " cs-seg-btn--on" : ""}`}
                  onClick={() => sf.setCloudFilter("any")}
                >
                  All
                </button>
                <button
                  className={`cs-seg-btn${sf.cloudFilter === "in" ? " cs-seg-btn--on" : ""}`}
                  onClick={() => sf.setCloudFilter("in")}
                >
                  <CloudCheck size={10} />
                  In cloud
                </button>
                <button
                  className={`cs-seg-btn${sf.cloudFilter === "out" ? " cs-seg-btn--on" : ""}`}
                  onClick={() => sf.setCloudFilter("out")}
                >
                  <CloudSlash size={10} />
                  Local only
                </button>
              </div>

              <div className="cs-seg">
                <button
                  className={`cs-seg-btn${sf.shareFilter === "any" ? " cs-seg-btn--on" : ""}`}
                  onClick={() => sf.setShareFilter("any")}
                >
                  All
                </button>
                <button
                  className={`cs-seg-btn${sf.shareFilter === "shared" ? " cs-seg-btn--on" : ""}`}
                  onClick={() => sf.setShareFilter("shared")}
                >
                  <ShareNetwork size={10} />
                  In a space
                </button>
                <button
                  className={`cs-seg-btn${sf.shareFilter === "private" ? " cs-seg-btn--on" : ""}`}
                  onClick={() => sf.setShareFilter("private")}
                >
                  Not shared
                </button>
              </div>

              <div className="cs-type-grid">
                <label
                  className={`cs-type-option${sf.receivedOnly ? " cs-type-option--on" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={sf.receivedOnly}
                    onChange={() => sf.setReceivedOnly((v) => !v)}
                    className="cs-type-cb"
                  />
                  <span
                    className="cs-type-icon type-pill"
                    style={{
                      background: "var(--accent-dim)",
                      color: "var(--accent)",
                    }}
                  >
                    <ArrowDown size={9} weight="bold" />
                  </span>
                  <span className="cs-type-name">From others</span>
                </label>
              </div>

              {sf.cloud.spaces.length > 0 && (
                <div className="cs-type-grid">
                  {sf.cloud.spaces.map((space) => (
                    <label
                      key={space.id}
                      className={`cs-type-option${sf.selectedSpaceIds.has(space.id) ? " cs-type-option--on" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={sf.selectedSpaceIds.has(space.id)}
                        onChange={() => sf.toggleSpaceFilter(space.id)}
                        className="cs-type-cb"
                      />
                      <span
                        className="cs-type-icon type-pill"
                        style={{
                          background: "var(--accent-dim)",
                          color: "var(--accent)",
                        }}
                      >
                        <ShareNetwork size={9} />
                      </span>
                      <span className="cs-type-name">{space.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* Types section */}
        <div className="cs-card-divider" />
        <div className="cs-card-section">
          <div className="cs-section-label">
            Types
            {sf.selectedKinds.size > 0 && (
              <span className="cs-count">{sf.selectedKinds.size}</span>
            )}
          </div>
          <div className="cs-type-grid">
            {ALL_DISPLAY_KINDS.map((k) => (
              <label
                key={k}
                className={`cs-type-option${sf.selectedKinds.has(k) ? " cs-type-option--on" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={sf.selectedKinds.has(k)}
                  onChange={() => sf.toggleKind(k)}
                  className="cs-type-cb"
                />
                <span className={`cs-type-icon type-pill type-pill--${k}`}>
                  {TYPE_ICONS[k]}
                </span>
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
                {sf.selectedFilterGroups.size > 0 && (
                  <span className="cs-count">
                    {sf.selectedFilterGroups.size}
                  </span>
                )}
              </div>
              <div className="cs-type-grid">
                {availableGroups
                  .filter((g) => g !== "Saved")
                  .map((g) => {
                    const gc = groupColor(g);
                    return (
                      <label
                        key={g}
                        className={`cs-type-option${sf.selectedFilterGroups.has(g) ? " cs-type-option--on" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={sf.selectedFilterGroups.has(g)}
                          onChange={() => sf.toggleFilterGroup(g)}
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

        <div className="cs-card-divider" />

        {/* Date section */}
        <div className="cs-card-section">
          <div className="cs-section-label">
            Date
            {(sf.dateAfter || sf.dateBefore) && (
              <span className="cs-count">1</span>
            )}
          </div>
          <div className="cs-date-row">
            <input
              type="date"
              className="cs-date-input"
              value={sf.dateAfter}
              onChange={(e) => sf.setDateAfter(e.target.value)}
              title="After"
            />
            <span className="cs-date-sep">-</span>
            <input
              type="date"
              className="cs-date-input"
              value={sf.dateBefore}
              onChange={(e) => sf.setDateBefore(e.target.value)}
              title="Before"
            />
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
      {sf.searchQuery.trim() ? (
        <>
          Nothing matches &ldquo;{sf.searchQuery.trim()}&rdquo;
          {sf.activeFilterCount > 0 ? " with the current filters" : ""}.
        </>
      ) : (
        <>No entries match the current filters.</>
      )}
    </p>
  </div>
);
