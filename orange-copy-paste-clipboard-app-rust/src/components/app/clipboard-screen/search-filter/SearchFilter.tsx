import React, { useCallback, useMemo, useRef, useState } from "react";
import { ArrowDown } from "@phosphor-icons/react";
import type { ClipboardEntry, DisplayKind, Space } from "../../../../types";
import { useSticky, useStickySet } from "../../../../hooks/useSticky";
import {
  deriveDisplayKind,
  htmlPlainText,
  imageDisplayName,
} from "../../../../types";
import {
  TYPE_LABELS,
  PinIcon as PinIconElement,
} from "../../../entry-types/EntryTypePill";
import {
  SearchIcon,
  CloseIcon,
  FilterIcon,
  SearchXIcon,
  SaveStarIcon,
} from "../../../icons";
import {
  CardDivider,
  ChipRow,
  CloudSection,
  DateSection,
  FilterCardShell,
  FilterChip,
  GroupChips,
  SectionLabel,
  TypeGrid,
  dateWindow,
} from "./FilterParts";
import type {
  CloudFilter,
  CountMap,
  DatePreset,
  ShareFilter,
} from "./FilterParts";
import "./SearchFilter.css";

export type { CloudFilter, ShareFilter, DatePreset };

const ALL_DISPLAY_KINDS: DisplayKind[] = [
  "text",
  "url",
  "html",
  "image",
  "video",
  "document",
  "file",
  "folder",
];

/** The group that backs the Saved quick filter. Shown alongside Pinned rather
 *  than in the group list, because it is a system tag, not one you made. */
const SAVED_GROUP = "Saved";

function entryText(entry: ClipboardEntry): string {
  if (entry.type === "html") return htmlPlainText(entry.content);
  if (entry.type === "image") return imageDisplayName(entry);
  return entry.content;
}

/** Case-insensitive matcher for one query, compiled once and reused.
 *
 *  The obvious `text.toLowerCase().includes(q)` allocates a full-length
 *  lowercased copy of every entry's content, and the predicate below runs over
 *  the whole history on each keystroke - then again per dimension for the
 *  option counts. A case-insensitive regexp scans the string in place instead,
 *  so a long entry costs no allocation at all. */
let matcherFor = "";
let matcher = /(?:)/;

