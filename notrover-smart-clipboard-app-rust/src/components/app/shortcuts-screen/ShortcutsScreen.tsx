import React from "react";
import "./ShortcutsScreen.css";

// Data

interface ShortcutEntry {
  keys: string[];
  description: string;
}

interface ShortcutSection {
  title: string;
  icon: React.ReactNode;
  entries: ShortcutEntry[];
}

const SECTIONS: ShortcutSection[] = [
  {
    title: "Global Shortcuts",
    icon: (
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
    entries: [
      {
        keys: ["Ctrl", "C"],
        description:
          "Capture (copy) selection to clipboard history without popup",
      },
      {
        keys: ["Ctrl", "Shift", "C"],
        description: "Capture (copy) selection to clipboard history",
      },
      { keys: ["Ctrl", "Shift", "V"], description: "Open quick-paste popup" },
    ],
  },
  {
    title: "Paste Popup",
    icon: (
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
        <polyline points="16 12 12 16 8 12" />
      </svg>
    ),
    entries: [
      { keys: ["1–9, 0"], description: "Paste entry by slot number" },
      { keys: ["↑", "↓"], description: "Navigate entries" },
      { keys: ["Enter"], description: "Paste selected entry" },
      { keys: ["←", "→"], description: "Switch between Recent / Pinned" },
      { keys: ["Tab"], description: "Toggle Recent / Pinned" },
      { keys: ["Esc"], description: "Close popup" },
    ],
  },
  {
    title: "Clipboard Cards",
    icon: (
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
      </svg>
    ),
    entries: [
      { keys: ["Click"], description: "Copy entry to clipboard" },
      {
        keys: ["Type chip dropdown"],
        description: "Expand / collapse multiple-file list",
      },
      { keys: ["Pin btn"], description: "Pin entry (right-click to reveal)" },

      { keys: ["Copy btn"], description: "Copy entry (right-click to reveal)" },
      {
        keys: ["Delete btn"],
        description: "Remove entry from history (right-click to reveal)",
      },
    ],
  },
  {
    title: "Search & Filter",
    icon: (
      <svg
        width="13"
        height="13"
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
    ),
    entries: [
      { keys: ["Type"], description: "Filter text entries by content" },
      { keys: ["Esc / ×"], description: "Clear search" },
    ],
  },
];

// Component

const ShortcutsScreen: React.FC = () => (
  <div className="shortcuts-screen">
    <div className="shortcuts-header">
      <p className="shortcuts-title">Shortcuts</p>
      <p className="shortcuts-subtitle">
        All keyboard shortcuts and interactions at a glance.
      </p>
    </div>

    <div className="shortcuts-sections">
      {SECTIONS.map((section) => (
        <div key={section.title} className="shortcuts-section">
          <div className="shortcuts-section-title">
            {section.icon}
            <span>{section.title}</span>
          </div>
          <div className="shortcuts-list">
            {section.entries.map((entry) => (
              <div key={entry.description} className="shortcut-row">
                <span className="shortcut-desc">{entry.description}</span>
                <span className="shortcut-keys">
                  {entry.keys.map((k, i) => (
                    <React.Fragment key={k}>
                      <kbd className="shortcut-key">{k}</kbd>
                      {i < entry.keys.length - 1 && (
                        <span className="shortcut-plus">+</span>
                      )}
                    </React.Fragment>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  </div>
);

export default ShortcutsScreen;
