import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * The two ways the Rust side can stop saving, which need different things said
 * about them:
 *
 * - `degraded` — a fault was caught and saving is being held back deliberately,
 *   so the good copy on disk is not overwritten with suspect memory. One-way:
 *   only a restart clears it.
 * - `stalled` — the thread that writes to disk stopped reporting in, which most
 *   likely means it is deadlocked. Nothing is being withheld on purpose and
 *   nothing is known to be corrupt, so this clears itself if the thread returns.
 */
export type HealthWarning = {
  kind: "degraded" | "stalled";
  reason: string;
};

/**
 * Whichever warning is currently active, or `null` while healthy. `degraded`
 * outranks `stalled`: it is the permanent one, and a wedged flush loop is a
 * plausible consequence of whatever caused it.
 *
 * Each window is its own webview with its own listeners, so every surface that
 * wants to warn the user has to ask for itself. Polls as well as listening,
 * because a window opened (or reloaded) after an event fired had nothing
 * attached to receive it — and because a stall can begin at any point later.
 */
export function useHealthWarning(): HealthWarning | null {
  const [degraded, setDegraded] = useState<string | null>(null);
  const [stalled, setStalled] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];

    const keep = (fn: () => void) => {
      if (cancelled) fn();
      else unlisten.push(fn);
    };

    invoke<string | null>("health_degraded_reason")
      .then((r) => {
        if (!cancelled && r) setDegraded(r);
      })
      .catch(() => {});
    invoke<string | null>("health_stall_reason")
      .then((r) => {
        if (!cancelled) setStalled(r ?? null);
      })
      .catch(() => {});

    // A degraded event never means "recovered", so an empty payload still has to
    // show something.
    listen<string | null>("health:degraded", (event) => {
      if (!cancelled) setDegraded(event.payload || "An internal error occurred");
    }).then(keep);

    // A stall event with no payload is the recovery signal, so this one must
    // pass null straight through rather than substituting a fallback.
    listen<string | null>("health:stalled", (event) => {
      if (!cancelled) setStalled(event.payload ?? null);
    }).then(keep);

    return () => {
      cancelled = true;
      unlisten.forEach((fn) => fn());
    };
  }, []);

  if (degraded) return { kind: "degraded", reason: degraded };
  if (stalled) return { kind: "stalled", reason: stalled };
  return null;
}
