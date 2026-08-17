/**
 * App-wide toast channel.
 *
 * Toasts used to be per-flag state inside App, which meant only App could raise
 * one. Screens doing background work - uploading to the cloud, sharing into a
 * space - had nothing to say when the work finished or failed, so an action
 * that worked looked identical to one that did nothing. This is the smallest
 * thing that fixes that: a DOM event any screen can fire and App renders.
 */

export type ToastTone = "info" | "success" | "error";

export interface ToastRequest {
  message: string;
  tone?: ToastTone;
  /** ms; 0 keeps it up until something replaces it. */
  duration?: number;
  /** Same key replaces the toast in place instead of stacking a near-copy. */
  key?: string;
}

export const APP_TOAST_EVENT = "app:toast";

export function showToast(
  message: string,
  tone: ToastTone = "info",
  opts: { duration?: number; key?: string } = {},
): void {
  const detail: ToastRequest = { message, tone, ...opts };
  document.dispatchEvent(new CustomEvent(APP_TOAST_EVENT, { detail }));
}

/** Turn a Tauri command rejection into something worth reading. */
export function toastError(prefix: string, e: unknown): void {
  const detail = typeof e === "string" ? e : ((e as Error)?.message ?? "");
  showToast(detail ? `${prefix}: ${detail}` : prefix, "error");
}
