import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Reason the Rust side has stopped trusting its own in-memory state, or `null`
 * while healthy. Saving is paused for as long as this is set; only a restart
 * clears it.
 *
 * Each window is its own webview with its own listeners, so every surface that
 * wants to warn the user has to ask for itself. Polls once as well as listening,
 * because a window opened (or reloaded) after the event fired had nothing
 * attached to receive it.
 */
export function useDegraded(): string | null {
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    invoke<string | null>("health_degraded_reason")
      .then((r) => {
        if (!cancelled && r) setReason(r);
      })
      .catch(() => {});

    listen<string | null>("health:degraded", (event) => {
      if (cancelled) return;
      setReason(event.payload || "An internal error occurred");
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return reason;
}
