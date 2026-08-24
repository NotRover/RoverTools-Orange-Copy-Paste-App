/**
 * The bar above an item opened for reading.
 *
 * Three screens open one item at a time - a clipboard entry, an item shared
 * into a space, a note in the editor - and all three answer the same three
 * questions on the same row: how do I get back, what am I looking at, and what
 * can I do with it. That row is here rather than three times over, so a change
 * to one of those answers reaches all three screens.
 *
 * What it deliberately does not decide is which actions belong on a given
 * screen. A note can be deleted and a space item cannot; the panels pass the
 * buttons they are entitled to.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, ChevronRightIcon } from "../../icons";
import { DotsThree } from "@phosphor-icons/react";
import "./view-toolbar.css";

/** The bar itself: the way out, then the middle, then the actions. */
export const ViewToolbar: React.FC<{
  onBack: () => void;
  /** "Back" on a screen that replaced a list, "Close" on a docked panel. */
  backLabel?: string;
  /** Whatever names the item: counts and a timestamp, or a title field. */
  children?: React.ReactNode;
  actions?: React.ReactNode;
}> = ({ onBack, backLabel = "Back", children, actions }) => (
  <div className="vt-bar">
    <button className="vt-back" onClick={onBack}>
      <ChevronRightIcon className="vt-back-chevron" />
      {backLabel}
    </button>
    {children}
    {actions && <div className="vt-actions">{actions}</div>}
  </div>
);

/** Counts and times, dot-separated. */
export const ToolbarFacts: React.FC<{ facts: string[] }> = ({ facts }) => (
  <div className="vt-facts">
    {facts.map((f) => (
      <span key={f} className="vt-fact">
        {f}
      </span>
    ))}
  </div>
);

/** The filled action on the row, with its own "Copied" flash. */
export const ToolbarCopyButton: React.FC<{
  copied: boolean;
  onClick: () => void;
}> = ({ copied, onClick }) => (
  <button
    className={`vt-btn vt-btn--primary${copied ? " vt-btn--done" : ""}`}
    onClick={onClick}
  >
    {copied ? (
      <>
        <CheckIcon size={11} strokeWidth={3} /> Copied
      </>
    ) : (
      <>
        <CopyIcon size={12} /> Copy
      </>
    )}
  </button>
);

/**
 * A menu anchored under a toolbar button.
 *
 * The menus these open dismiss themselves on any outside mousedown, which
 * includes the mousedown half of a click on the very button that opened them:
 * without the `closedAt` guard the button could open a menu but never close it,
 * because the menu would shut on mousedown and the click would reopen it.
 */
export function useToolbarMenu() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const closedAt = useRef(0);

  const close = useCallback(() => {
    closedAt.current = Date.now();
    setPos(null);
  }, []);

  // Anchored to the button's RIGHT edge, so the menu opens back across the
  // panel it belongs to. Anchoring the left edge sent it over whatever sits to
  // the right - on the Spaces screen, the rules column.
  const open = useCallback(() => {
    if (Date.now() - closedAt.current < 250) return;
    const r = buttonRef.current?.getBoundingClientRect();
    if (r) setPos({ x: r.right, y: r.bottom + 4 });
  }, []);

  return { buttonRef, pos, open, close, isOpen: pos !== null };
}

/**
 * Escape closes the panel.
 *
 * `blocked` is for anything on top of it with its own Escape - a menu, a
 * popover. Without it one Escape would dismiss that and take the whole panel
 * with it, leaving the screen the user was reading.
 */
export function useCloseOnEscape(onClose: () => void, blocked: boolean) {
  const ref = useRef({ onClose, blocked });
  ref.current = { onClose, blocked };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || ref.current.blocked) return;
      e.preventDefault();
      ref.current.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** The overflow button. The menu it opens stays the caller's, so a screen's
 *  real right-click menu is reused rather than rebuilt row by row. */
export const ToolbarMoreButton: React.FC<{
  menu: ReturnType<typeof useToolbarMenu>;
}> = ({ menu }) => (
  <button
    ref={menu.buttonRef}
    className={`vt-btn vt-btn--icon${menu.isOpen ? " vt-btn--on" : ""}`}
    onClick={menu.open}
    aria-haspopup="menu"
    aria-expanded={menu.isOpen}
    aria-label="More actions"
    data-tooltip="More actions"
    data-tooltip-pos="below"
  >
    <DotsThree size={16} weight="bold" />
  </button>
);
