import React, { useCallback, useMemo, useRef, useState } from "react";
import type { ClipboardEntry } from "../../../types";
import { filePaths } from "../../../types";
import { EntryCard } from "../clipboard-screen/entry-card/EntryCard";
import "./SearchScreen.css";

// Type filter

type TypeFilter = "all" | "text" | "image" | "file" | "pinned";

const TYPE_FILTERS: { id: TypeFilter; label: string; icon: React.ReactNode }[] =
  [
    {
      id: "all",
      label: "All",
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
          <line x1="8" y1="6" x2="21" y2="6" />
          <line x1="8" y1="12" x2="21" y2="12" />
          <line x1="8" y1="18" x2="21" y2="18" />
          <line x1="3" y1="6" x2="3.01" y2="6" />
          <line x1="3" y1="12" x2="3.01" y2="12" />
          <line x1="3" y1="18" x2="3.01" y2="18" />
        </svg>
      ),
    },
    {
      id: "pinned",
      label: "Pinned",
      icon: (
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 17v5" />
          <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
        </svg>
      ),
    },
    {
      id: "text",
      label: "Text",
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
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      ),
    },
    {
      id: "image",
      label: "Image",
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
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      ),
    },
    {
      id: "file",
      label: "File",
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
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <polyline points="13 2 13 9 20 9" />
        </svg>
      ),
    },
  ];

// Helpers

function matchesQuery(entry: ClipboardEntry, q: string): boolean {
  const lower = q.toLowerCase();
  if (entry.type === "text") {
    return entry.content.toLowerCase().includes(lower);
  }
  if (entry.type === "file") {
    // match against each file name in multi-file entries
    return filePaths(entry.content).some((path) => {
      const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
      return name.includes(lower);
    });
  }
  return false; // images aren't text-searchable; they still show under type filter
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
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [recentSearches, setRecentSearches] = useState<string[]>(loadRecent);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const results = useMemo(() => {
    let pool =
      typeFilter === "all"
        ? entries
        : typeFilter === "pinned"
          ? entries.filter((e) => e.pinned)
          : entries.filter((e) => e.type === typeFilter);

    if (query.trim()) {
      pool = pool.filter((e) => matchesQuery(e, query.trim()));
    }

    return pool;
  }, [entries, query, typeFilter]);

  const hasQuery = query.trim().length > 0;
  const showResults = hasQuery || typeFilter !== "all" || entries.length > 0;

  return (
    <div className="search-screen-root">
      {/*  Search input  */}
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

        {/* Type filter chips */}
        <div className="ss-filter-row">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.id}
              className={`ss-filter-chip${typeFilter === f.id ? " ss-filter-chip--active" : ""}`}
              onClick={() => setTypeFilter(f.id)}
            >
              {f.icon}
              <span>{f.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Results area  */}
      <div className="ss-results-area">
        {!showResults ? (
          // Idle state — show recent searches if any, else generic tip
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
                Type to search text &amp; file names, or pick a type filter
                above. Press <strong>Enter</strong> to save a search.
              </p>
            </div>
          </div>
        ) : results.length === 0 ? (
          // No matches
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
                  {typeFilter !== "all" ? " in this type" : ""}.
                </>
              ) : (
                <>No {typeFilter} entries in history.</>
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
