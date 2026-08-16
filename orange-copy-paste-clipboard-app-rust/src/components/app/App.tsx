import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ClipboardEntry, Note, AppScreen, AppTheme, SyncIndicator, SyncInviteList } from "../../types";
import {
  classifyFileEntry,
  removeGroupColor,
  renameGroupColor,
} from "../../types";
import Sidebar from "./sidebar/Sidebar";
import StatusPill from "./status-pill/StatusPill";
import SpacesScreen from "./spaces-screen/SpacesScreen";
import AccountScreen from "./account-screen/AccountScreen";
import SettingsScreen from "./settings-screen/SettingsScreen";
import ShortcutsScreen from "./shortcuts-screen/ShortcutsScreen";
import ClipboardScreen from "./clipboard-screen/ClipboardScreen";
import NotesScreen from "./notes-screen/NotesScreen";
import { initAttachmentResolver } from "./notes-screen/editor-engine";
import ToastNotification from "./toast/ToastNotification";
import TooltipPortal from "./tooltip/TooltipPortal";
import UpdateBanner from "./update-banner/UpdateBanner";
import { useHealthWarning } from "../../hooks/useHealthWarning";
import { useUpdater } from "../../hooks/useUpdater";
import {
  TrashIcon,
  UndoIcon,
  PinIcon,
  CloseIcon,
  MinimizeIcon,
  MaximizeIcon,
  RestoreIcon,
  WindowCloseIcon,
  CloudSyncIcon,
  WarningIcon,
} from "../icons";
import "./App.css";

const GROUPS_STORAGE_KEY = "sc-groups";
const SYSTEM_GROUPS = ["pinned", "saved"];

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
        <MinimizeIcon />
      </button>
      <button
        className="win-btn win-btn--max"
        onClick={() => (maximized ? win.unmaximize() : win.maximize())}
        title={maximized ? "Restore" : "Maximise"}
      >
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        className="win-btn win-btn--close"
        onClick={() => win.close()}
        title="Close"
      >
        <WindowCloseIcon />
      </button>
    </div>
  );
};

