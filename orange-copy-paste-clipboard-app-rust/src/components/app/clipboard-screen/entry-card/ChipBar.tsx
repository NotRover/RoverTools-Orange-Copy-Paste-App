import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ClipboardEntry } from "../../../../types";
import type { EntrySyncState } from "../../../../hooks/useEntrySyncStates";
import type { EntryOwner } from "../../../../hooks/useEntryOwners";
import OwnerChip from "./OwnerChip";
import { deriveDisplayKind, groupColor } from "../../../../types";
import {
  ImageIcon,
  FileIcon,
  PinIcon,
  SaveIcon,
  EntryTypePill,
  TYPE_ICONS,
  TYPE_LABELS,
} from "../../../entry-types/EntryTypePill";
import { ChevronDownIcon, CheckIcon, ClipboardIcon } from "../../../icons";
import { CloudArrowUp, CloudCheck } from "@phosphor-icons/react";
import { ShareNetwork } from "@phosphor-icons/react";

const CHIP_GAP_PX = 4;

interface ChipBarProps {
  entry: ClipboardEntry;
  /** Cloud badge state, resolved from Rust's sync bookkeeping. */
  syncState?: EntrySyncState;
  entryGroups: string[];
  displayGroups: string[];
  isInClipboard: boolean;
  isMulti: boolean;
  files: string[];
  imageFiles: string[];
  showFileList: boolean;
  setShowFileList: React.Dispatch<React.SetStateAction<boolean>>;
  contentExpanded: boolean;
  setContentExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  isExpandable: boolean;
  cardRef: React.RefObject<HTMLDivElement | null>;
  justPinned: boolean;
  copied: boolean;
  relTime: string;
  /** Spaces this entry is shared into, by name. Empty means personal only. */
  sharedSpaceNames?: string[];
  /** Set only when the entry arrived from another member. */
  owner?: EntryOwner;
}

