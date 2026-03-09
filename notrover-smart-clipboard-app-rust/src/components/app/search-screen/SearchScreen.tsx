import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ClipboardEntry, DisplayKind } from "../../../types";
import { deriveDisplayKind, htmlPlainText } from "../../../types";
import {
  TYPE_ICONS,
  TYPE_LABELS,
  PinIcon as PinIconElement,
} from "../../entry-types/EntryTypePill";
import { EntryCard } from "../clipboard-screen/entry-card/EntryCard";
import { SORT_OPTIONS, sortableText } from "../sort-options";
import type { SortMode } from "../sort-options";
import {
  SearchIcon,
  CloseIcon,
  FilterIcon,
  ChevronDownIcon,
  TagIcon,
  ClockIcon,
  SearchXIcon,
} from "../../icons";
import "./SearchScreen.css";

// Constants

const TYPE_ORDER: Record<string, number> = {
  text: 0,
  url: 1,
  document: 2,
  file: 3,
  folder: 4,
  image: 5,
  video: 6,
};

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

// Helpers

function matchesQuery(entry: ClipboardEntry, q: string): boolean {
  const lower = q.toLowerCase();
  if (entry.type === "text") return entry.content.toLowerCase().includes(lower);
  if (entry.type === "html") return htmlPlainText(entry.content).toLowerCase().includes(lower);
  if (entry.type === "file") {
    // Search full paths, not just filenames
    return entry.content.toLowerCase().includes(lower);
  }
  // Images have no searchable text
  return false;
}

function startOfDay(s: string): number {
  return new Date(s + "T00:00:00").getTime();
}
function endOfDay(s: string): number {
  return new Date(s + "T23:59:59.999").getTime();
}

// Recent searches helpers

const RECENT_KEY = "sc-recent-searches";
const MAX_RECENT = 8;

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function saveRecent(list: string[]) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

// Search Screen

interface SearchScreenProps {
  entries: ClipboardEntry[];
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string, shouldPin: boolean) => Promise<boolean>;
  availableGroups: string[];
  onSetGroups: (id: string, groups: string[]) => void;
}

