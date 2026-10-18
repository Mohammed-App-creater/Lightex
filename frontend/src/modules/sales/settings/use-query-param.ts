"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { replaceUrl } from "@/platform/routes";

/**
 * One query-string value (`?name=`), changed with `replaceUrl` (History API, never `router.push`). Setting the
 * fallback (or null / "") removes it from the URL. Shared by the settings, targets and daily-report screens.
 */
export function useQueryParam(name: string, fallback = ""): [string, (v: string | null) => void] {
  const pathname = usePathname();
  const search = useSearchParams();
  const value = search.get(name) ?? fallback;
  const set = (v: string | null) => {
    const sp = new URLSearchParams(window.location.search);
    if (!v || v === fallback) sp.delete(name);
    else sp.set(name, v);
    const qs = sp.toString();
    replaceUrl(qs ? `${pathname}?${qs}` : pathname);
  };
  return [value, set];
}
