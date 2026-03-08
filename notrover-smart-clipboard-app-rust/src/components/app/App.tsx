import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ClipboardEntry, AppScreen, AppTheme } from "../../types";
import {
  classifyFileEntry,
  removeGroupColor,
  renameGroupColor,
} from "../../types";
import Sidebar from "./sidebar/Sidebar";
import StatusPill from "./status-pill/StatusPill";
import SettingsScreen from "./settings-screen/SettingsScreen";
import ShortcutsScreen from "./shortcuts-screen/ShortcutsScreen";
import ClipboardScreen from "./clipboard-screen/ClipboardScreen";
import SearchScreen from "./search-screen/SearchScreen";
import ToastNotification from "./toast/ToastNotification";
import TooltipPortal from "./tooltip/TooltipPortal";
import "./App.css";

const GROUPS_STORAGE_KEY = "sc-groups";
const SYSTEM_GROUPS = ["pinned", "persistent"];

function sanitizeGroups(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of input) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }

  return out;
}

function readStoredGroups(): string[] {
  try {
    return sanitizeGroups(
      JSON.parse(localStorage.getItem(GROUPS_STORAGE_KEY) ?? "[]"),
    );
  } catch {
    return [];
  }
}

function groupsFromEntries(entries: ClipboardEntry[]): string[] {
  const groups: string[] = [];
  for (const entry of entries) {
    groups.push(...sanitizeGroups(entry.groups));
  }
  // Filter out system groups — they are managed separately.
  return sanitizeGroups(groups).filter(
    (g) => !SYSTEM_GROUPS.includes(g.toLowerCase()),
  );
}

function mergeGroups(primary: string[], secondary: string[]): string[] {
  return sanitizeGroups([...primary, ...secondary]);
}

