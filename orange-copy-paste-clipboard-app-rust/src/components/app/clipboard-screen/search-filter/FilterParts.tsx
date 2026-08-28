import { sharedNow } from "../../../../clock";
import React from "react";
import { ShareNetwork, CloudCheck, CloudSlash } from "@phosphor-icons/react";
import type { DisplayKind, Space } from "../../../../types";
import { groupColor } from "../../../../types";
import { TYPE_ICONS, TYPE_LABELS } from "../../../entry-types/EntryTypePill";
import { CloseIcon, FilterIcon } from "../../../icons";
import "./SearchFilter.css";

/* Shared filter parts.
 *
 * Every screen that filters - clipboard, notes, and a space's send rules -
 * draws the same sections, so they live here rather than three times over.
 * These are dumb renderers on purpose: each screen counts its own items,
 * because the thing being counted differs (entries, notes, or what a rule
 * would catch), and only the numbers are shared shapes. */

/** A count per option value, for the option counts these parts render. */
export type CountMap = Record<string, number>;

/* ── Chip ─────────────────────────────────────────────────────────────
 * One picker shape for quick toggles, spaces and groups. Squircle, on the
 * theme's radius scale - a fully round pill reads as a different family
 * from the app's cards and buttons. */

interface FilterChipProps {
  label: string;
  on: boolean;
  onToggle: () => void;
  /** Omit for a chip whose count would be noise rather than help. */
  count?: number;
  icon?: React.ReactNode;
  /** Selected colours. Defaults to the accent. */
  color?: { bg: string; fg: string };
  title?: string;
}

export const FilterChip: React.FC<FilterChipProps> = ({
  label,
  on,
  onToggle,
  count,
  icon,
  color,
  title,
}) => {
  const dead = count === 0 && !on;
  const tint = color ?? {
    bg: "var(--accent-dim-strong)",
    fg: "var(--accent)",
  };
  return (
    <button
      type="button"
      className={`cs-chip${on ? " cs-chip--on" : ""}${dead ? " cs-chip--dead" : ""}`}
      style={on ? { background: tint.bg, color: tint.fg } : undefined}
      onClick={onToggle}
      title={title}
    >
      {icon}
      {label}
      {count !== undefined && <span className="cs-chip-count">{count}</span>}
    </button>
  );
};

export const ChipRow: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => <div className="cs-chip-row">{children}</div>;

/* ── Section label ── */

interface SectionLabelProps {
  name: string;
  /** Number of selections in this section. Sections count selections, not
   *  dimensions, so the card's badge is their exact sum. */
  count?: number;
  /** Shown in place of a count when the section is neutral, for sections
   *  where "off" needs saying ("all types", "any time"). */
  hint?: string;
}

export const SectionLabel: React.FC<SectionLabelProps> = ({
  name,
  count = 0,
  hint,
}) => (
  <div className="cs-section-label">
    {name}
    {count > 0 && <span className="cs-count">{count}</span>}
    {count === 0 && hint && <span className="cs-section-hint">{hint}</span>}
  </div>
);

export const CardDivider: React.FC = () => <div className="cs-card-divider" />;

/* ── Card shell ───────────────────────────────────────────────────────
 * A header that does not move, holding the one number a filter exists to
 * produce.
 *
 * The card does not scroll. A filter list you have to scroll cannot be read
 * at a glance, which is the only thing it is for - so when one column would
 * run long, the card widens into two rather than growing taller. Pass
 * `secondary` for the second column; screens with few sections leave it out
 * and stay one column wide. */

interface FilterCardShellProps {
  /** How many items survive the filters. */
  matched: number;
  total: number;
  /** Sum of the section counts; drives whether Clear is live. */
  activeCount: number;
  onClear: () => void;
  children: React.ReactNode;
  /** Second column. Its presence is what widens the card. */
  secondary?: React.ReactNode;
  /** Narrower two-column card with even columns, for a screen without the
   *  type grid - the widest thing a column has to hold. */
  compact?: boolean;
}

export const FilterCardShell: React.FC<FilterCardShellProps> = ({
  matched,
  total,
  activeCount,
  onClear,
  children,
  secondary,
  compact,
}) => (
  <div
    className={`cs-filter-card cs-filter-card--shell${
      secondary ? " cs-filter-card--wide" : ""
    }${secondary && compact ? " cs-filter-card--compact" : ""}`}
  >
    <div className="cs-card-head">
      <FilterIcon size={12} className="cs-card-head-icon" />
      <span className="cs-card-title">Filters</span>
      <span className="cs-card-result">
        <b>{matched}</b> of {total}
      </span>
      <button
        className="cs-card-head-clear"
        onClick={onClear}
        disabled={activeCount === 0}
      >
        Clear
      </button>
    </div>
    <div className="cs-card-body">
      <div className="cs-card-col">{children}</div>
      {secondary && <div className="cs-card-col">{secondary}</div>}
    </div>
  </div>
);

