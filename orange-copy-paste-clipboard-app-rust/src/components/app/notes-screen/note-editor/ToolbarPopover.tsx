// ── Toolbar popover ──────────────────────────────────────────────────────
// The one anchored panel every toolbar control opens. Owns the outside-click
// and Escape handling so the toolbar does not carry a copy per picker; the
// toolbar keeps a single `openMenu` id and this component only knows whether
// it is the open one.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

interface ToolbarPopoverProps {
  open: boolean;
  onClose: () => void;
  /** The control that opens the panel. Rendered in place; the panel hangs
   *  under it. */
  trigger: React.ReactNode;
  /** Which edge of the trigger the panel lines up with. */
  align?: "left" | "right";
  /** `ns-popover--menu` for a column of rows, `ns-popover--panel` for a card
   *  with its own layout. Extra classes size the specific panel. */
  panelClassName?: string;
  children: React.ReactNode;
}

const ToolbarPopover: React.FC<ToolbarPopoverProps> = ({
  open,
  onClose,
  trigger,
  align = "left",
  panelClassName,
  children,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // A wide panel hangs off a button near the right end of the bar, so at the
  // window's 640px minimum it can start left of the window. Measure once the
  // panel is laid out and nudge it back inside.
  const [shift, setShift] = useState(0);

  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const clamp = () => {
      const el = panelRef.current;
      if (!el) return;
      // Measure the unshifted position: the current rect already includes
      // whatever nudge is applied, so subtract it before deciding.
      setShift((prev) => {
        const left = el.getBoundingClientRect().left - prev;
        const right = left + el.offsetWidth;
        if (left < 8) return 8 - left;
        if (right > window.innerWidth - 8)
          return Math.min(0, window.innerWidth - 8 - right);
        return 0;
      });
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  return (
    <div ref={wrapRef} className="ns-popover-wrap">
      {trigger}
      {open && (
        <div
          ref={panelRef}
          // A margin, not a transform: the open animation owns `transform`.
          style={
            shift
              ? align === "right"
                ? { marginRight: -shift }
                : { marginLeft: shift }
              : undefined
          }
          className={`ns-popover ns-popover--${align}${
            panelClassName ? " " + panelClassName : ""
          }`}
        >
          {children}
        </div>
      )}
    </div>
  );
};

export default ToolbarPopover;
