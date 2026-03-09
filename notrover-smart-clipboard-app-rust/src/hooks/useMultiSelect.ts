import { useCallback, useRef, useState } from "react";

export interface MultiSelectState {
  /** Whether multi-select mode is active. */
  isSelecting: boolean;
  /** Set of currently selected entry IDs. */
  selectedIds: Set<string>;
  /** Number of selected entries. */
  selectedCount: number;

  /** Enter multi-select mode (triggered by long-press or Ctrl+click). */
  enterSelectMode: () => void;
  /** Exit multi-select mode and clear all selections. */
  exitSelectMode: () => void;

  /** Toggle a single entry's selection. Enters select mode if not already. */
  toggleSelect: (id: string) => void;
  /** Shift+click range selection between last toggle and the given id. */
  selectRange: (id: string, allIds: string[]) => void;
  /** Select all provided IDs. */
  selectAll: (ids: string[]) => void;
  /** Deselect all. */
  deselectAll: () => void;

  /** Remove IDs that no longer exist (call after delete/clear). */
  pruneStaleIds: (activeIds: Set<string>) => void;
}

export function useMultiSelect(): MultiSelectState {
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastToggledRef = useRef<string | null>(null);

  const enterSelectMode = useCallback(() => {
    setIsSelecting(true);
  }, []);

  const exitSelectMode = useCallback(() => {
    setIsSelecting(false);
    setSelectedIds(new Set());
    lastToggledRef.current = null;
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setIsSelecting(true);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastToggledRef.current = id;
  }, []);

  const selectRange = useCallback((id: string, allIds: string[]) => {
    setIsSelecting(true);
    const lastId = lastToggledRef.current;
    if (!lastId) {
      // No anchor — just toggle
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      lastToggledRef.current = id;
      return;
    }

    const lastIdx = allIds.indexOf(lastId);
    const currIdx = allIds.indexOf(id);
    if (lastIdx < 0 || currIdx < 0) {
      // Fallback: just toggle
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      lastToggledRef.current = id;
      return;
    }

    const start = Math.min(lastIdx, currIdx);
    const end = Math.max(lastIdx, currIdx);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (let i = start; i <= end; i++) {
        next.add(allIds[i]);
      }
      return next;
    });
    // Don't change anchor for range select — it stays at the original click
  }, []);

  const selectAll = useCallback((ids: string[]) => {
    setIsSelecting(true);
    setSelectedIds(new Set(ids));
  }, []);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
    lastToggledRef.current = null;
  }, []);

  const pruneStaleIds = useCallback((activeIds: Set<string>) => {
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (activeIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      if (!changed) return prev;
      if (next.size === 0) {
        setIsSelecting(false);
        lastToggledRef.current = null;
      }
      return next;
    });
  }, []);

  return {
    isSelecting,
    selectedIds,
    selectedCount: selectedIds.size,
    enterSelectMode,
    exitSelectMode,
    toggleSelect,
    selectRange,
    selectAll,
    deselectAll,
    pruneStaleIds,
  };
}