/* ── Type grid ────────────────────────────────────────────────────────
 * The existing two-column checkbox grid, plus the count that turns a row
 * from a guess into a decision. */

interface TypeGridProps {
  kinds: readonly DisplayKind[];
  selected: Set<DisplayKind>;
  onToggle: (k: DisplayKind) => void;
  /** Per-kind counts. Omit to render the grid without them. */
  counts?: CountMap;
  /** Kinds that cannot be toggled right now, with the reason. Used where an
   *  empty selection has no meaning, to keep the last tick from coming off. */
  locked?: { has: (k: DisplayKind) => boolean; reason: string };
}

export const TypeGrid: React.FC<TypeGridProps> = ({
  kinds,
  selected,
  onToggle,
  counts,
  locked,
}) => (
  <div className="cs-type-grid">
    {kinds.map((k) => {
      const on = selected.has(k);
      const n = counts?.[k];
      const held = locked?.has(k) ?? false;
      return (
        <label
          key={k}
          className={`cs-type-option${on ? " cs-type-option--on" : ""}${
            n === 0 && !on ? " cs-type-option--dead" : ""
          }`}
          title={held ? locked?.reason : undefined}
        >
          <input
            type="checkbox"
            checked={on}
            disabled={held}
            onChange={() => onToggle(k)}
            className="cs-type-cb"
          />
          <span className={`cs-type-icon type-pill type-pill--${k}`}>
            {TYPE_ICONS[k]}
          </span>
          <span className="cs-type-name">{TYPE_LABELS[k]}</span>
          {n !== undefined && <span className="cs-option-count">{n}</span>}
        </label>
      );
    })}
  </div>
);

/* ── Groups ── */

interface GroupChipsProps {
  groups: string[];
  selected: Set<string>;
  onToggle: (g: string) => void;
  counts?: CountMap;
  /** Chip placed before the groups, for a screen that needs the neutral
   *  state to be visible rather than implied by an empty selection. */
  leading?: React.ReactNode;
}

export const GroupChips: React.FC<GroupChipsProps> = ({
  groups,
  selected,
  onToggle,
  counts,
  leading,
}) => (
  <ChipRow>
    {leading}
    {groups.map((g) => {
      const c = groupColor(g);
      return (
        <FilterChip
          key={g}
          label={g}
          on={selected.has(g)}
          onToggle={() => onToggle(g)}
          count={counts?.[g]}
          color={c}
          icon={
            <span className="cs-chip-dot" style={{ background: c.fg }} />
          }
        />
      );
    })}
  </ChipRow>
);

/* ── Cloud ────────────────────────────────────────────────────────────
 * Three-way segments rather than checkbox pairs: the two states are
 * opposites, so asking for both at once can only ever return nothing. */

/** Server-copy filter: either state, only uploaded, or only local. */
export type CloudFilter = "any" | "in" | "out";
/** Sharing filter: either state, in at least one space, or in none. */
export type ShareFilter = "any" | "shared" | "private";

interface CloudSectionProps {
  spaces: Space[];
  cloudFilter: CloudFilter;
  setCloudFilter: (v: CloudFilter) => void;
  shareFilter: ShareFilter;
  setShareFilter: (v: ShareFilter) => void;
  selectedSpaceIds: Set<string>;
  toggleSpace: (id: string) => void;
  count: number;
  /** Counts for the segment options and per space. */
  counts?: {
    inCloud?: number;
    localOnly?: number;
    shared?: number;
    notShared?: number;
    spaces?: CountMap;
  };
}

