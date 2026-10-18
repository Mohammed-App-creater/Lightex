"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { replaceUrl } from "@/platform/routes";

/**
 * Query-string state for sales screens (filters, view, tab). Reads with `useSearchParams`, writes with `replaceUrl`
 * (History API, never `router.push`). Empty / null values are dropped from the URL.
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

/** A `YYYY-MM-DD` date in the browser's time zone (the mock and the forms use workspace dates). */
export function isoDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "2026-10-14" → "Oct 14, 2026"; null → "—". */
export function formatDay(v: string | null | undefined) {
  if (!v) return "—";
  const d = new Date(v.length === 10 ? `${v}T12:00:00` : v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