const SearchScreen: React.FC<SearchScreenProps> = ({
  entries,
  onCopy,
  onDelete,
  onPin,
  availableGroups,
  onSetGroups,
}) => {
  const [query, setQuery] = useState("");
  const [selectedKinds, setSelectedKinds] = useState<Set<DisplayKind>>(
    new Set(),
  );
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [dateAfter, setDateAfter] = useState("");
  const [dateBefore, setDateBefore] = useState("");
  const [sort, setSort] = useState<SortMode>("newest");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(loadRecent);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  // Close sort/filter dropdowns on outside click
  useEffect(() => {
    if (!sortOpen && !filtersOpen) return;
    function handleClick(e: MouseEvent) {
      if (sortOpen && sortRef.current && !sortRef.current.contains(e.target as Node)) setSortOpen(false);
      if (filtersOpen && filterRef.current && !filterRef.current.contains(e.target as Node)) setFiltersOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [sortOpen, filtersOpen]);

  const toggleKind = useCallback((k: DisplayKind) => {
    setSelectedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

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
    if (selectedKinds.size > 0) n++;
    if (pinnedOnly) n++;
    if (dateAfter || dateBefore) n++;
    if (selectedGroups.size > 0) n++;
    return n;
  }, [selectedKinds, pinnedOnly, dateAfter, dateBefore, selectedGroups]);

  const clearAllFilters = useCallback(() => {
    setSelectedKinds(new Set());
    setPinnedOnly(false);
    setDateAfter("");
    setDateBefore("");
    setSort("newest");
    setSelectedGroups(new Set());
  }, []);

  const addRecentSearch = useCallback((term: string) => {
    const trimmed = term.trim();
    if (!trimmed) return;
    setRecentSearches((prev) => {
      const deduped = [trimmed, ...prev.filter((s) => s !== trimmed)].slice(
        0,
        MAX_RECENT,
      );
      saveRecent(deduped);
      return deduped;
    });
  }, []);

  const removeRecentSearch = useCallback((term: string) => {
    setRecentSearches((prev) => {
      const next = prev.filter((s) => s !== term);
      saveRecent(next);
      return next;
    });
  }, []);

  const clearRecentSearches = useCallback(() => {
    setRecentSearches([]);
    saveRecent([]);
  }, []);

  const applyRecent = useCallback(
    (term: string) => {
      setQuery(term);
      inputRef.current?.focus();
      addRecentSearch(term);
    },
    [addRecentSearch],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") addRecentSearch(query);
    },
    [query, addRecentSearch],
  );

  // Filtering & sorting
  const results = useMemo(() => {
    let pool = [...entries];

    // DisplayKind filter
    if (selectedKinds.size > 0) {
      pool = pool.filter((e) => selectedKinds.has(deriveDisplayKind(e)));
    }

    if (pinnedOnly) pool = pool.filter((e) => e.pinned);
    if (dateAfter) {
      const ts = startOfDay(dateAfter);
      pool = pool.filter((e) => e.timestamp >= ts);
    }
    if (dateBefore) {
      const ts = endOfDay(dateBefore);
      pool = pool.filter((e) => e.timestamp <= ts);
    }
    if (query.trim()) {
      const q = query.trim();
      pool = pool.filter((e) => {
        // Don't filter out entries that have no searchable text (images)
        // if they already passed a type/kind filter
        if (e.type === "image") return true;
        return matchesQuery(e, q);
      });
    }

    // Group filter (OR)
    if (selectedGroups.size > 0) {
      pool = pool.filter(
        (e) => e.groups && e.groups.some((g) => selectedGroups.has(g)),
      );
    }

    // Sort
    switch (sort) {
      case "oldest":
        pool.sort((a, b) => a.timestamp - b.timestamp);
        break;
      case "a-z":
        pool.sort((a, b) => sortableText(a).localeCompare(sortableText(b)));
        break;
      case "z-a":
        pool.sort((a, b) => sortableText(b).localeCompare(sortableText(a)));
        break;
      case "type":
        pool.sort(
          (a, b) =>
            (TYPE_ORDER[deriveDisplayKind(a)] ?? 9) -
            (TYPE_ORDER[deriveDisplayKind(b)] ?? 9),
        );
        break;
      default:
        pool.sort((a, b) => b.timestamp - a.timestamp);
        break;
    }
    return pool;
  }, [
    entries,
    query,
    selectedKinds,
    pinnedOnly,
    dateAfter,
    dateBefore,
    sort,
    selectedGroups,
  ]);

  const hasQuery = query.trim().length > 0;
  const hasFilters = activeFilterCount > 0;
  const showResults = hasQuery || hasFilters;

  return (
    <div className="search-screen-root">
      {/* Search input */}
      <div className="ss-searchbar-wrap">
        <div className="ss-searchbar">
          <SearchIcon className="ss-search-icon" />
          <input
            ref={inputRef}
            type="text"
            className="ss-input"
            placeholder="Search clipboard history…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          {query && (
            <button
              className="ss-clear"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <CloseIcon />
            </button>
          )}
        </div>

        {/* Compact filter bar */}
        <div className="ss-filter-toolbar">
          {/* Filter dropdown */}
          <div className="sort-dropdown" ref={filterRef}>
            <button
              className={`sort-dropdown-trigger${filtersOpen ? " sort-dropdown-trigger--open" : ""}`}
              onClick={() => setFiltersOpen((v) => !v)}
            >
              <FilterIcon />
              <span>
                Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
              </span>
              <ChevronDownIcon className="sort-chevron" />
            </button>
            {filtersOpen && (
              <div className="ss-filter-card">
                {/* Types section */}
                <div className="ss-card-section">
                  <div className="ss-section-label">
                    Types
                    {selectedKinds.size > 0 && (
                      <span className="ss-count">{selectedKinds.size}</span>
                    )}
                  </div>
                  <div className="ss-type-grid">
                    {ALL_DISPLAY_KINDS.map((k) => (
                      <label
                        key={k}
                        className={`ss-type-option${selectedKinds.has(k) ? " ss-type-option--on" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedKinds.has(k)}
                          onChange={() => toggleKind(k)}
                          className="ss-type-cb"
                        />
                        <span
                          className={`ss-type-icon type-pill type-pill--${k}`}
                        >
                          {TYPE_ICONS[k]}
                        </span>
                        <span className="ss-type-name">{TYPE_LABELS[k]}</span>
                      </label>
                    ))}
                    <label
                      className={`ss-type-option${pinnedOnly ? " ss-type-option--on" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={pinnedOnly}
                        onChange={() => setPinnedOnly((v) => !v)}
                        className="ss-type-cb"
                      />
                      <span
                        className="ss-type-icon type-pill type-pill--text"
                        style={{
                          background: "var(--accent-dim)",
                          color: "var(--accent)",
                        }}
                      >
                        {PinIconElement}
                      </span>
                      <span className="ss-type-name">Pinned</span>
                    </label>
                  </div>
                </div>

                {/* Groups section */}
                {availableGroups.length > 0 && (
                  <>
                    <div className="ss-card-divider" />
                    <div className="ss-card-section">
                      <div className="ss-section-label">
                        Groups
                        {selectedGroups.size > 0 && (
                          <span className="ss-count">
                            {selectedGroups.size}
                          </span>
                        )}
                      </div>
                      <div className="ss-type-grid">
                        {availableGroups.map((g) => (
                          <label
                            key={g}
                            className={`ss-type-option${selectedGroups.has(g) ? " ss-type-option--on" : ""}`}
                          >
                            <input
                              type="checkbox"
                              checked={selectedGroups.has(g)}
                              onChange={() => toggleGroup(g)}
                              className="ss-type-cb"
                            />
                            <span
                              className="ss-type-icon type-pill type-pill--text"
                              style={{
                                background: "var(--accent-dim)",
                                color: "var(--accent)",
                              }}
                            >
                              <TagIcon size={9} />
                            </span>
                            <span className="ss-type-name">{g}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                <div className="ss-card-divider" />

                {/* Date section */}
                <div className="ss-card-section">
                  <div className="ss-section-label">Date</div>
                  <div className="ss-date-row">
                    <input
                      type="date"
                      className="ss-date-input"
                      value={dateAfter}
                      onChange={(e) => setDateAfter(e.target.value)}
                      title="After"
                    />
                    <span className="ss-date-sep">–</span>
                    <input
                      type="date"
                      className="ss-date-input"
                      value={dateBefore}
                      onChange={(e) => setDateBefore(e.target.value)}
                      title="Before"
                    />
                  </div>
                </div>

                {/* Clear filters button */}
                {activeFilterCount > 0 && (
                  <>
                    <div className="ss-card-divider" />
                    <button
                      className="ss-card-clear-btn"
                      onClick={clearAllFilters}
                    >
                      <CloseIcon size={12} />
                      Clear Filters
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Sort dropdown */}
          <div className="sort-dropdown" ref={sortRef}>
            <button
              className={`sort-dropdown-trigger${sortOpen ? " sort-dropdown-trigger--open" : ""}`}
              onClick={() => setSortOpen((v) => !v)}
            >
              {SORT_OPTIONS.find((s) => s.id === sort)?.icon}
              <span>{SORT_OPTIONS.find((s) => s.id === sort)?.label}</span>
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

          {activeFilterCount > 0 && (
            <button className="ss-clear-filters" onClick={clearAllFilters}>
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Results area */}
      <div className="ss-results-area">
        {!showResults ? (
          <div className="ss-idle-wrap">
            {recentSearches.length > 0 && (
              <div className="ss-recent">
                <div className="ss-recent-header">
                  <span className="ss-recent-label">
                    <ClockIcon />
                    Recent Searches
                  </span>
                  <button
                    className="ss-recent-clear-all"
                    onClick={clearRecentSearches}
                    data-tooltip="Clear all recent searches"
                  >
                    Clear all
                  </button>
                </div>
                <div className="ss-recent-list">
                  {recentSearches.map((term) => (
                    <div key={term} className="ss-recent-item">
                      <button
                        className="ss-recent-term"
                        onClick={() => applyRecent(term)}
                      >
                        <SearchIcon size={11} />
                        <span>{term}</span>
                      </button>
                      <button
                        className="ss-recent-remove"
                        onClick={() => removeRecentSearch(term)}
                        data-tooltip="Remove"
                      >
                        <CloseIcon size={9} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="ss-idle">
              <SearchIcon size={44} strokeWidth={1.2} className="ss-idle-icon" />
              <p className="ss-idle-title">Search your clipboard history</p>
              <p className="ss-idle-subtitle">
                Type to search text &amp; file names, or use the filters above
                to narrow by type, date, or pinned status. Press{" "}
                <strong>Enter</strong> to save a search.
              </p>
            </div>
          </div>
        ) : results.length === 0 ? (
          <div className="ss-idle">
            <SearchXIcon className="ss-idle-icon" />
            <p className="ss-idle-title">No results</p>
            <p className="ss-idle-subtitle">
              {hasQuery ? (
                <>
                  Nothing matches &ldquo;{query.trim()}&rdquo;
                  {hasFilters ? " with the current filters" : ""}.
                </>
              ) : (
                <>No entries match the current filters.</>
              )}
            </p>
          </div>
        ) : (
          <>
            {/* Result count */}
            <div className="ss-result-count">
              {results.length} {results.length === 1 ? "result" : "results"}
              {hasQuery && (
                <span className="ss-result-query">
                  {" "}
                  for &ldquo;{query.trim()}&rdquo;
                </span>
              )}
            </div>

            {/* Cards */}
            <div className="ss-cards">
              {results.map((entry) => (
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
          </>
        )}
      </div>
    </div>
  );
};

export default SearchScreen;
