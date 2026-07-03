import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Layout toggle with a cross-fade: `selectLayout` flips `fading` on, then swaps
 * the layout (and persists it to localStorage) after `fadeMs`. Shared by the
 * clipboard and notes screens, which had identical copies of this logic.
 */
export function useLayoutTransition<T extends string>(
  storageKey: string,
  initial: T,
  fadeMs = 160,
): { layout: T; fading: boolean; selectLayout: (l: T) => void } {
  const [layout, setLayout] = useState<T>(
    () => (localStorage.getItem(storageKey) as T) ?? initial,
  );
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
        setFading(false);
      }, fadeMs);
    },
    [storageKey, fadeMs],
  );

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return { layout, fading, selectLayout };
}
