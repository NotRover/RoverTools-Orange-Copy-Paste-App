/**
 * Sends what a window logs to the app log on disk.
 *
 * The webview's console is gone the moment the window closes, and in a release
 * build nobody is looking at it anyway. Rust keeps one log file for the whole
 * app ({app_data}/logs/app.log), so each window forwards its `console.error`
 * and `console.warn` calls there, along with any uncaught error or rejected
 * promise. The console still gets every line, so `tauri dev` is unchanged.
 *
 * Called once per window entry, before the React root mounts.
 */

import { invoke } from "@tauri-apps/api/core";

type Level = "error" | "warn" | "info";

/** One line of text from whatever was passed to the console. */
function render(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/** Hand one line to Rust. Never throws: a log call must not break its caller. */
export function logToFile(level: Level, message: string): void {
  invoke("log_from_webview", { level, message }).catch(() => {});
}

let installed = false;

export function installFrontendLogging(): void {
  if (installed) return;
  installed = true;

  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      logToFile(level, render(args));
    };
  }

  window.addEventListener("error", (e) => {
    const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : "";
    logToFile("error", `uncaught: ${render([e.error ?? e.message])}${where}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    logToFile("error", `unhandled rejection: ${render([e.reason])}`);
  });
}
