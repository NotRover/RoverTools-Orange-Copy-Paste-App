import { useMemo } from "react";

interface SelectableItem {
  id: string;
  pinned: boolean;
  groups: string[];
}

/**
 * Derived bulk-selection state shared by the clipboard and notes screens:
 * whether every selected item is pinned / saved, and the groups common to all
 * of them (for the bulk group-toggle UI). Memoised on the item list + selection.
 */
export function useSelectionSummary<T extends SelectableItem>(
  items: T[],
  selectedIds: Set<string>,
): { allPinned: boolean; allSaved: boolean; commonGroups: string[] } {
  return useMemo(() => {
    if (selectedIds.size === 0) {
      return { allPinned: false, allSaved: false, commonGroups: [] };
    }
    const selected = items.filter((i) => selectedIds.has(i.id));
    if (selected.length === 0) {
      return { allPinned: false, allSaved: false, commonGroups: [] };
    }
    const allPinned = selected.every((i) => i.pinned);
    const allSaved = selected.every((i) => i.groups.includes("Saved"));
    const commonGroups = [...new Set(selected[0].groups)].filter((g) =>
      selected.every((i) => i.groups.includes(g)),
    );
    return { allPinned, allSaved, commonGroups };
  }, [items, selectedIds]);
}
