/**
 * App-wide toast channel.
 *
 * Toasts used to be per-flag state inside App, which meant only App could raise
 * one. Screens doing background work - uploading to the cloud, sharing into a
 * space - had nothing to say when the work finished or failed, so an action
 * that worked looked identical to one that did nothing. This is the smallest
 * thing that fixes that: a DOM event any screen can fire and App renders.
 */

import { markPending } from "../../../hooks/pendingRemoval";

export type ToastTone = "info" | "success" | "error" | "danger";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

/**
 * Which glyph sits to the left of the message.
 *
 * A name rather than a React node: the request crosses a DOM event, and the one
 * component that draws toasts is the right place to decide what a trash can
 * looks like. Left out, the tone picks one.
 */
export type ToastGlyph = "trash" | "pin" | "warning" | "cloud" | "cloud-off";

export interface ToastRequest {
  message: string;
  tone?: ToastTone;
  /** ms; 0 keeps it up until something replaces it. */
  duration?: number;
  /** Same key replaces the toast in place instead of stacking a near-copy. */
  key?: string;
  /** Button on the right of the toast, usually Undo. */
  action?: ToastAction;
  /** Overrides the glyph the tone would pick. */
  glyph?: ToastGlyph;
}

export const APP_TOAST_EVENT = "app:toast";
export const APP_TOAST_DISMISS_EVENT = "app:toast-dismiss";

/** How long a destructive action waits on screen before it actually runs. */
export const UNDO_GRACE_MS = 5000;

export function showToast(
  message: string,
  tone: ToastTone = "info",
  opts: {
    duration?: number;
    key?: string;
    action?: ToastAction;
    glyph?: ToastGlyph;
  } = {},
): void {
  const detail: ToastRequest = { message, tone, ...opts };
  document.dispatchEvent(new CustomEvent(APP_TOAST_EVENT, { detail }));
}

/**
 * Take a toast down early. `key` names which one, so undoing a slow action does
 * not pull the rug out from under a newer toast that has since replaced it.
 */
export function dismissToast(key?: string): void {
  document.dispatchEvent(
    new CustomEvent(APP_TOAST_DISMISS_EVENT, { detail: { key } }),
  );
}

/**
 * Hold a destructive action behind an Undo toast, then run it.
 *
 * Deleting a space, removing a member or revoking an invite are all one click
 * away and none of them can be reversed once the server has them, so the grace
 * period is the undo: nothing is sent until the toast runs out.
 *
 * `hides` is what keeps the click from looking like it did nothing in the
 * meantime. The keys are marked in the shared pending-removal store, which the
 * lists subtract from what they draw, so the row leaves at once and a refresh
 * mid-toast cannot put it back. They are released when `run` settles - so `run`
 * must re-read whatever it changed before returning, or the row would flash back
 * for a frame between the release and the new state arriving - and on Undo.
 *
 * `onUndo` is for anything else a caller has to put back by hand.
 */
export function deferDestructive(
  message: string,
  run: () => void | Promise<void>,
  opts: {
    key?: string;
    hides?: string[];
    graceMs?: number;
    glyph?: ToastGlyph;
    onUndo?: () => void;
    errorPrefix?: string;
  } = {},
): void {
  const graceMs = opts.graceMs ?? UNDO_GRACE_MS;
  const unhide = markPending(opts.hides ?? []);
  let undone = false;
  const timer = window.setTimeout(() => {
    if (undone) return;
    void (async () => {
      try {
        await run();
      } catch (e) {
        toastError(opts.errorPrefix ?? "That did not go through", e);
      } finally {
        unhide();
      }
    })();
  }, graceMs);

  showToast(message, "danger", {
    duration: graceMs,
    key: opts.key,
    glyph: opts.glyph,
    action: {
      label: "Undo",
      onClick: () => {
        undone = true;
        window.clearTimeout(timer);
        unhide();
        dismissToast(opts.key);
        opts.onUndo?.();
      },
    },
  });
}

/** Turn a Tauri command rejection into something worth reading. */
export function toastError(prefix: string, e: unknown): void {
  const detail = typeof e === "string" ? e : ((e as Error)?.message ?? "");
  showToast(detail ? `${prefix}: ${detail}` : prefix, "error");
}