function queryMatcher(q: string): RegExp {
  if (q !== matcherFor) {
    matcherFor = q;
    matcher = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  return matcher;
}

/** Matches content and group names, so a word that is a filter in one place
 *  is not invisible in the other. */
function matchesQuery(entry: ClipboardEntry, q: string): boolean {
  const re = queryMatcher(q);
  if (re.test(entryText(entry))) return true;
  return (entry.groups ?? []).some((g) => re.test(g));
}

// Hook

/** Cloud/space context the filters read. Supplied by the screen, which already
 *  holds these for the cards, so the hook stays free of Tauri calls. */
export interface CloudFilterContext {
  /** Entry keys (`"clipboard:{id}"`) with a copy on the server. */
  syncStates: Record<string, unknown>;
  /** Space ids per entry key. */
  shares: Record<string, string[]>;
  /** Entry keys another member wrote. */
  remoteKeys: Set<string>;
  /** Spaces this account belongs to, for the per-space rows. */
  spaces: Space[];
  /** False when no account is signed in, which hides the whole section. */
  signedIn: boolean;
}

/** Selections per section. The card's badge is their sum, so a section and the
 *  badge can never disagree. */
export interface SectionCounts {
  quick: number;
  kinds: number;
  cloud: number;
  groups: number;
  date: number;
}

/** What each option would leave you with: every other filter applied, that
 *  option's own dimension excluded. */
export interface OptionCounts {
  kinds: CountMap;
  groups: CountMap;
  spaces: CountMap;
  pinned: number;
  saved: number;
  received: number;
  inCloud: number;
  localOnly: number;
  shared: number;
  notShared: number;
}

/** Which dimension to leave out of a pass, when counting that dimension. */
type Dimension =
  | "pinned"
  | "saved"
  | "kinds"
  | "cloud"
  | "share"
  | "spaces"
  | "groups"
  | "received"
  | "date";

export interface SearchFilterState {
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  selectedKinds: Set<DisplayKind>;
  toggleKind: (k: DisplayKind) => void;
  pinnedOnly: boolean;
  setPinnedOnly: React.Dispatch<React.SetStateAction<boolean>>;
  datePreset: DatePreset;
  setDatePreset: (p: DatePreset) => void;
  dateAfter: string;
  setDateAfter: (v: string) => void;
  dateBefore: string;
  setDateBefore: (v: string) => void;
  filtersOpen: boolean;
  setFiltersOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectedFilterGroups: Set<string>;
  toggleFilterGroup: (g: string) => void;
  cloudFilter: CloudFilter;
  setCloudFilter: React.Dispatch<React.SetStateAction<CloudFilter>>;
  shareFilter: ShareFilter;
  setShareFilter: React.Dispatch<React.SetStateAction<ShareFilter>>;
  selectedSpaceIds: Set<string>;
  toggleSpaceFilter: (id: string) => void;
  receivedOnly: boolean;
  setReceivedOnly: React.Dispatch<React.SetStateAction<boolean>>;
  cloud: CloudFilterContext | null;
  sectionCounts: SectionCounts;
  activeFilterCount: number;
  optionCounts: OptionCounts;
  /** Active filters in plain words, for the strip and the empty state. */
  filterNames: string[];
  clearAllFilters: () => void;
  filteredEntries: ClipboardEntry[];
  totalCount: number;
  isFiltering: boolean;
  filterRef: React.RefObject<HTMLDivElement | null>;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

/** Every key a clipboard filter is stored under, listed next to the hooks that
 *  own them so a reset cannot fall behind a filter added later. */
const FILTER_KEYS = [
  "sc-f-search",
  "sc-f-cloud",
  "sc-f-share",
  "sc-f-spaces",
  "sc-f-received",
  "sc-f-kinds",
  "sc-f-pinned",
  "sc-f-date",
  "sc-f-date-after",
  "sc-f-date-before",
  "sc-f-groups",
] as const;

/** Point the clipboard screen at one set of kinds, for a caller that is about
 *  to navigate there.
 *
 *  Writes the storage the filters mount from rather than any live state: one
 *  screen is mounted at a time, so the clipboard screen does not exist yet and
 *  will read these on its way in. Everything else is cleared first - arriving
 *  with a stale date range still on would show a filtered slice of the thing
 *  the user just clicked a count of. */
export function showOnlyKinds(
  kinds: DisplayKind[],
  opts: { cloud?: CloudFilter } = {},
): void {
  try {
    for (const key of FILTER_KEYS) localStorage.removeItem(key);
    localStorage.setItem("sc-f-kinds", JSON.stringify(kinds));
    // A caller counting what is on the server wants the screen narrowed to
    // that, not to every local entry of the same kind.
    if (opts.cloud && opts.cloud !== "any") {
      localStorage.setItem("sc-f-cloud", JSON.stringify(opts.cloud));
    }
  } catch {
    /* Storage blocked: the screen opens unfiltered, which is not wrong. */
  }
}

export function useSearchFilter(
  entries: ClipboardEntry[],
  cloud: CloudFilterContext | null = null,
): SearchFilterState {
  // Every applied filter is sticky: the screen unmounts on a switch, and a
  // narrowed list silently going back to everything is worse than remembering
  // it - the chip row and Clear filters both say what is on. The dropdown
  // being open is not, since reopening itself on a return visit is not a
  // preference anyone expressed.
  const [searchQuery, setSearchQuery] = useSticky("sc-f-search", "");
  const [cloudFilter, setCloudFilter] = useSticky<CloudFilter>(
    "sc-f-cloud",
    "any",
  );
  const [shareFilter, setShareFilter] = useSticky<ShareFilter>(
    "sc-f-share",
    "any",
  );
  const [selectedSpaceIds, setSelectedSpaceIds] = useStickySet("sc-f-spaces");
  const [receivedOnly, setReceivedOnly] = useSticky("sc-f-received", false);
  const [selectedKinds, setSelectedKinds] = useStickySet<DisplayKind>(
    "sc-f-kinds",
  );
  const [pinnedOnly, setPinnedOnly] = useSticky("sc-f-pinned", false);
  const [datePreset, setDatePreset] = useSticky<DatePreset>("sc-f-date", "any");
  const [dateAfter, setDateAfter] = useSticky("sc-f-date-after", "");
  const [dateBefore, setDateBefore] = useSticky("sc-f-date-before", "");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedFilterGroups, setSelectedFilterGroups] =
    useStickySet("sc-f-groups");
  const filterRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const toggleKind = useCallback((k: DisplayKind) => {
    setSelectedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
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

  const toggleFilterGroup = useCallback((g: string) => {
    setSelectedFilterGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }, []);

  const savedOnly = selectedFilterGroups.has(SAVED_GROUP);

  /** Groups you made, without the system tag the Saved switch owns. */
  const userGroups = useMemo(() => {
    const next = new Set(selectedFilterGroups);
    next.delete(SAVED_GROUP);
    return next;
  }, [selectedFilterGroups]);

  const sectionCounts = useMemo<SectionCounts>(
    () => ({
      quick: (pinnedOnly ? 1 : 0) + (savedOnly ? 1 : 0) + (receivedOnly ? 1 : 0),
      kinds: selectedKinds.size,
      cloud: cloud?.signedIn
        ? (cloudFilter !== "any" ? 1 : 0) +
          (shareFilter !== "any" ? 1 : 0) +
          selectedSpaceIds.size
        : 0,
      groups: userGroups.size,
      date: datePreset === "any" ? 0 : 1,
    }),
    [
      pinnedOnly,
      savedOnly,
      receivedOnly,
      selectedKinds,
      cloud?.signedIn,
      cloudFilter,
      shareFilter,
      selectedSpaceIds,
      userGroups,
      datePreset,
    ],
  );

  const activeFilterCount = useMemo(
    () => Object.values(sectionCounts).reduce((a, b) => a + b, 0),
    [sectionCounts],
  );

  const clearAllFilters = useCallback(() => {
    setSelectedKinds(new Set());
    setPinnedOnly(false);
    setDatePreset("any");
    setDateAfter("");
    setDateBefore("");
    setSelectedFilterGroups(new Set());
    setCloudFilter("any");
    setShareFilter("any");
    setSelectedSpaceIds(new Set());
    setReceivedOnly(false);
  }, []);

  /** One predicate for the list and for every count. `skip` leaves a single
   *  dimension out, so a count reads as "what I get if I pick this" rather
   *  than "what is showing now". */
  const passes = useCallback(
    (e: ClipboardEntry, skip: Dimension | null): boolean => {
      if (skip !== "pinned" && pinnedOnly && !e.pinned) return false;
      if (skip !== "saved" && savedOnly && !e.groups?.includes(SAVED_GROUP))
        return false;
      if (skip !== "kinds" && selectedKinds.size > 0) {
        if (!selectedKinds.has(deriveDisplayKind(e))) return false;
      }
      if (skip !== "groups" && userGroups.size > 0) {
        if (!e.groups?.some((g) => userGroups.has(g))) return false;
      }
      if (skip !== "date") {
        const [from, to] = dateWindow(datePreset, dateAfter, dateBefore);
        if (e.timestamp < from || e.timestamp > to) return false;
      }
      // Cloud and space state is Rust-owned bookkeeping keyed by entry id,
      // not fields on the entry, so it all resolves through the same key.
      if (cloud) {
        const key = `clipboard:${e.id}`;
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
      if (searchQuery.trim() && !matchesQuery(e, searchQuery.trim()))
        return false;
      return true;
    },
    [
      pinnedOnly,
      savedOnly,
      selectedKinds,
      userGroups,
      datePreset,
      dateAfter,
      dateBefore,
      cloud,
      cloudFilter,
      shareFilter,
      selectedSpaceIds,
      receivedOnly,
      searchQuery,
    ],
  );

  const filteredEntries = useMemo(
    () => entries.filter((e) => passes(e, null)),
    [entries, passes],
  );

  const optionCounts = useMemo<OptionCounts>(() => {
    const pool = (skip: Dimension) => entries.filter((e) => passes(e, skip));
    const tally = <T extends string>(
      items: ClipboardEntry[],
      keys: T[],
      of: (e: ClipboardEntry) => T[] | T,
    ): CountMap => {
      const out: CountMap = {};
      for (const k of keys) out[k] = 0;
      for (const e of items) {
        const v = of(e);
        for (const k of Array.isArray(v) ? v : [v]) {
          if (k in out) out[k] += 1;
        }
      }
      return out;
    };

    const key = (e: ClipboardEntry) => `clipboard:${e.id}`;
    const spaceIds = (cloud?.spaces ?? []).map((s) => s.id);
    const groupNames = Array.from(
      new Set(entries.flatMap((e) => e.groups ?? [])),
    ).filter((g) => g !== SAVED_GROUP);

    const cloudPool = cloud ? pool("cloud") : [];
    const sharePool = cloud ? pool("share") : [];

    return {
      kinds: tally(pool("kinds"), ALL_DISPLAY_KINDS, deriveDisplayKind),
      groups: tally(pool("groups"), groupNames, (e) => e.groups ?? []),
      spaces: tally(pool("spaces"), spaceIds, (e) =>
        cloud ? (cloud.shares[key(e)] ?? []) : [],
      ),
      pinned: pool("pinned").filter((e) => e.pinned).length,
      saved: pool("saved").filter((e) => e.groups?.includes(SAVED_GROUP))
        .length,
      received: cloud
        ? pool("received").filter((e) => cloud.remoteKeys.has(key(e))).length
        : 0,
      inCloud: cloudPool.filter((e) => !!cloud?.syncStates[key(e)]).length,
      localOnly: cloudPool.filter((e) => !cloud?.syncStates[key(e)]).length,
      shared: sharePool.filter(
        (e) => (cloud?.shares[key(e)]?.length ?? 0) > 0,
      ).length,
      notShared: sharePool.filter(
        (e) => (cloud?.shares[key(e)]?.length ?? 0) === 0,
      ).length,
    };
  }, [entries, passes, cloud]);

  const filterNames = useMemo(() => {
    const out: string[] = [];
    if (pinnedOnly) out.push("Pinned");
    if (savedOnly) out.push("Saved");
    if (receivedOnly) out.push("From others");
    for (const k of ALL_DISPLAY_KINDS) {
      if (selectedKinds.has(k)) out.push(TYPE_LABELS[k]);
    }
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
    userGroups.forEach((g) => out.push(g));
    if (datePreset === "today") out.push("Today");
    if (datePreset === "7d") out.push("Last 7 days");
    if (datePreset === "range") out.push("Date range");
    return out;
  }, [
    pinnedOnly,
    savedOnly,
    receivedOnly,
    selectedKinds,
    cloud,
    cloudFilter,
    shareFilter,
    selectedSpaceIds,
    userGroups,
    datePreset,
  ]);

  const isFiltering = searchQuery.trim().length > 0 || activeFilterCount > 0;

  return {
    searchQuery,
    setSearchQuery,
    selectedKinds,
    toggleKind,
    pinnedOnly,
    setPinnedOnly,
    datePreset,
    setDatePreset,
    dateAfter,
    setDateAfter,
    dateBefore,
    setDateBefore,
    filtersOpen,
    setFiltersOpen,
    selectedFilterGroups,
    toggleFilterGroup,
    cloudFilter,
    setCloudFilter,
    shareFilter,
    setShareFilter,
    selectedSpaceIds,
    toggleSpaceFilter,
    receivedOnly,
    setReceivedOnly,
    cloud,
    sectionCounts,
    activeFilterCount,
    optionCounts,
    filterNames,
    clearAllFilters,
    filteredEntries,
    totalCount: entries.length,
    isFiltering,
    filterRef,
    searchInputRef,
  };
}

// Search bar component

interface SearchBarProps {
  sf: SearchFilterState;
}

export const SearchBar: React.FC<SearchBarProps> = ({ sf }) => (
  <div className="cs-searchbar">
    <SearchIcon size={13} className="cs-search-icon" />
    <input
      ref={sf.searchInputRef}
      type="text"
      className="cs-search-input"
      placeholder="Search..."
      value={sf.searchQuery}
      onChange={(e) => sf.setSearchQuery(e.target.value)}
    />
    {sf.searchQuery && (
      <button
        className="cs-search-clear"
        onClick={() => {
          sf.setSearchQuery("");
          sf.searchInputRef.current?.focus();
        }}
      >
        <CloseIcon size={9} />
      </button>
    )}
  </div>
);

// Filter dropdown component

interface FilterDropdownProps {
  sf: SearchFilterState;
  availableGroups: string[];
}

export const FilterDropdown: React.FC<FilterDropdownProps> = ({
  sf,
  availableGroups,
}) => {
  const groups = availableGroups.filter((g) => g !== SAVED_GROUP);

  const dateSection = (
    <DateSection
      preset={sf.datePreset}
      setPreset={sf.setDatePreset}
      after={sf.dateAfter}
      setAfter={sf.setDateAfter}
      before={sf.dateBefore}
      setBefore={sf.setDateBefore}
    />
  );

  const groupsSection = groups.length > 0 && (
    <div className="cs-card-section">
      <SectionLabel
        name="Groups"
        count={sf.sectionCounts.groups}
        hint="any group"
      />
      <GroupChips
        groups={groups}
        selected={sf.selectedFilterGroups}
        onToggle={sf.toggleFilterGroup}
        counts={sf.optionCounts.groups}
      />
    </div>
  );

  /* Only worth a second column when there is enough to put in it: signed out
     with no groups, the card has nothing to move over. */
  const splitColumns = !!sf.cloud?.signedIn || groups.length > 0;

  return (
    <div className="sort-dropdown" ref={sf.filterRef}>
      <button
        className={`cs-tb-btn${sf.filtersOpen ? " cs-tb-btn--open" : ""}`}
        onClick={() => {
          if (!sf.filtersOpen) document.dispatchEvent(new Event("tooltip:hide"));
          sf.setFiltersOpen((v) => !v);
        }}
        data-tooltip="Filters"
        data-tooltip-pos="below"
      >
        <FilterIcon size={12} />
        {sf.activeFilterCount > 0 && (
          <span className="cs-tb-badge">{sf.activeFilterCount}</span>
        )}
      </button>
      {sf.filtersOpen && (
        <FilterCardShell
          matched={sf.filteredEntries.length}
          total={sf.totalCount}
          activeCount={sf.activeFilterCount}
          onClear={sf.clearAllFilters}
          secondary={
            splitColumns ? (
              <>
                {/* Hidden entirely when signed out, where every answer is the
                    same. The column then holds groups and date alone. */}
                {sf.cloud?.signedIn && (
                  <CloudSection
                    spaces={sf.cloud.spaces}
                    cloudFilter={sf.cloudFilter}
                    setCloudFilter={sf.setCloudFilter}
                    shareFilter={sf.shareFilter}
                    setShareFilter={sf.setShareFilter}
                    selectedSpaceIds={sf.selectedSpaceIds}
                    toggleSpace={sf.toggleSpaceFilter}
                    count={sf.sectionCounts.cloud}
                    counts={{
                      inCloud: sf.optionCounts.inCloud,
                      localOnly: sf.optionCounts.localOnly,
                      shared: sf.optionCounts.shared,
                      notShared: sf.optionCounts.notShared,
                      spaces: sf.optionCounts.spaces,
                    }}
                  />
                )}

                {groupsSection && (
                  <>
                    <CardDivider />
                    {groupsSection}
                  </>
                )}
              </>
            ) : undefined
          }
        >
          {/* Quick: the one-off switches, which were split across two
              sections at opposite ends of the card. */}
          <div className="cs-card-section">
            <SectionLabel name="Quick" count={sf.sectionCounts.quick} />
            <ChipRow>
              <FilterChip
                label="Pinned"
                on={sf.pinnedOnly}
                onToggle={() => sf.setPinnedOnly((v) => !v)}
                count={sf.optionCounts.pinned}
                icon={PinIconElement}
              />
              <FilterChip
                label="Saved"
                on={sf.selectedFilterGroups.has(SAVED_GROUP)}
                onToggle={() => sf.toggleFilterGroup(SAVED_GROUP)}
                count={sf.optionCounts.saved}
                color={{ bg: "rgba(34, 197, 94, 0.16)", fg: "#22c55e" }}
                icon={<SaveStarIcon size={9} filled />}
              />
              {sf.cloud?.signedIn && (
                <FilterChip
                  label="From others"
                  on={sf.receivedOnly}
                  onToggle={() => sf.setReceivedOnly((v) => !v)}
                  count={sf.optionCounts.received}
                  icon={<ArrowDown size={10} weight="bold" />}
                />
              )}
            </ChipRow>
          </div>

          <CardDivider />
          <div className="cs-card-section">
            <SectionLabel
              name="Type"
              count={sf.sectionCounts.kinds}
              hint="all types"
            />
            <TypeGrid
              kinds={ALL_DISPLAY_KINDS}
              selected={sf.selectedKinds}
              onToggle={sf.toggleKind}
              counts={sf.optionCounts.kinds}
            />
          </div>

          <CardDivider />
          {dateSection}
        </FilterCardShell>
      )}
    </div>
  );
};

// No results component

interface NoResultsProps {
  sf: SearchFilterState;
}

export const NoResults: React.FC<NoResultsProps> = ({ sf }) => {
  const names = sf.filterNames.join(", ");
  return (
    <div className="cs-no-results">
      <SearchXIcon size={44} className="cs-no-results-icon" />
      <p className="cs-no-results-title">No results</p>
      <p className="cs-no-results-subtitle">
        {sf.searchQuery.trim() ? (
          <>
            Nothing matches &ldquo;{sf.searchQuery.trim()}&rdquo;
            {names ? <> with {names}</> : null}.
          </>
        ) : (
          <>No entries match {names || "the current filters"}.</>
        )}
      </p>
    </div>
  );
};
