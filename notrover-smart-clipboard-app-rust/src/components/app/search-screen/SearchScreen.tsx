import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEntry, DisplayKind } from "../../../types";
import { deriveDisplayKind, filePaths } from "../../../types";
import { TYPE_ICONS, TYPE_LABELS, PinIcon } from "../../entry-types/EntryTypePill";
import { EntryCard } from "../clipboard-screen/entry-card/EntryCard";
import "./SearchScreen.css";

// Constants

type SortMode = "newest" | "oldest" | "a-z" | "z-a" | "type";

const SORT_OPTIONS: { id: SortMode; label: string; icon: React.ReactNode }[] = [
  {
    id: "newest", label: "Newest",
    icon: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 11 12 6 7 11" /><line x1="12" y1="18" x2="12" y2="6" /></svg>,
  },
  {
    id: "oldest", label: "Oldest",
    icon: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="7 13 12 18 17 13" /><line x1="12" y1="6" x2="12" y2="18" /></svg>,
  },
  {
    id: "a-z", label: "A \u2192 Z",
    icon: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h7" /><path d="M3 12h5" /><path d="M3 18h3" /><path d="M16 6l4 12" /><path d="M20 6l-4 12" /><path d="M14.5 14h7" /></svg>,
  },
  {
    id: "z-a", label: "Z \u2192 A",
    icon: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 18h7" /><path d="M3 12h5" /><path d="M3 6h3" /><path d="M16 6l4 12" /><path d="M20 6l-4 12" /><path d="M14.5 14h7" /></svg>,
  },
  {
    id: "type", label: "Type",
    icon: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>,
  },
];

const TYPE_ORDER: Record<string, number> = {
  text: 0, url: 1, document: 2, file: 3, folder: 4, image: 5, video: 6,
};

function sortableText(e: ClipboardEntry): string {
  if (e.type === "text") return e.content.toLowerCase();
  if (e.type === "file") {
    const paths = filePaths(e.content);
    return ((paths[0] ?? "").split(/[\\/]/).pop() ?? "").toLowerCase();
  }
  return "";
}

const ALL_DISPLAY_KINDS: DisplayKind[] = [
  "text", "url", "image", "video", "document", "file", "folder",
];



// Helpers

function matchesQuery(entry: ClipboardEntry, q: string): boolean {
  const lower = q.toLowerCase();
  if (entry.type === "text") return entry.content.toLowerCase().includes(lower);
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
  onPin: (id: string, shouldPin: boolean) => void;
}

