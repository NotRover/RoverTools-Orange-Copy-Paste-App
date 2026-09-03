import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ClipboardEntry,
  DisplayKind,
  Note,
  DeletedMarker,
  SendFilter,
  PendingJoin,
  Space,
  SpaceJoinRequest,
  SpaceMember,
  SyncInvite,
  SyncInviteList,
} from "../../../types";
import {
  timeAgo,
  truncateText,
  htmlPlainText,
  htmlFragment,
  resolveImageSrc,
  filePaths,
  fileNameFromPath,
  deriveDisplayKind,
  fileCount,
  groupColor,
} from "../../../types";
import { UserAvatar } from "../../UserAvatar";
import { EntryTypePill, TYPE_LABELS } from "../../entry-types/EntryTypePill";
import Topbar, { SortDropdown, LayoutSegment } from "../topbar/Topbar";
import {
  CheckIcon,
  MultiSelectIcon,
  RowsIcon,
  TrashIcon,
} from "../../icons";
import { useMultiSelect } from "../../../hooks/useMultiSelect";
import { timeAgoFor } from "../../../hooks/useRelativeTime";
import {
  CommentsProvider,
  useCommentPopover,
} from "./comments/CommentPopover";
import {
  commentKey,
  useCommentCounts,
  type CommentMark,
} from "./comments/useCommentCounts";
import BulkActionsBar from "../clipboard-screen/bulk-actions/BulkActionsBar";
import type { ClipboardLayout } from "../topbar/Topbar";
import type { SortMode } from "../sort-options";
import "../clipboard-screen/search-filter/SearchFilter.css";
import {
  ActiveFilterStrip,
  CardDivider,
  ChipRow,
  DateSection,
  FilterCardShell,
  FilterChip,
  GroupChips,
  OwnerChips,
  SectionLabel,
  TypeGrid,
  dateWindow,
} from "../clipboard-screen/search-filter/FilterParts";
import type {
  CountMap,
  DatePreset,
  OwnerFilter,
} from "../clipboard-screen/search-filter/FilterParts";
import {
  Plus,
  Key,
  Users,
  ShareNetwork,
  X,
  Check,
  ChatCircle,
  Copy,
  CaretDown,
  Prohibit,
  Circle,
  Note as NoteIcon,
  File,
  MagnifyingGlass,
  Clipboard,
  Funnel,
  PushPin,
  ArrowsOutSimple,
  SquaresFour,
  ArrowDownLeft,
  ArrowUpRight,
  LockSimple as LockSimpleIcon,
} from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import "../card-menu/CardMenu.css";
import {
  deferDestructive,
  showToast,
  toastError,
} from "../toast/toastBus";
import { usePendingRemovals } from "../../../hooks/pendingRemoval";
import ConfirmDeleteDialog from "../../common/ConfirmDeleteDialog";
import {
  shouldConfirmSpaceRemove,
  disableSpaceRemoveConfirm,
} from "../../../confirmDelete";
import {
  NETWORK_REFOCUS_MS,
  useWindowRefocus,
} from "../../../hooks/useWindowRefocus";
import { useSticky, useStickySet } from "../../../hooks/useSticky";
import NotionPreview from "../notes-screen/editor-engine/NotionPreview";
import { deriveNoteTitle } from "../notes-screen/notes-utils";
import "../notes-screen/note-card/note-card.css";
import "../clipboard-screen/entry-card/EntryCard.css";
// An opened item wears the shared reading bar, and an opened note wears the
// notes editor's chrome on top of it, so a shared note reads like a note.
import {
  ToolbarCopyButton,
  ToolbarFacts,
  ToolbarMoreButton,
  ViewToolbar,
  useCloseOnEscape,
  useToolbarMenu,
} from "../view-toolbar/ViewToolbar";
import {
  EntryBody,
  EntryViewControls,
  absoluteTime,
  useCopyFlash,
  useEntryView,
  useEntryViewKeys,
} from "./expanded-entry";
import "../notes-screen/note-editor/note-editor.css";
import InvitesPopover from "./invites/InvitesPopover";
import "./SpacesScreen.css";

// ── Types ─────────────────────────────────────────────────────────────

type FeedFilter = "all" | "clipboard" | "notes";
type FeedItem =
  | { kind: "clipboard"; entry: ClipboardEntry }
  | { kind: "note"; note: Note }
  /** A tombstone the feed still shows. Carries no content — that is the point. */
  | { kind: "removed"; key: string; marker: DeletedMarker };

/** A feed item that still has content, which is everything but a placeholder. */
type ContentFeedItem = Exclude<FeedItem, { kind: "removed" }>;

/** A feed key ("clipboard:<id>") back into the pair the commands take. */
function splitFeedKey(key: string): ["clipboard" | "note", string] {
  const at = key.indexOf(":");
  return [key.slice(0, at) as "clipboard" | "note", key.slice(at + 1)];
}

/** When a feed item happened, which is what sorts it and which day it lands
 *  under. A placeholder takes the time of the item it stands for, so it sits
 *  where the item sat: keyed on the removal it appeared under whatever day it
 *  was taken down, in a date group of its own, with nothing around it to say
 *  what it referred to. Older records kept no item time, and fall back. */
const feedTimestamp = (item: FeedItem): number =>
  item.kind === "clipboard"
    ? item.entry.timestamp
    : item.kind === "note"
      ? item.note.updated_at
      : (item.marker.entry_ts ?? item.marker.deleted_at);

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

const CONTENT_OPTIONS: { value: SendFilter["content"]; label: string }[] = [
  { value: "clipboard", label: "Clipboard" },
  { value: "notes", label: "Notes" },
  { value: "both", label: "Both" },
];

const AVATAR_PALETTE = [
  "#ff3e1c",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
];

