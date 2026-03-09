import React, { useEffect, useRef, useState } from "react";
import { groupColor } from "../../../../types";
import {
  TrashIcon,
  PinIcon,
  SaveStarIcon,
  TagIcon,
  CloseIcon,
  CheckIcon,
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
  const groupsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!groupsOpen) return;
    const handler = (e: MouseEvent) => {
      if (groupsRef.current && !groupsRef.current.contains(e.target as Node)) {
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
    <div className="bulk-bar" ref={groupsRef}>
      {/* Top row: actions */}
      <div className="bulk-bar-row">
        {/* Left: close + count + select all */}
        <button className="bulk-bar-close" onClick={onExitSelectMode}>
          <CloseIcon size={10} strokeWidth={2.5} />
        </button>
        <span className="bulk-bar-count">{selectedCount} selected</span>
        <button
          className="bulk-bar-link"
          onClick={allSelected ? onDeselectAll : onSelectAll}
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>

        {/* Right: action buttons */}
        <div className="bulk-bar-actions">
          <button
            className={`bulk-bar-chip bulk-bar-chip--pin${allPinned ? " bulk-bar-chip--active" : ""}`}
            onClick={onBulkTogglePin}
          >
            <PinIcon size={10} filled={allPinned} />
            <span>{allPinned ? "Unpin" : "Pin"}</span>
          </button>

          <button
            className={`bulk-bar-chip bulk-bar-chip--save${allSaved ? " bulk-bar-chip--active" : ""}`}
            onClick={onBulkToggleSave}
          >
            <SaveStarIcon size={10} filled={allSaved} />
            <span>{allSaved ? "Unsave" : "Save"}</span>
          </button>

          {hasGroups && (
            <button
              className={`bulk-bar-chip bulk-bar-chip--groups${groupsOpen ? " bulk-bar-chip--active" : ""}`}
              onClick={() => setGroupsOpen((v) => !v)}
            >
              <TagIcon size={10} strokeWidth={2} />
              <span>Groups</span>
              <ChevronDownIcon size={9} className={`bulk-bar-chevron${groupsOpen ? " bulk-bar-chevron--open" : ""}`} />
            </button>
          )}

          <button
            className="bulk-bar-chip bulk-bar-chip--delete"
            onClick={onBulkDelete}
          >
            <TrashIcon size={10} />
            <span>Delete</span>
          </button>
        </div>
      </div>

      {/* Inline group chips row */}
      {groupsOpen && (
        <div className="bulk-bar-groups-row">
          {availableGroups.map((group) => {
            const active = commonGroups.includes(group);
            const gc = groupColor(group);
            return (
              <button
                key={group}
                className="card-menu-group-chip"
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
                  className="card-menu-group-dot"
                  style={{ background: gc.fg }}
                />
                <span className="card-menu-group-chip-name">{group}</span>
                <span className="bulk-bar-chip-check">
                  {active && <CheckIcon size={9} strokeWidth={2.8} />}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default BulkActionsBar;
