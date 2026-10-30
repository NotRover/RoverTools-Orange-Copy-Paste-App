import React from "react";
import { IconSearch, IconX } from "@tabler/icons-react";

export interface SettingsSection {
  /** The section element's id. */
  id: string;
  label: string;
  /** Tabler icon or one of the app's own; both take `size`. */
  Icon: React.ComponentType<{ size?: number }>;
}

/**
 * The table of contents and search box beside the Settings content. One
 * entry per section; the one under the top of the view is lit, and picking
 * one scrolls to it. Typing a query filters the content to the rows that
 * match, and the list dims until the query is cleared. An entry whose
 * section holds a changed setting carries a small mark.
 */
const SettingsNav: React.FC<{
  sections: SettingsSection[];
  active: string;
  /** Section ids holding a setting that is not at its default. */
  marked: string[];
  onSelect: (id: string) => void;
  query: string;
  onQuery: (q: string) => void;
}> = ({ sections, active, marked, onSelect, query, onQuery }) => {
  const searching = query.trim().length > 0;
  return (
    <nav className="set-nav" aria-label="Settings sections">
      <label className="set-nav-search">
        <IconSearch size={13} />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onQuery("");
          }}
          placeholder="Search settings"
          spellCheck={false}
          aria-label="Search settings"
        />
        {searching && (
          <button
            type="button"
            className="set-nav-clear"
            onClick={() => onQuery("")}
            aria-label="Clear search"
          >
            <IconX size={12} />
          </button>
        )}
      </label>
      <div className={`set-nav-list${searching ? " set-nav-list--dim" : ""}`}>
        {sections.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            className={`set-nav-item${!searching && active === id ? " active" : ""}`}
            onClick={() => {
              onQuery("");
              onSelect(id);
            }}
            aria-current={!searching && active === id ? "location" : undefined}
          >
            <Icon size={14} />
            {label}
            {marked.includes(id) && (
              <span
                className="set-nav-mark"
                data-tooltip="Holds a setting changed from the default"
                data-tooltip-pos="right"
              >
                *
              </span>
            )}
          </button>
        ))}
      </div>
    </nav>
  );
};

export default SettingsNav;
