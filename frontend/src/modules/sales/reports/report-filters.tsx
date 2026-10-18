"use client";

import { useSearchParams } from "next/navigation";
import type { SalesReportPeriod } from "@/api/types";
import { DatePicker } from "@/ui/date-picker";
import { FilterPills } from "@/ui/tabs";
import { TeamSelect, useSearchParam } from "../dashboard/kit";
import { useSalesScope } from "../shared/scope";
import { UserPicker } from "../shared/user-picker";

export const REPORT_PERIODS: { value: SalesReportPeriod; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
  { value: "custom", label: "Custom" },
];

const isPeriod = (v: string | null): v is SalesReportPeriod => REPORT_PERIODS.some((p) => p.value === v);

export interface ReportFilterState {
  /** null = the report's default period. */
  period: SalesReportPeriod | null;
  from: string | null;
  to: string | null;
  teamId: string | null;
  userId: string | null;
}

/** The report filters in the URL: `?period=&from=&to=&team=&user=`. */
export function useReportFilters() {
  const search = useSearchParams();
  const raw = search.get("period");
  const [from, setFrom] = useSearchParam("from");
  const [to, setTo] = useSearchParam("to");
  const [teamId, setTeam] = useSearchParam("team");
  const [userId, setUser] = useSearchParam("user");
  const [, setPeriod] = useSearchParam("period");
  const value: ReportFilterState = { period: isPeriod(raw) ? raw : null, from, to, teamId, userId };
  return { value, setPeriod, setFrom, setTo, setTeam, setUser };
}

/** API query for the filters; null while a custom range is incomplete or reversed. */
export function reportQuery(f: ReportFilterState) {
  const scope = { teamId: f.teamId ?? undefined, userId: f.userId ?? undefined };
  if (f.period === "custom") {
    if (!f.from || !f.to || f.to < f.from) return null;
    return { period: "custom" as const, from: f.from, to: f.to, ...scope };
  }
  return { period: f.period ?? undefined, ...scope };
}

/** The filters as a query string, carried from the reports center into a report. */
export function reportSearch(f: ReportFilterState) {
  const sp = new URLSearchParams();
  if (f.period) sp.set("period", f.period);
  if (f.period === "custom") {
    if (f.from) sp.set("from", f.from);
    if (f.to) sp.set("to", f.to);
  }
  if (f.teamId) sp.set("team", f.teamId);
  if (f.userId) sp.set("user", f.userId);
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

/** Period (incl. custom from/to), team (scope `all`) and person (scope `team` / `all`) filters. */
export function ReportFilters({ defaultPeriod }: { defaultPeriod?: SalesReportPeriod }) {
  const { value: f, setPeriod, setFrom, setTo, setTeam, setUser } = useReportFilters();
  const scope = useSalesScope("sales.report.view");
  const current = f.period ?? defaultPeriod ?? "default";
  const items = defaultPeriod ? REPORT_PERIODS : [{ value: "default" as const, label: "Default" }, ...REPORT_PERIODS];
  const invalid = f.period === "custom" && f.from && f.to && f.to < f.from;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="max-w-full overflow-x-auto">
          <FilterPills
            label="Period"
            value={current}
            items={items}
            onChange={(v) => setPeriod(v === "default" || v === defaultPeriod ? null : v)}
          />
        </div>
        {scope.isAll && <TeamSelect value={f.teamId} onChange={setTeam} />}
        {scope.beyondOwn && <UserPicker value={f.userId} onChange={setUser} noneLabel="Everyone" className="max-[760px]:w-full" />}
      </div>
      {f.period === "custom" && (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg-3">
          <DatePicker aria-label="From" value={f.from} onChange={setFrom} max={f.to ?? undefined} placeholder="From" />
          <span>to</span>
          <DatePicker aria-label="To" value={f.to} onChange={setTo} min={f.from ?? undefined} placeholder="To" />
          {invalid && <span className="text-danger">“To” must be on or after “From”.</span>}
        </div>
      )}
    </div>
  );
}
