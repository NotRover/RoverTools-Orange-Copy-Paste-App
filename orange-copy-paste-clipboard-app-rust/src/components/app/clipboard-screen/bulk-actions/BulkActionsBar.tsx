import React, { useEffect, useRef, useState } from "react";
import { groupColor } from "../../../../types";
import type { Space } from "../../../../types";
import { ShareNetwork, Check, CloudArrowUp, CloudSlash } from "@phosphor-icons/react";
import {
  TrashIcon,
  PinIcon,
  SaveStarIcon,
  TagIcon,
  CloseIcon,
  ChevronDownIcon,
} from "../../../icons";
import "./BulkActionsBar.css";

interface BulkActionsBarProps {
  selectedCount: number;
  totalCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onExitSelectMode: () => void;
  onBulkDelete: () => void;
  allPinned: boolean;
  onBulkTogglePin: () => void;
  allSaved: boolean;
  onBulkToggleSave: () => void;
  onBulkAddGroup: (group: string) => void;
  onBulkRemoveGroup: (group: string) => void;
  availableGroups: string[];
  commonGroups: string[];
  /** Spaces this account belongs to. Empty hides the share chip. */
  spaces?: Space[];
  /** Spaces every selected item is already in. */
  commonSpaceIds?: string[];
  /** Share (or stop sharing) every selected item with one space. */
  onBulkToggleSpace?: (spaceId: string, share: boolean) => void;
  /** Upload the selected items to the account's cloud copy. */
  onBulkSync?: () => void;
  /** Take the selected items off the server, keeping them on this device. */
  onBulkUnsync?: () => void;
}