const App: React.FC = () => {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [screen, setScreen] = useState<AppScreen>(() => {
    const saved = localStorage.getItem("sc-last-screen") as AppScreen | null;
    return saved === "notes" || saved === "clipboard" || saved === "spaces" ? saved : "clipboard";
  });
  const [undoSnapshot, setUndoSnapshot] = useState<ClipboardEntry[] | null>(
    null,
  );
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didRecoverGroupsRef = useRef(false);

  // ID of the entry currently in the OS clipboard
  const [activeClipboardId, setActiveClipboardId] = useState("");

  // null = sync inactive/not logged in; true/false = WS connected state
  const [syncConnected, setSyncConnected] = useState<boolean | null>(null);
  // Bumped whenever a merge lands, to briefly show a "syncing" pulse.
  const [syncTick, setSyncTick] = useState(0);
  const [syncActivity, setSyncActivity] = useState(false);
  // Received shared-space invites still awaiting a response.
  const [pendingInviteCount, setPendingInviteCount] = useState(0);

  // Undo state for group deletion
  const [deletedGroup, setDeletedGroup] = useState<{
    name: string;
    entries: ClipboardEntry[];
  } | null>(null);
  const deleteGroupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Undo state for single-entry deletion
  const [deletedEntry, setDeletedEntry] = useState<ClipboardEntry | null>(null);
  const deleteEntryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Undo state for single-note deletion
  const [deletedNote, setDeletedNote] = useState<Note | null>(null);
  const deleteNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Undo state for bulk note deletion
  const [bulkDeletedNotes, setBulkDeletedNotes] = useState<Note[] | null>(null);
  const bulkDeleteNotesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Toast: max pins reached
  const [pinLimitReached, setPinLimitReached] = useState(false);
  const pinLimitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Groups state — persisted to localStorage
  const [availableGroups, setAvailableGroups] = useState<string[]>(() => {
    return readStoredGroups();
  });

  // Notes state
  const [notes, setNotes] = useState<Note[]>([]);

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
    initAttachmentResolver();
  }, []);

  // Silent session restore: refresh token + device-wrapped UMK, no password.
  // Fire-and-forget — a null result shows the login screen, but Rust keeps
  // retrying in the background when the cause was only a network hiccup and
  // emits sync:session-restored once it gets through (AccountScreen listens).
  useEffect(() => {
    invoke("sync_restore_session").catch(() => {});
  }, []);

  // An internal error left the process running but no longer trusted, so saving
  // is paused until a restart.
  const health = useHealthWarning();

  // A newer release is out. Notify-only: nothing downloads or installs until the
  // user presses something in the banner below.
  const updater = useUpdater();

  // What a previous degraded session had to set aside and this one took back on.
  // Decided before this window existed, so it is polled rather than listened for.
  const [recovered, setRecovered] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<string | null>("health_recovery_notice")
      .then((notice) => {
        if (!cancelled && notice) setRecovered(notice);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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

    let unlistenGroups: (() => void) | undefined;

    listen<{ id: string; groups: string[] }>(
      "clipboard:entry-groups-changed",
      (event) => {
        if (cancelled) return;
        const { id, groups } = event.payload;
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, groups } : e)),
        );
      },
    ).then((fn) => {
      if (cancelled) fn();
      else unlistenGroups = fn;
    });

    let unlistenActiveId: (() => void) | undefined;

    invoke<string>("get_active_clipboard_id").then((id) => {
      if (!cancelled) setActiveClipboardId(id);
    });

    listen<string>("clipboard:active-id", (event) => {
      if (cancelled) return;
      setActiveClipboardId(event.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenActiveId = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
      unlistenDeleted?.();
      unlistenPinned?.();
      unlistenGroups?.();
      unlistenActiveId?.();
    };
  }, []);

  // Load notes on mount.
  useEffect(() => {
    invoke<Note[]>("get_notes").then(setNotes);
  }, []);

  // Re-sync notes when window regains focus.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win
      .listen("tauri://focus", () => {
        if (cancelled) return;
        invoke<Note[]>("get_notes").then((ns) => {
          if (!cancelled) setNotes(ns);
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

  // Reload local state whenever the sync engine merges entries from another
  // device. Rust holds the UMK, so it decrypts + writes the store directly
  // (on delta pull and on live WebSocket fan-out) and then emits these events;
  // the UI just re-reads the now-updated store.
  useEffect(() => {
    let cancelled = false;
    const win = getCurrentWindow();
    const unlisteners: Array<() => void> = [];

    const track = (p: Promise<() => void>) => {
      p.then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      });
    };

    track(
      win.listen("sync:history-merged", () => {
        if (!cancelled) setSyncTick((t) => t + 1);
        invoke<ClipboardEntry[]>("get_history").then((h) => {
          if (!cancelled) setEntries(h);
        });
      }),
    );
    track(
      win.listen("sync:notes-merged", () => {
        if (!cancelled) setSyncTick((t) => t + 1);
        invoke<Note[]>("get_notes").then((ns) => {
          if (!cancelled) setNotes(ns);
        });
      }),
    );
    // Another device changed settings: pull the new blob (which re-emits
    // `sync:settings`, applied by the effect below).
    track(
      win.listen("sync:settings-updated", () => {
        invoke("sync_pull_settings").catch(() => {});
      }),
    );

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // Re-sync with the Rust history whenever the main window regains focus or
  // becomes visible. This is a safety-net: if an event was missed for any
  // reason, the clipboard screen catches up as soon as the user switches back
  // to it. visibilitychange covers the "shown from tray/hotkey" path where
  // tauri://focus alone may not fire.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();

    const syncHistory = () => {
      if (cancelled) return;
      invoke<ClipboardEntry[]>("get_history").then((history) => {
        if (cancelled) return;
        setEntries(history);
      });
    };

    win.listen("tauri://focus", syncHistory).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    const onVisibility = () => {
      if (document.visibilityState === "visible") syncHistory();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      unlisten?.();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Track cloud sync connection state.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ connected: boolean }>("sync:status-changed", (event) => {
      if (!cancelled) setSyncConnected(event.payload.connected);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Show a brief "syncing" pulse on the sidebar after each merge, then decay.
  useEffect(() => {
    if (syncTick === 0) return;
    setSyncActivity(true);
    const t = setTimeout(() => setSyncActivity(false), 1200);
    return () => clearTimeout(t);
  }, [syncTick]);

  // Pending shared-space invites — drives the badge on the Account nav item.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];

    const track = (p: Promise<() => void>) => {
      p.then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      });
    };

    const refresh = () => {
      invoke<SyncInviteList>("sync_list_invites")
        .then((list) => {
          if (cancelled) return;
          setPendingInviteCount(
            list.received.filter((i) => i.status === "pending").length,
          );
        })
        .catch(() => {
          if (!cancelled) setPendingInviteCount(0);
        });
    };

    refresh();
    track(listen("sync:invite-received", refresh));
    track(listen("sync:invite-updated", refresh));
    track(
      listen<{ connected: boolean }>("sync:status-changed", (event) => {
        if (event.payload.connected) refresh();
      }),
    );

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // Settings sync: when the sync debounce fires, collect localStorage values
  // and send them to the Rust side so they can be merged into the push payload.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<null>("sync:collect-settings", () => {
      if (cancelled) return;
      const SYNC_KEYS: Record<string, string> = {
        theme: localStorage.getItem("sc-theme") ?? "",
        layout: localStorage.getItem("sc-layout") ?? "",
        sort: localStorage.getItem("sc-sort") ?? "",
        paste_slots: localStorage.getItem("sc-paste-slots") ?? "",
        group_names: localStorage.getItem("sc-groups") ?? "[]",
        group_colors: localStorage.getItem("sc-group-colors") ?? "{}",
      };
      invoke("sync_receive_local_settings", {
        json: JSON.stringify(SYNC_KEYS),
      }).catch(console.error);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Settings sync: apply incoming settings blob from the server to localStorage.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<string>("sync:settings", (event) => {
      if (cancelled) return;
      try {
        const data = JSON.parse(event.payload) as Record<string, unknown>;
        const STORAGE_MAP: Record<string, string> = {
          theme: "sc-theme",
          layout: "sc-layout",
          sort: "sc-sort",
          paste_slots: "sc-paste-slots",
          group_names: "sc-groups",
          group_colors: "sc-group-colors",
        };
        for (const [key, storageKey] of Object.entries(STORAGE_MAP)) {
          const val = data[key];
          if (val != null) {
            localStorage.setItem(
              storageKey,
              typeof val === "string" ? val : JSON.stringify(val),
            );
          }
        }
        // Apply theme change immediately without full reload
        if (data.theme === "dark" || data.theme === "light") {
          setTheme(data.theme as import("../../types").AppTheme);
        }
        // Apply groups change
        if (typeof data.group_names === "string") {
          try {
            const groups = JSON.parse(data.group_names) as string[];
            if (Array.isArray(groups)) {
              setAvailableGroups(groups.filter((g) => typeof g === "string"));
            }
          } catch { /* ignore */ }
        }
      } catch (e) {
        console.error("[sync:settings] apply failed", e);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // An entry sync refused to send. The reason comes from Rust so the toast can
  // say what actually happened instead of guessing at the file-size case.
  const [syncSkipReason, setSyncSkipReason] = useState<string | null>(null);
  const fileSyncSkippedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<{ client_id: string; label: string; reason: string }>("sync:entry-skipped", (event) => {
      if (cancelled) return;
      if (fileSyncSkippedTimerRef.current !== null)
        clearTimeout(fileSyncSkippedTimerRef.current);
      setSyncSkipReason(event.payload.reason || "Item could not be synced");
      fileSyncSkippedTimerRef.current = setTimeout(() => {
        fileSyncSkippedTimerRef.current = null;
        setSyncSkipReason(null);
      }, 5000);
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
    setActiveClipboardId(id);
    await invoke("copy_entry", { id });
  }, []);

  const handleDelete = useCallback(
    (id: string) => {
      // Commit any pending delete immediately
      if (deleteEntryTimerRef.current !== null) {
        clearTimeout(deleteEntryTimerRef.current);
        deleteEntryTimerRef.current = null;
        // Fire-and-forget commit for the previous pending delete
        if (deletedEntry) {
          invoke("delete_entry", { id: deletedEntry.id }).catch(console.error);
        }
      }

      // Snapshot the entry being deleted
      const entry = entries.find((e) => e.id === id);
      if (!entry) return;

      setDeletedEntry(entry);
      setEntries((prev) => prev.filter((e) => e.id !== id));

      // Defer the actual backend delete
      deleteEntryTimerRef.current = setTimeout(async () => {
        deleteEntryTimerRef.current = null;
        setDeletedEntry(null);
        await invoke("delete_entry", { id });
      }, 5000);
    },
    [entries, deletedEntry],
  );

  const handleUndoDelete = useCallback(() => {
    if (deleteEntryTimerRef.current !== null) {
      clearTimeout(deleteEntryTimerRef.current);
      deleteEntryTimerRef.current = null;
    }
    if (!deletedEntry) return;
    setEntries((prev) => {
      // Re-insert at original position by timestamp
      const next = [...prev, deletedEntry];
      next.sort((a, b) => b.timestamp - a.timestamp);
      return next;
    });
    setDeletedEntry(null);
  }, [deletedEntry]);

  const handlePin = useCallback(
    async (id: string, shouldPin: boolean): Promise<boolean> => {
      const success = await invoke<boolean>(
        shouldPin ? "pin_entry" : "unpin_entry",
        { id },
      );
      if (success) {
        setEntries((prev) =>
          prev.map((e) => {
            if (e.id !== id) return e;
            return { ...e, pinned: shouldPin };
          }),
        );
      } else if (shouldPin) {
        // Backend rejected — max pins reached
        if (pinLimitTimerRef.current !== null)
          clearTimeout(pinLimitTimerRef.current);
        setPinLimitReached(true);
        pinLimitTimerRef.current = setTimeout(() => {
          setPinLimitReached(false);
          pinLimitTimerRef.current = null;
        }, 3000);
      }
      return success;
    },
    [],
  );

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
      await invoke("rename_group_in_notes", { oldName, newName });
      const history = await invoke<ClipboardEntry[]>("get_history");
      setEntries(history);
      const updatedNotes = await invoke<Note[]>("get_notes");
      setNotes(updatedNotes);
    },
    [],
  );

  const handleSetGroups = useCallback(async (id: string, groups: string[]) => {
    // Optimistic update
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, groups } : e)));
    await invoke("set_entry_groups", { id, groups });
  }, []);

  // ── Bulk operations ───────────────────────────────────────────────

  // Undo state for bulk deletion
  const [bulkDeletedEntries, setBulkDeletedEntries] = useState<
    ClipboardEntry[] | null
  >(null);
  const bulkDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleBulkDelete = useCallback(
    (ids: string[]) => {
      // Commit any pending single-entry delete
      if (deleteEntryTimerRef.current !== null) {
        clearTimeout(deleteEntryTimerRef.current);
        deleteEntryTimerRef.current = null;
        if (deletedEntry) {
          invoke("delete_entry", { id: deletedEntry.id }).catch(console.error);
          setDeletedEntry(null);
        }
      }
      // Commit any pending bulk delete
      if (bulkDeleteTimerRef.current !== null) {
        clearTimeout(bulkDeleteTimerRef.current);
        bulkDeleteTimerRef.current = null;
        if (bulkDeletedEntries) {
          const prevIds = bulkDeletedEntries.map((e) => e.id);
          invoke("bulk_delete_entries", { ids: prevIds }).catch(console.error);
        }
      }

      const idSet = new Set(ids);
      const snapshot = entries.filter((e) => idSet.has(e.id));
      if (snapshot.length === 0) return;

      setBulkDeletedEntries(snapshot);
      setEntries((prev) => prev.filter((e) => !idSet.has(e.id)));

      bulkDeleteTimerRef.current = setTimeout(async () => {
        bulkDeleteTimerRef.current = null;
        setBulkDeletedEntries(null);
        await invoke("bulk_delete_entries", { ids });
      }, 5000);
    },
    [entries, deletedEntry, bulkDeletedEntries],
  );

  const handleUndoBulkDelete = useCallback(() => {
    if (bulkDeleteTimerRef.current !== null) {
      clearTimeout(bulkDeleteTimerRef.current);
      bulkDeleteTimerRef.current = null;
    }
    if (!bulkDeletedEntries) return;
    setEntries((prev) => {
      const next = [...prev, ...bulkDeletedEntries];
      next.sort((a, b) => b.timestamp - a.timestamp);
      return next;
    });
    setBulkDeletedEntries(null);
  }, [bulkDeletedEntries]);

  const handleBulkPin = useCallback(
    async (ids: string[]) => {
      const changed = await invoke<number>("bulk_pin_entries", {
        ids,
        pin: true,
      });
      if (changed < ids.length) {
        // Some were rejected (pin limit) — re-sync and show toast
        const history = await invoke<ClipboardEntry[]>("get_history");
        setEntries(history);
        if (pinLimitTimerRef.current !== null)
          clearTimeout(pinLimitTimerRef.current);
        setPinLimitReached(true);
        pinLimitTimerRef.current = setTimeout(() => {
          setPinLimitReached(false);
          pinLimitTimerRef.current = null;
        }, 3000);
      } else {
        // All succeeded — update UI
        const idSet = new Set(ids);
        setEntries((prev) =>
          prev.map((e) => (idSet.has(e.id) ? { ...e, pinned: true } : e)),
        );
      }
    },
    [],
  );

  const handleBulkUnpin = useCallback(async (ids: string[]) => {
    const idSet = new Set(ids);
    setEntries((prev) =>
      prev.map((e) => (idSet.has(e.id) ? { ...e, pinned: false } : e)),
    );
    await invoke("bulk_pin_entries", { ids, pin: false });
  }, []);

  const handleBulkAddGroup = useCallback(async (ids: string[], group: string) => {
    // Optimistic update — add the group to each entry
    const idSet = new Set(ids);
    setEntries((prev) =>
      prev.map((e) => {
        if (!idSet.has(e.id)) return e;
        if (e.groups.includes(group)) return e;
        return { ...e, groups: [...e.groups, group] };
      }),
    );
    await invoke("bulk_add_group", { ids, group });
  }, []);

  const handleBulkRemoveGroup = useCallback(
    async (ids: string[], group: string) => {
      const idSet = new Set(ids);
      setEntries((prev) =>
        prev.map((e) => {
          if (!idSet.has(e.id)) return e;
          return { ...e, groups: e.groups.filter((g) => g !== group) };
        }),
      );
      await invoke("bulk_remove_group", { ids, group });
    },
    [],
  );

  // Save / Unsave are just group add/remove with the "Saved" group
  const handleBulkSave = useCallback(
    async (ids: string[]) => {
      await handleBulkAddGroup(ids, "Saved");
    },
    [handleBulkAddGroup],
  );

  const handleBulkUnsave = useCallback(
    async (ids: string[]) => {
      await handleBulkRemoveGroup(ids, "Saved");
    },
    [handleBulkRemoveGroup],
  );

  const handleClearAll = useCallback(() => {
    if (undoTimerRef.current !== null) clearTimeout(undoTimerRef.current);
    setUndoSnapshot(entries);
    setEntries((prev) =>
      prev.filter((e) => e.pinned || e.groups.includes("Saved")),
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

  const { textCount, imageCount, fileCount, htmlCount } = entries.reduce(
    (acc, e) => {
      if (e.type === "text") acc.textCount++;
      else if (e.type === "html") acc.htmlCount++;
      else if (e.type === "image" || (e.type === "file" && classifyFileEntry(e.content) === "image")) acc.imageCount++;
      else if (e.type === "file" && classifyFileEntry(e.content) === "file") acc.fileCount++;
      return acc;
    },
    { textCount: 0, imageCount: 0, fileCount: 0, htmlCount: 0 },
  );

  // ── Notes handlers ─────────────────────────────────────────────────

  const handleCreateNote = useCallback(async () => {
    const note = await invoke<Note>("create_note");
    setNotes((prev) => [note, ...prev]);
    return note;
  }, []);

  const handleUpdateNote = useCallback(
    async (id: string, title: string, content: string) => {
      await invoke("update_note", { id, title, content });
      setNotes((prev) =>
        prev.map((n) =>
          n.id === id
            ? { ...n, title, content, updated_at: Date.now() }
            : n,
        ),
      );
    },
    [],
  );

  const handleDeleteNote = useCallback(
    (id: string) => {
      // Commit any pending note delete immediately
      if (deleteNoteTimerRef.current !== null) {
        clearTimeout(deleteNoteTimerRef.current);
        deleteNoteTimerRef.current = null;
        if (deletedNote) {
          invoke("delete_note", { id: deletedNote.id }).catch(console.error);
        }
      }

      const note = notes.find((n) => n.id === id);
      if (!note) return;

      setDeletedNote(note);
      setNotes((prev) => prev.filter((n) => n.id !== id));

      // Defer backend delete
      deleteNoteTimerRef.current = setTimeout(async () => {
        deleteNoteTimerRef.current = null;
        setDeletedNote(null);
        await invoke("delete_note", { id });
      }, 5000);
    },
    [notes, deletedNote],
  );

  const handleUndoDeleteNote = useCallback(() => {
    if (deleteNoteTimerRef.current !== null) {
      clearTimeout(deleteNoteTimerRef.current);
      deleteNoteTimerRef.current = null;
    }
    if (!deletedNote) return;
    setNotes((prev) => {
      const next = [...prev, deletedNote];
      next.sort((a, b) => b.updated_at - a.updated_at);
      return next;
    });
    setDeletedNote(null);
  }, [deletedNote]);

  const handlePinNote = useCallback(
    async (id: string, pin: boolean) => {
      await invoke(pin ? "pin_note" : "unpin_note", { id });
      setNotes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, pinned: pin } : n)),
      );
    },
    [],
  );

  const handleSetNoteGroups = useCallback(
    async (id: string, groups: string[]) => {
      setNotes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, groups } : n)),
      );
      await invoke("set_note_groups", { id, groups });
    },
    [],
  );

  const handleBulkDeleteNotes = useCallback(
    (ids: string[]) => {
      // Commit any pending single note delete
      if (deleteNoteTimerRef.current !== null) {
        clearTimeout(deleteNoteTimerRef.current);
        deleteNoteTimerRef.current = null;
        if (deletedNote) {
          invoke("delete_note", { id: deletedNote.id }).catch(console.error);
          setDeletedNote(null);
        }
      }
      // Commit any pending bulk note delete
      if (bulkDeleteNotesTimerRef.current !== null) {
        clearTimeout(bulkDeleteNotesTimerRef.current);
        bulkDeleteNotesTimerRef.current = null;
        if (bulkDeletedNotes) {
          for (const n of bulkDeletedNotes)
            invoke("delete_note", { id: n.id }).catch(console.error);
          setBulkDeletedNotes(null);
        }
      }

      const snapshot = notes.filter((n) => ids.includes(n.id));
      setBulkDeletedNotes(snapshot);
      setNotes((prev) => prev.filter((n) => !ids.includes(n.id)));

      bulkDeleteNotesTimerRef.current = setTimeout(async () => {
        bulkDeleteNotesTimerRef.current = null;
        setBulkDeletedNotes(null);
        for (const id of ids) await invoke("delete_note", { id });
      }, 5000);
    },
    [notes, deletedNote, bulkDeletedNotes],
  );

  const handleUndoBulkDeleteNotes = useCallback(() => {
    if (bulkDeleteNotesTimerRef.current !== null) {
      clearTimeout(bulkDeleteNotesTimerRef.current);
      bulkDeleteNotesTimerRef.current = null;
    }
    if (!bulkDeletedNotes) return;
    setNotes((prev) => {
      const next = [...prev, ...bulkDeletedNotes];
      next.sort((a, b) => b.updated_at - a.updated_at);
      return next;
    });
    setBulkDeletedNotes(null);
  }, [bulkDeletedNotes]);

  const handleBulkPinNotes = useCallback(async (ids: string[]) => {
    setNotes((prev) => prev.map((n) => ids.includes(n.id) ? { ...n, pinned: true } : n));
    for (const id of ids) await invoke("pin_note", { id });
  }, []);

  const handleBulkUnpinNotes = useCallback(async (ids: string[]) => {
    setNotes((prev) => prev.map((n) => ids.includes(n.id) ? { ...n, pinned: false } : n));
    for (const id of ids) await invoke("unpin_note", { id });
  }, []);

  const handleBulkAddGroupNotes = useCallback(async (ids: string[], group: string) => {
    setNotes((prev) => prev.map((n) =>
      ids.includes(n.id) && !n.groups.includes(group)
        ? { ...n, groups: [...n.groups, group] }
        : n,
    ));
    for (const id of ids) {
      const note = notes.find((n) => n.id === id);
      if (note && !note.groups.includes(group))
        await invoke("set_note_groups", { id, groups: [...note.groups, group] });
    }
  }, [notes]);

  const handleBulkRemoveGroupNotes = useCallback(async (ids: string[], group: string) => {
    setNotes((prev) => prev.map((n) =>
      ids.includes(n.id)
        ? { ...n, groups: n.groups.filter((g) => g !== group) }
        : n,
    ));
    for (const id of ids) {
      const note = notes.find((n) => n.id === id);
      if (note)
        await invoke("set_note_groups", { id, groups: note.groups.filter((g: string) => g !== group) });
    }
  }, [notes]);

  const syncPill =
    syncConnected === true
      ? { label: "Sync connected", modifier: "connected" }
      : syncConnected === false
        ? { label: "Sync offline", modifier: "offline" }
        : { label: "Sync inactive", modifier: "inactive" };
  const syncPillLabel = syncPill.label;
  const syncPillClass = `sync-pill sync-pill--${syncPill.modifier}`;

  // Richer status for the sidebar cloud icon.
  const syncState: SyncIndicator =
    syncConnected === null
      ? "signedOut"
      : syncActivity
        ? "syncing"
        : syncConnected
          ? "connected"
          : "offline";

  return (
    <div className="app" data-theme={theme}>
      <TooltipPortal />
      <Sidebar
        screen={screen}
        theme={theme}
        syncState={syncState}
        pendingInvites={pendingInviteCount}
        onNavigate={(s) => {
          setScreen(s);
          if (s === "clipboard" || s === "notes" || s === "spaces") {
            localStorage.setItem("sc-last-screen", s);
          }
        }}
        onToggleTheme={toggleTheme}
      />

      <div className="main-frame">
        <div className="titlebar" data-tauri-drag-region>
          <span className="titlebar-title">Orange Copy Paste</span>
          <WindowControls />
        </div>

        {health && (
          <div className="app-degraded" role="alert">
            <div className="app-degraded-text">
              {health.kind === "degraded" && (
                <>
                  <strong>Saving is paused.</strong> Something went wrong inside
                  the app, so your saved history and notes are being left
                  untouched rather than risk overwriting them. Anything captured
                  since is kept in memory only. Restart to start saving again.
                </>
              )}
              {health.kind === "stalled" && (
                <>
                  <strong>Saving has stopped responding.</strong> The part of the
                  app that writes history and notes to disk has not finished a
                  pass in a while, so anything captured recently may not be
                  saved. If it does not pick up again on its own, restart.
                </>
              )}
              {health.kind === "unwritable" && (
                <>
                  <strong>Your disk is refusing to save.</strong> The app is
                  working, but writing history and notes keeps failing. Usually
                  a full drive, or antivirus holding the file open. Free up space
                  or check the folder, and saving picks up on its own.
                </>
              )}
              <span className="app-degraded-reason">{health.reason}</span>
            </div>
            {/* A restart clears a fault or a wedged thread. It does nothing about
                a full disk, and offering it there sends the user in a circle. */}
            {health.kind !== "unwritable" && (
              <button
                type="button"
                onClick={() => {
                  invoke("health_restart_app").catch(() => {});
                }}
              >
                Restart app
              </button>
            )}
          </div>
        )}

        {/* Yields to the health bar: two stacked alarm strips is a lot of window
            to spend, and "saving is paused" is the more urgent of the two. The
            update stays pending either way, and Settings still offers it. */}
        {!health && <UpdateBanner updater={updater} />}

        {screen === "settings" ? (
          <SettingsScreen />
        ) : screen === "account" ? (
          <AccountScreen />
        ) : screen === "shortcuts" ? (
          <ShortcutsScreen />
        ) : screen === "spaces" ? (
          <SpacesScreen
            entries={entries}
            notes={notes}
            syncConnected={syncConnected}
            availableGroups={availableGroups}
            onCopyEntry={handleCopy}
          />
        ) : screen === "notes" ? (
          <NotesScreen
            notes={notes}
            entries={entries}
            availableGroups={availableGroups}
            onAddGroup={handleAddGroup}
            onDeleteGroup={handleDeleteGroup}
            onRenameGroup={handleRenameGroup}
            onCreate={handleCreateNote}
            onUpdate={handleUpdateNote}
            onDelete={handleDeleteNote}
            onPin={handlePinNote}
            onSetGroups={handleSetNoteGroups}
            onCopyEntry={handleCopy}
            onBulkDelete={handleBulkDeleteNotes}
            onBulkPin={handleBulkPinNotes}
            onBulkUnpin={handleBulkUnpinNotes}
            onBulkAddGroup={handleBulkAddGroupNotes}
            onBulkRemoveGroup={handleBulkRemoveGroupNotes}
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
            onBulkDelete={handleBulkDelete}
            onBulkPin={handleBulkPin}
            onBulkUnpin={handleBulkUnpin}
            onBulkSave={handleBulkSave}
            onBulkUnsave={handleBulkUnsave}
            onBulkAddGroup={handleBulkAddGroup}
            onBulkRemoveGroup={handleBulkRemoveGroup}
            activeClipboardId={activeClipboardId}
          />
        )}

        <div className="bottom-pill-row">
          {screen === "clipboard" && entries.length > 0 && (
            <StatusPill
              textCount={textCount}
              imageCount={imageCount}
              fileCount={fileCount}
              htmlCount={htmlCount}
              total={entries.length}
            />
          )}
          {screen !== "spaces" && screen !== "account" && (
            <div
              className={syncPillClass}
              data-tooltip={syncPillLabel}
              data-tooltip-pos="top"
            >
              <span className="sync-pill-dot" />
              <span className="sync-pill-text">{syncPillLabel}</span>
            </div>
          )}
        </div>

        {pinLimitReached && (
          <ToastNotification
            message="Max pins reached (10)"
            icon={<PinIcon size={13} />}
            duration={3000}
            onDismiss={() => setPinLimitReached(false)}
          />
        )}

        {recovered !== null && (
          <ToastNotification
            message={`Restored the ${recovered} you captured before the last restart`}
            icon={<WarningIcon />}
            duration={8000}
            onDismiss={() => setRecovered(null)}
          />
        )}

        {undoSnapshot !== null && (
          <ToastNotification
            message="History cleared"
            icon={<TrashIcon />}
            action={{
              label: "Undo",
              icon: <UndoIcon />,
              onClick: handleUndoClear,
            }}
            duration={5000}
            onDismiss={() => setUndoSnapshot(null)}
          />
        )}

        {deletedEntry !== null && (
          <ToastNotification
            message="Entry deleted"
            icon={<TrashIcon />}
            action={{
              label: "Undo",
              icon: <UndoIcon />,
              onClick: handleUndoDelete,
            }}
            duration={5000}
            onDismiss={() => setDeletedEntry(null)}
          />
        )}

        {deletedGroup !== null && (
          <ToastNotification
            message={`Group "${deletedGroup.name}" deleted`}
            icon={<CloseIcon size={13} strokeWidth={2.2} />}
            action={{
              label: "Undo",
              icon: <UndoIcon />,
              onClick: handleUndoDeleteGroup,
            }}
            duration={5000}
            onDismiss={() => setDeletedGroup(null)}
          />
        )}

        {bulkDeletedEntries !== null && (
          <ToastNotification
            message={`${bulkDeletedEntries.length} entries deleted`}
            icon={<TrashIcon />}
            action={{
              label: "Undo",
              icon: <UndoIcon />,
              onClick: handleUndoBulkDelete,
            }}
            duration={5000}
            onDismiss={() => setBulkDeletedEntries(null)}
          />
        )}

        {deletedNote !== null && (
          <ToastNotification
            message="Note deleted"
            icon={<TrashIcon />}
            action={{
              label: "Undo",
              icon: <UndoIcon />,
              onClick: handleUndoDeleteNote,
            }}
            duration={5000}
            onDismiss={() => setDeletedNote(null)}
          />
        )}

        {bulkDeletedNotes !== null && (
          <ToastNotification
            message={`${bulkDeletedNotes.length} notes deleted`}
            icon={<TrashIcon />}
            action={{
              label: "Undo",
              icon: <UndoIcon />,
              onClick: handleUndoBulkDeleteNotes,
            }}
            duration={5000}
            onDismiss={() => setBulkDeletedNotes(null)}
          />
        )}

        {syncSkipReason && (
          <ToastNotification
            message={`Not synced. ${syncSkipReason}`}
            icon={<CloudSyncIcon size={13} />}
            duration={5000}
            onDismiss={() => setSyncSkipReason(null)}
          />
        )}
      </div>
    </div>
  );
};

export default App;

/** Last line of defence for a render error. Without it React unmounts the tree
    and the window goes blank with no way back — indistinguishable from a hard
    crash. Shows what broke and offers a reload; local data is untouched either
    way, since it lives on the Rust side. */
class AppBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[app] render error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app-crash">
        <h1>Something broke on screen</h1>
        <p>
          Your clipboard history and notes are safe. They're stored outside the
          window, so reloading usually clears this.
        </p>
        <pre>{this.state.error.message}</pre>
        <button onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}

// Mount

ReactDOM.createRoot(document.getElementById("root")!).render(
  <AppBoundary>
    <App />
  </AppBoundary>,
);
