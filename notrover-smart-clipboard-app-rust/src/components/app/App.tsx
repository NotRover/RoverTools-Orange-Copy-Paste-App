import React, { useCallback, useEffect, useRef, useState } from "react";
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
import SearchScreen from "./search-screen/SearchScreen";
import ToastNotification from "./toast/ToastNotification";
import "./App.css";

// TODO: Set this to `false`; this demo-only setup must be removed before shipping.
const SHOW_DEMO_CLIPBOARD_ENTRIES = true;

const DEMO_CLIPBOARD_ENTRIES: ClipboardEntry[] = [
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-1",
    type: "text",
    content: "Meeting notes: timeline rollout starts Monday at 10:00 AM.",
    timestamp: Date.now() - 1000 * 30,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-2",
    type: "text",
    content: "https://github.com/tauri-apps/tauri/discussions",
    timestamp: Date.now() - 1000 * 90,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-3",
    type: "text",
    content: "const handleClick = useCallback(() => { setActive(true); }, []);",
    timestamp: Date.now() - 1000 * 60 * 3,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-4",
    type: "file",
    content: "C:/Users/salmantariq2/Desktop/screenshot.png",
    timestamp: Date.now() - 1000 * 60 * 8,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-5",
    type: "text",
    content: "Draft release note: timeline grouping now supports same-day clustering.",
    timestamp: Date.now() - 1000 * 60 * 15,
    pinned: true,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-6",
    type: "image",
    content: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    timestamp: Date.now() - 1000 * 60 * 25,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-7",
    type: "text",
    content: "john.doe@example.com",
    timestamp: Date.now() - 1000 * 60 * 40,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-8",
    type: "file",
    content: "C:/Users/salmantariq2/Documents/presentation.pptx",
    timestamp: Date.now() - 1000 * 60 * 60 * 2,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-9",
    type: "text",
    content: "npm install @tauri-apps/api",
    timestamp: Date.now() - 1000 * 60 * 60 * 5,
    pinned: true,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-10",
    type: "file",
    content: "C:/Users/salmantariq2/Downloads/video-tutorial.mp4",
    timestamp: Date.now() - 1000 * 60 * 60 * 9,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-11",
    type: "text",
    content: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
    timestamp: Date.now() - 1000 * 60 * 60 * 18,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-12",
    type: "image",
    content: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC",
    timestamp: Date.now() - 1000 * 60 * 60 * 22,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-13",
    type: "file",
    content: "C:/Users/salmantariq2/Desktop/sprint-board.png",
    timestamp: Date.now() - 1000 * 60 * 60 * 24,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-14",
    type: "text",
    content: "https://stackoverflow.com/questions/12345678/react-state-management",
    timestamp: Date.now() - 1000 * 60 * 60 * 24,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-15",
    type: "file",
    content: "C:/Users/salmantariq2/Documents/report.docx",
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 1.5,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-16",
    type: "text",
    content: '{"name": "Smart Clipboard", "version": "1.0.0", "author": "RoverTools"}',
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 2,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-17",
    type: "file",
    content: "C:/Users/salmantariq2/Desktop/project-plan.pdf",
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 2,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-18",
    type: "text",
    content: "SELECT * FROM users WHERE active = 1 ORDER BY created_at DESC;",
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 2.5,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-19",
    type: "image",
    content: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 3,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-20",
    type: "file",
    content: "C:/Users/salmantariq2/Pictures/vacation-2025/beach.jpg\nC:/Users/salmantariq2/Pictures/vacation-2025/sunset.jpg",
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 3,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-21",
    type: "text",
    content: "Customer quote: timeline view made old snippets much easier to locate.",
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 4,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-22",
    type: "file",
    content: "C:/Users/salmantariq2/Downloads/installer.exe",
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 5,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-23",
    type: "text",
    content: "Meeting ID: 123-456-789\nPassword: SecurePass2026!",
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 5,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-24",
    type: "file",
    content: "C:/Users/salmantariq2/Desktop/design-mockup.fig",
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 6,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-25",
    type: "text",
    content: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 7,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-26",
    type: "image",
    content: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAYAAACNbyblAAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==",
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 8,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-27",
    type: "file",
    content: "C:/Users/salmantariq2/Desktop/archive/retro-notes.txt",
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 8,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-28",
    type: "text",
    content: "git commit -m \"feat: add timeline grouping for clipboard history\"",
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 10,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-29",
    type: "file",
    content: "C:/Users/salmantariq2/Documents/contracts/agreement-2026.pdf",
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 12,
    pinned: false,
  },
  // TODO: Remove this demo-only entry; this is temporary timeline test data.
  {
    id: "demo-entry-30",
    type: "text",
    content: "+1 (555) 123-4567",
    timestamp: Date.now() - 1000 * 60 * 60 * 24 * 14,
    pinned: false,
  },
];

// Floating window controls

