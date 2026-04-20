import { useEffect, useState } from "react";
import ReactDOM from "react-dom";
import "./TooltipPortal.css";

type TipPos = "above" | "below" | "right" | "left";

interface TipState {
  text: string;
  x: number;
  y: number;
  pos: TipPos;
}

const GAP = 8;
const SHOW_DELAY = 400; // ms before tooltip appears
// Estimated tooltip dimensions used for boundary checks before the real element is measured
const EST_H = 24;
const EST_W = 120;

/**
 * Given the preferred position from data-tooltip-pos, pick the best actual
 * position based on how much viewport space is available on each side.
 */
function resolvePos(r: DOMRect, preferred: TipPos): TipPos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (preferred === "right") {
    const spaceRight = vw - r.right;
    const spaceLeft = r.left;
    // If not enough room on the right, fall back to whichever horizontal side
    // has more space, or flip to above/below if truly tight
    if (spaceRight >= EST_W + GAP) return "right";
    if (spaceLeft >= EST_W + GAP) return "left";
    // fall through to vertical logic
  }

  if (preferred === "left") {
    const spaceLeft = r.left;
    const spaceRight = vw - r.right;
    if (spaceLeft >= EST_W + GAP) return "left";
    if (spaceRight >= EST_W + GAP) return "right";
    // fall through to vertical logic
  }

  const spaceAbove = r.top;
  const spaceBelow = vh - r.bottom;

  if (preferred === "below") {
    return spaceBelow >= EST_H + GAP ? "below" : "above";
  }

  // Default: prefer above, flip to below if cramped
  return spaceAbove >= EST_H + GAP ? "above" : "below";
}

function anchorCoords(
  el: HTMLElement,
  preferred: TipPos,
): { x: number; y: number; resolved: TipPos } {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const resolved = resolvePos(r, preferred);
  let x: number;
  let y: number;

  switch (resolved) {
    case "below":
      x = r.left + r.width / 2;
      y = r.bottom + GAP;
      break;
    case "right":
      x = r.right + GAP;
      y = r.top + r.height / 2;
      break;
    case "left":
      x = r.left - GAP;
      y = r.top + r.height / 2;
      break;
    case "above":
    default:
      x = r.left + r.width / 2;
      y = r.top - GAP;
      break;
  }

  // Clamp x so the tooltip never bleeds off screen edges.
  if (resolved === "above" || resolved === "below") {
    x = Math.min(Math.max(x, EST_W / 2 + 4), vw - EST_W / 2 - 4);
  }

  return { x, y, resolved };
}

const TRANSFORMS: Record<TipPos, string> = {
  above: "translate(-50%, -100%)",
  below: "translate(-50%, 0)",
  right: "translate(0, -50%)",
  left: "translate(-100%, -50%)",
};

export default function TooltipPortal() {
  const [tip, setTip] = useState<TipState | null>(null);

  useEffect(() => {
    let lastEl: HTMLElement | null = null;
    let delayTimer: ReturnType<typeof setTimeout> | null = null;

    const clearDelay = () => {
      if (delayTimer !== null) {
        clearTimeout(delayTimer);
        delayTimer = null;
      }
    };

    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-tooltip]",
      );
      if (el === lastEl) return;
      lastEl = el;
      clearDelay();
      if (!el) {
        setTip(null);
        return;
      }

      const text = el.dataset.tooltip ?? "";
      if (!text) {
        setTip(null);
        return;
      }

      delayTimer = setTimeout(() => {
        delayTimer = null;
        const preferred =
          (el.dataset.tooltipPos as TipPos | undefined) ?? "above";
        const { x, y, resolved } = anchorCoords(el, preferred);
        setTip({ text, x, y, pos: resolved });
      }, SHOW_DELAY);
    };

    const onOut = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-tooltip]",
      );
      if (!el) return;
      // Only hide when the pointer truly leaves the tooltip element,
      // not when it moves between child nodes inside it.
      const into = (
        e.relatedTarget as HTMLElement | null
      )?.closest<HTMLElement>("[data-tooltip]");
      if (into !== el) {
        clearDelay();
        setTip(null);
        lastEl = null;
      }
    };

    const onHide = () => {
      clearDelay();
      setTip(null);
      lastEl = null;
    };

    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mouseout", onOut, true);
    document.addEventListener("tooltip:hide", onHide);
    return () => {
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("mouseout", onOut, true);
      document.removeEventListener("tooltip:hide", onHide);
      clearDelay();
      lastEl = null;
    };
  }, []);

  if (!tip) return null;

  return ReactDOM.createPortal(
    <div
      className="tooltip-bubble"
      style={
        {
          position: "fixed",
          left: tip.x,
          top: tip.y,
          "--tt-transform": TRANSFORMS[tip.pos],
          zIndex: 99999,
          pointerEvents: "none",
        } as React.CSSProperties
      }
    >
      {tip.text}
    </div>,
    document.body,
  );
}
