import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

type PopupLabel = "copy-popup" | "paste-popup";

/**
 * Make a popup draggable by its header.
 *
 * The popups are cursor-anchored and dismiss on blur; dragging is a "shove it
 * aside for this appearance" gesture, not a way to pin them. Nothing is
 * remembered - the next time the popup shows it anchors to the cursor as before.
 *
 * The move is an OS drag loop (`startDragging`). On these transparent
 * always-on-top windows that loop fires `tauri://blur`, which would otherwise
 * dismiss the popup mid-drag, so the hook exposes `isDragging()` for the blur
 * handler to check: while a drag is live the blur is ignored. The flag is raised
 * on the header press and lowered a short beat after the moves settle, at which
 * point the popup is also clamped back onto its monitor - dragged past an edge
 * it snaps back, left on-screen it stays put.
 *
 * `onMouseDown` drags only from a bare-header press: one that lands on a button,
 * input, link, or anything marked `data-no-drag` is left to that control.
 */
export function usePopupDrag(label: PopupLabel) {
  const draggingRef = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the drag alive until the moves stop, then lower the flag and clamp.
  // Also covers a header press that never moves: the timer still fires and
  // clears the flag, so a plain click does not leave blur suppressed.
  const settle = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      draggingRef.current = false;
      invoke("clamp_popup", { label }).catch(() => {});
    }, 250);
  }, [label]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .listen("tauri://move", () => {
        if (!draggingRef.current) return;
        settle();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
  }, [settle]);

  const onMouseDown = useCallback(
    (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (
        (e.target as HTMLElement).closest(
          "button, input, a, [role='button'], [data-no-drag]",
        )
      ) {
        return;
      }
      draggingRef.current = true;
      settle();
      getCurrentWindow().startDragging().catch(console.error);
    },
    [settle],
  );

  const isDragging = useCallback(() => draggingRef.current, []);

  return { onMouseDown, isDragging };
}
