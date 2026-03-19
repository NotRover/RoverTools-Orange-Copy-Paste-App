import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ClipboardEntry } from "../../../../types";
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

const CHIP_GAP_PX = 4;

interface ChipBarProps {
  entry: ClipboardEntry;
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
  isTextExpandable: boolean;
  cardRef: React.RefObject<HTMLDivElement | null>;
  justPinned: boolean;
  copied: boolean;
  relTime: string;
}

const ChipBar: React.FC<ChipBarProps> = ({
  entry,
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
  isTextExpandable,
  cardRef,
  justPinned,
  copied,
  relTime,
}) => {
  const [showHiddenGroups, setShowHiddenGroups] = useState(false);
  const [visibleGroupCount, setVisibleGroupCount] = useState(0);

  const footerChipsRef = useRef<HTMLDivElement>(null);
  const groupMeasureRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const typeMeasureRef = useRef<HTMLElement | null>(null);
  const pinMeasureRef = useRef<HTMLSpanElement | null>(null);
  const savedMeasureRef = useRef<HTMLSpanElement | null>(null);
  const clipboardMeasureRef = useRef<HTMLSpanElement | null>(null);
  const overflowMeasureRef = useRef<HTMLButtonElement | null>(null);

  const visibleGroups = displayGroups.slice(0, visibleGroupCount);
  const hiddenGroups = displayGroups.slice(visibleGroupCount);
  const hiddenGroupCount = hiddenGroups.length;

  const measureVisibleGroupCount = useCallback(() => {
    const chipContainer = footerChipsRef.current;
    if (!chipContainer) {
      return;
    }

    const containerWidth = chipContainer.clientWidth;
    if (containerWidth <= 0) {
      setVisibleGroupCount(0);
      return;
    }

    const widthOf = (node: Element | null): number =>
      node ? Math.ceil(node.getBoundingClientRect().width) : 0;

    const baseChipWidths: number[] = [];
    const typeWidth = widthOf(typeMeasureRef.current);
    if (typeWidth > 0) baseChipWidths.push(typeWidth);
    if (entry.pinned) {
      const pinWidth = widthOf(pinMeasureRef.current);
      if (pinWidth > 0) baseChipWidths.push(pinWidth);
    }
    if (entryGroups.includes("Saved")) {
      const savedWidth = widthOf(savedMeasureRef.current);
      if (savedWidth > 0) baseChipWidths.push(savedWidth);
    }
    if (isInClipboard) {
      const clipboardWidth = widthOf(clipboardMeasureRef.current);
      if (clipboardWidth > 0) baseChipWidths.push(clipboardWidth);
    }

    let usedWidth = 0;
    let chipCount = 0;
    for (const width of baseChipWidths) {
      if (chipCount > 0) usedWidth += CHIP_GAP_PX;
      usedWidth += width;
      chipCount += 1;
    }

    const overflowWidth = widthOf(overflowMeasureRef.current);
    const groupWidths = displayGroups.map((_, i) => widthOf(groupMeasureRefs.current[i]));

    let fitCount = 0;
    let fitUsed = usedWidth;
    let fitChips = chipCount;
    for (const width of groupWidths) {
      if (width <= 0) continue;
      const next = fitUsed + (fitChips > 0 ? CHIP_GAP_PX : 0) + width;
      if (next > containerWidth) break;
      fitUsed = next;
      fitChips += 1;
      fitCount += 1;
    }

    if (fitCount >= displayGroups.length) {
      setVisibleGroupCount(displayGroups.length);
      return;
    }

    const overflowWithGap = (chipCount > 0 ? CHIP_GAP_PX : 0) + overflowWidth;
    const budgetForGroups = containerWidth - usedWidth - overflowWithGap;

    if (budgetForGroups <= 0) {
      setVisibleGroupCount(0);
      return;
    }

    let groupsUsed = 0;
    fitCount = 0;
    for (const width of groupWidths) {
      if (width <= 0) continue;
      const next = groupsUsed + (fitCount > 0 ? CHIP_GAP_PX : 0) + width;
      if (next > budgetForGroups) break;
      groupsUsed = next;
      fitCount += 1;
    }

    setVisibleGroupCount(Math.max(0, Math.min(fitCount, displayGroups.length)));
  }, [displayGroups, entry.pinned, entryGroups, isInClipboard]);

  useEffect(() => {
    setShowHiddenGroups(false);
  }, [entry.id, hiddenGroupCount]);

  useLayoutEffect(() => {
    measureVisibleGroupCount();
  }, [measureVisibleGroupCount, relTime, entry.id]);

  useEffect(() => {
    const target = footerChipsRef.current;
    if (!target || typeof ResizeObserver === "undefined") {
      return;
    }
    const ro = new ResizeObserver(() => {
      measureVisibleGroupCount();
    });
    ro.observe(target);
    return () => ro.disconnect();
  }, [measureVisibleGroupCount]);

  useEffect(() => {
    if (!showHiddenGroups) return;
    const handler = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        setShowHiddenGroups(false);
      }
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [showHiddenGroups, cardRef]);

  const renderTypeChip = (withMeasureRef = false) => {
    if (entry.type === "file" && isMulti) {
      return (
        <button
          ref={withMeasureRef ? (typeMeasureRef as React.Ref<HTMLButtonElement>) : undefined}
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
          {!withMeasureRef && (
            <ChevronDownIcon className="card-type-chevron" />
          )}
        </button>
      );
    }

    if (isTextExpandable) {
      const dk = deriveDisplayKind(entry);
      return (
        <button
          ref={withMeasureRef ? (typeMeasureRef as React.Ref<HTMLButtonElement>) : undefined}
          className={`card-type-chip card-type-chip--${dk} card-type-chip--clickable${contentExpanded ? " open" : ""}`}
          onClick={
            withMeasureRef
              ? undefined
              : (e) => {
                  e.stopPropagation();
                  setContentExpanded((v) => !v);
                }
          }
          data-tooltip={withMeasureRef ? undefined : contentExpanded ? "Collapse" : "Expand"}
        >
          {TYPE_ICONS[dk]}
          <span className="card-type-label">{TYPE_LABELS[dk]}</span>
          {!withMeasureRef && (
            <ChevronDownIcon className="card-type-chevron" />
          )}
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
          {renderPinnedChip()}
          {renderSavedChip()}
          {renderClipboardChip()}
          {visibleGroups.length > 0 &&
            visibleGroups.map((g) => renderGroupChip(g, g))}
          {hiddenGroupCount > 0 && (
            <button
              type="button"
              className={`card-type-chip card-type-chip--group-overflow card-type-chip--group-overflow-btn${showHiddenGroups ? " active" : ""}`}
              data-tooltip={
                showHiddenGroups
                  ? "Hide extra groups"
                  : `show ${hiddenGroupCount} more group${hiddenGroupCount > 1 ? "s" : ""}`
              }
              onClick={(e) => {
                e.stopPropagation();
                setShowHiddenGroups((v) => !v);
              }}
              aria-expanded={showHiddenGroups}
            >
              +{hiddenGroupCount}
            </button>
          )}

          {/* Hidden measurer for dynamic chip fitting */}
          <div className="card-chip-measure" aria-hidden>
            {renderTypeChip(true)}
            {renderPinnedChip(true)}
            {renderSavedChip(true)}
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
          <span className="card-time">{relTime}</span>
        )}
      </div>
      {showHiddenGroups && hiddenGroups.length > 0 && (
        <div
          className="card-hidden-groups"
          onClick={(e) => e.stopPropagation()}
        >
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