const BulkActionsBar: React.FC<BulkActionsBarProps> = ({
  selectedCount,
  totalCount,
  onSelectAll,
  onDeselectAll,
  onExitSelectMode,
  onBulkDelete,
  allPinned,
  onBulkTogglePin,
  allSaved,
  onBulkToggleSave,
  onBulkAddGroup,
  onBulkRemoveGroup,
  availableGroups,
  commonGroups,
  spaces = [],
  commonSpaceIds = [],
  onBulkToggleSpace,
  onBulkSync,
  onBulkUnsync,
}) => {
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [spacesOpen, setSpacesOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const groupsWrapRef = useRef<HTMLDivElement>(null);
  const spacesWrapRef = useRef<HTMLDivElement>(null);
  const cloudWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!cloudOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        cloudWrapRef.current &&
        !cloudWrapRef.current.contains(e.target as Node)
      ) {
        setCloudOpen(false);
      }
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [cloudOpen]);

  // Close groups flyout on outside click
  useEffect(() => {
    if (!groupsOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        groupsWrapRef.current &&
        !groupsWrapRef.current.contains(e.target as Node)
      ) {
        setGroupsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [groupsOpen]);

  useEffect(() => {
    if (!groupsOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGroupsOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [groupsOpen]);

  // Same dismiss behaviour as the groups flyout, on the other wrapper.
  useEffect(() => {
    if (!spacesOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        spacesWrapRef.current &&
        !spacesWrapRef.current.contains(e.target as Node)
      ) {
        setSpacesOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSpacesOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onEsc);
    };
  }, [spacesOpen]);

  const allSelected = selectedCount === totalCount && totalCount > 0;
  const hasGroups = availableGroups.length > 0;
  const canShare = spaces.length > 0 && !!onBulkToggleSpace;

  return (
    <div className="bulk-popup">
      {/* Selection info — left side */}
      <span className="bulk-popup-count">
        <strong>{selectedCount}</strong> selected
      </span>

      <button
        className="bulk-popup-toggle"
        onClick={allSelected ? onDeselectAll : onSelectAll}
      >
        {allSelected ? "Deselect all" : "Select all"}
      </button>

      {/* Thin rule */}
      <div className="bulk-popup-vsep" />

      {/* Pin chip */}
      <button
        className={`bulk-popup-chip bulk-popup-chip--pin${allPinned ? " bulk-popup-chip--pin-active" : ""}`}
        onClick={onBulkTogglePin}
        data-tooltip={allPinned ? "Unpin selected" : "Pin selected"}
        data-tooltip-pos="below"
      >
        <PinIcon size={10} filled={allPinned} />
        <span>{allPinned ? "Pinned" : "Pin"}</span>
      </button>

      {/* Save chip */}
      <button
        className={`bulk-popup-chip bulk-popup-chip--save${allSaved ? " bulk-popup-chip--save-active" : ""}`}
        onClick={onBulkToggleSave}
        data-tooltip={allSaved ? "Unsave selected" : "Save selected"}
        data-tooltip-pos="below"
      >
        <SaveStarIcon size={10} filled={allSaved} />
        <span>{allSaved ? "Saved" : "Save"}</span>
      </button>

      {/* Groups chip + flyout */}
      {hasGroups && (
        <div className="bulk-popup-groups-wrap" ref={groupsWrapRef}>
          <button
            className={`bulk-popup-chip${groupsOpen ? " bulk-popup-chip--groups-active" : ""}`}
            onClick={() => setGroupsOpen((v) => !v)}
            data-tooltip="Assign groups"
            data-tooltip-pos="below"
          >
            <TagIcon size={10} strokeWidth={2} />
            <span>Groups</span>
            <ChevronDownIcon
              size={8}
              className={`bulk-popup-chevron${groupsOpen ? " bulk-popup-chevron--open" : ""}`}
            />
          </button>

          {groupsOpen && (
            <div className="bulk-popup-groups-flyout">
              <div className="bulk-popup-flyout-header">
                <TagIcon size={9} strokeWidth={2} />
                <span>Assign Groups</span>
              </div>
              <div className="bulk-popup-flyout-chips">
                {availableGroups.map((group) => {
                  const active = commonGroups.includes(group);
                  const gc = groupColor(group);
                  return (
                    <button
                      key={group}
                      className="bulk-popup-flyout-chip"
                      style={{
                        background: active ? gc.bg : undefined,
                        color: gc.fg,
                      }}
                      onClick={() =>
                        active
                          ? onBulkRemoveGroup(group)
                          : onBulkAddGroup(group)
                      }
                    >
                      <span
                        className="bulk-popup-flyout-dot"
                        style={{ background: gc.fg }}
                      />
                      <span className="bulk-popup-flyout-name">{group}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Share to space chip + flyout */}
      {canShare && (
        <div className="bulk-popup-groups-wrap" ref={spacesWrapRef}>
          <button
            className={`bulk-popup-chip${spacesOpen ? " bulk-popup-chip--groups-active" : ""}`}
            onClick={() => setSpacesOpen((v) => !v)}
            data-tooltip="Share with a space"
            data-tooltip-pos="below"
          >
            <ShareNetwork size={10} />
            <span>Share</span>
            <ChevronDownIcon
              size={8}
              className={`bulk-popup-chevron${spacesOpen ? " bulk-popup-chevron--open" : ""}`}
            />
          </button>

          {spacesOpen && (
            <div className="bulk-popup-groups-flyout">
              <div className="bulk-popup-flyout-header">
                <ShareNetwork size={9} />
                <span>Share to space</span>
              </div>
              <div className="bulk-popup-flyout-spaces">
                {spaces.map((space) => {
                  const active = commonSpaceIds.includes(space.id);
                  return (
                    <button
                      key={space.id}
                      className={`bulk-popup-space-row${active ? " bulk-popup-space-row--active" : ""}`}
                      onClick={() => onBulkToggleSpace?.(space.id, !active)}
                    >
                      <span className="bulk-popup-space-check">
                        {active && <Check size={9} weight="bold" />}
                      </span>
                      <span className="bulk-popup-row-label">{space.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Cloud chip: upload the selection, or take it back off the server. */}
      {(onBulkSync || onBulkUnsync) && (
        <div className="bulk-popup-groups-wrap" ref={cloudWrapRef}>
          <button
            className={`bulk-popup-chip${cloudOpen ? " bulk-popup-chip--groups-active" : ""}`}
            onClick={() => setCloudOpen((v) => !v)}
            data-tooltip="Upload or remove from your account"
            data-tooltip-pos="below"
          >
            <CloudArrowUp size={11} />
            <span>Cloud</span>
            <ChevronDownIcon
              size={8}
              className={`bulk-popup-chevron${cloudOpen ? " bulk-popup-chevron--open" : ""}`}
            />
          </button>

          {cloudOpen && (
            <div className="bulk-popup-groups-flyout">
              <div className="bulk-popup-flyout-header">
                <CloudArrowUp size={9} />
                <span>Cloud copy</span>
              </div>
              <div className="bulk-popup-flyout-spaces">
                <button
                  className="bulk-popup-space-row"
                  onClick={() => {
                    onBulkSync?.();
                    setCloudOpen(false);
                  }}
                >
                  <CloudArrowUp size={11} />
                  <span className="bulk-popup-row-label">Upload to cloud</span>
                </button>
                <button
                  className="bulk-popup-space-row bulk-popup-space-row--danger"
                  onClick={() => {
                    onBulkUnsync?.();
                    setCloudOpen(false);
                  }}
                >
                  <CloudSlash size={11} />
                  <span className="bulk-popup-row-label">Remove from cloud</span>
                </button>
              </div>
              <p className="bulk-popup-flyout-note">
                Removing takes these off your other devices too. The copies here
                stay.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Thin rule before delete */}
      <div className="bulk-popup-vsep" />

      {/* Delete */}
      <button
        className="bulk-popup-chip bulk-popup-chip--delete"
        onClick={onBulkDelete}
        data-tooltip="Delete selected"
        data-tooltip-pos="below"
      >
        <TrashIcon size={10} />
        <span>Delete</span>
      </button>

      {/* Close */}
      <button
        className="bulk-popup-close"
        onClick={onExitSelectMode}
        data-tooltip="Exit selection mode"
        data-tooltip-pos="below"
      >
        <CloseIcon size={9} strokeWidth={2.5} />
      </button>
    </div>
  );
};

export default BulkActionsBar;
