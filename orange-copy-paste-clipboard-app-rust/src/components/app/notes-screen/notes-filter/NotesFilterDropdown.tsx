import React, { useCallback, useMemo, useRef, useState } from "react";
import { ArrowDown } from "@phosphor-icons/react";
import type { Note, Space } from "../../../../types";
import { useSticky, useStickySet } from "../../../../hooks/useSticky";
import { FilterIcon } from "../../../icons";
import { PinIcon as PinIconElement } from "../../../entry-types/EntryTypePill";
import {
  CardDivider,
  ChipRow,
  CloudSection,
  DateSection,
  FilterCardShell,
  FilterChip,
  GroupChips,
  SectionLabel,
  dateWindow,
} from "../../clipboard-screen/search-filter/FilterParts";
import type {
  CloudFilter,
  CountMap,
  DatePreset,
  ShareFilter,
} from "../../clipboard-screen/search-filter/FilterParts";
import { stripHtml } from "../notes-utils";
import "../../clipboard-screen/search-filter/SearchFilter.css";

/* Notes filter.
 *
 * Notes upload, sync and share to spaces exactly like clipboard entries - the
 * note card already draws those badges - so they get the same sections. Type
 * is the only one that does not apply: a note has one. */

/** Cloud/space context, same shape the clipboard screen builds. Keys here are
 *  `"note:{id}"`. */
export interface NotesCloudContext {
  syncStates: Record<string, unknown>;
  shares: Record<string, string[]>;
  remoteKeys: Set<string>;
  spaces: Space[];
  signedIn: boolean;
}

type Dimension =
  "pinned" | "cloud" | "share" | "spaces" | "groups" | "received" | "date";

interface NotesFilterState {
  pinnedOnly: boolean;
  setPinnedOnly: React.Dispatch<React.SetStateAction<boolean>>;
  selectedGroups: Set<string>;
  toggleGroup: (g: string) => void;
  cloudFilter: CloudFilter;
  setCloudFilter: React.Dispatch<React.SetStateAction<CloudFilter>>;
  shareFilter: ShareFilter;
  setShareFilter: React.Dispatch<React.SetStateAction<ShareFilter>>;
  selectedSpaceIds: Set<string>;
  toggleSpaceFilter: (id: string) => void;
  receivedOnly: boolean;
  setReceivedOnly: React.Dispatch<React.SetStateAction<boolean>>;
  datePreset: DatePreset;
  setDatePreset: (p: DatePreset) => void;
  dateAfter: string;
  setDateAfter: (v: string) => void;
  dateBefore: string;
  setDateBefore: (v: string) => void;
  cloud: NotesCloudContext | null;
  sectionCounts: { quick: number; cloud: number; groups: number; date: number };
  activeFilterCount: number;
  optionCounts: {
    groups: CountMap;
    spaces: CountMap;
    pinned: number;
    received: number;
    inCloud: number;
    localOnly: number;
    shared: number;
    notShared: number;
  };
  filterNames: string[];
  clearAll: () => void;
  filteredNotes: Note[];
  totalCount: number;
  isFiltering: boolean;
  filtersOpen: boolean;
  setFiltersOpen: React.Dispatch<React.SetStateAction<boolean>>;
  filterRef: React.RefObject<HTMLDivElement | null>;
}

