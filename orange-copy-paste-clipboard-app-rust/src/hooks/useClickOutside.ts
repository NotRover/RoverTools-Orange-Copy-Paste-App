import { useEffect, useRef } from "react";

/**
 * Close a dropdown/flyout when a mousedown lands outside `ref`.
 * No-op while `isOpen` is false, so the listener is only attached when needed.
 * `onClose` is read through a ref so its identity doesn't need to be stable.
 */
export function useClickOutside<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  isOpen: boolean,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [isOpen, ref]);
}
