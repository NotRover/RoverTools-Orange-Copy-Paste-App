import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { groupColor } from "../../../types";
import type { Space } from "../../../types";
import { ShareNetwork, Check, CloudArrowUp, CloudSlash } from "@phosphor-icons/react";
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
  /** Spaces this account belongs to. Empty leaves the share row disabled. */
  spaces?: Space[];
  /** Whether a sync account is signed in, for the disabled row's reason. */
  signedIn?: boolean;
  /** Space ids this item is already shared into. */
  itemSpaceIds?: string[];
  /** Share this item into a space, or stop sharing it there. */
  onToggleSpace?: (spaceId: string) => void;
  /** Whether a copy of this item exists on the server. */
  inCloud?: boolean;
  /** Upload this item to the account, or take the server copy back off. */
  onToggleCloud?: (upload: boolean) => void;
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
  spaces = [],
  signedIn = false,
  itemSpaceIds = [],
  onToggleSpace,
  inCloud = false,
  onToggleCloud,
}) => {
  const dropdownRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  // One flyout slot: groups and spaces share the placement logic, and only one
  // of them can be open at a time.
  const [flyoutOpen, setFlyoutOpen] = useState<"groups" | "spaces" | null>(null);
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
    if (!open) setFlyoutOpen(null);
  }, [open]);

  // Position the open flyout so it doesn't overflow the viewport.
  useLayoutEffect(() => {
    if (!flyoutOpen || !flyoutRef.current || !dropdownRef.current) return;
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
  }, [flyoutOpen]);

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
  // The row stays on the menu when sharing is unavailable: hiding it made the
  // feature look absent rather than switched off, so it shows the reason.
  const showShare = !!onToggleSpace;
  const shareBlocked = !signedIn
    ? "Sign in on the Account screen to share"
    : spaces.length === 0
      ? "Create a space on the Spaces screen first"
      : null;
  const cloudBlocked = signedIn ? null : "Sign in on the Account screen to sync";

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

      {/* Cloud copy. Sits above sharing because an item has to reach the
          account before it can reach a space. */}
      {onToggleCloud && (
        <button
          /* aria-disabled rather than disabled, for the same reason as the
             share row: a disabled button fires no mouse events, so the tooltip
             saying why would never appear. */
          className={`card-menu-item${inCloud ? " card-menu-item--danger-soft" : ""}${cloudBlocked ? " card-menu-item--off" : ""}`}
          aria-disabled={!!cloudBlocked}
          data-tooltip={cloudBlocked ?? undefined}
          data-tooltip-pos="left"
          onClick={() => {
            if (cloudBlocked) return;
            onToggleCloud(!inCloud);
            onClose();
          }}
        >
          {inCloud ? <CloudSlash size={13} /> : <CloudArrowUp size={13} />}
          <span>{inCloud ? "Remove from cloud" : "Upload to cloud"}</span>
        </button>
      )}

      {/* Share to space submenu */}
      {showShare && (
        <div className="card-menu-groups-wrapper">
          <button
            /* aria-disabled, not disabled: a disabled button fires no mouse
               events, so the tooltip explaining why would never show. */
            className={`card-menu-item card-menu-item--groups-toggle${flyoutOpen === "spaces" ? " card-menu-item--groups-toggle-active" : ""}${shareBlocked ? " card-menu-item--off" : ""}`}
            aria-disabled={!!shareBlocked}
            data-tooltip={shareBlocked ?? undefined}
            data-tooltip-pos="left"
            onClick={() => {
              if (shareBlocked) return;
              setFlyoutOpen((v) => (v === "spaces" ? null : "spaces"));
            }}
          >
            <ShareNetwork size={13} />
            <span style={{ flex: 1 }}>Share to space</span>
            {/* A count, not a parenthetical: the number says how many spaces this
                item is already in, which is state rather than part of the label. */}
            {itemSpaceIds.length > 0 && (
              <span className="card-menu-count">{itemSpaceIds.length}</span>
            )}
            <ChevronRightIcon
              className={`card-menu-chevron${flyoutOpen === "spaces" ? " card-menu-chevron--open" : ""}`}
            />
          </button>
          {flyoutOpen === "spaces" && (
            <div ref={flyoutRef} className="card-menu-groups-flyout">
              <div className="card-menu-groups-flyout-header">
                <span>Spaces</span>
              </div>
              <div className="card-menu-groups-flyout-body">
                {spaces.map((space) => {
                  const active = itemSpaceIds.includes(space.id);
                  // A space whose key has not arrived can still be picked: the
                  // choice is held and sent when the key lands. The row says so
                  // rather than blocking on a wait nobody can shorten.
                  const waiting = !space.has_key;
                  return (
                    <button
                      key={space.id}
                      className={`card-menu-space-row${active ? " card-menu-space-row--active" : ""}${waiting ? " card-menu-space-row--waiting" : ""}`}
                      data-tooltip={
                        waiting
                          ? "Waiting for this space's key. Your choice is kept and sent when it arrives."
                          : undefined
                      }
                      data-tooltip-pos={waiting ? "left" : undefined}
                      onClick={() => onToggleSpace?.(space.id)}
                    >
                      <span className="card-menu-space-check">
                        {active && <Check size={10} weight="bold" />}
                      </span>
                      <span className="card-menu-space-name">{space.name}</span>
                      {waiting && (
                        <span className="card-menu-space-wait">waiting</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Groups submenu */}
      {hasGroups && (
        <>
          {/* <div className="card-menu-separator" /> */}
          <div className="card-menu-groups-wrapper">
            <button
              className={`card-menu-item card-menu-item--groups-toggle${flyoutOpen === "groups" ? " card-menu-item--groups-toggle-active" : ""}`}
              onClick={() =>
                setFlyoutOpen((v) => (v === "groups" ? null : "groups"))
              }
            >
              <TagIcon />
              <span style={{ flex: 1 }}>Groups</span>
              <ChevronRightIcon
                className={`card-menu-chevron${flyoutOpen === "groups" ? " card-menu-chevron--open" : ""}`}
              />
            </button>
            {flyoutOpen === "groups" && (
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
