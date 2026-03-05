import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ClipboardEntry, AppScreen, AppTheme } from "../../types";
import { classifyFileEntry } from "../../types";
import Sidebar from "./sidebar/Sidebar";
import StatusPill from "./status-pill/StatusPill";
import SettingsScreen from "./settings-screen/SettingsScreen";
import ShortcutsScreen from "./shortcuts-screen/ShortcutsScreen";
import ClipboardScreen from "./clipboard-screen/ClipboardScreen";
import "./App.css";

// ── Floating window controls ──────────────────────────────────────────────────

const WindowControls: React.FC = () => {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    win.isMaximized().then(setMaximized);
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setMaximized);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="win-controls">
      <button
        className="win-btn win-btn--min"
        onClick={() => win.minimize()}
        title="Minimise"
      >
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
          <rect
            x="0"
            y="4.5"
            width="10"
            height="1"
            rx="0.5"
            fill="currentColor"
          />
        </svg>
      </button>
      <button
        className="win-btn win-btn--max"
        onClick={() => (maximized ? win.unmaximize() : win.maximize())}
        title={maximized ? "Restore" : "Maximise"}
      >
        {maximized ? (
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
            <rect
              x="2"
              y="0"
              width="8"
              height="8"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <rect
              x="0"
              y="2"
              width="8"
              height="8"
              rx="1"
              fill="var(--bg)"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        ) : (
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
            <rect
              x="0.5"
              y="0.5"
              width="9"
              height="9"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        )}
      </button>
      <button
        className="win-btn win-btn--close"
        onClick={() => win.close()}
        title="Close"
      >
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
          <line
            x1="1"
            y1="1"
            x2="9"
            y2="9"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <line
            x1="9"
            y1="1"
            x2="1"
            y2="9"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
};

// ── Dummy data for timeline testing ──────────────────────────────────────────
// TODO: REMOVE BEFORE PRODUCTION — set to false to use real clipboard history
const USE_DUMMY_ENTRIES = true;
// ─────────────────────────────────────────────────────────────────────────────

const _now = Date.now();
const _min = 60_000;
const _hr = 3_600_000;
const _day = 86_400_000;

const DUMMY_ENTRIES: ClipboardEntry[] = [
  // ── Today ──
  {
    id: "dummy-1",
    type: "text",
    content: "npm install @tauri-apps/api @tauri-apps/plugin-shell",
    timestamp: _now - 2 * _min,
  },
  {
    id: "dummy-2",
    type: "text",
    content:
      "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.",
    timestamp: _now - 18 * _min,
  },
  {
    id: "dummy-3",
    type: "text",
    content: "https://tauri.app/v2/guides/getting-started/setup/",
    timestamp: _now - 45 * _min,
  },
  {
    id: "dummy-4",
    type: "file",
    content: "C:\\Users\\dev\\Documents\\report_final_v3.pdf",
    timestamp: _now - 1 * _hr - 10 * _min,
  },
  {
    id: "dummy-5",
    type: "text",
    content:
      "const greet = (name: string) => `Hello, ${name}! Welcome to RoverTools.`;",
    timestamp: _now - 2 * _hr,
  },
  // ── Yesterday ──
  {
    id: "dummy-6",
    type: "text",
    content: 'git commit -m "feat: add timeline grouping to clipboard screen"',
    timestamp: _now - _day - 30 * _min,
  },
  {
    id: "dummy-7",
    type: "file",
    content:
      "C:\\Users\\dev\\Pictures\\screenshot_2026-03-04.png\nC:\\Users\\dev\\Pictures\\screenshot_2026-03-04_02.png",
    timestamp: _now - _day - 2 * _hr,
  },
  {
    id: "dummy-8",
    type: "text",
    content:
      "Remember to update the CHANGELOG before tagging the next release.",
    timestamp: _now - _day - 5 * _hr,
  },
  // ── 3 days ago ──
  {
    id: "dummy-9",
    type: "text",
    content:
      "SELECT * FROM clipboard_history ORDER BY created_at DESC LIMIT 50;",
    timestamp: _now - 3 * _day - 1 * _hr,
  },
  {
    id: "dummy-10",
    type: "file",
    content: "C:\\Users\\dev\\Downloads\\tauri_v2_tutorial.mp4",
    timestamp: _now - 3 * _day - 4 * _hr,
  },
  {
    id: "dummy-11",
    type: "text",
    content: "Design review at 3 PM – bring the Figma prototype link.",
    timestamp: _now - 3 * _day - 6 * _hr,
  },
  // ── 6 days ago ──
  {
    id: "dummy-12",
    type: "text",
    content: "cargo build --release --target x86_64-pc-windows-msvc",
    timestamp: _now - 6 * _day - 2 * _hr,
  },
  {
    id: "dummy-13",
    type: "file",
    content:
      "C:\\Users\\dev\\Projects\\rover\\src\\lib.rs\nC:\\Users\\dev\\Projects\\rover\\src\\main.rs\nC:\\Users\\dev\\Projects\\rover\\Cargo.toml",
    timestamp: _now - 6 * _day - 4 * _hr,
  },
];

