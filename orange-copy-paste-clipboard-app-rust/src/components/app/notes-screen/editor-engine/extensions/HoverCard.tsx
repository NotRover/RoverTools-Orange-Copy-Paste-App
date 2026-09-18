// ── Hover card — preview popover for inline chips ───────────────────────
// Appears after a short hover, in a portal so the editor's overflow cannot
// clip it, and goes away on pointer leave, any keystroke, or scroll. Display
// only: nothing in the document changes, so the caret and the text around
// the chip never move.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const OPEN_DELAY = 380;
const CLOSE_DELAY = 120;
const GAP = 6;
const WIDTH = 340;

export function useHoverCard() {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const clear = () => {
    if (openTimer.current) window.clearTimeout(openTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  };

  const onEnter = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget);
    clear();
    openTimer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY);
  };
  const onLeave = () => {
    clear();
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY);
  };
  /** The card keeps itself open while the pointer is over it. */
  const cardEnter = () => clear();
  const cardLeave = onLeave;

  useEffect(() => {
    if (!open) return;
    const close = () => { clear(); setOpen(false); };
    document.addEventListener("keydown", close, true);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("keydown", close, true);
      document.removeEventListener("scroll", close, true);
    };
  }, [open]);

  useEffect(() => clear, []);

  return { open, anchor, onEnter, onLeave, cardEnter, cardLeave };
}

export const HoverCard: React.FC<{
  anchor: HTMLElement | null;
  onEnter: () => void;
  onLeave: () => void;
  children: React.ReactNode;
}> = ({ anchor, onEnter, onLeave, children }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const a = anchor.getBoundingClientRect();
    const h = ref.current.offsetHeight;
    const left = Math.max(8, Math.min(a.left, window.innerWidth - WIDTH - 8));
    const below = a.bottom + GAP + h <= window.innerHeight - 8;
    const top = below ? a.bottom + GAP : Math.max(8, a.top - GAP - h);
    setPos({ left, top });
  }, [anchor, children]);

  return createPortal(
    <div
      ref={ref}
      className="ee-hovercard"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width: WIDTH,
        visibility: pos ? "visible" : "hidden",
      }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onMouseDown={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
};