function sameGroups(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Floating window controls

const WindowControls: React.FC = () => {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    win.isMaximized().then(setMaximized);
    const unlisten = win.onResized(() => win.isMaximized().then(setMaximized));
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

const App: React.FC = () => {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [screen, setScreen] = useState<AppScreen>("clipboard");
  const [undoSnapshot, setUndoSnapshot] = useState<ClipboardEntry[] | null>(
    null,
  );
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didRecoverGroupsRef = useRef(false);

  // Undo state for group deletion
  const [deletedGroup, setDeletedGroup] = useState<{
    name: string;
    entries: ClipboardEntry[];
  } | null>(null);
  const deleteGroupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Groups state — persisted to localStorage
  const [availableGroups, setAvailableGroups] = useState<string[]>(() => {
    return readStoredGroups();
  });

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
      setEntries((prev) => {
        if (prev.length === 0) return history;
        const ids = new Set(history.map((e) => e.id));
        const extra = prev.filter((e) => !ids.has(e.id));
        return [...extra, ...history];
      });

      // Startup-only recovery: restore missing dropdown groups from entry tags.
      // Keeping this one-shot avoids re-adding a group while deletion is in-flight.
      if (!didRecoverGroupsRef.current) {
        didRecoverGroupsRef.current = true;
        setAvailableGroups((prev) => {
          const recovered = mergeGroups(prev, groupsFromEntries(history));
          if (sameGroups(recovered, prev)) return prev;
          localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(recovered));
          return recovered;
        });
      }
    });

    let unlistenDeleted: (() => void) | undefined;

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

    listen<string>("clipboard:entry-deleted", (event) => {
      if (cancelled) return;
      setEntries((prev) => prev.filter((e) => e.id !== event.payload));
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenDeleted = fn;
    });

    let unlistenPinned: (() => void) | undefined;

    listen<{ id: string; pinned: boolean }>(
      "clipboard:entry-pinned",
      (event) => {
        if (cancelled) return;
        const { id, pinned: pin } = event.payload;
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, pinned: pin } : e)),
        );
      },
    ).then((fn) => {
      if (cancelled) fn();
      else unlistenPinned = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
      unlistenDeleted?.();
      unlistenPinned?.();
    };
  }, []);

  // Re-sync with the Rust history whenever the main window regains focus.
  // This is a safety-net: if an event was missed for any reason, the
  // clipboard screen catches up as soon as the user switches back to it.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win
      .listen("tauri://focus", () => {
        if (cancelled) return;
        invoke<ClipboardEntry[]>("get_history").then((history) => {
          if (cancelled) return;
          setEntries(history);
        });
      })
      .then((fn) => {
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
    const success = await invoke<boolean>(
      shouldPin ? "pin_entry" : "unpin_entry",
      { id },
    );
    if (success) {
      setEntries((prev) =>
        prev.map((e) => {
          if (e.id !== id) return e;
          const updated = { ...e, pinned: shouldPin };
          // Pinning automatically makes the entry persistent
          if (shouldPin && !e.groups.includes("Persistent")) {
            updated.groups = [...e.groups, "Persistent"];
          }
          return updated;
        }),
      );
    }
  }, []);

  // Groups handlers

  const handleAddGroup = useCallback((name: string) => {
    setAvailableGroups((prev) => {
      const next = mergeGroups(prev, [name]);
      localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const handleDeleteGroup = useCallback(
    (name: string) => {
      // Cancel any pending group delete
      if (deleteGroupTimerRef.current !== null) {
        clearTimeout(deleteGroupTimerRef.current);
        deleteGroupTimerRef.current = null;
      }

      // Snapshot entries that have this group (for undo)
      const affectedEntries = entries.filter((e) => e.groups.includes(name));

      // Optimistic UI removal
      setAvailableGroups((prev) => {
        const next = prev.filter((g) => g !== name);
        localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(next));
        return next;
      });
      setEntries((prev) =>
        prev.map((e) =>
          e.groups.includes(name)
            ? { ...e, groups: e.groups.filter((g) => g !== name) }
            : e,
        ),
      );

      setDeletedGroup({ name, entries: affectedEntries });

      // After timeout, commit the delete to backend
      deleteGroupTimerRef.current = setTimeout(async () => {
        deleteGroupTimerRef.current = null;
        setDeletedGroup(null);
        removeGroupColor(name);
        await invoke("purge_group_from_entries", { group: name });
        const history = await invoke<ClipboardEntry[]>("get_history");
        setEntries(history);
      }, 5000);
    },
    [entries],
  );

  const handleUndoDeleteGroup = useCallback(() => {
    if (deleteGroupTimerRef.current !== null) {
      clearTimeout(deleteGroupTimerRef.current);
      deleteGroupTimerRef.current = null;
    }
    if (!deletedGroup) return;

    // Restore the group
    setAvailableGroups((prev) => {
      const next = mergeGroups(prev, [deletedGroup.name]);
      localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(next));
      return next;
    });

    // Restore group tag on affected entries
    const affectedIds = new Set(deletedGroup.entries.map((e) => e.id));
    setEntries((prev) =>
      prev.map((e) =>
        affectedIds.has(e.id) && !e.groups.includes(deletedGroup.name)
          ? { ...e, groups: [...e.groups, deletedGroup.name] }
          : e,
      ),
    );

    setDeletedGroup(null);
  }, [deletedGroup]);

  const handleRenameGroup = useCallback(
    async (oldName: string, newName: string) => {
      setAvailableGroups((prev) => {
        const next = prev.map((g) => (g === oldName ? newName : g));
        localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(next));
        return next;
      });
      renameGroupColor(oldName, newName);
      await invoke("rename_group_in_entries", { oldName, newName });
      const history = await invoke<ClipboardEntry[]>("get_history");
      setEntries(history);
    },
    [],
  );

  const handleSetGroups = useCallback(async (id: string, groups: string[]) => {
    // Optimistic update
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, groups } : e)));
    await invoke("set_entry_groups", { id, groups });
  }, []);

  const handleClearAll = useCallback(() => {
    if (undoTimerRef.current !== null) clearTimeout(undoTimerRef.current);
    setUndoSnapshot(entries);
    setEntries((prev) =>
      prev.filter((e) => e.pinned || e.groups.includes("Persistent")),
    );
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
    (e) =>
      e.type === "image" ||
      (e.type === "file" && classifyFileEntry(e.content) === "image"),
  ).length;
  const fileCount = entries.filter(
    (e) => e.type === "file" && classifyFileEntry(e.content) === "file",
  ).length;

  return (
    <div className="app" data-theme={theme}>
      <TooltipPortal />
      <Sidebar
        screen={screen}
        theme={theme}
        onNavigate={setScreen}
        onToggleTheme={toggleTheme}
      />

      <div className="main-frame">
        <div className="titlebar" data-tauri-drag-region>
          <span className="titlebar-title">Orange Copy Paste</span>
          <WindowControls />
        </div>

        {screen === "settings" ? (
          <SettingsScreen />
        ) : screen === "shortcuts" ? (
          <ShortcutsScreen />
        ) : screen === "search" ? (
          <SearchScreen
            entries={entries}
            onCopy={handleCopy}
            onDelete={handleDelete}
            onPin={handlePin}
            availableGroups={availableGroups}
            onSetGroups={handleSetGroups}
          />
        ) : (
          <ClipboardScreen
            entries={entries}
            onCopy={handleCopy}
            onDelete={handleDelete}
            onPin={handlePin}
            onClearAll={entries.length > 0 ? handleClearAll : undefined}
            availableGroups={availableGroups}
            onAddGroup={handleAddGroup}
            onDeleteGroup={handleDeleteGroup}
            onRenameGroup={handleRenameGroup}
            onSetGroups={handleSetGroups}
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
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            }
            action={{
              label: "Undo",
              icon: (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
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

        {deletedGroup !== null && (
          <ToastNotification
            message={`Group "${deletedGroup.name}" deleted`}
            icon={
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            }
            action={{
              label: "Undo",
              icon: (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 7v6h6" />
                  <path d="M3 13C5.5 6.5 14 4 19 8.5a9 9 0 0 1 2 5.5" />
                </svg>
              ),
              onClick: handleUndoDeleteGroup,
            }}
            duration={5000}
            onDismiss={() => setDeletedGroup(null)}
          />
        )}
      </div>
    </div>
  );
};

export default App;

// Mount

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
