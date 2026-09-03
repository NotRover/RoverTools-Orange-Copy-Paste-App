import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Shared, deduped, cached loaders for per-file metadata used by clipboard
// cards. Previously every file card fired its own `get_image_file_preview` and
// `check_missing_files` invokes on mount; with a large history that's a burst
// of redundant IPC. These loaders coalesce requests across all cards in a tick,
// dedupe by path, and cache results for the session.

// ── Missing-file checks (batched into a single invoke per tick) ────────────

const missingCache = new Map<string, boolean>();
const missingInflight = new Map<string, Promise<void>>();
let missingBatch: string[] = [];
let missingBatchPromise: Promise<void> | null = null;

function requestMissing(paths: string[]): Promise<void> {
  const uncached = paths.filter(
    (p) => !missingCache.has(p) && !missingInflight.has(p),
  );
  if (uncached.length > 0) {
    missingBatch.push(...uncached);
    if (!missingBatchPromise) {
      missingBatchPromise = new Promise((resolve) => {
        queueMicrotask(async () => {
          const batch = missingBatch;
          missingBatch = [];
          missingBatchPromise = null;
          try {
            const missing = new Set(
              await invoke<string[]>("check_missing_files", { paths: batch }),
            );
            for (const p of batch) missingCache.set(p, missing.has(p));
          } catch {
            // On error, treat all as present (matches the prior silent catch).
            for (const p of batch) missingCache.set(p, false);
          }
          resolve();
        });
      });
    }
    for (const p of uncached) missingInflight.set(p, missingBatchPromise);
  }
  const waits = paths
    .map((p) => (missingCache.has(p) ? null : missingInflight.get(p)))
    .filter((p): p is Promise<void> => p != null);
  return Promise.all(waits).then(() => {
    for (const p of paths) missingInflight.delete(p);
  });
}

function collectMissing(paths: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) if (missingCache.get(p)) out.add(p);
  return out;
}

/** Subset of `paths` that no longer exist on disk. */
export function useMissingFiles(paths: string[]): Set<string> {
  const key = paths.join("\n");
  const [missing, setMissing] = useState<Set<string>>(() =>
    collectMissing(paths),
  );
  useEffect(() => {
    if (paths.length === 0) {
      setMissing(new Set());
      return;
    }
    let active = true;
    requestMissing(paths).then(() => {
      if (active) setMissing(collectMissing(paths));
    });
    if (paths.every((p) => missingCache.has(p))) setMissing(collectMissing(paths));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return missing;
}

// ── Image previews (deduped per path, cached for the session) ──────────────

const previewCache = new Map<string, string | null>();
const previewInflight = new Map<string, Promise<string | null>>();

/**
 * Load (or return cached) base64 preview for one image path. Deduped per path
 * and cached for the session — safe to call from many components. Resolves to
 * null when no preview is available (or on error).
 */
export function loadImagePreview(path: string): Promise<string | null> {
  if (previewCache.has(path)) return Promise.resolve(previewCache.get(path)!);
  const existing = previewInflight.get(path);
  if (existing) return existing;
  const p = invoke<string | null>("get_image_file_preview", { path })
    .catch(() => null)
    .then((res) => {
      previewCache.set(path, res);
      previewInflight.delete(path);
      return res;
    });
  previewInflight.set(path, p);
  return p;
}

function collectPreviews(paths: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const p of paths) if (previewCache.has(p)) out[p] = previewCache.get(p)!;
  return out;
}

// ── File stats (size, dir/item-count, missing) batched per tick ────────────

export interface FileStat {
  path: string;
  is_dir: boolean;
  /** Byte size for a file; null for a directory or a missing path. */
  size: number | null;
  /** Top-level entry count for a directory; null otherwise. */
  item_count: number | null;
  missing: boolean;
}

const statCache = new Map<string, FileStat>();
const statInflight = new Map<string, Promise<void>>();
let statBatch: string[] = [];
let statBatchPromise: Promise<void> | null = null;

const missingStat = (path: string): FileStat => ({
  path,
  is_dir: false,
  size: null,
  item_count: null,
  missing: true,
});

function requestStats(paths: string[]): Promise<void> {
  const uncached = paths.filter(
    (p) => !statCache.has(p) && !statInflight.has(p),
  );
  if (uncached.length > 0) {
    statBatch.push(...uncached);
    if (!statBatchPromise) {
      statBatchPromise = new Promise((resolve) => {
        queueMicrotask(async () => {
          const batch = statBatch;
          statBatch = [];
          statBatchPromise = null;
          try {
            const stats = await invoke<FileStat[]>("stat_files", {
              paths: batch,
            });
            for (const s of stats) statCache.set(s.path, s);
            // Any path the command did not answer for: treat as missing, so a
            // row still resolves instead of waiting forever.
            for (const p of batch)
              if (!statCache.has(p)) statCache.set(p, missingStat(p));
          } catch {
            // On error leave rows unresolved-but-present rather than crossed out.
            for (const p of batch)
              statCache.set(p, { ...missingStat(p), missing: false });
          }
          resolve();
        });
      });
    }
    for (const p of uncached) statInflight.set(p, statBatchPromise);
  }
  const waits = paths
    .map((p) => (statCache.has(p) ? null : statInflight.get(p)))
    .filter((p): p is Promise<void> => p != null);
  return Promise.all(waits).then(() => {
    for (const p of paths) statInflight.delete(p);
  });
}

function collectStats(paths: string[]): Record<string, FileStat> {
  const out: Record<string, FileStat> = {};
  for (const p of paths) {
    const s = statCache.get(p);
    if (s) out[p] = s;
  }
  return out;
}

/** Size / directory / missing facts for the given paths, keyed by path.
 *  Batched into one `stat_files` invoke per tick and cached for the session. */
export function useFileStats(paths: string[]): Record<string, FileStat> {
  const key = paths.join("\n");
  const [stats, setStats] = useState<Record<string, FileStat>>(() =>
    collectStats(paths),
  );
  useEffect(() => {
    if (paths.length === 0) {
      setStats({});
      return;
    }
    let active = true;
    requestStats(paths).then(() => {
      if (active) setStats(collectStats(paths));
    });
    if (paths.every((p) => statCache.has(p))) setStats(collectStats(paths));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return stats;
}

/** Base64 data-URL previews for the given image paths, keyed by path. */
export function useImagePreviews(
  paths: string[],
): Record<string, string | null> {
  const key = paths.join("\n");
  const [previews, setPreviews] = useState<Record<string, string | null>>(() =>
    collectPreviews(paths),
  );
  useEffect(() => {
    if (paths.length === 0) {
      setPreviews({});
      return;
    }
    let active = true;
    Promise.all(
      paths.map((p) => loadImagePreview(p).then((res) => [p, res] as const)),
    ).then((entries) => {
      if (active) setPreviews(Object.fromEntries(entries));
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return previews;
}
