import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ClipboardEntry, AppScreen, AppTheme } from "../../types";
import { classifyFileEntry } from "../../types";
import Sidebar from "../sidebar/Sidebar";
import StatusPill from "../status-pill/StatusPill";
import SettingsScreen from "../settings-screen/SettingsScreen";
import ClipboardScreen from "../clipboard-screen/ClipboardScreen";
import "./App.css";

// ── App ──────────────────────────────────────────────────────────────────────

const App: React.FC = () => {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
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
      if (!cancelled) setEntries(history);
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
        {/* ── Top bar ── */}
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
            <button className="clear-all-btn" onClick={handleClearAll}>
              Clear All
            </button>
          )}
        </div>

        {/* ── Screen content ── */}
        {screen === "settings" ? (
          <SettingsScreen />
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