const WindowControls: React.FC = () => {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    win.isMaximized().then(setMaximized);
    const unlisten = win.onResized(() => win.isMaximized().then(setMaximized));
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  return (
    <div className="win-controls">
      <button className="win-btn win-btn--min" onClick={() => win.minimize()} title="Minimise">
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
          <rect x="0" y="4.5" width="10" height="1" rx="0.5" fill="currentColor" />
        </svg>
      </button>
      <button
        className="win-btn win-btn--max"
        onClick={() => (maximized ? win.unmaximize() : win.maximize())}
        title={maximized ? "Restore" : "Maximise"}
      >
        {maximized ? (
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
            <rect x="2" y="0" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <rect x="0" y="2" width="8" height="8" rx="1" fill="var(--bg)" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        ) : (
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
            <rect x="0.5" y="0.5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )}
      </button>
      <button className="win-btn win-btn--close" onClick={() => win.close()} title="Close">
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
          <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
};

const App: React.FC = () => {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [screen, setScreen] = useState<AppScreen>("clipboard");
  const [undoSnapshot, setUndoSnapshot] = useState<ClipboardEntry[] | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const systemPrefersDark = () =>
    window.matchMedia("(prefers-color-scheme: dark)").matches;

  const [theme, setTheme] = useState<AppTheme>(() => {
    const saved = localStorage.getItem("sc-theme") as AppTheme | null;
    return saved ?? (systemPrefersDark() ? "dark" : "light");
  });

  // Keep document.documentElement in sync so portals (e.g. CardMenu) also
  // inherit the correct CSS variables.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Track OS theme changes and apply them when the user hasn't pinned a preference.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      if (localStorage.getItem("sc-theme")) return; // user has a manual preference
      setTheme(e.matches ? "dark" : "light");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      localStorage.setItem("sc-theme", next);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    invoke<ClipboardEntry[]>("get_history").then((history) => {
      if (cancelled) return;
      if (!SHOW_DEMO_CLIPBOARD_ENTRIES) {
        setEntries(history);
        return;
      }
      const realEntriesWithoutDemoIds = history.filter(
        (entry) => !DEMO_CLIPBOARD_ENTRIES.some((demo) => demo.id === entry.id),
      );
      setEntries([...DEMO_CLIPBOARD_ENTRIES, ...realEntriesWithoutDemoIds]);
    });

    listen<ClipboardEntry>("clipboard:new-entry", (event) => {
      if (cancelled) return;
      setEntries((prev) => {
        if (prev.some((e) => e.id === event.payload.id)) return prev;
        return [event.payload, ...prev];
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleCopy = useCallback(async (id: string) => {
    await invoke("copy_entry", { id });
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await invoke("delete_entry", { id });
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const handlePin = useCallback(async (id: string, shouldPin: boolean) => {
    const success = await invoke<boolean>(shouldPin ? "pin_entry" : "unpin_entry", { id });
    if (success) {
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, pinned: shouldPin } : e))
      );
    }
  }, []);

  const handleClearAll = useCallback(() => {
    if (undoTimerRef.current !== null) clearTimeout(undoTimerRef.current);
    setUndoSnapshot(entries);
    setEntries([]);
    undoTimerRef.current = setTimeout(async () => {
      undoTimerRef.current = null;
      setUndoSnapshot(null);
      await invoke("clear_history");
    }, 5000);
  }, [entries]);

  const handleUndoClear = useCallback(() => {
    if (undoTimerRef.current !== null) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setEntries(undoSnapshot ?? []);
    setUndoSnapshot(null);
  }, [undoSnapshot]);

  const textCount = entries.filter((e) => e.type === "text").length;
  const imageCount = entries.filter(
    (e) => e.type === "image" || (e.type === "file" && classifyFileEntry(e.content) === "image"),
  ).length;
  const fileCount = entries.filter(
    (e) => e.type === "file" && classifyFileEntry(e.content) === "file",
  ).length;

  return (
    <div className="app" data-theme={theme}>
      <Sidebar screen={screen} theme={theme} onNavigate={setScreen} onToggleTheme={toggleTheme} />

      <div className="main-frame">
        <div className="titlebar" data-tauri-drag-region>
          <span className="titlebar-title">Smart Clipboard</span>
          <WindowControls />
        </div>

        {screen === "settings" ? (
          <SettingsScreen />
        ) : screen === "shortcuts" ? (
          <ShortcutsScreen />
        ) : screen === "search" ? (
          <SearchScreen entries={entries} onCopy={handleCopy} onDelete={handleDelete} onPin={handlePin} />
        ) : (
          <ClipboardScreen
            entries={entries}
            onCopy={handleCopy}
            onDelete={handleDelete}
            onPin={handlePin}
            onClearAll={entries.length > 0 ? handleClearAll : undefined}
          />
        )}

        {screen === "clipboard" && entries.length > 0 && (
          <StatusPill
            textCount={textCount}
            imageCount={imageCount}
            fileCount={fileCount}
            total={entries.length}
          />
        )}

        {undoSnapshot !== null && (
          <ToastNotification
            message="History cleared"
            icon={
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            }
            action={{
              label: "Undo",
              icon: (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7v6h6" />
                  <path d="M3 13C5.5 6.5 14 4 19 8.5a9 9 0 0 1 2 5.5" />
                </svg>
              ),
              onClick: handleUndoClear,
            }}
            duration={5000}
            onDismiss={() => setUndoSnapshot(null)}
          />
        )}
      </div>
    </div>
  );
};

export default App;

// Mount

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
