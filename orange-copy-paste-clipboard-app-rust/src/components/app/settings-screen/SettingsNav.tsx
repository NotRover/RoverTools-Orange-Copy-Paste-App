import React from "react";
import { IconSearch, IconX } from "@tabler/icons-react";

export interface SettingsPage {
  /** The page key, remembered between visits. */
  id: string;
  /** The `id`s of the section elements this page shows, in order. */
  sections: string[];
  label: string;
  /** One line under the page title. */
  blurb: string;
  /** Tabler icon or one of the app's own; both take `size`. */
  Icon: React.ComponentType<{ size?: number }>;
}

/**
 * The page list and search box beside the Settings content. One entry per
 * page; the current one lit. Typing a query switches the content to search
 * results across every page, and the list dims until the query is cleared.
 * An entry whose section holds a changed setting carries a small mark.
 */
const SettingsNav: React.FC<{
  pages: SettingsPage[];
  active: string;
  /** Section ids holding a setting that is not at its default. */
  marked: string[];
  onSelect: (id: string) => void;
  query: string;
  onQuery: (q: string) => void;
}> = ({ pages, active, marked, onSelect, query, onQuery }) => {
  const searching = query.trim().length > 0;
  return (
    <nav className="set-nav" aria-label="Settings pages">
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
        {pages.map(({ id, label, Icon, sections }, index) => (
          <button
            key={id}
            type="button"
            className={`set-nav-item${index === 0 ? " set-nav-item--all" : ""}${
              !searching && active === id ? " active" : ""
            }`}
            onClick={() => {
              onQuery("");
              onSelect(id);
            }}
            aria-current={!searching && active === id ? "page" : undefined}
          >
            <Icon size={14} />
            {index === 0 ? "All settings" : label}
            {index > 0 && sections.some((sid) => marked.includes(sid)) && (
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
