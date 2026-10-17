"use client";

import { useEffect, useRef } from "react";

/**
 * Guards unsaved edits: blocks in-app link navigation (capture-phase click on <a href>) and asks
 * the browser to confirm reloads / tab closes. `onBlocked` runs when a navigation was stopped
 * (shake the save bar, show a hint).
 */
export function useLeaveGuard(active: boolean, onBlocked: () => void) {
  const cb = useRef(onBlocked);
  useEffect(() => {
    cb.current = onBlocked;
  });

  useEffect(() => {
    if (!active) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      cb.current();
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [active]);
}
