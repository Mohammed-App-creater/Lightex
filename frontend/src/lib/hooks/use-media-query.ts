"use client";

import { useCallback, useSyncExternalStore } from "react";

export function useMediaQuery(query: string, serverValue = false) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverValue,
  );
}

/** Design breakpoints: mobile ≤ 760px (task sheet, list cards), drawer < 1024px. */
export const useIsMobile = () => useMediaQuery("(max-width: 760px)");
export const useIsCompact = () => useMediaQuery("(max-width: 1023px)");
export const usePrefersReducedMotion = () => useMediaQuery("(prefers-reduced-motion: reduce)");