const ChipBar: React.FC<ChipBarProps> = ({
  entry,
  syncState,
  entryGroups,
  displayGroups,
  isInClipboard,
  isMulti,
  files,
  imageFiles,
  showFileList,
  setShowFileList,
  contentExpanded,
  setContentExpanded,
  isExpandable,
  cardRef,
  justPinned,
  copied,
  relTime,
  sharedSpaceNames = [],
  owner,
}) => {
  const [showHiddenChips, setShowHiddenChips] = useState(false);
  const [visibleBaseCount, setVisibleBaseCount] = useState(0);
  const [visibleGroupCount, setVisibleGroupCount] = useState(0);

  const footerChipsRef = useRef<HTMLDivElement>(null);
  const groupMeasureRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const typeMeasureRef = useRef<HTMLElement | null>(null);
  const pinMeasureRef = useRef<HTMLSpanElement | null>(null);
  const savedMeasureRef = useRef<HTMLSpanElement | null>(null);
  const clipboardMeasureRef = useRef<HTMLSpanElement | null>(null);
  const overflowMeasureRef = useRef<HTMLButtonElement | null>(null);
  const ownerMeasureRef = useRef<HTMLSpanElement | null>(null);

  // Build an ordered list of optional base chips (excluding type, which always shows)
  const optionalBases: Array<{
    key: "pinned" | "saved" | "clipboard";
    width: 0;
  }> = [];
  if (entryGroups.includes("Saved"))
    optionalBases.push({ key: "saved", width: 0 });
  if (entry.pinned) optionalBases.push({ key: "pinned", width: 0 });
  if (isInClipboard) optionalBases.push({ key: "clipboard", width: 0 });

  const visibleBases = optionalBases.slice(0, visibleBaseCount);
  const hiddenBases = optionalBases.slice(visibleBaseCount);
  const visibleGroups = displayGroups.slice(0, visibleGroupCount);
  const hiddenGroups = displayGroups.slice(visibleGroupCount);
  const totalHiddenCount = hiddenBases.length + hiddenGroups.length;

  const measureChipOverflow = useCallback(() => {
    const chipContainer = footerChipsRef.current;
    if (!chipContainer) return;

    const ownerNode = ownerMeasureRef.current;
    const ownerWidth = ownerNode
      ? Math.ceil(ownerNode.getBoundingClientRect().width) + CHIP_GAP_PX
      : 0;
    const containerWidth = chipContainer.clientWidth - ownerWidth;
    if (containerWidth <= 0) {
      setVisibleBaseCount(0);
      setVisibleGroupCount(0);
      return;
    }

    const widthOf = (node: Element | null): number =>
      node ? Math.ceil(node.getBoundingClientRect().width) : 0;

    // Type chip always visible
    const typeWidth = widthOf(typeMeasureRef.current);
    let typeUsed = typeWidth > 0 ? typeWidth : 0;

    // Measure optional base chips
    // Same order as `optionalBases` above - the counts index into both.
    const baseWidths: number[] = [];
    if (entryGroups.includes("Saved"))
      baseWidths.push(widthOf(savedMeasureRef.current));
    if (entry.pinned) baseWidths.push(widthOf(pinMeasureRef.current));
    if (isInClipboard) baseWidths.push(widthOf(clipboardMeasureRef.current));

    const overflowWidth = widthOf(overflowMeasureRef.current);
    const groupWidths = displayGroups.map((_, i) =>
      widthOf(groupMeasureRefs.current[i]),
    );

    // All optional chip widths in order: bases then groups
    const allOptionalWidths = [...baseWidths, ...groupWidths];

    // Try fitting everything (no overflow button needed)
    let fitAll = true;
    let tempUsed = typeUsed;
    let tempChips = typeUsed > 0 ? 1 : 0;
    for (const w of allOptionalWidths) {
      if (w <= 0) continue;
      const next = tempUsed + (tempChips > 0 ? CHIP_GAP_PX : 0) + w;
      if (next > containerWidth) {
        fitAll = false;
        break;
      }
      tempUsed = next;
      tempChips++;
    }

    if (fitAll) {
      setVisibleBaseCount(baseWidths.length);
      setVisibleGroupCount(displayGroups.length);
      return;
    }

    // Not everything fits — reserve space for overflow button
    const overflowReserve = (typeUsed > 0 ? CHIP_GAP_PX : 0) + overflowWidth;
    let budget = containerWidth - typeUsed - overflowReserve;

    if (budget <= 0) {
      setVisibleBaseCount(0);
      setVisibleGroupCount(0);
      return;
    }

    // Fit base chips first, then group chips
    let baseFit = 0;
    let fitCount = 0;
    for (const w of baseWidths) {
      if (w <= 0) {
        baseFit++;
        continue;
      }
      const needed = (fitCount > 0 ? CHIP_GAP_PX : 0) + w;
      if (needed > budget) break;
      budget -= needed;
      fitCount++;
      baseFit++;
    }

    let groupFit = 0;
    for (const w of groupWidths) {
      if (w <= 0) continue;
      const needed = (fitCount > 0 ? CHIP_GAP_PX : 0) + w;
      if (needed > budget) break;
      budget -= needed;
      fitCount++;
      groupFit++;
    }

    setVisibleBaseCount(baseFit);
    setVisibleGroupCount(Math.max(0, Math.min(groupFit, displayGroups.length)));
  }, [displayGroups, entry.pinned, entryGroups, isInClipboard, owner]);

  useEffect(() => {
    setShowHiddenChips(false);
  }, [entry.id, totalHiddenCount]);

  useLayoutEffect(() => {
    measureChipOverflow();
  }, [measureChipOverflow, relTime, entry.id]);

  useEffect(() => {
    const target = footerChipsRef.current;
    if (!target || typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(() => {
      measureChipOverflow();
    });
    ro.observe(target);
    return () => ro.disconnect();
  }, [measureChipOverflow]);

  useEffect(() => {
    if (!showHiddenChips) return;
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        setShowHiddenChips(false);
      }
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [showHiddenChips, cardRef]);

  const renderTypeChip = (withMeasureRef = false) => {
    if (entry.type === "file" && isMulti) {
      return (
        <button
          ref={
            withMeasureRef
              ? (typeMeasureRef as React.Ref<HTMLButtonElement>)
              : undefined
          }
          className={`card-type-chip card-type-chip--file card-type-chip--clickable${showFileList ? " open" : ""}`}
          onClick={
            withMeasureRef
              ? undefined
              : (e) => {
                  e.stopPropagation();
                  setShowFileList((v) => !v);
                }
          }
          data-tooltip={
            withMeasureRef
              ? undefined
              : showFileList
                ? "Collapse"
                : `Show ${files.length} ${imageFiles.length === files.length ? "images" : "files"}`
          }
        >
          {imageFiles.length === files.length ? ImageIcon : FileIcon}
          <span className="card-type-label">
            {imageFiles.length === files.length ? "Images" : "Files"}
          </span>
          {!withMeasureRef && <ChevronDownIcon className="card-type-chevron" />}
        </button>
      );
    }

    if (isExpandable) {
      const dk = deriveDisplayKind(entry);
      return (
        <button
          ref={
            withMeasureRef
              ? (typeMeasureRef as React.Ref<HTMLButtonElement>)
              : undefined
          }
          className={`card-type-chip card-type-chip--${dk} card-type-chip--clickable${contentExpanded ? " open" : ""}`}
          onClick={
            withMeasureRef
              ? undefined
              : (e) => {
                  e.stopPropagation();
                  setContentExpanded((v) => !v);
                }
          }
          data-tooltip={
            withMeasureRef ? undefined : contentExpanded ? "Collapse" : "Expand"
          }
        >
          {TYPE_ICONS[dk]}
          <span className="card-type-label">{TYPE_LABELS[dk]}</span>
          {!withMeasureRef && <ChevronDownIcon className="card-type-chevron" />}
        </button>
      );
    }

    if (withMeasureRef) {
      return (
        <span ref={typeMeasureRef as React.Ref<HTMLSpanElement>}>
          <EntryTypePill kind={deriveDisplayKind(entry)} />
        </span>
      );
    }
    return <EntryTypePill kind={deriveDisplayKind(entry)} />;
  };

  const renderPinnedChip = (withMeasureRef = false) =>
    entry.pinned ? (
      <span
        ref={withMeasureRef ? pinMeasureRef : undefined}
        className="card-type-chip card-type-chip--pinned"
      >
        {PinIcon}
        <span className="card-type-label">Pinned</span>
      </span>
    ) : null;

  const renderSavedChip = (withMeasureRef = false) =>
    entryGroups.includes("Saved") ? (
      <span
        ref={withMeasureRef ? savedMeasureRef : undefined}
        className="card-type-chip card-type-chip--saved"
      >
        {SaveIcon}
        <span className="card-type-label">Saved</span>
      </span>
    ) : null;

  const renderClipboardChip = (withMeasureRef = false) =>
    isInClipboard ? (
      <span
        ref={withMeasureRef ? clipboardMeasureRef : undefined}
        className="card-type-chip card-type-chip--in-clipboard"
      >
        <ClipboardIcon size={9} strokeWidth={2.5} />
        <span className="card-type-label">In clipboard</span>
      </span>
    ) : null;

  const renderGroupChip = (
    group: string,
    key: string,
    measureIndex?: number,
  ) => {
    const gc = groupColor(group);
    return (
      <span
        key={key}
        ref={
          measureIndex !== undefined
            ? (node) => {
                groupMeasureRefs.current[measureIndex] = node;
              }
            : undefined
        }
        className="card-type-chip card-type-chip--group"
        style={{ background: gc.bg, color: gc.fg }}
      >
        <span className="card-group-dot" />
        <span className="card-type-label">{group}</span>
      </span>
    );
  };

  return (
    <>
      <div className="card-footer">
        <div className="card-chips" ref={footerChipsRef}>
          {renderTypeChip()}
          {visibleBases.some((b) => b.key === "saved") && renderSavedChip()}
          {visibleBases.some((b) => b.key === "pinned") && renderPinnedChip()}
          {visibleBases.some((b) => b.key === "clipboard") &&
            renderClipboardChip()}
          {owner && (
            <span ref={ownerMeasureRef} className="card-owner-slot">
              <OwnerChip owner={owner} />
            </span>
          )}
          {visibleGroups.length > 0 &&
            visibleGroups.map((g) => renderGroupChip(g, g))}
          {totalHiddenCount > 0 && (
            <button
              type="button"
              className={`card-type-chip card-type-chip--group-overflow card-type-chip--group-overflow-btn${showHiddenChips ? " active" : ""}`}
              data-tooltip={
                showHiddenChips ? "Hide" : `show ${totalHiddenCount} more`
              }
              onClick={(e) => {
                e.stopPropagation();
                setShowHiddenChips((v) => !v);
              }}
              aria-expanded={showHiddenChips}
            >
              +{totalHiddenCount}
            </button>
          )}

          {/* Hidden measurer for dynamic chip fitting */}
          <div className="card-chip-measure" aria-hidden>
            {renderTypeChip(true)}
            {renderSavedChip(true)}
            {renderPinnedChip(true)}
            {renderClipboardChip(true)}
            {displayGroups.map((g, idx) =>
              renderGroupChip(g, `measure-${g}-${idx}`, idx),
            )}
            <button
              ref={overflowMeasureRef}
              type="button"
              className="card-type-chip card-type-chip--group-overflow card-type-chip--group-overflow-btn"
            >
              +99
            </button>
          </div>
        </div>
        {sharedSpaceNames.length > 0 && (
          <span
            className="card-share-icon"
            data-tooltip={`Shared to ${sharedSpaceNames.join(", ")}`}
          >
            <ShareNetwork size={15} />
            {sharedSpaceNames.length > 1 && (
              <span className="card-share-count">
                {sharedSpaceNames.length}
              </span>
            )}
          </span>
        )}
        {syncState === "synced" && (
          <span
            className="card-sync-icon card-sync-icon--synced"
            data-tooltip="Synced"
          >
            <CloudCheck size={15} />
          </span>
        )}
        {syncState === "pending" && (
          <span
            className="card-sync-icon card-sync-icon--pending"
            data-tooltip="Waiting to upload"
          >
            <CloudArrowUp size={15} />
          </span>
        )}
        {justPinned ? (
          <span className="card-time card-time--pinned">
            {PinIcon}
            Pinned
          </span>
        ) : copied ? (
          <span className="card-time card-time--copied">
            <CheckIcon size={9} strokeWidth={2.8} />
            Copied
          </span>
        ) : (
          <span className="card-time card-time--pinned">
            {entry.pinned && PinIcon}
            {relTime}
          </span>
        )}
      </div>
      {showHiddenChips && totalHiddenCount > 0 && (
        <div
          className="card-hidden-groups"
          onClick={(e) => e.stopPropagation()}
        >
          {hiddenBases.some((b) => b.key === "saved") && renderSavedChip()}
          {hiddenBases.some((b) => b.key === "pinned") && renderPinnedChip()}
          {hiddenBases.some((b) => b.key === "clipboard") &&
            renderClipboardChip()}
          {hiddenGroups.map((g) => {
            const gc = groupColor(g);
            return (
              <span
                key={g}
                className="card-type-chip card-type-chip--group"
                style={{ background: gc.bg, color: gc.fg }}
              >
                <span className="card-group-dot" />
                <span className="card-type-label">{g}</span>
              </span>
            );
          })}
        </div>
      )}
    </>
  );
};

export default ChipBar;
