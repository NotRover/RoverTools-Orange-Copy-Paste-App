import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type { SpaceMember } from "../../../../types";
import CommentThread from "./CommentThread";
import "./CommentPopover.css";

/** Which thread is open, and what it is hanging off.
 *
 *  The chip itself rather than a measurement of it: a rect taken once goes
 *  stale the moment anything scrolls, and the panel has to keep up. */
interface Target {
  clientId: string;
  entryType: "clipboard" | "note";
  el: HTMLElement;
}

interface Api {
  /** Open the thread for one entry, anchored to the element that was clicked.
   *  Clicking the same chip again closes it, the way a menu button behaves. */
  toggle: (
    clientId: string,
    entryType: "clipboard" | "note",
    el: HTMLElement,
  ) => void;
  /** The thread currently open, so a chip can show itself as pressed. */
  openId: string | null;
}

const Ctx = createContext<Api | null>(null);

/** For the chips. Returns null outside a space, where there is nothing to open. */
export function useCommentPopover(): Api | null {
  return useContext(Ctx);
}

const WIDTH = 340;
const MAX_H = 380;
const GAP = 6;
const EDGE = 8;

/** Where the panel goes: under the chip, or above it when the chip is low
 *  enough that a panel below would run off the bottom. Clamped horizontally so
 *  a chip near the right edge does not push it off-screen. */
function place(anchor: DOMRect): React.CSSProperties {
  const below = window.innerHeight - anchor.bottom;
  const left = Math.min(
    Math.max(EDGE, anchor.left),
    Math.max(EDGE, window.innerWidth - WIDTH - EDGE),
  );
  const flip = below < MAX_H && anchor.top > below;
  return flip
    ? { left, bottom: window.innerHeight - anchor.top + GAP }
    : { left, top: anchor.bottom + GAP };
}

export const CommentsProvider: React.FC<{
  spaceId: string;
  members: SpaceMember[];
  selfUserId: string | null;
  isOwner: boolean;
  /** The feed's tallies are stale the moment a comment is written from here. */
  onCountChange: () => void;
  /** Whatever the open thread drew has been read, including anything that
   *  arrives while it stays open. Reported by the thread rather than guessed
   *  at open time, so the watermark is a real comment's timestamp. */
  onRead: (
    entryType: "clipboard" | "note",
    clientId: string,
    latestAt: number,
  ) => void;
  children: React.ReactNode;
}> = ({
  spaceId,
  members,
  selfUserId,
  isOwner,
  onCountChange,
  onRead,
  children,
}) => {
  const [target, setTarget] = useState<Target | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const toggle = useCallback(
    (clientId: string, entryType: "clipboard" | "note", el: HTMLElement) => {
      setTarget((prev) =>
        prev && prev.clientId === clientId && prev.entryType === entryType
          ? null
          : { clientId, entryType, el },
      );
    },
    [],
  );

  // Leaving the space, or switching entries under it, takes the panel with it.
  useEffect(() => setTarget(null), [spaceId]);

  const close = useCallback(() => setTarget(null), []);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // Capture phase, and this matters: React's own handlers run first in the
    // bubble phase, and one of them - picking a mention - unmounts the row that
    // was clicked. By the time a bubble-phase listener ran, `e.target` was
    // detached, `contains` said false, and the panel closed itself on its own
    // click. In the capture phase the DOM is still whole.
    const onDown = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [target, close]);

  const openId = target ? `${target.entryType}:${target.clientId}` : null;

  return (
    <Ctx.Provider value={{ toggle, openId }}>
      {children}
      {target &&
        createPortal(
          <Panel
            ref={panelRef}
            target={target}
            spaceId={spaceId}
            members={members}
            selfUserId={selfUserId}
            isOwner={isOwner}
            onCountChange={onCountChange}
            onRead={onRead}
            onClose={close}
          />,
          document.body,
        )}
    </Ctx.Provider>
  );
};

const Panel = React.forwardRef<
  HTMLDivElement,
  {
    target: Target;
    spaceId: string;
    members: SpaceMember[];
    selfUserId: string | null;
    isOwner: boolean;
    onCountChange: () => void;
    onRead: (
      entryType: "clipboard" | "note",
      clientId: string,
      latestAt: number,
    ) => void;
    onClose: () => void;
  }
>(
  (
    {
      target,
      spaceId,
      members,
      selfUserId,
      isOwner,
      onCountChange,
      onRead,
      onClose,
    },
    ref,
  ) => {
    const [style, setStyle] = useState<React.CSSProperties>(() =>
      place(target.el.getBoundingClientRect()),
    );

    // Re-measure whenever anything moves rather than closing on it. Closing on
    // scroll looked reasonable until focusing the textarea - which picking a
    // mention does - fired a scroll on an ancestor and tore the panel down
    // between the click and the insert.
    useLayoutEffect(() => {
      let frame = 0;
      const sync = () => {
        frame = 0;
        const r = target.el.getBoundingClientRect();
        // Gone from the page, or scrolled out of sight: a panel still hanging
        // there would be pointing at nothing.
        if (
          !document.contains(target.el) ||
          r.bottom < 0 ||
          r.top > window.innerHeight
        ) {
          onClose();
          return;
        }
        setStyle(place(r));
      };
      const queue = () => {
        if (!frame) frame = requestAnimationFrame(sync);
      };
      sync();
      window.addEventListener("scroll", queue, true);
      window.addEventListener("resize", queue);
      return () => {
        if (frame) cancelAnimationFrame(frame);
        window.removeEventListener("scroll", queue, true);
        window.removeEventListener("resize", queue);
      };
    }, [target, onClose]);

    return (
      <div
        ref={ref}
        className="cmt-pop"
        style={{ ...style, width: WIDTH, maxHeight: MAX_H }}
        role="dialog"
        aria-label="Comments"
      >
        <CommentThread
          key={`${target.entryType}:${target.clientId}`}
          spaceId={spaceId}
          clientId={target.clientId}
          entryType={target.entryType}
          members={members}
          selfUserId={selfUserId ?? ""}
          isOwner={isOwner}
          onCountChange={(_n, latestAt) => {
            onCountChange();
            onRead(target.entryType, target.clientId, latestAt);
          }}
          onClose={onClose}
        />
      </div>
    );
  },
);

Panel.displayName = "CommentPanel";
