"use client";

import { usePathname, useSearchParams } from "next/navigation";
import type { SalesDashboardPeriod, SalesKpiPeriod } from "@/api/types";
import { replaceUrl } from "@/platform/routes";
import { FilterPills } from "@/ui/tabs";

export type SalesPeriod = SalesDashboardPeriod;

export const SALES_PERIODS: { value: SalesPeriod; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
];

export const isSalesPeriod = (v: string | null | undefined): v is SalesPeriod => SALES_PERIODS.some((p) => p.value === v);
/** Performance / targets call "today" `day`. */
export const toKpiPeriod = (p: SalesPeriod): SalesKpiPeriod => (p === "today" ? "day" : p);

/**
 * The period in the query string (`?period=`; the default is left out of the URL). Changes go through `replaceUrl`
 * (History API), never `router.push`.
 */
export function usePeriodParam(param = "period", fallback: SalesPeriod = "month"): [SalesPeriod, (p: SalesPeriod) => void] {
  const pathname = usePathname();
  const search = useSearchParams();
  const raw = search.get(param);
  const value = isSalesPeriod(raw) ? raw : fallback;
  const set = (p: SalesPeriod) => {
    const sp = new URLSearchParams(window.location.search);
    if (p === fallback) sp.delete(param);
    else sp.set(param, p);
    const qs = sp.toString();
    replaceUrl(qs ? `${pathname}?${qs}` : pathname);
  };
  return [value, set];
}

/** Today / Week / Month / Quarter / Year pills. Controlled; pair with `usePeriodParam` for URL state. */
export function PeriodPicker({
  value,
  onChange,
  periods = SALES_PERIODS,
  className,
}: {
  value: SalesPeriod;
  onChange: (p: SalesPeriod) => void;
  periods?: { value: SalesPeriod; label: string }[];
  className?: string;
}) {
  return <FilterPills label="Period" value={value} onChange={onChange} items={periods} className={className} />;
}
