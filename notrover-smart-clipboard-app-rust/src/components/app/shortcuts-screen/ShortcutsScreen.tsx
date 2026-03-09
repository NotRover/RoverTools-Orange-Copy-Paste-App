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
        keys: ["Right-click"],
        description: "Open context menu (Copy, Pin, Save, Groups, Delete)",
      },
      {
        keys: ["Type chip"],
        description: "Expand / collapse multiple-file list",
      },
      { keys: ["+N chip"], description: "Show overflow group tags" },
    ],
  },
  {
    title: "Pin & Save",
    icon: (
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 17v5" />
        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
      </svg>
    ),
    entries: [
      {
        keys: ["Pin"],
        description: "Pin entry — shows in quick-paste popup (max 10)",
      },
      { keys: ["Pin"], description: "Pinning an entry automatically saves it" },
      {
        keys: ["Save"],
        description: "Save entry — persists across app restarts",
      },
      {
        keys: ["Unsave"],
        description: "Remove persistence (entry may be evicted from history)",
      },
      {
        keys: ["Max 10"],
        description: "Pin limit reached — a toast notification appears",
      },
    ],
  },
  {
    title: "Groups",
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
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
        <line x1="7" y1="7" x2="7.01" y2="7" />
      </svg>
    ),
    entries: [
      {
        keys: ["Groups menu"],
        description: "Assign or remove group tags from an entry (right-click)",
      },
      {
        keys: ["Groups btn"],
        description: "Open Group Manager to add, rename or delete groups",
      },
      {
        keys: ["Click chip"],
        description: "Select a group — input switches to rename mode",
      },
      {
        keys: ["Click chip again"],
        description: "Deselect group / return to add mode",
      },
      {
        keys: ["Click outside"],
        description: "Deselect group without changes",
      },
      { keys: ["Enter"], description: "Confirm add or rename" },
      {
        keys: ["Delete × btn"],
        description: "Delete group — undo available for 5 seconds via toast",
      },
      {
        keys: ["Color swatches"],
        description: "Change the color of a selected group",
      },
    ],
  },
  {
    title: "System Groups",
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
        <circle cx="12" cy="12" r="3" />
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
      </svg>
    ),
    entries: [
      {
        keys: ["Pinned"],
        description:
          "System group — shows entries currently pinned to the popup",
      },
      {
        keys: ["Saved"],
        description: "System group — shows entries saved to survive restarts",
      },
      {
        keys: ["Reserved"],
        description:
          '"pinned" and "saved" cannot be used as custom group names',
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
      { keys: ["Type"], description: "Filter entries by content" },
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
