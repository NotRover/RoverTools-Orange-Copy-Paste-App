import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { groupColor } from "../../../types";
import "./CardMenu.css";

export interface CardMenuProps {
  open: boolean;
  anchorX: number;
  anchorY: number;
  onClose: () => void;
  isPinned: boolean;
  isPersistent: boolean;
  copied: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onPin: (shouldPin: boolean) => void;
  onTogglePersistent: () => void;
  /** Available user-defined groups. */
  availableGroups: string[];
  /** Groups currently assigned to this entry. */
  entryGroups: string[];
  /** Toggle a group on/off for this entry. */
  onToggleGroup: (group: string) => void;
}

const CardMenu: React.FC<CardMenuProps> = ({
  open,
  anchorX,
  anchorY,
  onClose,
  isPinned,
  isPersistent,
  copied,
  onCopy,
  onDelete,
  onPin,
  onTogglePersistent,
  availableGroups,
  entryGroups,
  onToggleGroup,
}) => {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const groupsRowRef = useRef<HTMLButtonElement>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const closeAfter = (fn: () => void) => () => {
    fn();
    onClose();
  };

  useEffect(() => {
    if (!open) setGroupsOpen(false);
  }, [open]);

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
      <button
        className={`card-menu-item card-menu-item--copy${copied ? " card-menu-item--success" : ""}`}
        onClick={closeAfter(onCopy)}
      >
        {copied ? (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
        <span>{copied ? "Copied!" : "Copy"}</span>
      </button>

      <button
        className={`card-menu-item card-menu-item--pin${isPinned ? " card-menu-item--pinned" : ""}`}
        onClick={closeAfter(() => onPin(!isPinned))}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill={isPinned ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 17v5" />
          <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
        </svg>
        <span>{isPinned ? "Unpin" : "Pin"}</span>
      </button>

      <button
        className={`card-menu-item card-menu-item--persist${isPersistent ? " card-menu-item--persisted" : ""}`}
        onClick={closeAfter(onTogglePersistent)}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill={isPersistent ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
        <span>{isPersistent ? "Unsave" : "Save"}</span>
      </button>

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
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                <line x1="7" y1="7" x2="7.01" y2="7" />
              </svg>
              <span style={{ flex: 1 }}>Groups</span>
              <svg
                className={`card-menu-chevron${groupsOpen ? " card-menu-chevron--open" : ""}`}
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </button>
            {groupsOpen && (
              <div className="card-menu-groups-flyout">
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

      <div className="card-menu-separator" />

      <button
        className="card-menu-item card-menu-item--danger"
        onClick={closeAfter(onDelete)}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
        <span>Delete</span>
      </button>
    </div>,
    document.body,
  );
};

export default CardMenu;
