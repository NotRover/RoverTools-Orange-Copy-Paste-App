import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ClipboardEntry, Note, AppScreen, AppTheme } from "../../types";
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
import NotesScreen from "./notes-screen/NotesScreen";
import { initAttachmentResolver } from "./notes-screen/editor-engine";
import ToastNotification from "./toast/ToastNotification";
import TooltipPortal from "./tooltip/TooltipPortal";
import {
  TrashIcon,
  UndoIcon,
  PinIcon,
  CloseIcon,
  MinimizeIcon,
  MaximizeIcon,
  RestoreIcon,
  WindowCloseIcon,
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
    return saved === "notes" || saved === "clipboard" ? saved : "clipboard";
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

  return (
    <div className="app" data-theme={theme}>
      <TooltipPortal />
      <Sidebar
        screen={screen}
        theme={theme}
        onNavigate={(s) => {
          setScreen(s);
          if (s === "clipboard" || s === "notes") {
            localStorage.setItem("sc-last-screen", s);
          }
        }}
        onToggleTheme={toggleTheme}
        syncConnected={syncConnected}
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

        {screen === "clipboard" && entries.length > 0 && (
          <StatusPill
            textCount={textCount}
            imageCount={imageCount}
            fileCount={fileCount}
            htmlCount={htmlCount}
            total={entries.length}
          />
        )}

        {pinLimitReached && (
          <ToastNotification
            message="Max pins reached (10)"
            icon={<PinIcon size={13} />}
            duration={3000}
            onDismiss={() => setPinLimitReached(false)}
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
      </div>
    </div>
  );
};

export default App;

// Mount

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
