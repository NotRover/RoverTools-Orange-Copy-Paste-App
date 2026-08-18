import { useEffect, useState } from "react";

/**
 * State that survives the screen unmounting.
 *
 * Only one screen is mounted at a time, so everything a screen held in
 * `useState` - which filters were applied, which day sections were collapsed -
 * was thrown away the moment you looked at another screen and came back to an
 * unfiltered, fully expanded list you had not asked for.
 *
 * Backed by localStorage rather than a module variable, so it survives a
 * restart too. Sort and layout already worked this way; this is the same idea
 * with the JSON round trip written once instead of at every call site.
 */
function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    // Written by an older build, or storage is unavailable. Start clean.
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage full or blocked: losing the preference beats throwing. */
  }
}

export function useSticky<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => read(key, fallback));
  useEffect(() => write(key, value), [key, value]);
  return [value, setValue] as const;
}

/** Same, for the sets the filters are built from. Stored as an array. */
export function useStickySet<T extends string>(key: string, fallback: T[] = []) {
  const [value, setValue] = useState<Set<T>>(
    () => new Set(read<T[]>(key, fallback)),
  );
  useEffect(() => write(key, [...value]), [key, value]);
  return [value, setValue] as const;
}
