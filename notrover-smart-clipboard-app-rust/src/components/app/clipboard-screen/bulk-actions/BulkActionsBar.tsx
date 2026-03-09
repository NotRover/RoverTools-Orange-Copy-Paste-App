import React, { useEffect, useRef, useState } from "react";
import { groupColor } from "../../../../types";
import {
  TrashIcon,
  PinIcon,
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
  onBulkPin: () => void;
  onBulkUnpin: () => void;
  onBulkAddGroup: (group: string) => void;
  onBulkRemoveGroup: (group: string) => void;
  availableGroups: string[];
  /** Groups common to ALL selected entries (for showing active state). */
  commonGroups: string[];
}

const BulkActionsBar: React.FC<BulkActionsBarProps> = ({
  selectedCount,
  totalCount,
  onSelectAll,
  onDeselectAll,
  onExitSelectMode,
  onBulkDelete,
  onBulkPin,
  onBulkUnpin,
  onBulkAddGroup,
  onBulkRemoveGroup,
  availableGroups,
  commonGroups,
}) => {
  const [groupsOpen, setGroupsOpen] = useState(false);
  const groupsRef = useRef<HTMLDivElement>(null);

  // Close groups flyout on outside click
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

  // Close groups flyout on Escape
  useEffect(() => {
    if (!groupsOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGroupsOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [groupsOpen]);

  const allSelected = selectedCount === totalCount && totalCount > 0;

  return (
    <div className="bulk-actions-bar">
      <div className="bulk-actions-left">
        <button
          className="bulk-actions-close"
          onClick={onExitSelectMode}
          data-tooltip="Exit selection"
          data-tooltip-pos="above"
        >
          <CloseIcon size={12} strokeWidth={2.5} />
        </button>

        <span className="bulk-actions-count">
          {selectedCount} selected
        </span>

        <button
          className="bulk-actions-select-toggle"
          onClick={allSelected ? onDeselectAll : onSelectAll}
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>
      </div>

      <div className="bulk-actions-right">
        {/* Pin */}
        <button
          className="bulk-actions-btn"
          onClick={onBulkPin}
          data-tooltip="Pin selected"
          data-tooltip-pos="above"
        >
          <PinIcon size={12} />
          <span className="bulk-actions-btn-label">Pin</span>
        </button>

        {/* Unpin */}
        <button
          className="bulk-actions-btn"
          onClick={onBulkUnpin}
          data-tooltip="Unpin selected"
          data-tooltip-pos="above"
        >
          <PinIcon size={12} filled />
          <span className="bulk-actions-btn-label">Unpin</span>
        </button>

        {/* Groups */}
        {availableGroups.length > 0 && (
          <div className="bulk-actions-groups-wrap" ref={groupsRef}>
            <button
              className={`bulk-actions-btn${groupsOpen ? " bulk-actions-btn--active" : ""}`}
              onClick={() => setGroupsOpen((v) => !v)}
              data-tooltip="Assign groups"
              data-tooltip-pos="above"
            >
              <TagIcon size={11} strokeWidth={2} />
              <span className="bulk-actions-btn-label">Groups</span>
              <ChevronDownIcon
                size={9}
                strokeWidth={2.5}
                className={`bulk-actions-groups-chevron${groupsOpen ? " bulk-actions-groups-chevron--open" : ""}`}
              />
            </button>
            {groupsOpen && (
              <div className="bulk-actions-groups-flyout">
                <div className="bulk-actions-groups-flyout-header">
                  Assign to group
                </div>
                <div className="bulk-actions-groups-flyout-body">
                  {availableGroups.map((group) => {
                    const active = commonGroups.includes(group);
                    const gc = groupColor(group);
                    return (
                      <button
                        key={group}
                        className={`bulk-actions-group-chip${active ? " bulk-actions-group-chip--active" : ""}`}
                        style={
                          active
                            ? { background: gc.bg, color: gc.fg }
                            : undefined
                        }
                        onClick={() =>
                          active
                            ? onBulkRemoveGroup(group)
                            : onBulkAddGroup(group)
                        }
                      >
                        <span
                          className="bulk-actions-group-dot"
                          style={{ background: gc.fg }}
                        />
                        <span className="bulk-actions-group-name">{group}</span>
                        {active && <CheckIcon size={10} strokeWidth={2.8} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Delete */}
        <button
          className="bulk-actions-btn bulk-actions-btn--danger"
          onClick={onBulkDelete}
          data-tooltip="Delete selected"
          data-tooltip-pos="above"
        >
          <TrashIcon size={12} />
          <span className="bulk-actions-btn-label">Delete</span>
        </button>
      </div>
    </div>
  );
};

export default BulkActionsBar;
