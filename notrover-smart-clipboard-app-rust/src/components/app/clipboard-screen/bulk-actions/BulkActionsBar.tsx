import React, { useEffect, useRef, useState } from "react";
import { groupColor } from "../../../../types";
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
}) => {
  const [groupsOpen, setGroupsOpen] = useState(false);
  const groupsWrapRef = useRef<HTMLDivElement>(null);

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

  const allSelected = selectedCount === totalCount && totalCount > 0;
  const hasGroups = availableGroups.length > 0;

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
        title={allPinned ? "Unpin selected" : "Pin selected"}
      >
        <PinIcon size={10} filled={allPinned} />
        <span>{allPinned ? "Pinned" : "Pin"}</span>
      </button>

      {/* Save chip */}
      <button
        className={`bulk-popup-chip bulk-popup-chip--save${allSaved ? " bulk-popup-chip--save-active" : ""}`}
        onClick={onBulkToggleSave}
        title={allSaved ? "Unsave selected" : "Save selected"}
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
            title="Assign groups"
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

      {/* Thin rule before delete */}
      <div className="bulk-popup-vsep" />

      {/* Delete */}
      <button
        className="bulk-popup-chip bulk-popup-chip--delete"
        onClick={onBulkDelete}
        title="Delete selected"
      >
        <TrashIcon size={10} />
        <span>Delete</span>
      </button>

      {/* Close */}
      <button
        className="bulk-popup-close"
        onClick={onExitSelectMode}
        title="Exit selection mode"
      >
        <CloseIcon size={9} strokeWidth={2.5} />
      </button>
    </div>
  );
};

export default BulkActionsBar;
