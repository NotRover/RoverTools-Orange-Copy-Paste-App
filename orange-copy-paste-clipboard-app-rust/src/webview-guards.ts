/**
 * Hides the fact that the app is a webview.
 *
 * WebView2 ships a browser context menu (Back, Refresh, Print, Save as, More
 * tools, Send tab to your devices) and the matching keyboard shortcuts. In a
 * browser those are features; in a desktop app they are a leak, and two of them
 * are worse than cosmetic - Refresh throws away in-memory state and remounts
 * every window, and Back on a multi-page build can navigate a window to a
 * different window's document with no way back.
 *
 * Both are suppressed in release builds only. In `tauri dev` the whole set stays
 * available, because reload and devtools are how the frontend is worked on.
 *
 * Called once per window entry, before the React root mounts.
 */

/** Fields where the native menu is Cut/Copy/Paste and worth keeping. */
function isEditable(node: EventTarget | null): boolean {
  const el = node instanceof Element ? node : null;
  if (!el) return false;
  if (el.closest("input, textarea")) return true;
  const editable = el.closest<HTMLElement>("[contenteditable]");
  return !!editable && editable.isContentEditable;
}

/** Keys WebView2 acts on itself: reload, devtools, print, save, history. */
function isBrowserShortcut(e: KeyboardEvent): boolean {
  const key = e.key.toLowerCase();
  if (key === "f5" || key === "f12" || key === "f7") return true;
  if (e.altKey && (key === "arrowleft" || key === "arrowright")) return true;
  if (e.ctrlKey && e.shiftKey && ["i", "j", "c", "r"].includes(key)) return true;
  return (e.ctrlKey || e.metaKey) && ["r", "p", "s", "u"].includes(key);
}

export function installWebviewGuards(): void {
  if (import.meta.env.DEV) return;

  window.addEventListener(
    "contextmenu",
    (e) => {
      if (!isEditable(e.target)) e.preventDefault();
    },
    { capture: true },
  );

  window.addEventListener(
    "keydown",
    (e) => {
      // preventDefault only, never stopPropagation: Ctrl+S is the note
      // editor's save, and it should keep working while the browser's Save as
      // dialog does not open.
      if (isBrowserShortcut(e)) e.preventDefault();
    },
    { capture: true },
  );

  // Middle-click on a link is a new-window navigation, and a dragged link or
  // image drops the file into whatever it lands on.
  window.addEventListener("auxclick", (e) => {
    if (e.button === 1) e.preventDefault();
  });
  window.addEventListener("dragstart", (e) => {
    if (e.target instanceof HTMLAnchorElement || e.target instanceof HTMLImageElement) {
      e.preventDefault();
    }
  });
}