export function useNotesFilter(
  notes: Note[],
  search: string,
  cloud: NotesCloudContext | null = null,
): NotesFilterState {
  // Sticky for the same reason as the clipboard filters, and with the same
  // exception: the dropdown itself does not reopen on a return visit.
  const [pinnedOnly, setPinnedOnly] = useSticky("ns-f-pinned", false);
  const [selectedGroups, setSelectedGroups] = useStickySet("ns-f-groups");
  const [cloudFilter, setCloudFilter] = useSticky<CloudFilter>(
    "ns-f-cloud",
    "any",
  );
  const [shareFilter, setShareFilter] = useSticky<ShareFilter>(
    "ns-f-share",
    "any",
  );
  const [selectedSpaceIds, setSelectedSpaceIds] = useStickySet("ns-f-spaces");
  const [receivedOnly, setReceivedOnly] = useSticky("ns-f-received", false);
  const [datePreset, setDatePreset] = useSticky<DatePreset>("ns-f-date", "any");
  const [dateAfter, setDateAfter] = useSticky("ns-f-date-after", "");
  const [dateBefore, setDateBefore] = useSticky("ns-f-date-before", "");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  const toggleGroup = useCallback((g: string) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }, []);

  const toggleSpaceFilter = useCallback((id: string) => {
    setSelectedSpaceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const sectionCounts = useMemo(
    () => ({
      quick: (pinnedOnly ? 1 : 0) + (receivedOnly ? 1 : 0),
      cloud: cloud?.signedIn
        ? (cloudFilter !== "any" ? 1 : 0) +
          (shareFilter !== "any" ? 1 : 0) +
          selectedSpaceIds.size
        : 0,
      groups: selectedGroups.size,
      date: datePreset === "any" ? 0 : 1,
    }),
    [
      pinnedOnly,
      receivedOnly,
      cloud?.signedIn,
      cloudFilter,
      shareFilter,
      selectedSpaceIds,
      selectedGroups,
      datePreset,
    ],
  );

  const activeFilterCount = useMemo(
    () => Object.values(sectionCounts).reduce((a, b) => a + b, 0),
    [sectionCounts],
  );

  const clearAll = useCallback(() => {
    setPinnedOnly(false);
    setSelectedGroups(new Set());
    setCloudFilter("any");
    setShareFilter("any");
    setSelectedSpaceIds(new Set());
    setReceivedOnly(false);
    setDatePreset("any");
    setDateAfter("");
    setDateBefore("");
  }, []);

  const passes = useCallback(
    (n: Note, skip: Dimension | null): boolean => {
      if (skip !== "pinned" && pinnedOnly && !n.pinned) return false;
      if (skip !== "groups" && selectedGroups.size > 0) {
        if (!n.groups.some((g) => selectedGroups.has(g))) return false;
      }
      if (skip !== "date") {
        const [from, to] = dateWindow(datePreset, dateAfter, dateBefore);
        if (n.updated_at < from || n.updated_at > to) return false;
      }
      if (cloud) {
        const key = `note:${n.id}`;
        if (skip !== "cloud" && cloudFilter !== "any") {
          if (!!cloud.syncStates[key] !== (cloudFilter === "in")) return false;
        }
        if (skip !== "share" && shareFilter !== "any") {
          const shared = (cloud.shares[key]?.length ?? 0) > 0;
          if (shared !== (shareFilter === "shared")) return false;
        }
        if (skip !== "spaces" && selectedSpaceIds.size > 0) {
          const ids = cloud.shares[key] ?? [];
          if (!ids.some((id) => selectedSpaceIds.has(id))) return false;
        }
        if (skip !== "received" && receivedOnly && !cloud.remoteKeys.has(key))
          return false;
      }
      const q = search.trim().toLowerCase();
      if (q) {
        const hit =
          n.title.toLowerCase().includes(q) ||
          stripHtml(n.content).toLowerCase().includes(q) ||
          n.groups.some((g) => g.toLowerCase().includes(q));
        if (!hit) return false;
      }
      return true;
    },
    [
      pinnedOnly,
      selectedGroups,
      datePreset,
      dateAfter,
      dateBefore,
      cloud,
      cloudFilter,
      shareFilter,
      selectedSpaceIds,
      receivedOnly,
      search,
    ],
  );

  const filteredNotes = useMemo(
    () => notes.filter((n) => passes(n, null)),
    [notes, passes],
  );

  const optionCounts = useMemo(() => {
    const pool = (skip: Dimension) => notes.filter((n) => passes(n, skip));
    const key = (n: Note) => `note:${n.id}`;
    const tally = (
      items: Note[],
      keys: string[],
      of: (n: Note) => string[],
    ) => {
      const out: CountMap = {};
      for (const k of keys) out[k] = 0;
      for (const n of items) {
        for (const k of of(n)) if (k in out) out[k] += 1;
      }
      return out;
    };

    const groupNames = Array.from(new Set(notes.flatMap((n) => n.groups)));
    const spaceIds = (cloud?.spaces ?? []).map((s) => s.id);
    const cloudPool = cloud ? pool("cloud") : [];
    const sharePool = cloud ? pool("share") : [];

    return {
      groups: tally(pool("groups"), groupNames, (n) => n.groups),
      spaces: tally(pool("spaces"), spaceIds, (n) =>
        cloud ? (cloud.shares[key(n)] ?? []) : [],
      ),
      pinned: pool("pinned").filter((n) => n.pinned).length,
      received: cloud
        ? pool("received").filter((n) => cloud.remoteKeys.has(key(n))).length
        : 0,
      inCloud: cloudPool.filter((n) => !!cloud?.syncStates[key(n)]).length,
      localOnly: cloudPool.filter((n) => !cloud?.syncStates[key(n)]).length,
      shared: sharePool.filter((n) => (cloud?.shares[key(n)]?.length ?? 0) > 0)
        .length,
      notShared: sharePool.filter(
        (n) => (cloud?.shares[key(n)]?.length ?? 0) === 0,
      ).length,
    };
  }, [notes, passes, cloud]);

  const filterNames = useMemo(() => {
    const out: string[] = [];
    if (pinnedOnly) out.push("Pinned");
    if (receivedOnly) out.push("From others");
    if (cloud?.signedIn) {
      if (cloudFilter !== "any") {
        out.push(cloudFilter === "in" ? "In cloud" : "Local only");
      }
      if (shareFilter !== "any") {
        out.push(shareFilter === "shared" ? "In a space" : "Not shared");
      }
      for (const s of cloud.spaces) {
        if (selectedSpaceIds.has(s.id)) out.push(s.name);
      }
    }
    selectedGroups.forEach((g) => out.push(g));
    if (datePreset === "today") out.push("Today");
    if (datePreset === "7d") out.push("Last 7 days");
    if (datePreset === "range") out.push("Date range");
    return out;
  }, [
    pinnedOnly,
    receivedOnly,
    cloud,
    cloudFilter,
    shareFilter,
    selectedSpaceIds,
    selectedGroups,
    datePreset,
  ]);

  return {
    pinnedOnly,
    setPinnedOnly,
    selectedGroups,
    toggleGroup,
    cloudFilter,
    setCloudFilter,
    shareFilter,
    setShareFilter,
    selectedSpaceIds,
    toggleSpaceFilter,
    receivedOnly,
    setReceivedOnly,
    datePreset,
    setDatePreset,
    dateAfter,
    setDateAfter,
    dateBefore,
    setDateBefore,
    cloud,
    sectionCounts,
    activeFilterCount,
    optionCounts,
    filterNames,
    clearAll,
    filteredNotes,
    totalCount: notes.length,
    isFiltering: search.trim().length > 0 || activeFilterCount > 0,
    filtersOpen,
    setFiltersOpen,
    filterRef,
  };
}

// ── Notes Filter Dropdown Component ──────────────────────────────────

interface NotesFilterDropdownProps {
  nf: NotesFilterState;
  availableGroups: string[];
}

const NotesFilterDropdown: React.FC<NotesFilterDropdownProps> = ({
  nf,
  availableGroups,
}) => {
  const dateSection = (
    <DateSection
      preset={nf.datePreset}
      setPreset={nf.setDatePreset}
      after={nf.dateAfter}
      setAfter={nf.setDateAfter}
      before={nf.dateBefore}
      setBefore={nf.setDateBefore}
    />
  );

  return (
    <div className="sort-dropdown" ref={nf.filterRef}>
      <button
        className={`cs-tb-btn${nf.filtersOpen ? " cs-tb-btn--open" : ""}`}
        onClick={() => {
          if (!nf.filtersOpen)
            document.dispatchEvent(new Event("tooltip:hide"));
          nf.setFiltersOpen((v) => !v);
        }}
        data-tooltip="Filters"
        data-tooltip-pos="below"
      >
        <FilterIcon size={12} />
        {nf.activeFilterCount > 0 && (
          <span className="cs-tb-badge">{nf.activeFilterCount}</span>
        )}
      </button>
      {nf.filtersOpen && (
        <FilterCardShell
          matched={nf.filteredNotes.length}
          total={nf.totalCount}
          activeCount={nf.activeFilterCount}
          onClear={nf.clearAll}
          compact
          /* Cloud is the tall section, so it takes the second column on its own
           with the short date row under it; the groups chips balance it in
           the first. Signed out there is no cloud, so it stays one column. */
          secondary={
            nf.cloud?.signedIn ? (
              <>
                <CloudSection
                  spaces={nf.cloud.spaces}
                  cloudFilter={nf.cloudFilter}
                  setCloudFilter={nf.setCloudFilter}
                  shareFilter={nf.shareFilter}
                  setShareFilter={nf.setShareFilter}
                  selectedSpaceIds={nf.selectedSpaceIds}
                  toggleSpace={nf.toggleSpaceFilter}
                  count={nf.sectionCounts.cloud}
                  counts={{
                    inCloud: nf.optionCounts.inCloud,
                    localOnly: nf.optionCounts.localOnly,
                    shared: nf.optionCounts.shared,
                    notShared: nf.optionCounts.notShared,
                    spaces: nf.optionCounts.spaces,
                  }}
                />

                <CardDivider />
                {dateSection}
              </>
            ) : undefined
          }
        >
          <div className="cs-card-section">
            <SectionLabel name="Quick" count={nf.sectionCounts.quick} />
            <ChipRow>
              <FilterChip
                label="Pinned"
                on={nf.pinnedOnly}
                onToggle={() => nf.setPinnedOnly((v) => !v)}
                count={nf.optionCounts.pinned}
                icon={PinIconElement}
              />
              {nf.cloud?.signedIn && (
                <FilterChip
                  label="From others"
                  on={nf.receivedOnly}
                  onToggle={() => nf.setReceivedOnly((v) => !v)}
                  count={nf.optionCounts.received}
                  icon={<ArrowDown size={10} weight="bold" />}
                />
              )}
            </ChipRow>
          </div>

          {availableGroups.length > 0 && (
            <>
              <CardDivider />
              <div className="cs-card-section">
                <SectionLabel
                  name="Groups"
                  count={nf.sectionCounts.groups}
                  hint="any group"
                />
                <GroupChips
                  groups={availableGroups}
                  selected={nf.selectedGroups}
                  onToggle={nf.toggleGroup}
                  counts={nf.optionCounts.groups}
                />
              </div>
            </>
          )}

          {/* One column: date has nowhere else to go. */}
          {!nf.cloud?.signedIn && (
            <>
              <CardDivider />
              {dateSection}
            </>
          )}
        </FilterCardShell>
      )}
    </div>
  );
};

export default NotesFilterDropdown;