// ── App ──────────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  const [entries, setEntries] = useState<ClipboardEntry[]>(
    // TODO: REMOVE BEFORE PRODUCTION — dummy seed controlled by USE_DUMMY_ENTRIES
    USE_DUMMY_ENTRIES ? DUMMY_ENTRIES : [],
  );
  const [search, setSearch] = useState("");
  const [screen, setScreen] = useState<AppScreen>("clipboard");
  const [theme, setTheme] = useState<AppTheme>(() => {
    return (localStorage.getItem("sc-theme") as AppTheme) ?? "dark";
  });

  const toggleTheme = () => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      localStorage.setItem("sc-theme", next);
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    let actualUnlisten: (() => void) | undefined;

    invoke<ClipboardEntry[]>("get_history").then((history) => {
      if (!cancelled)
        // TODO: REMOVE BEFORE PRODUCTION — dummy fallback controlled by USE_DUMMY_ENTRIES
        setEntries(
          history.length > 0 ? history : USE_DUMMY_ENTRIES ? DUMMY_ENTRIES : [],
        );
    });

    listen<ClipboardEntry>("clipboard:new-entry", (event) => {
      if (cancelled) return;
      setEntries((prev) => {
        if (prev.some((entry) => entry.id === event.payload.id)) return prev;
        return [event.payload, ...prev];
      });
    }).then((fn) => {
      if (cancelled) fn();
      else actualUnlisten = fn;
    });

    return () => {
      cancelled = true;
      actualUnlisten?.();
    };
  }, []);

  const handleCopy = useCallback(async (id: string) => {
    await invoke("copy_entry", { id });
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await invoke("delete_entry", { id });
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const handleClearAll = useCallback(async () => {
    await invoke("clear_history");
    setEntries([]);
  }, []);

  const filtered = search
    ? entries.filter(
        (e) =>
          e.type === "text" &&
          e.content.toLowerCase().includes(search.toLowerCase()),
      )
    : entries;

  const textCount = entries.filter((e) => e.type === "text").length;
  const imageCount = entries.filter(
    (e) =>
      e.type === "image" ||
      (e.type === "file" && classifyFileEntry(e.content) === "image"),
  ).length;
  const fileCount = entries.filter(
    (e) => e.type === "file" && classifyFileEntry(e.content) === "file",
  ).length;

  return (
    <div className="app" data-theme={theme}>
      <Sidebar
        screen={screen}
        theme={theme}
        onNavigate={setScreen}
        onToggleTheme={toggleTheme}
      />

      <div className="main-frame">
        {/* ── Slim title bar (drag region + window controls) ── */}
        <div className="titlebar" data-tauri-drag-region>
          <span className="titlebar-title">Smart Clipboard</span>
          <WindowControls />
        </div>

        {/* ── Search + Clear All bar ── */}
        <div className="topbar">
          <div className="search-bar">
            <svg
              className="search-icon"
              width="14"
              height="14"
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
              type="text"
              className="search-input"
              placeholder="Search clipboard history…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button className="search-clear" onClick={() => setSearch("")}>
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
          {screen === "clipboard" && entries.length > 0 && (
            <button
              className="topbar-clear-btn"
              onClick={handleClearAll}
              title="Clear all history"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
        </div>

        {/* ── Screen content ── */}
        {screen === "settings" ? (
          <SettingsScreen />
        ) : screen === "shortcuts" ? (
          <ShortcutsScreen />
        ) : (
          <ClipboardScreen
            entries={entries}
            filtered={filtered}
            search={search}
            onCopy={handleCopy}
            onDelete={handleDelete}
          />
        )}

        {/* ── Status pill ── */}
        {screen === "clipboard" && entries.length > 0 && (
          <StatusPill
            textCount={textCount}
            imageCount={imageCount}
            fileCount={fileCount}
            total={entries.length}
          />
        )}
      </div>
    </div>
  );
};

export default App;

// ── Mount ────────────────────────────────────────────────────────────────────

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
