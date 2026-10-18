"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { replaceUrl } from "@/platform/routes";

/**
 * Query-string state for filters, tabs and dialogs (`?status=active&q=abay`). Writes go through `replaceUrl`
 * (History API), never `router.push`. An empty value removes the key.
 */
export function useUrlState() {
  const pathname = usePathname();
  const search = useSearchParams();
  const get = (k: string) => search.get(k) ?? "";
  const set = (patch: Record<string, string | null | undefined>) => {
    const sp = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    const qs = sp.toString();
    replaceUrl(qs ? `${pathname}?${qs}` : pathname);
  };
  return { get, set };
}