export const CloudSection: React.FC<CloudSectionProps> = ({
  spaces,
  cloudFilter,
  setCloudFilter,
  shareFilter,
  setShareFilter,
  selectedSpaceIds,
  toggleSpace,
  count,
  counts,
}) => (
  <div className="cs-card-section">
    <SectionLabel name="Cloud" count={count} />

    <div className="cs-seg">
      <button
        className={`cs-seg-btn${cloudFilter === "any" ? " cs-seg-btn--on" : ""}`}
        onClick={() => setCloudFilter("any")}
      >
        Any
      </button>
      <button
        className={`cs-seg-btn${cloudFilter === "in" ? " cs-seg-btn--on" : ""}`}
        onClick={() => setCloudFilter(cloudFilter === "in" ? "any" : "in")}
      >
        <CloudCheck size={11} />
        In cloud
        {counts?.inCloud !== undefined && (
          <span className="cs-seg-count">{counts.inCloud}</span>
        )}
      </button>
      <button
        className={`cs-seg-btn${cloudFilter === "out" ? " cs-seg-btn--on" : ""}`}
        onClick={() => setCloudFilter(cloudFilter === "out" ? "any" : "out")}
      >
        <CloudSlash size={11} />
        Local
        {counts?.localOnly !== undefined && (
          <span className="cs-seg-count">{counts.localOnly}</span>
        )}
      </button>
    </div>

    {/* With no spaces, "In a space" and "Not shared" are the same set - the
        same reason the whole section is hidden when signed out. */}
    {spaces.length > 0 && (
      <>
        <div className="cs-seg">
          <button
            className={`cs-seg-btn${shareFilter === "any" ? " cs-seg-btn--on" : ""}`}
            onClick={() => setShareFilter("any")}
          >
            Any
          </button>
          <button
            className={`cs-seg-btn${shareFilter === "shared" ? " cs-seg-btn--on" : ""}`}
            onClick={() =>
              setShareFilter(shareFilter === "shared" ? "any" : "shared")
            }
          >
            <ShareNetwork size={11} />
            In a space
            {counts?.shared !== undefined && (
              <span className="cs-seg-count">{counts.shared}</span>
            )}
          </button>
          <button
            className={`cs-seg-btn${shareFilter === "private" ? " cs-seg-btn--on" : ""}`}
            onClick={() =>
              setShareFilter(shareFilter === "private" ? "any" : "private")
            }
          >
            Not shared
            {counts?.notShared !== undefined && (
              <span className="cs-seg-count">{counts.notShared}</span>
            )}
          </button>
        </div>

        <ChipRow>
          {spaces.map((s) => (
            <FilterChip
              key={s.id}
              label={s.name}
              on={selectedSpaceIds.has(s.id)}
              onToggle={() => toggleSpace(s.id)}
              count={counts?.spaces?.[s.id]}
              icon={<ShareNetwork size={10} />}
            />
          ))}
        </ChipRow>
      </>
    )}
  </div>
);

/* ── Date ─────────────────────────────────────────────────────────────
 * Presets, with Range revealing the two inputs. "Any time" is the default
 * so the neutral state reads as the absence of a filter - the old default
 * pre-filled today, which silently hid everything copied after midnight. */

export type DatePreset = "any" | "today" | "7d" | "range";

const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: "any", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "range", label: "Range" },
];

interface DateSectionProps {
  preset: DatePreset;
  setPreset: (p: DatePreset) => void;
  after: string;
  setAfter: (v: string) => void;
  before: string;
  setBefore: (v: string) => void;
}

export const DateSection: React.FC<DateSectionProps> = ({
  preset,
  setPreset,
  after,
  setAfter,
  before,
  setBefore,
}) => (
  <div className="cs-card-section">
    <SectionLabel
      name="Date"
      count={preset === "any" ? 0 : 1}
      hint="any time"
    />
    <div className="cs-seg">
      {DATE_PRESETS.map((p) => (
        <button
          key={p.value}
          className={`cs-seg-btn${preset === p.value ? " cs-seg-btn--on" : ""}`}
          onClick={() => setPreset(p.value)}
        >
          {p.label}
        </button>
      ))}
    </div>
    {preset === "range" && (
      <div className="cs-date-row">
        <input
          type="date"
          className="cs-date-input"
          value={after}
          onChange={(e) => setAfter(e.target.value)}
          title="After"
        />
        <span className="cs-date-sep">-</span>
        <input
          type="date"
          className="cs-date-input"
          value={before}
          onChange={(e) => setBefore(e.target.value)}
          title="Before"
        />
      </div>
    )}
  </div>
);

/** The window a preset means, as `[after, before]` timestamps. */
export function dateWindow(
  preset: DatePreset,
  after: string,
  before: string,
): [number, number] {
  if (preset === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return [d.getTime(), Infinity];
  }
  if (preset === "7d") return [sharedNow() - 7 * 86400000, Infinity];
  if (preset === "range") {
    return [
      after ? new Date(after + "T00:00:00").getTime() : -Infinity,
      before ? new Date(before + "T23:59:59.999").getTime() : Infinity,
    ];
  }
  return [-Infinity, Infinity];
}

/* ── Active filter strip ──────────────────────────────────────────────
 * The card is a dropdown, so once it closes a badge is all that is left,
 * and a badge can only say how many filters are on. This says which. */

interface ActiveFilterStripProps {
  names: string[];
  matched: number;
  total: number;
  onClear: () => void;
}

export const ActiveFilterStrip: React.FC<ActiveFilterStripProps> = ({
  names,
  matched,
  total,
  onClear,
}) => {
  if (names.length === 0) return null;
  return (
    <div className="cs-filter-strip">
      <FilterIcon size={10} className="cs-filter-strip-icon" />
      <span>
        Showing{" "}
        <span className="cs-filter-strip-count">
          {matched} of {total}
        </span>
      </span>
      <span className="cs-filter-strip-names">{names.join(", ")}</span>
      <button className="cs-filter-strip-clear" onClick={onClear}>
        <CloseIcon size={8} />
        Clear
      </button>
    </div>
  );
};