function spaceAvatarColor(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

/** Show an invite code as XXXX-XXXX when it is a plain 8-char code. */
function formatInviteCode(code: string): string {
  const c = code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : code;
}

const DEFAULT_FILTER: SendFilter = {
  enabled: false,
  kinds: [],
  groups: [],
  content: "both",
};

/** How many narrowing rules a filter carries, for the header badge. Being
 *  switched on is not itself a rule: on with nothing set means "share
 *  everything", which is zero narrowing, not one. */
function filterRuleCount(f: SendFilter | undefined): number {
  if (!f?.enabled) return 0;
  let n = 0;
  if (f.content !== "both") n++;
  if (f.kinds.length > 0) n++;
  if (f.groups.length > 0) n++;
  return n;
}

// ── Helpers ───────────────────────────────────────────────────────────

function extractNoteText(content: string): string {
  if (!content) return "";
  try {
    const doc = JSON.parse(content) as { type?: string; content?: unknown[] };
    if (doc.type === "doc") {
      const texts: string[] = [];
      const walk = (node: { text?: string; content?: unknown[] }) => {
        if (typeof node.text === "string") texts.push(node.text);
        if (Array.isArray(node.content))
          node.content.forEach((n) => walk(n as typeof node));
      };
      walk(doc as { text?: string; content?: unknown[] });
      return texts.join(" ").replace(/\s+/g, " ").trim();
    }
  } catch {
    /* legacy HTML */
  }
  return content
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Placeholders are excluded by the caller: there is no content to match. */
function matchesSearch(item: ContentFeedItem, q: string): boolean {
  const lower = q.toLowerCase();
  if (item.kind === "clipboard") {
    const { entry } = item;
    if (entry.type === "text")
      return entry.content.toLowerCase().includes(lower);
    if (entry.type === "html")
      return htmlPlainText(entry.content).toLowerCase().includes(lower);
    if (entry.type === "file")
      return entry.content.toLowerCase().includes(lower);
    return false;
  }
  return (
    item.note.title.toLowerCase().includes(lower) ||
    extractNoteText(item.note.content).toLowerCase().includes(lower)
  );
}

// ── Feed context menu ─────────────────────────────────────────────────

interface MenuPos {
  x: number;
  y: number;
}

const FeedCardMenu: React.FC<{
  pos: MenuPos | null;
  onClose: () => void;
  copied: boolean;
  onCopy?: () => void;
  /** Absent on the panel that already has the item open. */
  onOpen?: () => void;
  /** Owner-only takedown. Absent for members, who cannot moderate. */
  onRemove?: () => void;
  /** Drop this device's copy of an item a member shared. Present only on
   *  received items - deleting your own copy would tombstone it for everyone,
   *  which is what "Remove from space" is for. */
  onDeleteForMe?: () => void;
  /** Treat `pos.x` as the menu's right edge, not its left. For a menu hung off
   *  a toolbar button, where opening rightwards would cross into the rules
   *  column instead of staying over the panel the button is on. */
  alignRight?: boolean;
}> = ({
  pos,
  onClose,
  copied,
  onCopy,
  onOpen,
  onRemove,
  onDeleteForMe,
  alignRight,
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onEsc);
    };
  }, [pos, onClose]);

  // Before paint, not after: the width is only known once the rows are laid
  // out, and a right-aligned menu measured after paint would flash on the wrong
  // side of the button first.
  useLayoutEffect(() => {
    if (!pos || !ref.current) return;
    const el = ref.current;
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    const r = el.getBoundingClientRect();
    let x = alignRight ? Math.max(0, pos.x - r.width) : pos.x;
    let y = pos.y;
    if (!alignRight && r.right > window.innerWidth)
      x = Math.max(0, pos.x - r.width);
    if (r.bottom > window.innerHeight) y = Math.max(0, pos.y - r.height);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [pos, alignRight]);

  if (!pos) return null;

  const closeAfter = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return createPortal(
    <div
      ref={ref}
      className="card-menu-dropdown"
      style={{ position: "fixed", left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
    >
      {onCopy && (
        <button
          className={`card-menu-item card-menu-item--copy${copied ? " card-menu-item--success" : ""}`}
          onClick={closeAfter(onCopy)}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? "Copied!" : "Copy"}</span>
        </button>
      )}
      {onOpen && (
        <button className="card-menu-item" onClick={closeAfter(onOpen)}>
          <ArrowsOutSimple size={13} />
          <span>Open</span>
        </button>
      )}
      {(onRemove || onDeleteForMe) && <div className="card-menu-separator" />}
      {onRemove && (
        <button
          className="card-menu-item card-menu-item--danger-soft"
          onClick={closeAfter(onRemove)}
        >
          <Prohibit size={13} />
          <span>Remove from space</span>
        </button>
      )}
      {onDeleteForMe && (
        <button
          className="card-menu-item card-menu-item--danger"
          onClick={closeAfter(onDeleteForMe)}
        >
          <TrashIcon size={13} />
          <span>Delete for me</span>
        </button>
      )}
    </div>,
    document.body,
  );
};

// ── Remove-from-space confirmation ────────────────────────────────────

interface RemoveOrigin {
  spaceName: string;
  /** How many targets are the user's own items. */
  mine: number;
  /** How many are another member's, i.e. an owner takedown. */
  received: number;
  /** Sender's name for a single received target, when it can be named. */
  fromMember: string | null;
  /** The removal to run once confirmed. */
  run: () => void;
}

/**
 * Body copy for the remove-from-space confirmation, matched to who owns the
 * targets so it reads true either way: unsharing your own leaves the space but
 * keeps your copy; an owner takedown of someone else's leaves their copy alone.
 */
function removeFromSpaceMessage(o: Omit<RemoveOrigin, "run">): React.ReactNode {
  const space = <span className="cdd-hi">{o.spaceName}</span>;
  const count = o.mine + o.received;

  if (count === 1) {
    if (o.received === 1) {
      const who = o.fromMember ? (
        <span className="cdd-hi">{o.fromMember}</span>
      ) : (
        "a member"
      );
      return (
        <>
          This removes it from {space} for everyone. {who} shared it and keeps
          it in their own clipboard.
        </>
      );
    }
    return (
      <>
        This stops sharing it to {space}. It leaves the space for everyone else,
        but your own copy stays in your clipboard.
      </>
    );
  }

  if (o.received === 0) {
    return (
      <>
        This stops sharing these <span className="cdd-hi">{count}</span> items to{" "}
        {space}. They leave the space for everyone else, but your own copies stay
        in your clipboard.
      </>
    );
  }
  if (o.mine === 0) {
    return (
      <>
        This removes these <span className="cdd-hi">{count}</span> items from{" "}
        {space} for everyone. The people who shared them keep them in their own
        clipboards.
      </>
    );
  }
  return (
    <>
      This removes these <span className="cdd-hi">{count}</span> items from{" "}
      {space} for everyone. Your own{" "}
      <span className="cdd-hi">{o.mine}</span> stay in your clipboard, and the{" "}
      <span className="cdd-hi">{o.received}</span> shared by others stay in
      theirs.
    </>
  );
}

// ── Feed filter dropdown ──────────────────────────────────────────────

interface FeedFilterState {
  selectedKinds: Set<DisplayKind>;
  toggleKind: (k: DisplayKind) => void;
  datePreset: DatePreset;
  setDatePreset: (p: DatePreset) => void;
  dateAfter: string;
  setDateAfter: (v: string) => void;
  dateBefore: string;
  setDateBefore: (v: string) => void;
  ownerFilter: OwnerFilter;
  setOwnerFilter: React.Dispatch<React.SetStateAction<OwnerFilter>>;
  /** What each half of the owner pair would leave, other filters applied. */
  ownerCounts: { mine: number; others: number };
  activeFilterCount: number;
  clearAll: () => void;
  filtersOpen: boolean;
  setFiltersOpen: React.Dispatch<React.SetStateAction<boolean>>;
  filterRef: React.RefObject<HTMLDivElement | null>;
  /** Feed items surviving the filters, and the whole feed, for the header. */
  matched: number;
  total: number;
  /** Per-kind counts, computed against the other filters. */
  kindCounts: CountMap;
}

const FeedFilterDropdown: React.FC<{
  sf: FeedFilterState;
  feedFilter: FeedFilter;
}> = ({ sf, feedFilter }) => {
  return (
    <div className="sort-dropdown" ref={sf.filterRef}>
      <button
        className={`cs-tb-btn${sf.filtersOpen ? " cs-tb-btn--open" : ""}`}
        onClick={() => {
          if (!sf.filtersOpen)
            document.dispatchEvent(new Event("tooltip:hide"));
          sf.setFiltersOpen((v) => !v);
        }}
        data-tooltip="Filters"
        data-tooltip-pos="below"
      >
        <Funnel size={12} />
        {sf.activeFilterCount > 0 && (
          <span className="cs-tb-badge">{sf.activeFilterCount}</span>
        )}
      </button>
      {sf.filtersOpen && (
        <FilterCardShell
          matched={sf.matched}
          total={sf.total}
          activeCount={sf.activeFilterCount}
          onClear={sf.clearAll}
        >
          <div className="cs-card-section">
            <SectionLabel
              name="Quick"
              count={sf.ownerFilter === "any" ? 0 : 1}
            />
            <ChipRow>
              <OwnerChips
                value={sf.ownerFilter}
                set={sf.setOwnerFilter}
                counts={sf.ownerCounts}
              />
            </ChipRow>
          </div>
          <CardDivider />
          {feedFilter !== "notes" && (
            <>
              <div className="cs-card-section">
                <SectionLabel
                  name="Type"
                  count={sf.selectedKinds.size}
                  hint="all types"
                />
                <TypeGrid
                  kinds={ALL_DISPLAY_KINDS}
                  selected={sf.selectedKinds}
                  onToggle={sf.toggleKind}
                  counts={sf.kindCounts}
                />
              </div>
              <CardDivider />
            </>
          )}
          <DateSection
            preset={sf.datePreset}
            setPreset={sf.setDatePreset}
            after={sf.dateAfter}
            setAfter={sf.setDateAfter}
            before={sf.dateBefore}
            setBefore={sf.setDateBefore}
          />
        </FilterCardShell>
      )}
    </div>
  );
};

// ── Clipboard detail panel ────────────────────────────────────────────

/**
 * One shared clipboard item, read whole.
 *
 * Wears the same bar and the same body as the clipboard screen's viewer, so an
 * item does not change shape when it travels into a space. What it does not
 * carry is anything that would act on the entry itself: a space item may belong
 * to another member, and the only thing anyone can do to it here is take it out
 * of the space.
 */
const DetailPanel: React.FC<{
  entry: ClipboardEntry;
  onClose: () => void;
  onCopy: (id: string) => void;
  /** This entry's tally, for the chip that opens its thread. */
  comments?: CommentMark;
  /** Member who shared it, when it came from someone else. */
  owner: SpaceMember | null;
  incoming: boolean;
  /** Takedown, absent for members who cannot remove this item. */
  onRemove?: () => void;
  /** Drop this device's copy, present only on received items. */
  onDeleteForMe?: () => void;
}> = ({
  entry,
  onClose,
  onCopy,
  comments,
  owner,
  incoming,
  onRemove,
  onDeleteForMe,
}) => {
  const view = useEntryView(entry);
  const { copied, fire: handleCopy } = useCopyFlash(
    useCallback(() => onCopy(entry.id), [onCopy, entry.id]),
  );
  const menu = useToolbarMenu();
  const popover = useCommentPopover();
  const relTime = timeAgoFor(entry.timestamp, `clipboard:${entry.id}`);
  useEntryViewKeys({
    view,
    onClose,
    onCopy: handleCopy,
    blocked: menu.isOpen || !!popover?.openId,
  });

  return (
    <div className="cv-panel">
      <ViewToolbar
        onBack={onClose}
        actions={
          <>
            <EntryViewControls view={view} />
            {(view.hasAlt || view.zoomKind) && (
              <span className="vt-sep" aria-hidden="true" />
            )}
            <ToolbarCopyButton copied={copied} onClick={handleCopy} />
            <ToolbarMoreButton menu={menu} />
          </>
        }
      >
        <ToolbarFacts
          facts={[...view.facts, `${absoluteTime(entry.timestamp)} (${relTime})`]}
        />
      </ViewToolbar>

      {/* Everything the card's chip row has to drop for want of room. Same
          chips, same colours - nothing is hidden here. */}
      <div className="cv-meta">
        <EntryTypePill kind={deriveDisplayKind(entry)} count={fileCount(entry)} />
        <DirectionBadge incoming={incoming} />
        <OwnerBadge owner={owner} incoming={incoming} />
        <CommentChip
          mark={comments}
          clientId={entry.id}
          entryType="clipboard"
        />
      </div>

      <div className={`cv-scroll${view.isMedia ? " cv-scroll--media" : ""}`}>
        <EntryBody entry={entry} view={view} />
      </div>

      {/* The feed's own right-click menu, anchored under the button rather than
          at a cursor. Open is dropped: the item is already open. */}
      <FeedCardMenu
        pos={menu.pos}
        onClose={menu.close}
        copied={copied}
        onCopy={handleCopy}
        onRemove={onRemove}
        onDeleteForMe={onDeleteForMe}
        alignRight
      />
    </div>
  );
};

// ── Direction badge ───────────────────────────────────────────────────

/** Which way an item travelled, using the same arrows as the Incoming and
 *  Outgoing blocks in space settings, so a row points back at the rule that
 *  put it there. Rows only: a card already shows a preview and its chips. */
const DirectionBadge: React.FC<{ incoming: boolean }> = ({ incoming }) => (
  <span
    className={`sp-list-dir sp-list-dir--${incoming ? "in" : "out"}`}
    data-tooltip={incoming ? "Shared by a member" : "Shared from this account"}
    data-tooltip-pos="right"
  >
    {incoming ? (
      <ArrowDownLeft size={11} weight="bold" />
    ) : (
      <ArrowUpRight size={11} weight="bold" />
    )}
  </span>
);

/** Who put the item in the space.
 *
 * The direction arrow said an item came from "a member" without saying which
 * one, so in a space with several people there was no way to tell whose item
 * you were looking at. This names them.
 */
const OwnerBadge: React.FC<{
  owner: SpaceMember | null;
  incoming: boolean;
}> = ({ owner, incoming }) => {
  if (!incoming) {
    return (
      <span className="sp-owner sp-owner--self" data-tooltip="You shared this">
        You
      </span>
    );
  }
  const name = owner?.display_name?.trim() || "A member";
  return (
    <span className="sp-owner" data-tooltip={`Shared by ${name}`}>
      <UserAvatar
        className="sp-owner-avatar"
        url={owner?.avatar_url}
        label={owner?.display_name?.trim() || ""}
        glyphSize={9}
      />
      <span className="sp-owner-name">{name}</span>
    </span>
  );
};

/** What the placeholder says, written from the reader's side.
 *
 * Who did it comes first, because that is what a reader wants to know and
 * getting it wrong is what made these rows confusing: an account that removed
 * its own item was told "a space owner took this item out of the space",
 * describing the reader in the third person as somebody who had moderated
 * them. `removed_by` is compared with this account's own id, so "You" is a
 * fact rather than something inferred from `by_author` - a relation computed
 * upstream that is wrong whenever a payload arrives without one of its two ids.
 *
 * `byMe === null` is a record written before the actor was kept. Those keep the
 * old wording, minus the claim about who it was: it cannot be known now, and
 * naming the wrong person is worse than naming nobody. */
function removedText(
  item: Extract<FeedItem, { kind: "removed" }>,
  byMe: boolean | null,
  remover: SpaceMember | null,
  incoming: boolean,
  what: string,
): string {
  const { local_only, content_gone, by_author } = item.marker;
  // Nothing happened in the space - the item is still there for everyone else.
  if (local_only) return `Removed your copy of this ${what}`;
  if (byMe === true)
    // Somebody else's item is only ever taken out of the space, whatever it
    // cost this device locally. Ours can genuinely be deleted, and the two are
    // worth telling apart: one is recoverable from its author, the other is not.
    return incoming
      ? `You took this ${what} out of the space`
      : content_gone
        ? `You deleted this ${what}`
        : `You stopped sharing this ${what} here`;
  // Only the space owner may take down an item they did not write, so an
  // unresolvable name is still worth saying that much about.
  const who =
    remover?.display_name?.trim() || (by_author ? "A member" : "A space owner");
  if (byMe === false)
    return by_author
      ? `${who} stopped sharing this ${what}`
      : `${who} took this ${what} out of the space`;
  // No actor on the record, so nothing may be claimed about who.
  return by_author
    ? content_gone && !incoming
      ? `Removed this ${what}`
      : `Stopped sharing this ${what} here`
    : `This ${what} was taken out of the space`;
}

/** What is left after an item is taken out of a space.
 *
 * Deliberately shows nothing of the content — it is gone from this device, and
 * that is the point of removing it. What it does say is that a row used to be
 * here, so the item does not seem to vanish under the other members. */
const RemovedRow: React.FC<{
  item: Extract<FeedItem, { kind: "removed" }>;
  owner: SpaceMember | null;
  /** Who took it out, when the record says and they are still in the space. */
  remover: SpaceMember | null;
  /** Whether this account did it. Null when the record does not say. */
  byMe: boolean | null;
  isNote: boolean;
}> = ({ item, owner, remover, byMe, isNote }) => {
  // The content is gone, but the record of it is not: an owner id on the
  // marker means someone else put it here, which is the same thing the arrow
  // and the name pill say on a live card.
  const incoming = !!item.marker.owner_id;
  const what = isNote ? "note" : "item";
  return (
    <div className="sp-removed-row">
      <span className="sp-removed-icon">
        <Prohibit size={11} weight="bold" />
      </span>
      <DirectionBadge incoming={incoming} />
      <OwnerBadge owner={owner} incoming={incoming} />
      <span
        className={`sp-list-source-badge sp-list-source-badge--${isNote ? "note" : "clip"}`}
      >
        {isNote ? <NoteIcon size={10} /> : <Clipboard size={10} />}
      </span>
      <span className="sp-removed-text">{removedText(item, byMe, remover, incoming, what)}</span>
      <span
        className="sp-removed-time"
        data-tooltip={new Date(item.marker.deleted_at).toLocaleString()}
        data-tooltip-pos="left"
      >
        {timeAgo(item.marker.deleted_at)}
      </span>
    </div>
  );
};

// ── Clipboard feed card ───────────────────────────────────────────────

/* How many comments an entry has carried, and whether any of them are new to
   this device. Only drawn once there is one: an empty chip on every card would
   be noise, and the thread is one click away either way. */
const CommentChip: React.FC<{
  mark?: CommentMark;
  clientId: string;
  entryType: "clipboard" | "note";
}> = ({ mark, clientId, entryType }) => {
  const pop = useCommentPopover();
  const count = mark?.count ?? 0;
  const open = pop?.openId === `${entryType}:${clientId}`;
  return (
    <button
      className={[
        "sp-cmt-chip",
        count === 0 ? "sp-cmt-chip--empty" : "",
        mark?.unread ? "sp-cmt-chip--new" : "",
        open ? "sp-cmt-chip--open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      // The chip is inside a card that selects on click, and reading a thread
      // is not selecting the thing it is about.
      onClick={(e) => {
        e.stopPropagation();
        pop?.toggle(clientId, entryType, e.currentTarget);
      }}
      data-tooltip={
        count === 0
          ? "Add a comment"
          : mark?.unread
            ? "New comments"
            : `${count} comment${count === 1 ? "" : "s"}`
      }
      data-tooltip-pos="top"
      aria-label={count === 0 ? "Add a comment" : `${count} comments`}
    >
      <ChatCircle size={10} weight={mark?.unread ? "fill" : "regular"} />
      {count > 0 && <span className="sp-cmt-chip-n">{count}</span>}
    </button>
  );
};

/* The same box the clipboard cards draw, so a selection reads identically on
   both screens. Every feed card shape gets it. */
const SelectBox: React.FC = () => (
  <div className="entry-card-checkbox">
    <CheckIcon size={10} strokeWidth={3} />
  </div>
);

const ClipFeedCard: React.FC<{
  entry: ClipboardEntry;
  onCopy: (id: string) => void;
  onView: (entry: ClipboardEntry) => void;
  layout: ClipboardLayout;
  showSourceBadge?: boolean;
  incoming: boolean;
  /** Member who shared it, when it came from someone else. */
  owner: SpaceMember | null;
  /** Owner-only takedown, absent when we do not own the space. */
  onRemove?: () => void;
  /** Drop this device's copy, present only on received items. */
  onDeleteForMe?: () => void;
  /** Bulk selection: on while the feed is in select mode. */
  selecting?: boolean;
  selected?: boolean;
  /** Toggle this card. `range` is true for a shift-click. */
  onSelect?: (range: boolean) => void;
  /** This entry's comment tally, absent when nobody has commented. */
  comments?: CommentMark;
}> = ({
  entry,
  onCopy,
  onView,
  layout,
  showSourceBadge,
  incoming,
  owner,
  onRemove,
  onDeleteForMe,
  selecting = false,
  selected = false,
  onSelect,
  comments,
}) => {
  const [copied, setCopied] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markCopied = useCallback(() => {
    onCopy(entry.id);
    if (timer.current) clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, [entry.id, onCopy]);
  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      markCopied();
    },
    [markCopied],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // In select mode the card is a checkbox: a click picks it rather than
  // opening it, and the right-click menu would offer actions that only make
  // sense one at a time.
  const handleCardClick = (e: React.MouseEvent) => {
    if (selecting && onSelect) {
      onSelect(e.shiftKey);
      return;
    }
    onView(entry);
  };
  const handleContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (selecting) return;
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  const dk = deriveDisplayKind(entry);

  // ── List mode ──────────────────────────────────────────────────────
  if (layout === "list") {
    const text =
      entry.type === "text"
        ? entry.content
        : entry.type === "html"
          ? htmlPlainText(entry.content)
          : entry.type === "file"
            ? filePaths(entry.content).map(fileNameFromPath).join(", ")
            : (entry.label ?? "");
    return (
      <>
        <div
          className={`sp-list-card${selecting ? " sp-selectable" : ""}${selected ? " sp-selected" : ""}`}
          onClick={handleCardClick}
          onContextMenu={handleContext}
        >
          {selecting && <SelectBox />}
          <DirectionBadge incoming={incoming} />
          {showSourceBadge && (
            <span className="sp-list-source-badge sp-list-source-badge--clip">
              <Clipboard size={10} />
            </span>
          )}
          <span className="sp-list-type-wrap">
            <EntryTypePill kind={dk} count={fileCount(entry)} />
          </span>
          <OwnerBadge owner={owner} incoming={incoming} />
          <span className="sp-list-text">{truncateText(text, 100)}</span>
          <CommentChip
            mark={comments}
            clientId={entry.id}
            entryType="clipboard"
          />
          <span className="sp-list-time">
            {timeAgoFor(entry.timestamp, `clipboard:${entry.id}`)}
          </span>
          {!selecting && (
            <button
              className={`sp-list-action${copied ? " sp-list-action--done" : ""}`}
              onClick={handleCopy}
            >
              {copied ? <Check size={10} weight="bold" /> : <Copy size={10} />}
            </button>
          )}
        </div>
        <FeedCardMenu
          pos={menuPos}
          onClose={() => setMenuPos(null)}
          copied={copied}
          onCopy={markCopied}
          onOpen={() => onView(entry)}
          onRemove={onRemove}
          onDeleteForMe={onDeleteForMe}
        />
      </>
    );
  }

  // ── Tiles mode ─────────────────────────────────────────────────────
  let mediaSection: React.ReactNode = null;
  let preview: React.ReactNode = null;

  if (entry.type === "text") {
    preview = <p className="card-text">{truncateText(entry.content, 180)}</p>;
  } else if (entry.type === "html") {
    preview = (
      <div
        className="card-html-preview"
        dangerouslySetInnerHTML={{ __html: htmlFragment(entry.content) }}
      />
    );
  } else if (entry.type === "image") {
    mediaSection = (
      <div className="card-media">
        <img
          src={resolveImageSrc(entry.content, convertFileSrc)}
          alt={entry.label ?? "Image"}
          className="card-media-img"
        />
      </div>
    );
    preview = (
      <p className="card-text card-text--image-name">
        {entry.label ?? "Image"}
      </p>
    );
  } else if (entry.type === "file") {
    const paths = filePaths(entry.content);
    preview = (
      <div className="card-file-preview">
        {paths.slice(0, 3).map((p) => (
          <div key={p} className="card-file-preview-item">
            <File size={9} />
            <span className="card-file-preview-name">
              {fileNameFromPath(p)}
            </span>
          </div>
        ))}
        {paths.length > 3 && (
          <p className="card-file-preview-more">+{paths.length - 3} more</p>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        className={`entry-card sp-feed-entry-card${selecting ? " sp-selectable" : ""}${selected ? " sp-selected" : ""}`}
        onClick={handleCardClick}
        onContextMenu={handleContext}
      >
        {selecting && <SelectBox />}
        {mediaSection}
        <div className="card-body">
          {preview}
          <div className="card-footer">
            <div className="card-chips">
              {showSourceBadge && (
                <span className="card-type-chip sp-source-chip--clip">
                  <Clipboard size={9} weight="bold" />
                  <span className="card-type-label">Clipboard</span>
                </span>
              )}
              <EntryTypePill kind={dk} count={fileCount(entry)} />
              <OwnerBadge owner={owner} incoming={incoming} />
              <CommentChip
                mark={comments}
                clientId={entry.id}
                entryType="clipboard"
              />
            </div>
            {copied ? (
              <span className="card-time card-time--copied">
                <Check size={9} weight="bold" />
                Copied
              </span>
            ) : (
              <span className="card-time">
                {timeAgoFor(entry.timestamp, `clipboard:${entry.id}`)}
              </span>
            )}
            {!selecting && (
              <button
                className="sp-card-copy-btn"
                onClick={handleCopy}
                data-tooltip="Copy"
                data-tooltip-pos="top"
              >
                <Copy size={10} />
              </button>
            )}
          </div>
        </div>
      </div>
      <FeedCardMenu
        pos={menuPos}
        onClose={() => setMenuPos(null)}
        copied={copied}
        onCopy={markCopied}
        onOpen={() => onView(entry)}
        onRemove={onRemove}
        onDeleteForMe={onDeleteForMe}
      />
    </>
  );
};

// ── Note feed card ────────────────────────────────────────────────────

const NoteFeedCard: React.FC<{
  note: Note;
  entries: ClipboardEntry[];
  onView: (note: Note) => void;
  layout: ClipboardLayout;
  showSourceBadge?: boolean;
  incoming: boolean;
  /** Member who shared it, when it came from someone else. */
  owner: SpaceMember | null;
  /** Owner-only takedown, absent when we do not own the space. */
  onRemove?: () => void;
  /** Drop this device's copy, present only on received items. */
  onDeleteForMe?: () => void;
  /** Bulk selection: on while the feed is in select mode. */
  selecting?: boolean;
  selected?: boolean;
  /** Toggle this card. `range` is true for a shift-click. */
  onSelect?: (range: boolean) => void;
  /** This note's comment tally, absent when nobody has commented. */
  comments?: CommentMark;
}> = ({
  note,
  entries,
  onView,
  layout,
  showSourceBadge,
  incoming,
  owner,
  onRemove,
  onDeleteForMe,
  selecting = false,
  selected = false,
  onSelect,
  comments,
}) => {
  const plain = extractNoteText(note.content);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const openMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (selecting) return;
      setMenuPos({ x: e.clientX, y: e.clientY });
    },
    [selecting],
  );
  const handleCardClick = (e: React.MouseEvent) => {
    if (selecting && onSelect) {
      onSelect(e.shiftKey);
      return;
    }
    onView(note);
  };

  // ── List mode ──────────────────────────────────────────────────────
  if (layout === "list") {
    return (
      <>
        <div
          className={`sp-list-card sp-list-card--note${selecting ? " sp-selectable" : ""}${selected ? " sp-selected" : ""}`}
          onClick={handleCardClick}
          onContextMenu={openMenu}
        >
          {selecting && <SelectBox />}
          <DirectionBadge incoming={incoming} />
          <span className="sp-list-note-badge">
            <NoteIcon size={12} />
          </span>
          <OwnerBadge owner={owner} incoming={incoming} />
          <div className="sp-list-note-content">
            <span className="sp-list-title">
              {note.title || "(Untitled note)"}
            </span>
            {plain && (
              <span className="sp-list-preview">{truncateText(plain, 70)}</span>
            )}
          </div>
          <CommentChip mark={comments} clientId={note.id} entryType="note" />
          <span className="sp-list-time">
            {timeAgoFor(note.updated_at, `note:${note.id}`)}
          </span>
        </div>
        <FeedCardMenu
          pos={menuPos}
          onClose={() => setMenuPos(null)}
          copied={false}
          onOpen={() => onView(note)}
          onRemove={onRemove}
          onDeleteForMe={onDeleteForMe}
        />
      </>
    );
  }

  // ── Tiles mode: mirrors NoteCard markup so the chip row is ours ─────
  const content = note.content ?? "";
  return (
    <>
      <div
        className={`ns-card${selecting ? " sp-selectable" : ""}${selected ? " sp-selected" : ""}`}
        onClick={handleCardClick}
        onContextMenu={openMenu}
      >
        {selecting && <SelectBox />}
        <div className="ns-card-body">
          <div className="ns-card-title">
            {deriveNoteTitle(note.title, note.content)}
          </div>
          {content && (
            <div className="ns-card-preview">
              <NotionPreview
                content={content}
                entries={entries}
                className="ns-card-preview-md"
              />
            </div>
          )}
          <div className="ns-card-footer">
            <div className="ns-card-chips">
              {showSourceBadge && (
                <span className="card-type-chip sp-source-chip--note">
                  <NoteIcon size={9} />
                  <span className="card-type-label">Note</span>
                </span>
              )}
              <OwnerBadge owner={owner} incoming={incoming} />
              <CommentChip mark={comments} clientId={note.id} entryType="note" />
              {note.groups.map((g) => {
                const c = groupColor(g);
                return (
                  <span
                    key={g}
                    className="ns-chip"
                    style={{ background: c.bg, color: c.fg }}
                  >
                    <span className="ns-chip-dot" />
                    <span className="ns-chip-label">{g}</span>
                  </span>
                );
              })}
            </div>
            <span
              className={`ns-card-time${note.pinned ? " ns-card-time--pinned" : ""}`}
            >
              {note.pinned && <PushPin size={8} weight="fill" />}
              {timeAgoFor(note.updated_at, `note:${note.id}`)}
            </span>
          </div>
        </div>
      </div>
      <FeedCardMenu
        pos={menuPos}
        onClose={() => setMenuPos(null)}
        copied={false}
        onOpen={() => onView(note)}
        onRemove={onRemove}
        onDeleteForMe={onDeleteForMe}
      />
    </>
  );
};

// ── Read-only note detail panel ───────────────────────────────────────

/**
 * One shared note, read whole.
 *
 * Wears the notes editor's own chrome - the same bar, the same title field, the
 * same group row, the same footer - so a note that arrived from a space reads
 * exactly like a note of your own. The difference is that nothing here is
 * editable, which the bar under the header says in words rather than leaving
 * for someone to discover by typing.
 */
const ReadOnlyNotePanel: React.FC<{
  note: Note;
  entries: ClipboardEntry[];
  onClose: () => void;
  comments?: CommentMark;
  /** Member who shared it, when it came from someone else. */
  owner: SpaceMember | null;
  incoming: boolean;
  /** Takedown, absent for members who cannot remove this note. */
  onRemove?: () => void;
  /** Drop this device's copy, present only on received notes. */
  onDeleteForMe?: () => void;
}> = ({
  note,
  entries,
  onClose,
  comments,
  owner,
  incoming,
  onRemove,
  onDeleteForMe,
}) => {
  const menu = useToolbarMenu();
  const popover = useCommentPopover();
  const sharer = owner?.display_name?.trim();
  useCloseOnEscape(onClose, menu.isOpen || !!popover?.openId);

  return (
    <div className="ns-editor-shell">
      <div className="ns-editor">
        <ViewToolbar
          onBack={onClose}
          actions={
            <>
              <CommentChip
                mark={comments}
                clientId={note.id}
                entryType="note"
              />
              {onRemove && (
                <>
                  <span className="vt-sep" aria-hidden="true" />
                  <ToolbarMoreButton menu={menu} />
                </>
              )}
            </>
          }
        >
          <ToolbarFacts facts={[`Updated ${timeAgoFor(note.updated_at, `note:${note.id}`)}`]} />
        </ViewToolbar>

        {/* Read-only, but still a field: a title you can select and copy is
            worth more here than one you cannot touch. */}
        <div className="ns-title-row">
          <input
            className="ns-title-input"
            value={deriveNoteTitle(note.title, note.content)}
            readOnly
          />
          {note.groups.length > 0 && (
            <div className="ns-title-groups">
              {note.groups.slice(0, 3).map((g) => {
                const c = groupColor(g);
                return (
                  <span
                    key={g}
                    className="ns-editor-group-chip"
                    style={{ background: c.bg, color: c.fg }}
                  >
                    <span className="ns-chip-dot" />
                    <span className="ns-chip-label">{g}</span>
                  </span>
                );
              })}
              {note.groups.length > 3 && (
                <span className="ns-title-groups-more">
                  +{note.groups.length - 3}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="ns-readonly-bar">
          <LockSimpleIcon size={12} />
          <span>
            {incoming
              ? sharer
                ? `${sharer} shared this note. Only they can edit it.`
                : "Shared with you. Only the author can edit it."
              : "Your note, as this space sees it. Edit it on the Notes screen."}
          </span>
        </div>

        <div className="ns-editor-content">
          <NotionPreview content={note.content} entries={entries} />
        </div>

        <FeedCardMenu
          pos={menu.pos}
          onClose={menu.close}
          copied={false}
          onRemove={onRemove}
          onDeleteForMe={onDeleteForMe}
          alignRight
        />
      </div>
    </div>
  );
};

// ── Create / join forms ───────────────────────────────────────────────

const CreateForm: React.FC<{
  onSubmit: (name: string, shareHistory: boolean) => void;
  onCancel: () => void;
  loading: boolean;
}> = ({ onSubmit, onCancel, loading }) => {
  const [name, setName] = useState("");
  const [shareHistory, setShareHistory] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const submit = () => {
    if (name.trim()) onSubmit(name.trim(), shareHistory);
  };
  return (
    <div className="sp-inline-form">
      <input
        ref={inputRef}
        className="sp-inline-input"
        placeholder="Space name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      {/* Fixed per member at join time, so turning it off later never takes
          history away from someone who already has it. */}
      <label className="sp-inline-check">
        <input
          type="checkbox"
          checked={shareHistory}
          onChange={(e) => setShareHistory(e.target.checked)}
        />
        <span>New members can read earlier items</span>
      </label>
      <div className="sp-inline-form-actions">
        <button
          className="sp-inline-btn sp-inline-btn--primary"
          disabled={!name.trim() || loading}
          onClick={submit}
        >
          {loading ? "Creating..." : "Create"}
        </button>
        <button className="sp-inline-btn" onClick={onCancel}>
          <X size={10} />
        </button>
      </div>
    </div>
  );
};

const JoinForm: React.FC<{
  onSubmit: (code: string) => void;
  onCancel: () => void;
  loading: boolean;
}> = ({ onSubmit, onCancel, loading }) => {
  const [code, setCode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div className="sp-inline-form">
      <input
        ref={inputRef}
        className="sp-inline-input"
        placeholder="Paste an invite code or link"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && code.trim()) onSubmit(code.trim());
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="sp-inline-form-actions">
        <button
          className="sp-inline-btn sp-inline-btn--primary"
          disabled={!code.trim() || loading}
          onClick={() => code.trim() && onSubmit(code.trim())}
        >
          {loading ? "Joining..." : "Join"}
        </button>
        <button className="sp-inline-btn" onClick={onCancel}>
          <X size={10} />
        </button>
      </div>
    </div>
  );
};

// ── Space settings panel ──────────────────────────────────────────────

const SpaceSettings: React.FC<{
  space: Space;
  selfUserId: string | null;
  autocopy: boolean;
  onAutocopy: (enabled: boolean) => void;
  showRemoved: boolean;
  onShowRemoved: (enabled: boolean) => void;
  onShareHistory: (enabled: boolean) => void;
  onMembersCanApprove: (allowed: boolean) => void;
  filter: SendFilter;
  onFilter: (next: SendFilter) => void;
  availableGroups: string[];
  onInvite: (email: string) => Promise<void>;
  onRemoveMember: (userId: string) => void;
  onLeave: () => void;
  onDelete: () => void;
  error: string | null;
}> = ({
  space,
  selfUserId,
  autocopy,
  onAutocopy,
  showRemoved,
  onShowRemoved,
  onShareHistory,
  onMembersCanApprove,
  filter,
  onFilter,
  availableGroups,
  onInvite,
  onRemoveMember,
  onLeave,
  onDelete,
  error,
}) => {
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Somebody removed a moment ago is off the list while the Undo toast is up,
  // even though the server has not been told yet and still lists them.
  const pendingGone = usePendingRemovals();
  const shownMembers = space.members.filter(
    (m) => !pendingGone.has(`member:${space.id}:${m.user_id}`),
  );
  // Waiting on a key is waiting on a person, not on the service, so say which
  // person: "a member" gives nobody to go and nudge. Any member who already has
  // the key can hand it over, so name whoever is online rather than the owner -
  // and when nobody is, name the owner, since minting a first key is only ever
  // theirs to do. Presence is live: a `space:presence-changed` event reloads
  // this list, so the wording flips on its own. A profile that never set a
  // display name falls back.
  const owner = space.members.find((m) => m.user_id === space.owner_id);
  const holderOnline = space.members.find(
    (m) => m.online && m.has_space_key && m.user_id !== selfUserId,
  );
  const nameOf = (m: SpaceMember | undefined, fallback: string) =>
    m?.display_name?.trim() ? `${m.display_name.trim()}'s app` : fallback;
  const waitingReason = holderOnline
    ? `${nameOf(holderOnline, "Another member's app")} is online, so the key should land in a moment.`
    : `${nameOf(owner, "The owner's app")} is not running, and nobody else here has the key yet. It arrives on its own once someone opens the app, even if it only sits in the tray.`;

  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current);
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copy = (key: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setCopied(key);
    copyTimer.current = setTimeout(() => setCopied(null), 1600);
  };

  // The https form, built in Rust from the configured server URL: mail and chat
  // clients strip an orange:// link, and the page it lands on offers the app plus
  // a download when it is not installed. Falls back to the deep link if the
  // command fails, which is what shipped before.
  const copyInviteLink = async (code: string) => {
    let link = `orange://join?code=${code}`;
    try {
      // Dashed, so the URL reads the way the code is shown everywhere else; the
      // backend normalizes it either way.
      link = await invoke<string>("space_invite_link", {
        inviteCode: formatInviteCode(code),
      });
    } catch {
      // keep the deep link
    }
    copy("link", link);
  };

  const sendInvite = async () => {
    if (!email.trim()) return;
    setInviting(true);
    try {
      await onInvite(email.trim());
      setEmail("");
    } finally {
      setInviting(false);
    }
  };

  const armDelete = () => {
    if (!armed) {
      setArmed(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    setArmed(false);
    onDelete();
  };

  /* A rule with no type ticked used to mean "every type", so the boxes said
     one thing and the rule did another. The stored empty list still means
     every type - that is what the sync engine reads - but it now draws as
     every box ticked, so what you see is what leaves this machine. Untick to
     narrow; tick the last one back and it collapses to the empty list again.
     The final tick cannot come off: a rule that shares nothing is a rule that
     should be switched off instead. */
  const selectedKinds = useMemo(
    () =>
      new Set(
        filter.kinds.length > 0
          ? (filter.kinds as DisplayKind[])
          : ALL_DISPLAY_KINDS,
      ),
    [filter.kinds],
  );

  const lastKind = selectedKinds.size === 1;

  const toggleKind = (k: DisplayKind) => {
    const next = new Set(selectedKinds);
    if (next.has(k)) {
      if (next.size === 1) return; // held by the disabled checkbox
      next.delete(k);
    } else {
      next.add(k);
    }
    const kinds =
      next.size === ALL_DISPLAY_KINDS.length
        ? []
        : ALL_DISPLAY_KINDS.filter((x) => next.has(x));
    onFilter({ ...filter, kinds });
  };

  const toggleGroup = (g: string) => {
    const groups = filter.groups.includes(g)
      ? filter.groups.filter((x) => x !== g)
      : [...filter.groups, g];
    onFilter({ ...filter, groups });
  };

  const selectedGroups = useMemo(() => new Set(filter.groups), [filter.groups]);

  return (
    <div className="sp-settings">
      {/* The column used to open on a bare "Incoming" label, so nothing said
          which space you were editing once the list scrolled. */}
      <header className="sp-rules-head">
        <span
          className="sp-rules-avatar"
          style={{ background: spaceAvatarColor(space.id) }}
        >
          {space.name.slice(0, 2).toUpperCase()}
        </span>
        <span className="sp-rules-head-text">
          <span className="sp-rules-name">{space.name}</span>
          <span className="sp-rules-sub">
            {space.member_count} member{space.member_count === 1 ? "" : "s"}
            {space.is_owner ? " - you own it" : ""}
          </span>
        </span>
      </header>

      <div className="sp-rules-body">
        {error && <span className="sp-settings-error">{error}</span>}

        {/* Everything in a space is encrypted under its key, so until the key
            arrives there is nothing here to read. Sharing is not blocked: the
            choice is held and sent when the key lands. Said once, here, so no
            control has to explain it. */}
        {!space.has_key && (
          <div className="sp-waiting">
            <span className="sp-waiting-title">Waiting for this space's key</span>
            <span className="sp-waiting-desc">
              {waitingReason} The feed stays empty until then. You can still
              choose to share items here and they go out as soon as the key
              arrives. You do not need to rejoin.
            </span>
          </div>
        )}

        {/* Rules: what the space does with items, in and out. */}
        <div className="sp-settings-block">
          <div className="sp-settings-label">
            Rules
            {filter.enabled && <span className="sp-settings-count">auto</span>}
          </div>
          <label className="sp-toggle-row">
            <span className="sp-toggle-text">
              <span className="sp-toggle-title">Copy new items in</span>
              <span className="sp-toggle-desc">
                {autocopy
                  ? "Anything shared here lands on your clipboard as it arrives."
                  : "Items still appear in this space, they just do not touch your clipboard."}
              </span>
            </span>
            <input
              type="checkbox"
              className="sp-switch"
              checked={autocopy}
              onChange={(e) => onAutocopy(e.target.checked)}
            />
          </label>
          <label className="sp-toggle-row">
            <span className="sp-toggle-text">
              <span className="sp-toggle-title">Share new items out</span>
              <span className="sp-toggle-desc">
                {filter.enabled
                  ? space.has_key
                    ? "New items that match the rules below are shared here. Older items are untouched."
                    : "New items that match the rules below are held until this space's key arrives, then sent."
                  : "Off. Only items you share by hand go into this space."}
              </span>
            </span>
            <input
              type="checkbox"
              className="sp-switch"
              checked={filter.enabled}
              onChange={(e) =>
                onFilter({ ...filter, enabled: e.target.checked })
              }
            />
          </label>

          {filter.enabled && (
            /* Same parts as the filter cards on the other screens: section
               labels, hairline dividers, the segmented control and the chip.
               A share rule is a filter, so it should not look like its own
               invention. */
            <div className="sp-filter-body">
              <div className="cs-card-section">
                <SectionLabel name="Content" />
                <div className="cs-seg">
                  {CONTENT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`cs-seg-btn${filter.content === opt.value ? " cs-seg-btn--on" : ""}`}
                      onClick={() =>
                        onFilter({
                          ...filter,
                          content: opt.value,
                          // Notes have no clipboard type, so the type rule stops
                          // applying. Drop it rather than hiding a selection
                          // that quietly comes back on the way out.
                          kinds: opt.value === "notes" ? [] : filter.kinds,
                        })
                      }
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {filter.content !== "notes" && (
                <>
                  <CardDivider />
                  <div className="cs-card-section">
                    <SectionLabel
                      name="Clipboard types"
                      count={selectedKinds.size}
                    />
                    <TypeGrid
                      kinds={ALL_DISPLAY_KINDS}
                      selected={selectedKinds}
                      onToggle={toggleKind}
                      locked={
                        lastKind
                          ? {
                              has: (k) => selectedKinds.has(k),
                              reason:
                                "Keep at least one type, or switch sharing off.",
                            }
                          : undefined
                      }
                    />
                  </div>
                </>
              )}

              <CardDivider />
              <div className="cs-card-section">
                <SectionLabel
                  name="Groups"
                  count={filter.groups.length}
                  hint="any group"
                />
                {availableGroups.length === 0 ? (
                  <p className="sp-filter-empty">
                    You have no groups yet. Tag items with a group to filter by
                    it.
                  </p>
                ) : (
                  <GroupChips
                    groups={availableGroups}
                    selected={selectedGroups}
                    onToggle={toggleGroup}
                    /* The neutral state as a chip you can see and click, not
                       a silent empty list that behaved like "everything". */
                    leading={
                      <FilterChip
                        label="Any group"
                        on={filter.groups.length === 0}
                        onToggle={() => onFilter({ ...filter, groups: [] })}
                      />
                    }
                  />
                )}
              </div>
            </div>
          )}

          {space.is_owner && (
            <label className="sp-toggle-row">
              <span className="sp-toggle-text">
                <span className="sp-toggle-title">Share earlier items</span>
                <span className="sp-toggle-desc">
                  {space.share_history
                    ? "Everyone here can read what was shared before they joined."
                    : "Members only see items shared after they joined. Turn this on to open the rest to them."}
                </span>
              </span>
              <input
                type="checkbox"
                className="sp-switch"
                checked={space.share_history}
                onChange={(e) => onShareHistory(e.target.checked)}
              />
            </label>
          )}

          {space.is_owner && (
            <label className="sp-toggle-row">
              <span className="sp-toggle-text">
                <span className="sp-toggle-title">
                  Members can approve requests
                </span>
                <span className="sp-toggle-desc">
                  {space.members_can_approve
                    ? "Anyone here can let in someone who used the code or a join link."
                    : "Only you can let in someone who used the code or a join link. Turn this on so you are not the only way in."}
                </span>
              </span>
              <input
                type="checkbox"
                className="sp-switch"
                checked={space.members_can_approve}
                onChange={(e) => onMembersCanApprove(e.target.checked)}
              />
            </label>
          )}

          <label className="sp-toggle-row">
            <span className="sp-toggle-text">
              <span className="sp-toggle-title">Show removed items</span>
              <span className="sp-toggle-desc">
                {showRemoved
                  ? "Items taken out of this space leave a line saying who removed them and when."
                  : "Removed items disappear from the feed with no trace."}
              </span>
            </span>
            <input
              type="checkbox"
              className="sp-switch"
              checked={showRemoved}
              onChange={(e) => onShowRemoved(e.target.checked)}
            />
          </label>
        </div>

        {/* People: who is here, and how to add more. */}
        <div className="sp-settings-block">
          <div className="sp-settings-label">
            People
            <span className="sp-settings-count">
              {space.member_count - (space.members.length - shownMembers.length)}
            </span>
          </div>
          <div className="sp-member-list">
            {shownMembers.length === 0 ? (
              <p className="sp-filter-empty">Just you so far.</p>
            ) : (
              shownMembers.map((m) => (
                <div key={m.user_id} className="sp-member-row">
                  <UserAvatar
                    className="sp-member-pic"
                    url={m.avatar_url}
                    label={m.display_name || ""}
                    glyphSize={10}
                  />
                  <span className="sp-member-name">
                    {m.user_id === selfUserId
                      ? "You"
                      : m.display_name || "Member"}
                  </span>
                  {m.role === "owner" && (
                    <span className="sp-badge sp-badge--owner">owner</span>
                  )}
                  {!m.has_space_key && (
                    <span
                      className="sp-badge sp-badge--warn"
                      data-tooltip="They cannot read this space yet. The owner's app hands over the key and keeps retrying until it lands."
                      data-tooltip-pos="below"
                    >
                      waiting for key
                    </span>
                  )}
                  {space.is_owner && m.user_id !== selfUserId && (
                    <button
                      type="button"
                      className="sp-btn sp-btn--danger sp-member-remove"
                      onClick={() => onRemoveMember(m.user_id)}
                    >
                      Remove
                    </button>
                  )}
                  {/* Last in the row, so it sits in the same column on every
                      line no matter which badges or buttons come before it. */}
                  <span
                    className="sp-member-dot"
                    data-tooltip={m.online ? "Online now" : "Offline"}
                    data-tooltip-pos="left"
                  >
                    <Circle
                      size={8}
                      weight="fill"
                      color={m.online ? "#22c55e" : "#6b7280"}
                    />
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Two rows of the same width, both ending in an action, so the
            column reads as one block instead of four loose controls. */}
          <div className="sp-invite-box">
            {space.invite_code && (
              <div className="sp-invite-row">
                <code className="sp-invite-code">
                  {formatInviteCode(space.invite_code)}
                </code>
                <button
                  type="button"
                  className="sp-btn sp-btn--icon"
                  onClick={() =>
                    copy("code", formatInviteCode(space.invite_code!))
                  }
                  data-tooltip="Copy code"
                  data-tooltip-pos="top"
                >
                  {copied === "code" ? <Check size={12} /> : <Copy size={12} />}
                  <span className="sp-btn-label">
                    {copied === "code" ? "Copied" : "Copy code"}
                  </span>
                </button>
                <button
                  type="button"
                  className="sp-btn sp-btn--icon"
                  onClick={() =>
                    void copyInviteLink(space.invite_code!)
                  }
                  data-tooltip="Copy invite link"
                  data-tooltip-pos="top"
                >
                  {copied === "link" ? (
                    <Check size={12} />
                  ) : (
                    <ShareNetwork size={12} />
                  )}
                  <span className="sp-btn-label">
                    {copied === "link" ? "Copied" : "Copy link"}
                  </span>
                </button>
              </div>
            )}
            <div className="sp-invite-row">
              <input
                className="sp-inline-input"
                type="email"
                placeholder="Invite by email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendInvite();
                }}
              />
              <button
                type="button"
                className="sp-btn"
                onClick={sendInvite}
                disabled={inviting || !email.trim()}
              >
                {inviting ? "..." : "Send"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Pinned, so the one destructive control sits on the column edge instead
          of trailing the scroll with empty space under it. */}
      <footer className="sp-rules-foot">
        {space.is_owner ? (
          <button
            type="button"
            className="sp-btn sp-btn--danger"
            onClick={armDelete}
            onBlur={() => setArmed(false)}
          >
            {armed ? "Confirm delete?" : "Delete space"}
          </button>
        ) : (
          <button
            type="button"
            className="sp-btn sp-btn--danger"
            onClick={onLeave}
          >
            Leave space
          </button>
        )}
        <span className="sp-danger-note">
          {space.is_owner
            ? "Stops sharing for everyone. Items already on their devices stay."
            : "Stops new items reaching you. What you already have stays."}
        </span>
      </footer>
    </div>
  );
};

// ── Rules column placeholder ──────────────────────────────────────────

/** The column keeps its shape with no space selected: the rules are per space,
 *  so there is nothing to set yet, but showing what lives here beats an empty
 *  gutter that reads as a missing feature. */
const RulesPlaceholder: React.FC<{ hasSpaces: boolean }> = ({ hasSpaces }) => (
  <div className="sp-settings">
    <header className="sp-rules-head">
      <span className="sp-rules-avatar sp-rules-avatar--ghost" />
      <span className="sp-rules-head-text">
        <span className="sp-rules-name">No space selected</span>
        <span className="sp-rules-sub">
          {hasSpaces ? "Pick one from the list" : "Create or join one to start"}
        </span>
      </span>
    </header>

    <div className="sp-rules-body">
      <div className="sp-settings-block">
        <div className="sp-settings-label">Rules</div>
        <p className="sp-rules-ghost-row">
          Copy new items to your clipboard as they arrive, on this device only.
        </p>
        <p className="sp-rules-ghost-row">
          Share new items out automatically, narrowed by clipboard type and
          group. Off by default, so only what you share by hand goes out.
        </p>
      </div>
      <div className="sp-settings-block">
        <div className="sp-settings-label">People</div>
        <p className="sp-rules-ghost-row">
          Who is in the space, who is online, and the invite code.
        </p>
      </div>
    </div>
  </div>
);

// ── Cross-visit cache ─────────────────────────────────────────────────

/** The screen unmounts when you switch away, so every visit used to start
 *  from empty and paint "No spaces yet" until the first round trip came back.
 *  This keeps the last answer so a return visit renders it immediately and
 *  the fetch only corrects it. */
const cache: {
  loaded: boolean;
  spaces: Space[];
  selfUserId: string | null;
  shares: Record<string, string[]>;
  remote: string[];
  invites: SyncInviteList;
  filters: Record<string, SendFilter>;
  autocopy: Record<string, boolean>;
  showRemoved: Record<string, boolean>;
} = {
  loaded: false,
  spaces: [],
  selfUserId: null,
  shares: {},
  remote: [],
  invites: { sent: [], received: [] },
  filters: {},
  autocopy: {},
  showRemoved: {},
};

const SELECTED_KEY = "spaces-selected";

// ── Resizable side panels ─────────────────────────────────────────────

/** Both panels resize within a range rather than freely: the feed in the
 *  middle is the point of the screen, and a space card stops being readable
 *  under ~190px. */
interface PaneSize {
  key: string;
  min: number;
  max: number;
  def: number;
}

const LIST_PANE: PaneSize = {
  key: "spaces-list-width",
  // The floor is where "1 member - 1 online" still fits beside the avatar and
  // the owner badge. Below it the meta line wraps and cards go double height.
  min: 244,
  max: 380,
  def: 252,
};
const RULES_PANE: PaneSize = {
  key: "spaces-rules-width",
  min: 240,
  max: 420,
  def: 272,
};

/** Below this the invite code needs the whole row, so its actions are icons. */
const RULES_LABEL_WIDTH = 336;

const clampWidth = (pane: PaneSize, px: number) =>
  Math.min(pane.max, Math.max(pane.min, Math.round(px)));

const readWidth = (pane: PaneSize) => {
  const raw = Number(localStorage.getItem(pane.key));
  return Number.isFinite(raw) && raw > 0 ? clampWidth(pane, raw) : pane.def;
};

// ── Props ─────────────────────────────────────────────────────────────

interface SpacesScreenProps {
  entries: ClipboardEntry[];
  notes: Note[];
  syncConnected: boolean | null;
  availableGroups: string[];
  onCopyEntry: (id: string) => void;
  /** Delete a received item's local copy ("Delete for me"). Shares the app's
   *  guarded, undoable delete, so the feed matches the clipboard screen. */
  onDeleteEntry: (id: string) => void;
  onDeleteNote: (id: string) => void;
  /** Code from an invite link the user opened, joined once and then cleared. */
  joinCode?: string | null;
  onJoinCodeConsumed?: () => void;
}

// ── Main screen ───────────────────────────────────────────────────────

const SpacesScreen: React.FC<SpacesScreenProps> = ({
  entries,
  notes,
  syncConnected,
  availableGroups,
  onCopyEntry,
  onDeleteEntry,
  onDeleteNote,
  joinCode,
  onJoinCodeConsumed,
}) => {
  const [spaces, setSpaces] = useState<Space[]>(cache.spaces);
  // The event listeners below are registered once, so they cannot read `spaces`
  // from their own closure without going stale. They name a space by id.
  const spacesRef = useRef<Space[]>(spaces);
  spacesRef.current = spaces;
  const [loaded, setLoaded] = useState(cache.loaded);
  const screenRef = useRef<HTMLDivElement>(null);
  const [listWidth, setListWidth] = useState(() => readWidth(LIST_PANE));
  const [rulesWidth, setRulesWidth] = useState(() => readWidth(RULES_PANE));
  const [dragging, setDragging] = useState<"list" | "rules" | null>(null);
  const [selfUserId, setSelfUserId] = useState<string | null>(cache.selfUserId);
  // Auth, not connectivity: a signed-in device that is offline can still be
  // shown its spaces, but nothing that needs the server should be offered.
  const signedIn = selfUserId !== null;
  // "clipboard:{id}" / "note:{id}" -> space ids the item is shared into.
  const [entryShares, setEntryShares] = useState<Record<string, string[]>>(
    cache.shares,
  );
  // Same keys, for the items another member wrote. Anything absent went out
  // from this account, which is also the right answer while sync is off.
  const [remoteKeys, setRemoteKeys] = useState<Set<string>>(
    () => new Set(cache.remote),
  );
  // Same keys again, mapping to the account that wrote the item. Only received
  // items are recorded, so a miss means this account shared it.
  const [entryOwners, setEntryOwners] = useState<Record<string, string>>({});
  // Items that were taken out of a space. Same keys again; the feed shows these
  // as placeholders so a removal is visible to everyone who saw the item.
  const [deletedMarkers, setDeletedMarkers] = useState<
    Record<string, DeletedMarker>
  >({});
  // Keys whose removal is waiting out an Undo toast. Everything below subtracts
  // them from what it draws, so a click takes the row away at once while the
  // call itself is still pending, and a refresh landing mid-toast cannot put it
  // back - the hint lives outside the maps being refreshed.
  const pendingGone = usePendingRemovals();
  // Reopens on the space you left, which is usually the one you want again.
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    localStorage.getItem(SELECTED_KEY),
  );
  const [invites, setInvites] = useState<SyncInviteList>(cache.invites);
  // People waiting to be let in, across every space this account may approve
  // for. Not cached: a request answered on another device should not reappear
  // here on the strength of a stale list.
  const [joinRequests, setJoinRequests] = useState<SpaceJoinRequest[]>([]);
  // Our own outstanding knocks. These spaces are not memberships, so they are
  // absent from `spaces_list` and would otherwise be nothing on screen at all.
  const [pendingJoins, setPendingJoins] = useState<PendingJoin[]>([]);
  const [invitesOpen, setInvitesOpen] = useState(false);
  const [invitesAnchor, setInvitesAnchor] = useState({ x: 0, y: 0 });
  // Answering the last one takes the button away with it, so the popover has
  // to go too rather than hang under a control that is no longer there.
  const invitesEmpty =
    invites.received.every((i) => i.status !== "pending") &&
    invites.sent.every((i) => i.status !== "pending");
  useEffect(() => {
    if (invitesEmpty) setInvitesOpen(false);
  }, [invitesEmpty]);
  const [sendFilters, setSendFilters] = useState<Record<string, SendFilter>>(
    cache.filters,
  );
  const [autocopy, setAutocopy] = useState<Record<string, boolean>>(
    cache.autocopy,
  );
  // Whether this space's feed keeps the placeholders for removed items. On by
  // default: a row vanishing with no trace is the confusing case.
  const [showRemoved, setShowRemoved] = useState<Record<string, boolean>>(
    cache.showRemoved,
  );
  // Two homes, because there are two panels. `spaceError` belongs to whatever
  // space is open and renders inside its detail panel; `listError` belongs to
  // the list column - creating, joining, and answering an invite all happen
  // there. One shared state rendered in both places meant an invite refusal
  // appeared three times at once: above the list, above the invite field, and
  // in a toast.
  const [spaceError, setSpaceError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // Sticky, like the clipboard and notes filters: this screen unmounts on a
  // switch, and coming back to an unfiltered feed with every day expanded
  // undoes work the user did on purpose.
  const [feedFilter, setFeedFilter] = useSticky<FeedFilter>("sp-f-kind", "all");
  const [search, setSearch] = useSticky("sp-f-search", "");
  const [sort, setSort] = useState<SortMode>(
    () => (localStorage.getItem("spaces-sort") as SortMode) ?? "newest",
  );
  const [layout, setLayout] = useState<ClipboardLayout>(
    () => (localStorage.getItem("spaces-layout") as ClipboardLayout) ?? "tiles",
  );
  // Never a placeholder: there is nothing to open.
  const [detailItem, setDetailItem] = useState<ContentFeedItem | null>(null);
  const {
    marks: commentMarks,
    refresh: refreshCommentCounts,
    markRead: markCommentsRead,
  } = useCommentCounts(selectedId);

  const [collapsedDays, setCollapsedDays] = useStickySet("sp-collapsed-days");
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Feed filter state. The dropdown being open is the one thing that is not
  // remembered - it would reopen itself on every return visit.
  const [selectedKinds, setSelectedKinds] = useStickySet<DisplayKind>(
    "sp-f-kinds",
  );
  /* Whose items to show. The feed is the one screen where everything is, by
     definition, shared with other people, so it is also where "only mine" and
     "only theirs" are worth asking - and it was the one screen with no way to
     ask either. */
  const [ownerFilter, setOwnerFilter] = useSticky<OwnerFilter>(
    "sp-f-owner",
    "any",
  );
  const [datePreset, setDatePreset] = useSticky<DatePreset>("sp-f-date", "any");
  const [dateAfter, setDateAfter] = useSticky("sp-f-date-after", "");
  const [dateBefore, setDateBefore] = useSticky("sp-f-date-before", "");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => spaces.find((s) => s.id === selectedId) ?? null,
    [spaces, selectedId],
  );

  // Off means the placeholders are not on screen, so there is nothing for the
  // clear button to act on either.
  const placeholdersOn = selected ? showRemoved[selected.id] !== false : false;

  const removedCount = useMemo(
    () =>
      selected && placeholdersOn
        ? Object.values(deletedMarkers).filter((m) =>
            m.space_ids.includes(selected.id),
          ).length
        : 0,
    [deletedMarkers, selected, placeholdersOn],
  );

  const multiSelect = useMultiSelect();

  // Removing is the only bulk action here, so only what this account may
  // remove can be picked: the space owner moderates anything, a member takes
  // out what they shared. Same rule as the card menu, and the backend narrows
  // to the caller's own rows for non-owners regardless.
  const canRemoveKey = useCallback(
    (key: string) =>
      !!selected && (selected.is_owner || !remoteKeys.has(key)),
    [selected, remoteKeys],
  );

  // Clearing forgets the placeholders only. The items stay gone: the same
  // markers are what stop a pull re-merging something removed here, so this
  // drops them for spaces the user has finished reviewing.
  const handleClearRemoved = useCallback(() => {
    if (!selected) return;
    const spaceId = selected.id;
    invoke<number>("space_clear_removed", { spaceId })
      .then((count) => {
        showToast(
          count === 1
            ? "Cleared 1 placeholder"
            : `Cleared ${count} placeholders`,
          "info",
        );
        setDeletedMarkers((prev) =>
          Object.fromEntries(
            Object.entries(prev).filter(
              ([, m]) => !m.space_ids.includes(spaceId),
            ),
          ),
        );
      })
      .catch((e) => toastError("Could not clear the placeholders", e));
  }, [selected]);

  // Resolve an item to the member who shared it. A member who has since left
  // the space is no longer in the list, so this can return null for an item
  // that is genuinely incoming - the badge falls back to "A member".
  const ownerFor = useCallback(
    (key: string): SpaceMember | null => {
      const userId = entryOwners[key];
      if (!userId || !selected) return null;
      return selected.members.find((m) => m.user_id === userId) ?? null;
    },
    [entryOwners, selected],
  );

  /* Removing an item drops its id_map row, so `ownerFor` has nothing left to
     look up. The marker keeps the author's id for exactly this reason. */
  const removedOwnerFor = useCallback(
    (marker: DeletedMarker): SpaceMember | null => {
      if (!marker.owner_id || !selected) return null;
      return (
        selected.members.find((m) => m.user_id === marker.owner_id) ?? null
      );
    },
    [selected],
  );

  /* Who took it out. Null for a record written before the actor was kept, and
     for one naming somebody who has since left - the wording falls back to
     "A member" rather than to a name it cannot resolve. */
  const removerFor = useCallback(
    (marker: DeletedMarker): SpaceMember | null => {
      if (!marker.removed_by || !selected) return null;
      return (
        selected.members.find((m) => m.user_id === marker.removed_by) ?? null
      );
    },
    [selected],
  );

  /* Whether this account did it. Null means the record does not say, which is
     different from "no" and has to stay different: guessing produces exactly
     the third-person wording this replaces. */
  const removedByMe = useCallback(
    (marker: DeletedMarker): boolean | null => {
      if (!marker.removed_by || !selfUserId) return null;
      return marker.removed_by === selfUserId;
    },
    [selfUserId],
  );

  // How much is in each space, counted from the share map rather than the feed
  // so a space that is not selected still has a number.
  const itemCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const ids of Object.values(entryShares))
      for (const id of ids) counts[id] = (counts[id] ?? 0) + 1;
    return counts;
  }, [entryShares]);

  // Sections only appear when they split something: a solo account has nobody
  // else online anywhere, and one "Quiet" header over the whole list says
  // nothing. Your own presence does not count - it is true everywhere.
  const spaceGroups = useMemo(() => {
    const shown = spaces.filter((s) => !pendingGone.has(`space:${s.id}`));
    const live = (s: Space) =>
      s.members.some((m) => m.online && m.user_id !== selfUserId);
    const active = shown.filter(live);
    const quiet = shown.filter((s) => !live(s));
    if (active.length === 0 || quiet.length === 0)
      return [{ title: "All", spaces: shown }];
    return [
      { title: "Active now", spaces: active },
      { title: "Quiet", spaces: quiet },
    ];
  }, [spaces, selfUserId, pendingGone]);

  // Panel drag. Widths are measured off the screen box rather than the panel
  // so a fast drag that outruns the pointer still tracks it.
  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      const rect = screenRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      if (dragging === "list") {
        setListWidth(clampWidth(LIST_PANE, e.clientX - rect.left));
      } else {
        setRulesWidth(clampWidth(RULES_PANE, rect.right - e.clientX));
      }
    };
    const onUp = () => setDragging(null);

    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  useEffect(() => {
    localStorage.setItem(LIST_PANE.key, String(listWidth));
  }, [listWidth]);

  useEffect(() => {
    localStorage.setItem(RULES_PANE.key, String(rulesWidth));
  }, [rulesWidth]);

  // Tauri commands reject with the Rust error string, which reads like
  // `create space 401: {...}`. Translate the cases a user can act on and let
  // the caller's fallback cover the rest - never show the raw string.
  const errMsg = (e: unknown, fallback: string) => {
    const raw = typeof e === "string" ? e : "";
    if (raw.includes("not authenticated"))
      return "Sign in on the Account screen first.";
    if (/\b401\b/.test(raw))
      return "Your session expired. Sign in again on the Account screen.";
    if (/\b403\b/.test(raw))
      return "This account does not have access to that.";
    return fallback;
  };

  /* A content item is ours when its key never arrived from anyone else, which
     is the same test the cards use to draw the direction badge. A placeholder
     has no entry left to ask, so it carries the answer on the marker. */
  const itemIsMine = useCallback(
    (item: FeedItem): boolean =>
      item.kind === "removed"
        ? !item.marker.owner_id
        : !remoteKeys.has(
            item.kind === "clipboard"
              ? `clipboard:${item.entry.id}`
              : `note:${item.note.id}`,
          ),
    [remoteKeys],
  );

  const activeFilterCount = useMemo(
    () =>
      selectedKinds.size +
      (datePreset === "any" ? 0 : 1) +
      (ownerFilter !== "any" ? 1 : 0),
    [selectedKinds, datePreset, ownerFilter],
  );

  // What the badge on the funnel cannot say: which filters are on. Same strip
  // and same wording as the clipboard and notes screens.
  const filterNames = useMemo(() => {
    const out = ALL_DISPLAY_KINDS.filter((k) => selectedKinds.has(k)).map(
      (k) => TYPE_LABELS[k],
    );
    if (ownerFilter === "mine") out.push("Mine");
    else if (ownerFilter === "others") out.push("From others");
    if (datePreset === "today") out.push("Today");
    if (datePreset === "7d") out.push("Last 7 days");
    if (datePreset === "range") out.push("Date range");
    return out;
  }, [selectedKinds, datePreset, ownerFilter]);

  const clearAllFilters = useCallback(() => {
    setSelectedKinds(new Set());
    setOwnerFilter("any");
    setDatePreset("any");
    setDateAfter("");
    setDateBefore("");
  }, []);

  const toggleDay = useCallback((label: string) => {
    setCollapsedDays((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }, []);

  const toggleKind = useCallback((k: DisplayKind) => {
    setSelectedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!filtersOpen) return;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node))
        setFiltersOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [filtersOpen]);

  // Both maps move together - a merge changes where an item is and where it
  // came from - so they share one refresh and one set of listeners.
  const refreshShares = useCallback(
    () =>
      Promise.all([
        invoke<Record<string, string[]>>("sync_get_entry_shares")
          .then(setEntryShares)
          .catch(() => {}),
        invoke<string[]>("sync_get_remote_entries")
          .then((keys) => setRemoteKeys(new Set(keys)))
          .catch(() => {}),
        invoke<Record<string, string>>("sync_get_entry_owners")
          .then(setEntryOwners)
          .catch(() => {}),
        invoke<Record<string, DeletedMarker>>("sync_get_deleted_markers")
          .then(setDeletedMarkers)
          .catch(() => {}),
      ]).then(() => {}),
    [],
  );

  // Removing from a space is confirmed the same way a delete is, with its own
  // "Don't ask again". Holds what the copy needs - the space, and how many of
  // the targets are the user's own vs another member's (an owner takedown) so
  // the wording is right for each - and the removal to run once confirmed.
  const [removeConfirm, setRemoveConfirm] = useState<RemoveOrigin | null>(null);

  // Gate a removal behind the confirmation when the preference is on; otherwise
  // run it straight away. Mirrors the delete path's `guardDelete`.
  const guardRemove = useCallback(
    async (origin: Omit<RemoveOrigin, "run">, proceed: () => void) => {
      if (await shouldConfirmSpaceRemove()) {
        setRemoveConfirm({ ...origin, run: proceed });
      } else {
        proceed();
      }
    },
    [],
  );

  // Take an item out of a space. Two callers: the space owner moderating
  // anything here, and a member unsharing something they posted. Neither is a
  // deletion - whoever shared it keeps their own copy, the space stops carrying
  // it, and everyone here gets a placeholder in its place.
  //
  // Sits below `refreshShares` because it needs it: the row leaves the feed on
  // the click and the call itself waits out the Undo toast, so Undo has to put
  // the feed back.
  const handleRemoveFromSpace = useCallback(
    (clientId: string, entryType: "clipboard" | "note") => {
      if (!selected) return;
      const spaceId = selected.id;
      const proceed = () => {
        deferDestructive(
          "Removed from the space",
          async () => {
            try {
              await invoke("space_remove_entry", {
                spaceId,
                clientId,
                entryType,
              });
            } catch (e) {
              setSpaceError(String(e));
              throw e;
            } finally {
              // Re-read before returning: the hint is released the moment this
              // resolves, and the feed goes back to reading the share map.
              await refreshShares();
            }
          },
          {
            key: "space-remove-entry",
            hides: [`share:${entryType}:${clientId}:${spaceId}`],
            errorPrefix: "Could not remove from the space",
          },
        );
      };
      const key = `${entryType}:${clientId}`;
      const received = remoteKeys.has(key);
      void guardRemove(
        {
          spaceName: selected.name,
          mine: received ? 0 : 1,
          received: received ? 1 : 0,
          fromMember: received
            ? (ownerFor(key)?.display_name?.trim() ?? null)
            : null,
        },
        proceed,
      );
    },
    [selected, refreshShares, guardRemove, remoteKeys, ownerFor],
  );

  const refreshInvites = useCallback(() => {
    invoke<SyncInviteList>("sync_list_invites")
      .then(setInvites)
      .catch(() => {});
  }, []);

  // Requests are per space, and only for spaces the server says we may approve
  // for - `i_can_approve` is its answer, not a rule re-derived here. Takes the
  // space list as an argument rather than reading state, so the reload that
  // fetched it can hand it straight over instead of waiting a render.
  const refreshJoinRequests = useCallback((list: Space[]) => {
    const mine = list.filter((sp) => sp.i_can_approve);
    if (mine.length === 0) {
      setJoinRequests([]);
      return;
    }
    Promise.all(
      mine.map((sp) =>
        invoke<SpaceJoinRequest[]>("space_join_requests", {
          spaceId: sp.id,
        }).catch(() => [] as SpaceJoinRequest[]),
      ),
    )
      .then((lists) => setJoinRequests(lists.flat()))
      .catch(() => {});
  }, []);

  const refreshPendingJoins = useCallback(() => {
    invoke<PendingJoin[]>("space_my_join_requests")
      .then(setPendingJoins)
      .catch(() => {});
  }, []);

  // Reads the server and recovers keyrings on the way, so it is the mount
  // path and the answer to a real membership change - not to presence ticks.
  const reloadSpaces = useCallback(() => {
    invoke<Space[]>("spaces_list")
      .then((list) => {
        setSpaces(list);
        setLoaded(true);
        refreshJoinRequests(list);
        refreshPendingJoins();
      })
      .catch(() => setLoaded(true));
  }, [refreshJoinRequests, refreshPendingJoins]);

  // Everything this screen shows that comes from the server. Spaces, members
  // and invites arrive over REST, not the socket, so nothing on screen updates
  // itself while the window is in the background - which is why leaving the
  // screen and coming back used to be the only way to see a change.
  const reloadAll = useCallback(() => {
    reloadSpaces();
    refreshShares();
    refreshInvites();
    invoke<Record<string, SendFilter>>("space_get_send_filters")
      .then(setSendFilters)
      .catch(() => {});
    invoke<{ user_id: string } | null>("sync_get_user")
      .then((u) => setSelfUserId(u?.user_id ?? null))
      .catch(() => setSelfUserId(null));
  }, [reloadSpaces, refreshShares, refreshInvites]);

  useEffect(() => {
    // First visit of the launch: the local list lands in one call, while
    // spaces_list goes to the server and recovers keyrings on the way.
    if (!cache.loaded) {
      invoke<Space[]>("spaces_cached")
        .then((list) => {
          if (list.length > 0)
            setSpaces((cur) => (cur.length > 0 ? cur : list));
        })
        .catch(() => {});
    }
    reloadAll();
  }, [syncConnected, reloadAll]);

  useWindowRefocus(reloadAll, NETWORK_REFOCUS_MS);

  // Auto-copy and the placeholder toggle are per device, so both are read from
  // local settings per space.
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      spaces.map((s) =>
        invoke<boolean | null>("get_setting", { key: `space_autocopy:${s.id}` })
          .then((v) => [s.id, v === true] as const)
          .catch(() => [s.id, false] as const),
      ),
    ).then((pairs) => {
      if (!cancelled) setAutocopy(Object.fromEntries(pairs));
    });
    Promise.all(
      spaces.map((s) =>
        invoke<boolean | null>("get_setting", {
          key: `space_show_removed:${s.id}`,
        })
          .then((v) => [s.id, v !== false] as const)
          .catch(() => [s.id, true] as const),
      ),
    ).then((pairs) => {
      if (!cancelled) setShowRemoved(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [spaces]);

  // Where an item went lives outside the item model, so it needs its own
  // refresh whenever something is pushed or merged.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    for (const event of [
      "sync:history-merged",
      "sync:notes-merged",
      "sync:entry-synced",
      "sync:note-synced",
    ]) {
      listen(event, refreshShares).then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      });
    }
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [refreshShares]);

  // Space events. Presence only moved a dot, so it re-reads the cached list
  // instead of paying for a full reconcile.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    const track = (p: Promise<() => void>) => {
      p.then((fn) => {
        if (cancelled) fn();
        else unlisteners.push(fn);
      });
    };
    track(
      listen("space:presence-changed", () => {
        invoke<Space[]>("spaces_cached")
          .then(setSpaces)
          .catch(() => {});
      }),
    );
    track(listen("space:membership-changed", reloadSpaces));
    // The key landing is the moment a space becomes readable and anything held
    // for it goes out, so it is worth saying rather than leaving the user to
    // notice the notice disappear.
    track(
      listen<{ space_id: string }>("space:key-received", (event) => {
        reloadSpaces();
        const name = spacesRef.current.find(
          (sp) => sp.id === event.payload.space_id,
        )?.name;
        showToast(
          name ? `${name} is ready` : "Space key arrived",
          "success",
          { key: `space-key:${event.payload.space_id}` },
        );
      }),
    );
    // A keyring that does not match what the owner published is refused, not
    // retried: a wrong key unwraps fine and then decrypts nothing, and no amount
    // of waiting turns it into the right one. The owner removing whoever sent it
    // rekeys the space, which is the way out.
    track(
      listen<{ space_id: string }>("space:key-rejected", (event) => {
        const name = spacesRef.current.find(
          (sp) => sp.id === event.payload.space_id,
        )?.name;
        showToast(
          `The key sent for ${name ?? "a space"} does not match the one its owner published, so it was not used.`,
          "error",
          { key: `space-key-bad:${event.payload.space_id}` },
        );
      }),
    );
    track(
      listen<SyncInvite>("sync:invite-received", (event) => {
        setInvites((prev) => ({
          ...prev,
          received: [
            event.payload,
            ...prev.received.filter((i) => i.id !== event.payload.id),
          ],
        }));
      }),
    );
    track(
      listen("sync:invite-updated", () => {
        refreshInvites();
        reloadSpaces();
      }),
    );
    // Somebody used a code or a join link. Only people who may approve are sent
    // this, so anything arriving is ours to answer.
    track(
      listen("sync:join-requested", () => {
        reloadSpaces();
      }),
    );
    // Our own request was answered. An approval carries the Space Key with it,
    // so the space is readable by the time the reload lands - no separate wait.
    track(
      listen<{ space_id: string; status: string }>(
        "sync:join-decided",
        (event) => {
          reloadSpaces();
          refreshPendingJoins();
          if (event.payload.status === "approved") return;
          showToast("Your request to join was turned down.", "error", {
            key: `join-declined:${event.payload.space_id}`,
          });
        },
      ),
    );
    // Answered here or from the notification centre, it is the same invite.
    // Dropped from the list on the spot rather than waiting for the refresh:
    // for the seconds in between, the buttons were still there to be pressed,
    // and pressing Decline on one already accepted is what the server answers
    // with "Invite already accepted".
    track(
      listen<{ invite_id: string }>("sync:invite-answered", (event) => {
        const gone = event.payload.invite_id;
        setInvites((prev) => ({
          sent: prev.sent.filter((i) => i.id !== gone),
          received: prev.received.filter((i) => i.id !== gone),
        }));
        refreshInvites();
        reloadSpaces();
      }),
    );
    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [reloadSpaces, refreshInvites]);

  useEffect(() => {
    setDetailItem(null);
    setSpaceError(null);
  }, [selectedId]);

  // Keep the next visit's starting point current. Assignments only, so it can
  // run every render without a dependency list to keep in sync.
  useEffect(() => {
    cache.loaded = loaded;
    cache.spaces = spaces;
    cache.selfUserId = selfUserId;
    cache.shares = entryShares;
    cache.remote = [...remoteKeys];
    cache.invites = invites;
    cache.filters = sendFilters;
    cache.autocopy = autocopy;
    cache.showRemoved = showRemoved;
  });

  useEffect(() => {
    if (selectedId) localStorage.setItem(SELECTED_KEY, selectedId);
    else localStorage.removeItem(SELECTED_KEY);
  }, [selectedId]);

  // Report the open space to Rust so os_notify can tell "you are reading this
  // space" from "you are elsewhere in the app". Cleared on unmount, so leaving
  // the screen stops counting as viewing any space.
  useEffect(() => {
    invoke("ui_space_changed", { spaceId: selectedId }).catch(() => {});
  }, [selectedId]);
  useEffect(() => {
    return () => {
      invoke("ui_space_changed", { spaceId: null }).catch(() => {});
    };
  }, []);

  // A notification about a space asks us to open that one. The screen is often
  // already mounted (the user was on it, or on another space), so reading
  // localStorage on mount is not enough - this selects it live. Exit any
  // select mode and close an open detail so the target space is what shows.
  useEffect(() => {
    const onFocus = (e: Event) => {
      const id = (e as CustomEvent<{ spaceId?: string }>).detail?.spaceId;
      if (!id) return;
      setSelectedId(id);
      setDetailItem(null);
      multiSelect.exitSelectMode();
    };
    document.addEventListener("spaces:focus", onFocus);
    return () => document.removeEventListener("spaces:focus", onFocus);
    // multiSelect is stable for the life of the screen; exclude to avoid
    // re-subscribing on every selection change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The remembered space may have been deleted or left from another device.
  // Only judge that once the list is real, or a restore would drop itself.
  useEffect(() => {
    if (!loaded || !selectedId) return;
    if (!spaces.some((s) => s.id === selectedId)) setSelectedId(null);
  }, [loaded, spaces, selectedId]);

  // Membership is server truth: an item is in a space when the share record
  // says so. Local group names are tags, and tagging shares nothing.
  const allFeedItems = useMemo((): FeedItem[] => {
    if (!selected) return [];
    const inSpace = (shareKey: string) =>
      !!entryShares[shareKey]?.includes(selected.id) &&
      !pendingGone.has(`share:${shareKey}:${selected.id}`);
    const items: FeedItem[] = [];
    if (feedFilter !== "notes")
      for (const entry of entries)
        if (inSpace(`clipboard:${entry.id}`))
          items.push({ kind: "clipboard", entry });
    if (feedFilter !== "clipboard")
      for (const note of notes)
        if (inSpace(`note:${note.id}`)) items.push({ kind: "note", note });
    // Placeholders for what was taken out. Filtered by the same kind segment as
    // real items, off the key rather than the content it no longer has. The
    // space can turn them off; the records stay, they just stop showing.
    if (placeholdersOn)
      for (const [key, marker] of Object.entries(deletedMarkers)) {
        if (!marker.space_ids.includes(selected.id)) continue;
        const isNote = key.startsWith("note:");
        if (feedFilter === "notes" && !isNote) continue;
        if (feedFilter === "clipboard" && isNote) continue;
        items.push({ kind: "removed", key, marker });
      }
    return items;
  }, [
    selected,
    feedFilter,
    entries,
    notes,
    entryShares,
    pendingGone,
    deletedMarkers,
    placeholdersOn,
  ]);

  /* Everything the other filters leave. Split out so the owner counts can be
     read off the same set the owner filter is about to narrow, rather than
     re-running the type, date and search passes to say what each half holds. */
  const feedPool = useMemo((): FeedItem[] => {
    let pool = allFeedItems;
    // A placeholder has no content, so a type filter or a search can only ever
    // exclude it. Both drop it rather than showing a row that matches nothing.
    if (selectedKinds.size > 0)
      pool = pool.filter(
        (item) =>
          item.kind === "note" ||
          (item.kind === "clipboard" &&
            selectedKinds.has(deriveDisplayKind(item.entry))),
      );
    if (datePreset !== "any") {
      const [from, to] = dateWindow(datePreset, dateAfter, dateBefore);
      pool = pool.filter((item) => {
        const ts = feedTimestamp(item);
        return ts >= from && ts <= to;
      });
    }
    if (search.trim())
      pool = pool.filter(
        (item) => item.kind !== "removed" && matchesSearch(item, search.trim()),
      );
    return pool;
  }, [allFeedItems, selectedKinds, datePreset, dateAfter, dateBefore, search]);

  const ownerCounts = useMemo(() => {
    let mine = 0;
    for (const item of feedPool) if (itemIsMine(item)) mine += 1;
    return { mine, others: feedPool.length - mine };
  }, [feedPool, itemIsMine]);

  const feedItems = useMemo((): FeedItem[] => {
    const pool =
      ownerFilter === "any"
        ? feedPool
        : feedPool.filter((i) => itemIsMine(i) === (ownerFilter === "mine"));

    const sorted = [...pool];
    const getTs = feedTimestamp;
    const getText = (item: FeedItem) =>
      item.kind === "clipboard"
        ? extractNoteText(item.entry.content)
        : item.kind === "note"
          ? item.note.title || ""
          : "";
    switch (sort) {
      case "oldest":
        sorted.sort((a, b) => getTs(a) - getTs(b));
        break;
      case "a-z":
        sorted.sort((a, b) => getText(a).localeCompare(getText(b)));
        break;
      case "z-a":
        sorted.sort((a, b) => getText(b).localeCompare(getText(a)));
        break;
      case "type":
        sorted.sort((a, b) => {
          const kindKey = (i: FeedItem) =>
            i.kind === "note"
              ? "zzz-note"
              : i.kind === "removed"
                ? "zzz-removed"
                : deriveDisplayKind(i.entry);
          return kindKey(a).localeCompare(kindKey(b));
        });
        break;
      default:
        sorted.sort((a, b) => getTs(b) - getTs(a));
    }
    return sorted;
  }, [feedPool, ownerFilter, itemIsMine, sort]);

  // Every key in the feed this account may remove, in the order they are on
  // screen, so shift-click picks the range the user sees.
  const selectableKeys = useMemo(
    () =>
      feedItems
        .filter((i) => i.kind !== "removed")
        .map((i) =>
          i.kind === "clipboard" ? `clipboard:${i.entry.id}` : `note:${i.note.id}`,
        )
        .filter(canRemoveKey),
    [feedItems, canRemoveKey],
  );

  // The bulk half of handleRemoveFromSpace: one toast and one grace period for
  // the whole selection, and every row leaves the feed on the click.
  const handleBulkRemoveFromSpace = useCallback(() => {
    if (!selected) return;
    const spaceId = selected.id;
    const keys = [...multiSelect.selectedIds].filter(canRemoveKey);
    if (keys.length === 0) return;
    multiSelect.exitSelectMode();
    const proceed = () => {
      deferDestructive(
        keys.length === 1
          ? "Removed from the space"
          : `Removed ${keys.length} items from the space`,
        async () => {
          try {
            for (const key of keys) {
              const [entryType, clientId] = splitFeedKey(key);
              await invoke("space_remove_entry", {
                spaceId,
                clientId,
                entryType,
              });
            }
          } catch (e) {
            setSpaceError(String(e));
            throw e;
          } finally {
            // Re-read before returning: the hints are released the moment this
            // resolves, and the feed goes back to reading the share map.
            await refreshShares();
          }
        },
        {
          key: "space-remove-entry",
          hides: keys.map((k) => `share:${k}:${spaceId}`),
          errorPrefix: "Could not remove from the space",
        },
      );
    };
    let mine = 0;
    let received = 0;
    for (const key of keys) {
      if (remoteKeys.has(key)) received += 1;
      else mine += 1;
    }
    // Only name a sender when a single received item is the whole selection.
    const fromMember =
      keys.length === 1 && received === 1
        ? (ownerFor(keys[0])?.display_name?.trim() ?? null)
        : null;
    void guardRemove(
      { spaceName: selected.name, mine, received, fromMember },
      proceed,
    );
  }, [
    selected,
    multiSelect,
    canRemoveKey,
    refreshShares,
    guardRemove,
    remoteKeys,
    ownerFor,
  ]);

  useEffect(() => {
    if (!multiSelect.isSelecting) return;
    multiSelect.pruneStaleIds(new Set(selectableKeys));
  }, [selectableKeys, multiSelect.isSelecting]);

  // A selection is about one space. Switching spaces makes it meaningless.
  useEffect(() => {
    multiSelect.exitSelectMode();
  }, [selectedId]);

  useEffect(() => {
    if (!multiSelect.isSelecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") multiSelect.exitSelectMode();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [multiSelect.isSelecting]);

  /** What each type would leave you with: date and search applied, the type
   *  filter itself excluded. Placeholders have no type, so they sit outside. */
  const kindCounts = useMemo<CountMap>(() => {
    const out: CountMap = {};
    for (const k of ALL_DISPLAY_KINDS) out[k] = 0;
    const [from, to] = dateWindow(datePreset, dateAfter, dateBefore);
    const q = search.trim();
    for (const item of allFeedItems) {
      if (item.kind !== "clipboard") continue;
      const ts = feedTimestamp(item);
      if (datePreset !== "any" && (ts < from || ts > to)) continue;
      if (q && !matchesSearch(item, q)) continue;
      const k = deriveDisplayKind(item.entry);
      if (k in out) out[k] += 1;
    }
    return out;
  }, [allFeedItems, datePreset, dateAfter, dateBefore, search]);

  const sf: FeedFilterState = {
    selectedKinds,
    toggleKind,
    datePreset,
    setDatePreset,
    dateAfter,
    setDateAfter,
    dateBefore,
    setDateBefore,
    ownerFilter,
    setOwnerFilter,
    ownerCounts,
    activeFilterCount,
    clearAll: clearAllFilters,
    filtersOpen,
    setFiltersOpen,
    filterRef,
    matched: feedItems.length,
    total: allFeedItems.length,
    kindCounts,
  };

  const feedByDay = useMemo(() => {
    const days: { label: string; items: FeedItem[] }[] = [];
    let current: { label: string; items: FeedItem[] } | null = null;
    for (const item of feedItems) {
      const label = dayLabel(feedTimestamp(item));
      if (!current || current.label !== label) {
        current = { label, items: [] };
        days.push(current);
      }
      current.items.push(item);
    }
    return days;
  }, [feedItems]);

  // ── Space actions ───────────────────────────────────────────────────

  const handleCreate = useCallback(
    async (name: string, shareHistory: boolean) => {
      setFormLoading(true);
      setListError(null);
      try {
        const space = await invoke<Space>("space_create", {
          name,
          shareHistory,
        });
        // Insert by id, not a blind append: creating a space also lands a
        // `space:membership-changed` over the socket, whose reloadSpaces can
        // replace the list with one that already holds the new space before this
        // runs. A plain append then showed it twice until the next reconcile
        // collapsed it. Replace-or-append keeps the optimistic insert idempotent.
        setSpaces((prev) => [...prev.filter((s) => s.id !== space.id), space]);
        setSelectedId(space.id);
        setShowCreate(false);
      } catch (e) {
        setListError(errMsg(e, "Could not create the space."));
      } finally {
        setFormLoading(false);
      }
    },
    [],
  );

  const handleJoin = useCallback(
    async (inviteCode: string) => {
      setFormLoading(true);
      setListError(null);
      try {
        // A code and a join link both land here, and neither one grants
        // membership: they ask. The space arrives on `sync:join-decided`.
        const out = await invoke<{ status: string; space_name: string }>(
          "space_join",
          { inviteCode },
        );
        setShowJoin(false);
        if (out.status === "declined") {
          setListError(
            `Your request to join ${out.space_name} was turned down.`,
          );
        } else {
          showToast(
            `Asked to join ${out.space_name}. Somebody in it has to let you in.`,
            "success",
          );
        }
        refreshPendingJoins();
        reloadSpaces();
      } catch (e) {
        setListError(errMsg(e, "Could not use that code."));
      } finally {
        setFormLoading(false);
      }
    },
    [reloadSpaces, refreshPendingJoins, showToast],
  );

  // Leaving, deleting and removing a member all reach the server and none of
  // them can be taken back once they have, so the row goes on the click and the
  // call waits out the Undo toast. The space list itself is left alone: hiding
  // it is the pending hint job, which is what makes Undo a no-op and stops a
  // reload landing mid-toast from putting the row back.
  const handleLeave = useCallback(
    (spaceId: string) => {
      setSpaceError(null);
      setSelectedId((cur) => (cur === spaceId ? null : cur));
      deferDestructive(
        "Left the space",
        async () => {
          try {
            await invoke("space_leave", { spaceId });
          } catch (e) {
            setSpaceError(errMsg(e, "Could not leave the space."));
            throw e;
          } finally {
            await reloadSpaces();
          }
        },
        {
          key: "space-membership",
          hides: [`space:${spaceId}`],
          // Reopen it, unless another space was picked while the toast was up.
          onUndo: () => setSelectedId((cur) => cur ?? spaceId),
          errorPrefix: "Could not leave the space",
        },
      );
    },
    [reloadSpaces],
  );

  const handleDelete = useCallback(
    (spaceId: string) => {
      setSpaceError(null);
      setSelectedId((cur) => (cur === spaceId ? null : cur));
      deferDestructive(
        "Space deleted",
        async () => {
          try {
            await invoke("space_delete", { spaceId });
          } catch (e) {
            setSpaceError(errMsg(e, "Could not delete the space."));
            throw e;
          } finally {
            await reloadSpaces();
          }
        },
        {
          key: "space-membership",
          hides: [`space:${spaceId}`],
          onUndo: () => setSelectedId((cur) => cur ?? spaceId),
          errorPrefix: "Could not delete the space",
        },
      );
    },
    [reloadSpaces],
  );

  const handleRemoveMember = useCallback(
    (spaceId: string, memberUserId: string) => {
      setSpaceError(null);
      deferDestructive(
        "Member removed",
        async () => {
          try {
            await invoke("space_remove_member", { spaceId, memberUserId });
          } catch (e) {
            setSpaceError(errMsg(e, "Could not remove the member."));
            throw e;
          } finally {
            await reloadSpaces();
          }
        },
        {
          key: "space-member",
          hides: [`member:${spaceId}:${memberUserId}`],
          errorPrefix: "Could not remove the member",
        },
      );
    },
    [reloadSpaces],
  );

  const handleInvite = useCallback(
    async (spaceId: string, email: string) => {
      setSpaceError(null);
      try {
        await invoke("sync_send_invite", { spaceId, email });
        refreshInvites();
      } catch (e) {
        // `sync_send_invite` already turned the status into a reason the owner
        // can act on, so this shows it instead of guessing from the text - the
        // guess was a regex over the error string, and any rewording on the Rust
        // side quietly turned every reason into the generic fallback. The panel
        // is easy to miss while typing in the field below it, so the same
        // sentence also goes out as a toast.
        const msg = typeof e === "string" && e ? e : "Could not send the invite.";
        setSpaceError(msg);
        showToast(msg, "error");
      }
    },
    [refreshInvites],
  );

  const handleSetAutocopy = useCallback(
    async (spaceId: string, enabled: boolean) => {
      setAutocopy((prev) => ({ ...prev, [spaceId]: enabled }));
      try {
        await invoke("space_set_autocopy", { spaceId, enabled });
      } catch (e) {
        setAutocopy((prev) => ({ ...prev, [spaceId]: !enabled }));
        setSpaceError(errMsg(e, "Could not change auto-copy."));
      }
    },
    [],
  );

  // A view preference for this device, so it goes straight to local settings.
  const handleSetShowRemoved = useCallback(
    (spaceId: string, enabled: boolean) => {
      setShowRemoved((prev) => ({ ...prev, [spaceId]: enabled }));
      invoke("set_setting", {
        key: `space_show_removed:${spaceId}`,
        value: enabled,
      }).catch(() => {});
    },
    [],
  );

  // Owner action, and a server one: the space policy and every current member's
  // history floor live there. The reply is the refreshed list, so the toggle
  // reflects what the server actually stored rather than what was clicked.
  const handleSetShareHistory = useCallback(
    async (spaceId: string, enabled: boolean) => {
      try {
        const next = await invoke<Space[]>("space_set_share_history", {
          spaceId,
          shareHistory: enabled,
        });
        setSpaces(next);
        showToast(
          enabled
            ? "Everyone here can now read earlier items"
            : "New members will only see items from after they join",
          "info",
        );
      } catch (e) {
        setSpaceError(errMsg(e, "Could not change history sharing."));
        toastError("Could not change history sharing", e);
      }
    },
    [],
  );

  const handleSetFilter = useCallback(
    async (spaceId: string, filter: SendFilter) => {
      const previous = sendFilters[spaceId];
      setSendFilters((prev) => ({ ...prev, [spaceId]: filter }));
      try {
        await invoke("space_set_send_filter", { spaceId, filter });
      } catch (e) {
        setSendFilters((prev) => {
          const next = { ...prev };
          if (previous) next[spaceId] = previous;
          else delete next[spaceId];
          return next;
        });
        setSpaceError(errMsg(e, "Could not save the filter."));
      }
    },
    [sendFilters],
  );

  const handleAcceptInvite = useCallback(
    async (inviteId: string) => {
      setListError(null);
      try {
        await invoke("sync_accept_invite", { inviteId });
        refreshInvites();
        reloadSpaces();
      } catch (e) {
        setListError(errMsg(e, "Could not accept the invite."));
      }
    },
    [refreshInvites, reloadSpaces],
  );

  // An invite that is turned down or pulled back is gone for good - the only
  // way back is a fresh one - so both wait out the Undo toast before going.
  const handleDeclineInvite = useCallback(
    (inviteId: string) => {
      deferDestructive(
        "Invite declined",
        async () => {
          try {
            await invoke("sync_decline_invite", { inviteId });
          } catch (e) {
            setListError(errMsg(e, "Could not decline the invite."));
            throw e;
          } finally {
            await refreshInvites();
          }
        },
        {
          key: "space-invite",
          hides: [`invite:${inviteId}`],
          errorPrefix: "Could not decline the invite",
        },
      );
    },
    [refreshInvites],
  );

  const handleRevokeInvite = useCallback(
    (inviteId: string) => {
      deferDestructive(
        "Invite revoked",
        async () => {
          try {
            await invoke("sync_revoke_invite", { inviteId });
          } catch (e) {
            setSpaceError(errMsg(e, "Could not revoke the invite."));
            throw e;
          } finally {
            await refreshInvites();
          }
        },
        {
          key: "space-invite",
          hides: [`invite:${inviteId}`],
          errorPrefix: "Could not revoke the invite",
        },
      );
    },
    [refreshInvites],
  );

  // Approving hands over the Space Key: Rust wraps our ring for the requester's
  // identity key inside the same call, which is why the row carries that key and
  // why the new member can read the space the moment this returns.
  const handleApproveJoin = useCallback(
    async (req: SpaceJoinRequest) => {
      setJoinRequests((prev) => prev.filter((r) => r.id !== req.id));
      try {
        await invoke("space_approve_join", {
          spaceId: req.space_id,
          requestId: req.id,
          identityPubkey: req.identity_pubkey ?? null,
        });
        showToast(
          `${req.display_name || "They"} can read ${req.space_name} now.`,
          "success",
        );
      } catch (e) {
        setListError(errMsg(e, "Could not approve that request."));
      }
      reloadSpaces();
    },
    [reloadSpaces, showToast],
  );

  const handleTurnDownJoin = useCallback(
    async (req: SpaceJoinRequest) => {
      setJoinRequests((prev) => prev.filter((r) => r.id !== req.id));
      try {
        await invoke("space_decline_join", {
          spaceId: req.space_id,
          requestId: req.id,
        });
      } catch (e) {
        setListError(errMsg(e, "Could not turn down that request."));
      }
      reloadSpaces();
    },
    [reloadSpaces],
  );

  const handleMembersCanApprove = useCallback(
    async (spaceId: string, allowed: boolean) => {
      setSpaceError(null);
      // Optimistic: this is a switch, and waiting on the round trip makes it
      // feel like the click missed.
      setSpaces((prev) =>
        prev.map((sp) =>
          sp.id === spaceId ? { ...sp, members_can_approve: allowed } : sp,
        ),
      );
      try {
        await invoke("space_set_members_can_approve", { spaceId, allowed });
      } catch (e) {
        setSpaceError(errMsg(e, "Could not change who can approve."));
        reloadSpaces();
      }
    },
    [reloadSpaces],
  );

  // An invite link the user opened. Joining straight away rather than
  // prefilling the form: they already chose to open the link, and a second
  // confirmation would be a step with nothing behind it.
  useEffect(() => {
    const code = joinCode?.trim();
    if (!code) return;
    onJoinCodeConsumed?.();
    void handleJoin(code);
  }, [joinCode, handleJoin, onJoinCodeConsumed]);

  const receivedPending = invites.received.filter(
    (i) => i.status === "pending" && !pendingGone.has(`invite:${i.id}`),
  );
  const sentPending = invites.sent.filter(
    (i) => i.status === "pending" && !pendingGone.has(`invite:${i.id}`),
  );

  const isFiltering = search.trim().length > 0 || activeFilterCount > 0;
  const feedFilterIndex =
    feedFilter === "all" ? 0 : feedFilter === "clipboard" ? 1 : 2;

  const selectedFilter = selected
    ? (sendFilters[selected.id] ?? DEFAULT_FILTER)
    : DEFAULT_FILTER;

  const leftSlot = (
    <div className="sp-filter-tabs">
      <div className="sp-feed-segment">
        <div
          className="sp-feed-segment-slider"
          style={{ transform: `translateX(${feedFilterIndex * 100}%)` }}
        />
        <button
          className={`sp-feed-seg-btn${feedFilter === "all" ? " sp-feed-seg-btn--active" : ""}`}
          onClick={() => setFeedFilter("all")}
          data-tooltip="All items"
          data-tooltip-pos="below"
        >
          <SquaresFour size={12} weight="regular" />
        </button>
        <button
          className={`sp-feed-seg-btn${feedFilter === "clipboard" ? " sp-feed-seg-btn--active" : ""}`}
          onClick={() => setFeedFilter("clipboard")}
          data-tooltip="Clipboard only"
          data-tooltip-pos="below"
        >
          <Clipboard size={11} />
        </button>
        <button
          className={`sp-feed-seg-btn${feedFilter === "notes" ? " sp-feed-seg-btn--active" : ""}`}
          onClick={() => setFeedFilter("notes")}
          data-tooltip="Notes only"
          data-tooltip-pos="below"
        >
          <NoteIcon size={11} />
        </button>
      </div>
      <div className="cs-toolbar-sep" />
      <SortDropdown
        sort={sort}
        onSortChange={(s) => {
          setSort(s);
          localStorage.setItem("spaces-sort", s);
        }}
      />
      <FeedFilterDropdown sf={sf} feedFilter={feedFilter} />
    </div>
  );

  const rightSlot = (
    <>
      <LayoutSegment
        layout={layout}
        onLayoutChange={(l) => {
          setLayout(l);
          localStorage.setItem("spaces-layout", l);
        }}
        tilesLabel="Cards"
        listLabel="Rows"
        listIcon={<RowsIcon size={12} />}
      />
      {/* Nothing to select in an empty feed, and nothing removable in one
          where everything belongs to other members. */}
      {selectableKeys.length > 0 && (
        <>
          <div className="cs-toolbar-sep" />
          <div className="bulk-select-wrap">
            <button
              className={`cs-tb-btn${multiSelect.isSelecting ? " cs-tb-btn--active" : ""}`}
              onClick={() => {
                document.dispatchEvent(new Event("tooltip:hide"));
                multiSelect.isSelecting
                  ? multiSelect.exitSelectMode()
                  : multiSelect.enterSelectMode();
              }}
              data-tooltip={
                multiSelect.isSelecting
                  ? multiSelect.selectedCount > 0
                    ? `${multiSelect.selectedCount} selected`
                    : "Exit selection"
                  : "Select items"
              }
              data-tooltip-pos="below"
            >
              <MultiSelectIcon size={13} />
              {multiSelect.isSelecting && multiSelect.selectedCount > 0 && (
                <span className="cs-tb-badge">{multiSelect.selectedCount}</span>
              )}
            </button>

            {multiSelect.isSelecting && (
              <BulkActionsBar
                selectedCount={multiSelect.selectedCount}
                totalCount={selectableKeys.length}
                onSelectAll={() => multiSelect.selectAll(selectableKeys)}
                onDeselectAll={multiSelect.deselectAll}
                onExitSelectMode={multiSelect.exitSelectMode}
                onBulkRemoveFromSpace={handleBulkRemoveFromSpace}
              />
            )}
          </div>
        </>
      )}

      {/* Only while this space has placeholders to clear, so the corner does
          not carry a permanently dead button. */}
      {removedCount > 0 && (
        <>
          <div className="cs-toolbar-sep" />
          <button
            className="cs-tb-btn cs-tb-btn--danger"
            onClick={handleClearRemoved}
            aria-label={`Clear ${removedCount} placeholder${removedCount === 1 ? "" : "s"}`}
            data-tooltip="Clear placeholders"
            data-tooltip-pos="below"
          >
            <TrashIcon size={13} />
            <span className="cs-tb-n">{removedCount}</span>
          </button>
        </>
      )}
    </>
  );

  return (
    <div
      className={`sp-screen${dragging ? " sp-screen--dragging" : ""}`}
      ref={screenRef}
    >
      <div className="sp-feed-panel">
        {/* An open item takes the whole panel, so the feed's controls go with
            the feed: searching, sorting and filtering a list that is not on
            screen is chrome nobody can act on. The clipboard and notes screens
            do the same when they open something. */}
        {!detailItem && (
          <Topbar
            leftSlot={leftSlot}
            rightSlot={rightSlot}
            searchQuery={search}
            onSearchChange={setSearch}
            searchPlaceholder="Search in space..."
            searchInputRef={searchRef}
          />
        )}

        {selected ? (
          <CommentsProvider
            spaceId={selected.id}
            members={selected.members}
            selfUserId={selfUserId}
            isOwner={selected.is_owner}
            onCountChange={refreshCommentCounts}
            onRead={markCommentsRead}
          >
            {/* The name, member count and the rules are all on the panel to
                the right, so the only thing worth a line here is what the
                filters left - and only while the feed is what you are looking
                at. */}
            {!detailItem && (
              <ActiveFilterStrip
                names={filterNames}
                matched={feedItems.length}
                total={allFeedItems.length}
                onClear={clearAllFilters}
              />
            )}

            {detailItem ? (
              detailItem.kind === "note" ? (
                <ReadOnlyNotePanel
                  key={detailItem.note.id}
                  note={detailItem.note}
                  entries={entries}
                  onClose={() => setDetailItem(null)}
                  comments={commentMarks.get(
                    commentKey("note", detailItem.note.id),
                  )}
                  owner={ownerFor(`note:${detailItem.note.id}`)}
                  incoming={remoteKeys.has(`note:${detailItem.note.id}`)}
                  onRemove={
                    canRemoveKey(`note:${detailItem.note.id}`)
                      ? () => {
                          const id = detailItem.note.id;
                          setDetailItem(null);
                          handleRemoveFromSpace(id, "note");
                        }
                      : undefined
                  }
                  onDeleteForMe={
                    remoteKeys.has(`note:${detailItem.note.id}`)
                      ? () => {
                          const id = detailItem.note.id;
                          setDetailItem(null);
                          onDeleteNote(id);
                        }
                      : undefined
                  }
                />
              ) : (
                <DetailPanel
                  key={detailItem.entry.id}
                  entry={detailItem.entry}
                  onClose={() => setDetailItem(null)}
                  onCopy={onCopyEntry}
                  comments={commentMarks.get(
                    commentKey("clipboard", detailItem.entry.id),
                  )}
                  owner={ownerFor(`clipboard:${detailItem.entry.id}`)}
                  incoming={remoteKeys.has(
                    `clipboard:${detailItem.entry.id}`,
                  )}
                  onRemove={
                    canRemoveKey(`clipboard:${detailItem.entry.id}`)
                      ? () => {
                          const id = detailItem.entry.id;
                          setDetailItem(null);
                          handleRemoveFromSpace(id, "clipboard");
                        }
                      : undefined
                  }
                  onDeleteForMe={
                    remoteKeys.has(`clipboard:${detailItem.entry.id}`)
                      ? () => {
                          const id = detailItem.entry.id;
                          setDetailItem(null);
                          onDeleteEntry(id);
                        }
                      : undefined
                  }
                />
              )
            ) : (
              <div className="sp-feed-scroll">
                {feedItems.length === 0 ? (
                  <div className="sp-feed-empty">
                    <MagnifyingGlass size={38} />
                    <span className="sp-feed-empty-title">
                      {isFiltering ? "No results" : "Nothing shared yet"}
                    </span>
                    <span className="sp-feed-empty-sub">
                      {search.trim()
                        ? `Nothing matches "${search.trim()}"${activeFilterCount > 0 ? " with current filters" : ""}`
                        : activeFilterCount > 0
                          ? "No items match the current filters"
                          : feedFilter !== "all"
                            ? `No ${feedFilter} items in this space`
                            : "Right-click an item and pick Share to space, or turn on auto-share in space settings."}
                    </span>
                    {activeFilterCount > 0 && (
                      <button
                        className="sp-clear-filters-btn"
                        onClick={clearAllFilters}
                      >
                        Clear filters
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="sp-timeline-wrap">
                    <div className="sp-timeline-groups">
                      {feedByDay.map(({ label, items }, idx) => (
                        <div
                          key={label}
                          className={`sp-timeline-group${
                            feedByDay.length === 1
                              ? " sp-timeline-group--only"
                              : idx === feedByDay.length - 1
                                ? " sp-timeline-group--last"
                                : ""
                          }`}
                        >
                          <button
                            className={`sp-timeline-day-row${collapsedDays.has(label) ? " sp-timeline-day-row--collapsed" : ""}`}
                            onClick={() => toggleDay(label)}
                          >
                            <div className="sp-timeline-day-dot" />
                            <span className="sp-timeline-day-label">
                              {label}
                            </span>
                            {collapsedDays.has(label) && (
                              <span className="sp-timeline-day-count">
                                {items.length}
                              </span>
                            )}
                            <CaretDown
                              className="sp-timeline-day-chevron"
                              size={10}
                            />
                          </button>
                          <div
                            className={`sp-timeline-group-body${collapsedDays.has(label) ? " sp-timeline-group-body--collapsed" : ""}`}
                          >
                            <div className="sp-timeline-group-body__inner">
                              <div
                                className={
                                  layout === "tiles"
                                    ? "sp-feed-card-grid"
                                    : "sp-feed-card-list"
                                }
                              >
                                {items.map((item) =>
                                  item.kind === "removed" ? (
                                    <RemovedRow
                                      key={item.key}
                                      item={item}
                                      owner={removedOwnerFor(item.marker)}
                                      remover={removerFor(item.marker)}
                                      byMe={removedByMe(item.marker)}
                                      isNote={item.key.startsWith("note:")}
                                    />
                                  ) : item.kind === "clipboard" ? (
                                    <ClipFeedCard
                                      key={item.entry.id}
                                      entry={item.entry}
                                      onCopy={onCopyEntry}
                                      onView={(e) =>
                                        setDetailItem({
                                          kind: "clipboard",
                                          entry: e,
                                        })
                                      }
                                      layout={layout}
                                      showSourceBadge={feedFilter === "all"}
                                      incoming={remoteKeys.has(
                                        `clipboard:${item.entry.id}`,
                                      )}
                                      owner={ownerFor(
                                        `clipboard:${item.entry.id}`,
                                      )}
                                      onRemove={
                                        canRemoveKey(
                                          `clipboard:${item.entry.id}`,
                                        )
                                          ? () =>
                                              handleRemoveFromSpace(
                                                item.entry.id,
                                                "clipboard",
                                              )
                                          : undefined
                                      }
                                      onDeleteForMe={
                                        remoteKeys.has(
                                          `clipboard:${item.entry.id}`,
                                        )
                                          ? () => onDeleteEntry(item.entry.id)
                                          : undefined
                                      }
                                      selecting={
                                        multiSelect.isSelecting &&
                                        canRemoveKey(
                                          `clipboard:${item.entry.id}`,
                                        )
                                      }
                                      selected={multiSelect.selectedIds.has(
                                        `clipboard:${item.entry.id}`,
                                      )}
                                      onSelect={(range) =>
                                        range
                                          ? multiSelect.selectRange(
                                              `clipboard:${item.entry.id}`,
                                              selectableKeys,
                                            )
                                          : multiSelect.toggleSelect(
                                              `clipboard:${item.entry.id}`,
                                            )
                                      }
                                      comments={commentMarks.get(
                                        commentKey(
                                          "clipboard",
                                          item.entry.id,
                                        ),
                                      )}
                                    />
                                  ) : (
                                    <NoteFeedCard
                                      key={item.note.id}
                                      note={item.note}
                                      entries={entries}
                                      onView={(n) =>
                                        setDetailItem({ kind: "note", note: n })
                                      }
                                      layout={layout}
                                      showSourceBadge={feedFilter === "all"}
                                      incoming={remoteKeys.has(
                                        `note:${item.note.id}`,
                                      )}
                                      owner={ownerFor(`note:${item.note.id}`)}
                                      onRemove={
                                        canRemoveKey(`note:${item.note.id}`)
                                          ? () =>
                                              handleRemoveFromSpace(
                                                item.note.id,
                                                "note",
                                              )
                                          : undefined
                                      }
                                      onDeleteForMe={
                                        remoteKeys.has(`note:${item.note.id}`)
                                          ? () => onDeleteNote(item.note.id)
                                          : undefined
                                      }
                                      selecting={
                                        multiSelect.isSelecting &&
                                        canRemoveKey(`note:${item.note.id}`)
                                      }
                                      selected={multiSelect.selectedIds.has(
                                        `note:${item.note.id}`,
                                      )}
                                      onSelect={(range) =>
                                        range
                                          ? multiSelect.selectRange(
                                              `note:${item.note.id}`,
                                              selectableKeys,
                                            )
                                          : multiSelect.toggleSelect(
                                              `note:${item.note.id}`,
                                            )
                                      }
                                      comments={commentMarks.get(
                                        commentKey("note", item.note.id),
                                      )}
                                    />
                                  ),
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                      <div className="sp-timeline-end">
                        <span className="sp-timeline-end-text">
                          You are all caught up
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CommentsProvider>
        ) : (
          <div className="sp-no-selection">
            <div className="sp-no-selection-inner">
              <Users size={40} />
              <span className="sp-no-selection-title">
                {spaces.length === 0 ? "No spaces yet" : "Pick a space"}
              </span>
              <span className="sp-no-selection-sub">
                {spaces.length === 0
                  ? "A space shares clipboard items and notes with other people, live and end-to-end encrypted. Create one, or join with an invite code."
                  : "Choose a space on the right to see what is shared in it."}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Rules column: what this space does with items, in and out. Pinned
          rather than collapsible - these are the settings a member checks
          while reading the feed, not a dialog they open once. */}
      {/* Past this width the invite actions have room to say what they do, so
          they stop being icon-only. */}
      <aside
        className={`sp-rules${rulesWidth >= RULES_LABEL_WIDTH ? " sp-rules--wide" : ""}`}
        style={{ width: rulesWidth }}
      >
        <button
          type="button"
          className={`sp-resizer sp-resizer--left${
            dragging === "rules" ? " sp-resizer--active" : ""
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            setDragging("rules");
          }}
          onDoubleClick={() => setRulesWidth(RULES_PANE.def)}
          aria-label="Resize the rules panel"
          data-tooltip="Drag to resize"
          data-tooltip-pos="left"
        />
        {selected ? (
          <SpaceSettings
            space={selected}
            selfUserId={selfUserId}
            autocopy={autocopy[selected.id] === true}
            onAutocopy={(enabled) => handleSetAutocopy(selected.id, enabled)}
            showRemoved={placeholdersOn}
            onShowRemoved={(enabled) =>
              handleSetShowRemoved(selected.id, enabled)
            }
            onShareHistory={(enabled) =>
              handleSetShareHistory(selected.id, enabled)
            }
            onMembersCanApprove={(allowed) =>
              handleMembersCanApprove(selected.id, allowed)
            }
            filter={selectedFilter}
            onFilter={(next) => handleSetFilter(selected.id, next)}
            availableGroups={availableGroups}
            onInvite={(email) => handleInvite(selected.id, email)}
            onRemoveMember={(uid) => handleRemoveMember(selected.id, uid)}
            onLeave={() => handleLeave(selected.id)}
            onDelete={() => handleDelete(selected.id)}
            error={spaceError}
          />
        ) : (
          <RulesPlaceholder hasSpaces={spaces.length > 0} />
        )}
      </aside>

      {/* Space list */}
      <aside className="sp-panel-right" style={{ width: listWidth }}>
        <button
          type="button"
          className={`sp-resizer sp-resizer--right${
            dragging === "list" ? " sp-resizer--active" : ""
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            setDragging("list");
          }}
          onDoubleClick={() => setListWidth(LIST_PANE.def)}
          aria-label="Resize the space list"
          data-tooltip="Drag to resize"
          data-tooltip-pos="right"
        />
        <div className="sp-panel-header">
          <span className="sp-panel-title">Spaces</span>
          <span
            className={`sp-conn-chip sp-conn-chip--${
              !signedIn
                ? "idle"
                : syncConnected === true
                  ? "on"
                  : syncConnected === false
                    ? "off"
                    : "idle"
            }`}
          >
            <span className="sp-conn-dot" />
            {/* Account first: a socket state left over from an earlier session
                said "Live" on a signed-out device. */}
            {!signedIn
              ? "Signed out"
              : syncConnected === true
                ? "Live"
                : syncConnected === false
                  ? "Offline"
                  : "Inactive"}
          </span>
        </div>

        <div className="sp-panel-scroll">
          {listError && (
            <span className="sp-settings-error">{listError}</span>
          )}

          {/* Nothing until the first read answers: "No spaces yet" is a claim,
              and flashing it at someone who has spaces reads as data loss. */}
          {spaces.length === 0 && !loaded ? null : spaces.length === 0 ? (
            <div className="sp-panel-empty">
              <span className="sp-panel-empty-icon">
                <Users size={22} />
              </span>
              <span className="sp-panel-empty-title">
                {!signedIn
                  ? "Not signed in"
                  : syncConnected === false
                    ? "Offline"
                    : "No spaces yet"}
              </span>
              <span className="sp-panel-empty-sub">
                {!signedIn
                  ? "Sign in on the Account screen to share."
                  : syncConnected === false
                    ? "Reconnecting..."
                    : pendingJoins.length > 0
                      ? "Waiting to be let into the space you asked to join."
                      : "Create a space, or join one with an invite code."}
              </span>
            </div>
          ) : (
            <div className="sp-space-section">
              {spaceGroups.map((group) => (
                <React.Fragment key={group.title}>
                  {spaceGroups.length > 1 && (
                    <div className="sp-space-group">
                      {group.title}
                      <span className="sp-space-group-n">
                        {group.spaces.length}
                      </span>
                      <span className="sp-space-group-rule" />
                    </div>
                  )}
                  {group.spaces.map((space) => {
                    const isActive = space.id === selectedId;
                    const online = space.members.filter((m) => m.online).length;
                    const rules = filterRuleCount(sendFilters[space.id]);
                    return (
                      <button
                        key={space.id}
                        className={`sp-space-card${isActive ? " active" : ""}`}
                        onClick={() => setSelectedId(space.id)}
                      >
                        <span
                          className="sp-space-avatar"
                          style={{ background: spaceAvatarColor(space.id) }}
                        >
                          {space.name.slice(0, 2).toUpperCase()}
                        </span>
                        <span className="sp-space-card-body">
                          <span className="sp-space-card-name">
                            {space.name}
                          </span>
                          {/* Two numbers that change, rather than one that does
                          not: who is around, and how much is in here. */}
                          <span className="sp-space-card-meta">
                            {space.members.length > 0
                              ? `${online}/${space.member_count} online`
                              : `${space.member_count} member${space.member_count === 1 ? "" : "s"}`}
                            {" - "}
                            {itemCounts[space.id] ?? 0} item
                            {(itemCounts[space.id] ?? 0) === 1 ? "" : "s"}
                          </span>
                        </span>
                        <span className="sp-space-card-flags">
                          {space.is_owner && (
                            <span className="sp-badge sp-badge--owner">
                              owner
                            </span>
                          )}
                          {autocopy[space.id] && (
                            <span
                              className="sp-flag-dot"
                              data-tooltip="Copies new items to your clipboard"
                              data-tooltip-pos="left"
                            >
                              <Clipboard size={9} />
                            </span>
                          )}
                          {rules > 0 && (
                            <span
                              className="sp-flag-dot"
                              data-tooltip="Shares matching new items automatically"
                              data-tooltip-pos="left"
                            >
                              <Funnel size={9} />
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </React.Fragment>
              ))}

              {pendingJoins.length > 0 && (
                <>
                  <div className="sp-space-group">
                    Waiting
                    <span className="sp-space-group-n">
                      {pendingJoins.length}
                    </span>
                    <span className="sp-space-group-rule" />
                  </div>
                  {pendingJoins.map((p) => (
                    <div
                      key={p.space_id}
                      className="sp-space-card sp-space-card--waiting"
                    >
                      <span
                        className="sp-space-avatar"
                        style={{ background: spaceAvatarColor(p.space_id) }}
                      >
                        {p.space_name.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="sp-space-card-body">
                        <span className="sp-space-card-name">
                          {p.space_name}
                        </span>
                        <span className="sp-space-card-meta">
                          Waiting for someone in this space to let you in
                        </span>
                      </span>
                    </div>
                  ))}
                </>
              )}

            </div>
          )}
        </div>

        <div className="sp-panel-actions">
          {(receivedPending.length > 0 ||
            sentPending.length > 0 ||
            joinRequests.length > 0) && (
            <button
              type="button"
              data-invites-trigger
              className={`sp-invites-btn${invitesOpen ? " active" : ""}`}
              onClick={(e) => {
                const r = (
                  e.currentTarget as HTMLElement
                ).getBoundingClientRect();
                // Centre and top edge: this sits at the foot of the panel, so
                // the popover is centred on the button and grows upward.
                setInvitesAnchor({ x: r.left + r.width / 2, y: r.top });
                setInvitesOpen((v) => !v);
              }}
            >
              Invites
              <span className="sp-invites-count">
                {receivedPending.length +
                  sentPending.length +
                  joinRequests.length}
              </span>
            </button>
          )}
          {showCreate && (
            <CreateForm
              onSubmit={handleCreate}
              onCancel={() => setShowCreate(false)}
              loading={formLoading}
            />
          )}
          {showJoin && (
            <JoinForm
              onSubmit={handleJoin}
              onCancel={() => setShowJoin(false)}
              loading={formLoading}
            />
          )}
          {!showCreate && !showJoin && (
            <div className="sp-panel-btns">
              <button
                className="sp-action-btn sp-action-btn--primary"
                disabled={!signedIn}
                onClick={() => {
                  setShowCreate(true);
                  setShowJoin(false);
                  setListError(null);
                }}
                data-tooltip={
                  signedIn
                    ? "Create a new space"
                    : "Sign in on the Account screen first"
                }
                data-tooltip-pos="top"
              >
                <Plus size={11} />
                Create
              </button>
              <button
                className="sp-action-btn"
                disabled={!signedIn}
                onClick={() => {
                  setShowJoin(true);
                  setShowCreate(false);
                  setListError(null);
                }}
                data-tooltip={
                  signedIn
                    ? "Join with an invite code"
                    : "Sign in on the Account screen first"
                }
                data-tooltip-pos="top"
              >
                <Key size={11} />
                Join
              </button>
            </div>
          )}
        </div>
      </aside>

      <InvitesPopover
        open={invitesOpen}
        anchorX={invitesAnchor.x}
        anchorY={invitesAnchor.y}
        received={receivedPending}
        sent={sentPending}
        requests={joinRequests}
        signedIn={signedIn}
        onClose={() => setInvitesOpen(false)}
        onAccept={handleAcceptInvite}
        onDecline={handleDeclineInvite}
        onRevoke={handleRevokeInvite}
        onApprove={handleApproveJoin}
        onTurnDown={handleTurnDownJoin}
      />

      {/* Same confirmation as a delete, with its own "Don't ask again", so
          taking an item out of a space is not a one-click accident. */}
      <ConfirmDeleteDialog
        open={!!removeConfirm}
        count={removeConfirm ? removeConfirm.mine + removeConfirm.received : 1}
        title={
          removeConfirm && removeConfirm.mine + removeConfirm.received > 1
            ? `Remove ${removeConfirm.mine + removeConfirm.received} items from space?`
            : "Remove from space?"
        }
        confirmLabel="Remove"
        message={removeConfirm ? removeFromSpaceMessage(removeConfirm) : null}
        onCancel={() => setRemoveConfirm(null)}
        onConfirm={(dontAsk) => {
          const pending = removeConfirm;
          setRemoveConfirm(null);
          if (dontAsk) void disableSpaceRemoveConfirm();
          pending?.run();
        }}
      />
    </div>
  );
};

export default SpacesScreen;