const SearchScreen: React.FC<SearchScreenProps> = ({
  entries,
  onCopy,
  onDelete,
  onPin,
}) => {
  const [query, setQuery] = useState("");
  const [selectedKinds, setSelectedKinds] = useState<Set<DisplayKind>>(new Set());
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [dateAfter, setDateAfter] = useState("");
  const [dateBefore, setDateBefore] = useState("");
  const [sort, setSort] = useState<SortMode>("newest");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(loadRecent);
  const inputRef = useRef<HTMLInputElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  // Close sort dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
        setSortOpen(false);
      }
    }
    if (sortOpen) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [sortOpen]);

  // Close filter dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFiltersOpen(false);
      }
    }
    if (filtersOpen) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [filtersOpen]);

  const toggleKind = useCallback((k: DisplayKind) => {
    setSelectedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (selectedKinds.size > 0) n++;
    if (pinnedOnly) n++;
    if (dateAfter || dateBefore) n++;
    return n;
  }, [selectedKinds, pinnedOnly, dateAfter, dateBefore]);

  const clearAllFilters = useCallback(() => {
    setSelectedKinds(new Set());
    setPinnedOnly(false);
    setDateAfter("");
    setDateBefore("");
    setSort("newest");
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
    if (dateAfter) { const ts = startOfDay(dateAfter); pool = pool.filter((e) => e.timestamp >= ts); }
    if (dateBefore) { const ts = endOfDay(dateBefore); pool = pool.filter((e) => e.timestamp <= ts); }
    if (query.trim()) {
      const q = query.trim();
      pool = pool.filter((e) => {
        // Don't filter out entries that have no searchable text (images)
        // if they already passed a type/kind filter
        if (e.type === "image") return true;
        return matchesQuery(e, q);
      });
    }

    // Sort
    switch (sort) {
      case "oldest":  pool.sort((a, b) => a.timestamp - b.timestamp); break;
      case "a-z":     pool.sort((a, b) => sortableText(a).localeCompare(sortableText(b))); break;
      case "z-a":     pool.sort((a, b) => sortableText(b).localeCompare(sortableText(a))); break;
      case "type":    pool.sort((a, b) => (TYPE_ORDER[deriveDisplayKind(a)] ?? 9) - (TYPE_ORDER[deriveDisplayKind(b)] ?? 9)); break;
      default:        pool.sort((a, b) => b.timestamp - a.timestamp); break;
    }
    return pool;
  }, [entries, query, selectedKinds, pinnedOnly, dateAfter, dateBefore, sort]);

  const hasQuery = query.trim().length > 0;
  const hasFilters = activeFilterCount > 0;
  const showResults = hasQuery || hasFilters;

  return (
    <div className="search-screen-root">
      {/* Search input */}
      <div className="ss-searchbar-wrap">
        <div className="ss-searchbar">
          <svg
            className="ss-search-icon"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
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
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
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
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
              <span>Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}</span>
              <svg className="sort-chevron" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {filtersOpen && (
              <div className="ss-filter-card">
                {/* Types section */}
                <div className="ss-card-section">
                  <div className="ss-section-label">
                    Types
                    {selectedKinds.size > 0 && <span className="ss-count">{selectedKinds.size}</span>}
                  </div>
                  <div className="ss-type-grid">
                    {ALL_DISPLAY_KINDS.map((k) => (
                      <label key={k} className={`ss-type-option${selectedKinds.has(k) ? " ss-type-option--on" : ""}`}>
                        <input type="checkbox" checked={selectedKinds.has(k)} onChange={() => toggleKind(k)} className="ss-type-cb" />
                        <span className={`ss-type-icon type-pill type-pill--${k}`}>{TYPE_ICONS[k]}</span>
                        <span className="ss-type-name">{TYPE_LABELS[k]}</span>
                      </label>
                    ))}
                    <label className={`ss-type-option${pinnedOnly ? " ss-type-option--on" : ""}`}>
                      <input type="checkbox" checked={pinnedOnly} onChange={() => setPinnedOnly((v) => !v)} className="ss-type-cb" />
                      <span className="ss-type-icon type-pill type-pill--text" style={{ background: 'var(--accent-dim)', color: 'var(--accent)' }}>{PinIcon}</span>
                      <span className="ss-type-name">Pinned</span>
                    </label>
                  </div>
                </div>

                <div className="ss-card-divider" />

                {/* Date section */}
                <div className="ss-card-section">
                  <div className="ss-section-label">Date</div>
                  <div className="ss-date-row">
                    <input type="date" className="ss-date-input" value={dateAfter} onChange={(e) => setDateAfter(e.target.value)} title="After" />
                    <span className="ss-date-sep">–</span>
                    <input type="date" className="ss-date-input" value={dateBefore} onChange={(e) => setDateBefore(e.target.value)} title="Before" />
                  </div>
                </div>

                {/* Clear filters button */}
                {activeFilterCount > 0 && (
                  <>
                    <div className="ss-card-divider" />
                    <button className="ss-card-clear-btn" onClick={clearAllFilters}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
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
              <svg className="sort-chevron" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {sortOpen && (
              <div className="sort-dropdown-menu">
                {SORT_OPTIONS.map((s) => (
                  <button
                    key={s.id}
                    className={`sort-dropdown-item${sort === s.id ? " sort-dropdown-item--active" : ""}`}
                    onClick={() => { setSort(s.id); setSortOpen(false); }}
                  >
                    {s.icon}
                    <span>{s.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {activeFilterCount > 0 && (
            <button className="ss-clear-filters" onClick={clearAllFilters}>Clear</button>
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
                      <polyline points="12 8 12 12 14 14" />
                      <circle cx="12" cy="12" r="10" />
                    </svg>
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
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="11" cy="11" r="8" />
                          <line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        <span>{term}</span>
                      </button>
                      <button
                        className="ss-recent-remove"
                        onClick={() => removeRecentSearch(term)}
                        data-tooltip="Remove"
                      >
                        <svg
                          width="9"
                          height="9"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="ss-idle">
              <svg
                className="ss-idle-icon"
                width="44"
                height="44"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <p className="ss-idle-title">Search your clipboard history</p>
              <p className="ss-idle-subtitle">
                Type to search text &amp; file names, or use the filters
                above to narrow by type, date, or pinned status.
                Press <strong>Enter</strong> to save a search.
              </p>
            </div>
          </div>
        ) : results.length === 0 ? (
          <div className="ss-idle">
            <svg
              className="ss-idle-icon"
              width="44"
              height="44"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
              <line
                x1="8"
                y1="8"
                x2="14"
                y2="14"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <line
                x1="14"
                y1="8"
                x2="8"
                y2="14"
                stroke="currentColor"
                strokeWidth="1.8"
              />
            </svg>
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
