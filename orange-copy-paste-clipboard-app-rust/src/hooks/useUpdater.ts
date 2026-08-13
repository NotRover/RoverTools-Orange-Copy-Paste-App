import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Mirrors `UpdateInfo` in `src-tauri/src/updater.rs`. */
export interface UpdateInfo {
  version: string;
  current_version: string;
  notes: string | null;
  downloaded: boolean;
  /** The user asked not to be told about this version again. */
  skipped: boolean;
}

/** Mirrors the `updater:progress` payload. */
interface Progress {
  downloaded: number;
  total: number | null;
}

/**
 * Where the update is in the notify → download → restart sequence.
 *
 * `available` and `ready` are the two resting states the user acts from, and the
 * distinction matters: `ready` means the bytes are already on disk, so the button
 * restarts rather than starting a transfer.
 */
export type UpdateStage =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface Updater {
  stage: UpdateStage;
  info: UpdateInfo | null;
  /** Download progress 0–100, or null when the server sent no content-length. */
  percent: number | null;
  error: string | null;
  /** True while the banner should be shown. Dismissing clears it, not the update. */
  visible: boolean;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  /** Hide until the next launch. */
  dismiss: () => void;
  /** Never mention this version again. */
  skip: () => void;
}

/**
 * Drives the updater from the UI side.
 *
 * Both listens and polls: the automatic check fires several seconds after launch,
 * which may be before or after this mounts, and `updater_pending` covers the
 * "after" case. Progress arrives as events because a download is the one step
 * long enough that silence would read as a hang.
 */
export function useUpdater(): Updater {
  const [stage, setStage] = useState<UpdateStage>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const keep = (fn: () => void) => {
      if (cancelled) fn();
      else unlisten.push(fn);
    };

    // The startup check may already have run and emitted before this mounted.
    invoke<UpdateInfo | null>("updater_pending")
      .then((pending) => {
        if (cancelled || !pending) return;
        setInfo(pending);
        setStage(pending.downloaded ? "ready" : "available");
        // A skipped update stays pending so Settings can still offer it, but it
        // must not come back as a banner on the next launch.
        setVisible(!pending.skipped);
      })
      .catch(() => {});

    listen<UpdateInfo>("updater:available", (event) => {
      if (cancelled) return;
      setInfo(event.payload);
      setStage("available");
      setVisible(true);
    }).then(keep);

    listen<Progress>("updater:progress", (event) => {
      if (cancelled) return;
      const { downloaded, total } = event.payload;
      setPercent(total && total > 0 ? Math.floor((downloaded / total) * 100) : null);
    }).then(keep);

    // Emitted when a download completes, whoever started it. Both the banner and
    // the Settings section run their own instance of this hook over one shared
    // Rust-side state, so without this the surface that did not start the download
    // would sit on "downloading" forever.
    listen<UpdateInfo>("updater:ready", (event) => {
      if (cancelled) return;
      setInfo(event.payload);
      setStage("ready");
      setPercent(100);
    }).then(keep);

    return () => {
      cancelled = true;
      unlisten.forEach((fn) => fn());
    };
  }, []);

  const check = useCallback(async () => {
    setStage("checking");
    setError(null);
    try {
      const found = await invoke<UpdateInfo | null>("updater_check");
      setInfo(found);
      if (found) {
        setStage(found.downloaded ? "ready" : "available");
        setVisible(true);
      } else {
        setStage("idle");
      }
    } catch (e) {
      setError(String(e));
      setStage("error");
    }
  }, []);

  const download = useCallback(async () => {
    setStage("downloading");
    setPercent(0);
    setError(null);
    try {
      setInfo(await invoke<UpdateInfo>("updater_download"));
      setStage("ready");
    } catch (e) {
      setError(String(e));
      setStage("error");
    }
  }, []);

  const install = useCallback(async () => {
    setStage("installing");
    setError(null);
    try {
      // Succeeds by never returning — the process is replaced. Reaching the line
      // after this means the install failed to take over, so only the catch
      // below is a meaningful outcome.
      await invoke("updater_install");
    } catch (e) {
      setError(String(e));
      setStage("error");
    }
  }, []);

  const dismiss = useCallback(() => setVisible(false), []);

  const skip = useCallback(() => {
    setVisible(false);
    if (info) invoke("updater_skip_version", { version: info.version }).catch(() => {});
  }, [info]);

  return { stage, info, percent, error, visible, check, download, install, dismiss, skip };
}
