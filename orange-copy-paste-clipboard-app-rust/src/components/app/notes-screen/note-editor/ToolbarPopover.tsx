// ── Toolbar popover ──────────────────────────────────────────────────────
// The one anchored panel every toolbar control opens. Owns the outside-click
// and Escape handling so the toolbar does not carry a copy per picker; the
// toolbar keeps a single `openMenu` id and this component only knows whether
// it is the open one.

import React, { useEffect, useRef } from "react";

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
