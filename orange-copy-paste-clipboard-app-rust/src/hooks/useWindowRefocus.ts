import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Fires when the user comes back to the window.
 *
 * Screens read server-backed data when they mount and then rely on the
 * WebSocket to keep it current. Anything that arrives while the app is in the
 * background - or while a socket was quietly dead - is missed, which is why
 * leaving a screen and returning to it used to be the fix. This is that fix,
 * without the navigation: come back to the window and whatever is on screen
 * re-reads itself.
 *
 * One `tauri://focus` listener and one `visibilitychange` listener for the
 * whole app, with the subscribers behind them, because both events fire for the
 * same alt-tab and every screen would otherwise register its own pair. The
 * throttle collapses that burst into a single round of work.
 */
/**
 * Default gap between runs of the same subscriber. Enough to collapse the
 * focus/visibility pair one alt-tab produces, and the click that follows it.
 */
const THROTTLE_MS = 1500;

/**
 * What a subscriber that talks to the server should pass instead. Matches the
 * `CATCH_UP_MIN_SECS` gate in `sync/commands.rs`, so someone flicking between
 * windows costs one round of requests rather than one per flick.
 */
export const NETWORK_REFOCUS_MS = 20_000;

type Subscriber = { run: () => void; minMs: number; last: number };

const subscribers = new Set<Subscriber>();
let teardown: (() => void) | null = null;

function fire(): void {
  const now = Date.now();
  for (const sub of subscribers) {
    if (now - sub.last < sub.minMs) continue;
    sub.last = now;
    sub.run();
  }
}

function onVisibility(): void {
  if (document.visibilityState === "visible") fire();
}

function attach(): void {
  if (teardown) return;
  document.addEventListener("visibilitychange", onVisibility);
  // The Tauri listener resolves asynchronously, so it can land after the last
  // subscriber has already gone. Unlisten immediately in that case rather than
  // leaving a listener behind with nothing to call.
  let detached = false;
  let unlistenFocus: (() => void) | null = null;
  void getCurrentWindow()
    .onFocusChanged(({ payload: focused }) => {
      if (focused) fire();
    })
    .then((un) => {
      if (detached) un();
      else unlistenFocus = un;
    })
    .catch(() => {});

  teardown = () => {
    detached = true;
    document.removeEventListener("visibilitychange", onVisibility);
    unlistenFocus?.();
  };
}

function detach(): void {
  if (subscribers.size > 0) return;
  teardown?.();
  teardown = null;
}

/**
 * Run `fn` when the window regains focus or becomes visible again, at most
 * once per `minMs`.
 *
 * Pass `NETWORK_REFOCUS_MS` for anything that reaches the server. The gap is
 * per subscriber, so a local re-read stays responsive while the requests
 * beside it do not repeat on every alt-tab.
 *
 * The callback is held in a ref, so it can close over fresh state without
 * re-subscribing on every render.
 */
export function useWindowRefocus(fn: () => void, minMs = THROTTLE_MS): void {
  const ref = useRef(fn);
  ref.current = fn;

  useEffect(() => {
    const sub: Subscriber = { run: () => ref.current(), minMs, last: 0 };
    subscribers.add(sub);
    attach();
    return () => {
      subscribers.delete(sub);
      detach();
    };
  }, [minMs]);
}
