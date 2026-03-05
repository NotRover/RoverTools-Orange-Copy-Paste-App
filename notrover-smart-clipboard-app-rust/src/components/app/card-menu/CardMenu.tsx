import React, { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import "./CardMenu.css";

export interface CardMenuProps {
  open: boolean;
  anchorX: number;
  anchorY: number;
  onClose: () => void;
  isPinned: boolean;
  copied: boolean;
  onCopy: () => void;
  onDelete: () => void;
  onPin: (shouldPin: boolean) => void;
}

const CardMenu: React.FC<CardMenuProps> = ({
  open,
  anchorX,
  anchorY,
  onClose,
  isPinned,
  copied,
  onCopy,
  onDelete,
  onPin,
}) => {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const closeAfter = (fn: () => void) => () => {
    fn();
    onClose();
  };

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
    document.body
  );
};

export default CardMenu;
