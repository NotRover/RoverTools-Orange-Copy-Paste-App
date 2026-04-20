import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { groupColor } from "../../../types";
import {
  CheckIcon,
  CopyIcon,
  PinIcon,
  SaveStarIcon,
  TagIcon,
  ChevronRightIcon,
  TrashIcon,
  ExpandIcon,
  CollapseIcon,
} from "../../icons";
import "./CardMenu.css";

export interface CardMenuProps {
  open: boolean;
  anchorX: number;
  anchorY: number;
  onClose: () => void;
  isPinned: boolean;
  isSaved: boolean;
  copied: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onPin: (shouldPin: boolean) => void;
  onToggleSave: () => void;
  /** Available user-defined groups. */
  availableGroups: string[];
  /** Groups currently assigned to this entry. */
  entryGroups: string[];
  /** Toggle a group on/off for this entry. */
  onToggleGroup: (group: string) => void;
  /** Whether this entry can be expanded (long text / overflowing html). */
  isExpandable?: boolean;
  /** Whether this entry is currently expanded. */
  isExpanded?: boolean;
  /** Toggle expand / collapse for this entry. */
  onToggleExpand?: () => void;
  /** Show copy action (default true). */
  showCopy?: boolean;
  /** Show save action (default true). */
  showSave?: boolean;
}

const CardMenu: React.FC<CardMenuProps> = ({
  open,
  anchorX,
  anchorY,
  onClose,
  isPinned,
  isSaved,
  copied,
  onCopy,
  onDelete,
  onPin,
  onToggleSave,
  availableGroups,
  entryGroups,
  onToggleGroup,
  isExpandable,
  isExpanded,
  onToggleExpand,
  showCopy = true,
  showSave = true,
}) => {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const groupsRowRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const closeAfter = (fn: () => void) => () => {
    fn();
    onClose();
  };

  // Position the menu at the anchor and adjust for viewport overflow.
  // Uses direct DOM manipulation to avoid a flash at (0,0) on first open.
  useLayoutEffect(() => {
    if (!open || !dropdownRef.current) return;
    const el = dropdownRef.current;
    el.style.left = `${anchorX}px`;
    el.style.top = `${anchorY}px`;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = anchorX;
    let y = anchorY;
    if (rect.bottom > vh) y = Math.max(0, anchorY - rect.height);
    if (rect.top < 0) y = 4;
    if (rect.right > vw) x = Math.max(0, anchorX - rect.width);
    if (rect.left < 0) x = 4;
    if (x !== anchorX || y !== anchorY) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }, [open, anchorX, anchorY]);

  useEffect(() => {
    if (!open) setGroupsOpen(false);
  }, [open]);

  // Position the groups flyout so it doesn't overflow the viewport.
  useLayoutEffect(() => {
    if (!groupsOpen || !flyoutRef.current || !dropdownRef.current) return;
    const flyout = flyoutRef.current;
    const menu = dropdownRef.current;
    const menuRect = menu.getBoundingClientRect();
    const gap = 6;

    // Reset to default (right-side) so we can measure the natural size.
    flyout.style.left = "";
    flyout.style.right = "";
    const flyoutW = flyout.offsetWidth;
    const vw = window.innerWidth;

    if (menuRect.right + gap + flyoutW > vw) {
      // Not enough room on the right — flip to the left side.
      flyout.style.left = "auto";
      flyout.style.right = `calc(100% + ${gap}px)`;
    } else {
      flyout.style.left = `calc(100% + ${gap}px)`;
      flyout.style.right = "auto";
    }
  }, [groupsOpen]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClickOutside, true);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside, true);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [open, onClose]);

  if (!open) return null;

  const hasGroups = availableGroups.length > 0;

  return createPortal(
    <div
      ref={dropdownRef}
      className="card-menu-dropdown"
      style={{ position: "fixed", left: anchorX, top: anchorY }}
      onClick={(e) => e.stopPropagation()}
    >
      {showCopy && (
        <button
          className={`card-menu-item card-menu-item--copy${copied ? " card-menu-item--success" : ""}`}
          onClick={closeAfter(onCopy)}
        >
          {copied ? <CheckIcon size={13} /> : <CopyIcon />}
          <span>{copied ? "Copied!" : "Copy"}</span>
        </button>
      )}

      <button
        className={`card-menu-item card-menu-item--pin${isPinned ? " card-menu-item--pinned" : ""}`}
        onClick={closeAfter(() => onPin(!isPinned))}
      >
        <PinIcon size={13} filled={isPinned} />
        <span>{isPinned ? "Unpin" : "Pin"}</span>
      </button>

      {showSave && (
        <button
          className={`card-menu-item card-menu-item--save${isSaved ? " card-menu-item--saved" : ""}`}
          onClick={closeAfter(onToggleSave)}
        >
          <SaveStarIcon size={13} filled={isSaved} />
          <span>{isSaved ? "Unsave" : "Save"}</span>
        </button>
      )}

      {/* Groups submenu */}
      {hasGroups && (
        <>
          {/* <div className="card-menu-separator" /> */}
          <div className="card-menu-groups-wrapper">
            <button
              ref={groupsRowRef}
              className={`card-menu-item card-menu-item--groups-toggle${groupsOpen ? " card-menu-item--groups-toggle-active" : ""}`}
              onClick={() => setGroupsOpen((v) => !v)}
            >
              <TagIcon />
              <span style={{ flex: 1 }}>Groups</span>
              <ChevronRightIcon
                className={`card-menu-chevron${groupsOpen ? " card-menu-chevron--open" : ""}`}
              />
            </button>
            {groupsOpen && (
              <div ref={flyoutRef} className="card-menu-groups-flyout">
                <div className="card-menu-groups-flyout-header">
                  <span>Groups</span>
                </div>
                <div className="card-menu-groups-flyout-body">
                  {availableGroups.map((group) => {
                    const active = entryGroups.includes(group);
                    const gc = groupColor(group);
                    return (
                      <button
                        key={group}
                        className={`card-menu-group-chip${active ? " card-menu-group-chip--active" : ""}`}
                        style={
                          active
                            ? { background: gc.bg, color: gc.fg }
                            : undefined
                        }
                        onClick={() => onToggleGroup(group)}
                      >
                        <span
                          className="card-menu-group-dot"
                          style={{ background: gc.fg }}
                        />
                        <span className="card-menu-group-chip-name">
                          {group}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Expand / Collapse */}
      {isExpandable && onToggleExpand && (
        <button
          className="card-menu-item card-menu-item--expand"
          onClick={closeAfter(onToggleExpand)}
        >
          {isExpanded ? <CollapseIcon size={13} /> : <ExpandIcon size={13} />}
          <span>{isExpanded ? "Collapse" : "Expand"}</span>
        </button>
      )}

      <div className="card-menu-separator" />

      <button
        className="card-menu-item card-menu-item--danger"
        onClick={closeAfter(onDelete)}
      >
        <TrashIcon />
        <span>Delete</span>
      </button>
    </div>,
    document.body,
  );
};

export default CardMenu;
