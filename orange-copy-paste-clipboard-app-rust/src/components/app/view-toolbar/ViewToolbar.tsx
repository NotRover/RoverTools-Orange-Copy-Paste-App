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
import {
  DotsThree,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
} from "@phosphor-icons/react";
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
 * The zoom cluster: minus, the current level, plus.
 *
 * Joined tighter than the row's own gap because the three are one control, and
 * the level in the middle is a button too - pressing it puts the zoom back. What
 * is being zoomed is the caller's business: a picture scales against its own
 * pixels, text against a reading size, and the editor scales itself.
 */
export const ToolbarZoom: React.FC<{
  /** What to show in the middle. "Fit", "150%" - whatever the caller counts in. */
  label: string;
  /** Whether the level is where it started, so the middle can stop shouting. */
  atDefault: boolean;
  /** What pressing the middle goes back to, in words. */
  resetTooltip: string;
  onIn: () => void;
  onOut: () => void;
  onReset: () => void;
}> = ({ label, atDefault, resetTooltip, onIn, onOut, onReset }) => (
  <div className="vt-zoom" role="group" aria-label="Zoom">
    <button
      className="vt-btn vt-btn--icon"
      onClick={onOut}
      aria-label="Zoom out"
      data-tooltip="Zoom out (Ctrl and minus)"
      data-tooltip-pos="below"
    >
      <MagnifyingGlassMinus size={13} />
    </button>
    <button
      className={`vt-btn vt-zoom-level${atDefault ? "" : " vt-btn--on"}`}
      onClick={onReset}
      aria-label={`Zoom ${label}. Click to reset.`}
      data-tooltip={resetTooltip}
      data-tooltip-pos="below"
    >
      {label}
    </button>
    <button
      className="vt-btn vt-btn--icon"
      onClick={onIn}
      aria-label="Zoom in"
      data-tooltip="Zoom in (Ctrl and plus)"
      data-tooltip-pos="below"
    >
      <MagnifyingGlassPlus size={13} />
    </button>
  </div>
);

/** Zoom stops for reading text. Coarse on purpose: a zoom that needs eight
 *  presses to get anywhere is a slider wearing the wrong clothes. */
export const TEXT_ZOOM_STEPS = [0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];

/** The next stop above or below `from`, or `from` itself at either end. */
export function stepZoom(
  steps: number[],
  from: number,
  dir: 1 | -1,
): number {
  const i = steps.indexOf(from);
  if (i === -1) return dir === 1 ? steps[steps.length - 1] : steps[0];
  return steps[Math.min(steps.length - 1, Math.max(0, i + dir))];
}

/**
 * Ctrl +/-/0 zoom what is on the panel, not the window.
 *
 * The webview's own zoom would scale the chrome along with it, which is never
 * what somebody pressing Ctrl and plus on a reading screen is asking for.
 */
export function useZoomKeys(
  zoom: { in: () => void; out: () => void; reset: () => void } | null,
  blocked = false,
) {
  const ref = useRef({ zoom, blocked });
  ref.current = { zoom, blocked };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { zoom, blocked } = ref.current;
      if (blocked || !zoom || !(e.ctrlKey || e.metaKey)) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoom.in();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoom.out();
      } else if (e.key === "0") {
        e.preventDefault();
        zoom.reset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
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
