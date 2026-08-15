import React from "react";
import {
  KeyboardIcon,
  ClipboardPasteIcon,
  ClipboardIcon,
  PinIcon,
  TagIcon,
  SystemGroupsIcon,
  SearchIcon,
} from "../../icons";
// Reuses the shared scr-* page header and set-section-* heading styles.
import "../settings-screen/SettingsScreen.css";
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
    icon: <KeyboardIcon size={13} />,
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
    icon: <ClipboardPasteIcon />,
    entries: [
      { keys: ["1-9, 0"], description: "Paste entry by slot number" },
      { keys: ["Up", "Down"], description: "Navigate entries" },
      { keys: ["Enter"], description: "Paste selected entry" },
      { keys: ["Left", "Right"], description: "Switch between Recent / Pinned" },
      { keys: ["Tab"], description: "Toggle Recent / Pinned" },
      { keys: ["Esc"], description: "Close popup" },
    ],
  },
  {
    title: "Clipboard Cards",
    icon: <ClipboardIcon size={13} />,
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
    icon: <PinIcon size={13} filled strokeWidth={1.5} />,
    entries: [
      { keys: ["Pin"], description: "Pin entry. Shows in quick-paste popup (max 10)" },
      {
        keys: ["Save"],
        description: "Save entry. Survives app restarts independently of pin",
      },
      {
        keys: ["Unsave"],
        description: "Remove save (entry may be evicted from history)",
      },
      {
        keys: ["Max 10"],
        description: "Pin limit reached. A toast notification appears",
      },
    ],
  },
  {
    title: "Groups",
    icon: <TagIcon size={13} strokeWidth={2} />,
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
        description: "Select a group. Input switches to rename mode",
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
        keys: ["Delete button"],
        description: "Delete group. Undo available for 5 seconds via toast",
      },
      {
        keys: ["Color swatches"],
        description: "Change the color of a selected group",
      },
    ],
  },
  {
    title: "System Groups",
    icon: <SystemGroupsIcon />,
    entries: [
      {
        keys: ["Pinned"],
        description:
          "System group. Shows entries currently pinned to the popup",
      },
      {
        keys: ["Saved"],
        description: "System group. Shows entries saved to survive restarts",
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
    icon: <SearchIcon size={13} />,
    entries: [
      { keys: ["Type"], description: "Filter entries by content" },
      { keys: ["Esc / clear btn"], description: "Clear search" },
    ],
  },
];

// Component

const ShortcutsScreen: React.FC = () => (
  <div className="shortcuts-screen">
    <div className="shortcuts-inner">
      <header className="scr-head">
        <span className="scr-eyebrow">Reference</span>
        <h2 className="scr-title">Shortcuts</h2>
        <p className="scr-subtitle">
          Every keyboard shortcut and interaction, at a glance.
        </p>
      </header>

      <div className="shortcuts-sections">
        {SECTIONS.map((section) => (
          <section key={section.title} className="shortcuts-section">
            <div className="set-section-head">
              <span className="set-section-icon">{section.icon}</span>
              <h3 className="set-section-title">{section.title}</h3>
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
          </section>
        ))}
      </div>
    </div>
  </div>
);

export default ShortcutsScreen;
