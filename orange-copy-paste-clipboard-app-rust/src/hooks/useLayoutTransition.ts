import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Layout toggle with a cross-fade: `selectLayout` flips `fading` on, then swaps
 * the layout (and persists it to localStorage) after `fadeMs`. Shared by the
 * clipboard and notes screens, which had identical copies of this logic.
 * A stored value outside `allowed` reads as `allowed[0]`. `onPersist` runs
 * right after each write, for a caller whose key roams.
 */
export function useLayoutTransition<T extends string>(
  storageKey: string,
  allowed: readonly T[],
  onPersist?: () => void,
  fadeMs = 160,
): { layout: T; fading: boolean; selectLayout: (l: T) => void } {
  const [layout, setLayout] = useState<T>(() => {
    const v = localStorage.getItem(storageKey);
    return allowed.includes(v as T) ? (v as T) : allowed[0];
  });
  const [fading, setFading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const selectLayout = useCallback(
    (l: T) => {
      if (l === layoutRef.current) return;
      setFading(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setLayout(l);
        localStorage.setItem(storageKey, l);
        onPersist?.();
        setFading(false);
      }, fadeMs);
    },
    [storageKey, onPersist, fadeMs],
  );

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return { layout, fading, selectLayout };
}
