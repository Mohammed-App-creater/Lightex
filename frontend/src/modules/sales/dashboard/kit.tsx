"use client";

import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import type { SalesKpis } from "@/api/types";
import { useTeams } from "@/platform/teams/queries";
import { replaceUrl } from "@/platform/routes";
import { Skeleton } from "@/ui/feedback";
import { Select } from "@/ui/select";
import { cn } from "@/lib/utils/cn";
import { useSlug } from "../api";
import { formatMoney, formatPct, toCents } from "../shared/money";
import { StatusDot } from "../shared/status-dot";

/* Small pieces shared by the dashboard, performance and reports screens (phase B1). */

/** One query-string value (`?name=`), changed with `replaceUrl`. Empty / null removes it. */
export function useSearchParam(name: string): [string | null, (v: string | null) => void] {
  const pathname = usePathname();
  const search = useSearchParams();
  const value = search.get(name) || null;
  const set = (v: string | null) => {
    const sp = new URLSearchParams(window.location.search);
    if (v) sp.set(name, v);
    else sp.delete(name);
    const qs = sp.toString();
    replaceUrl(qs ? `${pathname}?${qs}` : pathname);
  };
  return [value, set];
}

const ALL = "__all";

/** Team filter (the workspace's teams); null = every team. */
export function TeamSelect({ value, onChange, className }: { value: string | null; onChange: (id: string | null) => void; className?: string }) {
  const slug = useSlug();
  const teams = useTeams(slug);
  const options = [{ value: ALL, label: "All teams" }, ...(teams.data ?? []).map((t) => ({ value: t.id, label: t.name }))];
  return (
    <Select
      label="Team"
      hideLabel
      value={value ?? ALL}
      onChange={(v) => onChange(v === ALL ? null : v)}
      options={options}
      width={220}
      className={cn("w-[180px] max-[760px]:w-full", className)}
    />
  );
}

export type Trend = "up" | "down" | "flat" | null;

/** Compare money strings (cents) or numbers; null when either side is missing. */
export function trendOf(cur: string | number | null | undefined, prev: string | number | null | undefined): Trend {
  if (cur == null || prev == null) return null;
  if (typeof cur === "string" || typeof prev === "string") {
    const a = toCents(String(cur));
    const b = toCents(String(prev));
    return a > b ? "up" : a < b ? "down" : "flat";
  }
  return cur > prev ? "up" : cur < prev ? "down" : "flat";
}

/** KPI tile: value, previous-period comparison and an optional extra line. */
export function KpiTile({ label, value, prev, trend, extra }: { label: ReactNode; value: ReactNode; prev?: string; trend?: Trend; extra?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface px-4 py-3.5">
      <span className="truncate text-meta text-fg-3">{label}</span>
      <span className="tabular truncate text-[22px] font-semibold leading-8 tracking-[-0.02em]">{value}</span>
      {prev !== undefined && (
        <span className="flex min-w-0 items-center gap-1 text-meta text-fg-3">
          {trend === "up" && <ArrowUpRight size={13} aria-label="Up" className="flex-none text-ok" />}
          {trend === "down" && <ArrowDownRight size={13} aria-label="Down" className="flex-none text-danger" />}
          <span className="truncate">Previous: {prev}</span>
        </span>
      )}
      {extra}
    </div>
  );
}

export const kpiGrid = "grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3 max-[760px]:grid-cols-2";

export function KpiSkeleton({ n = 8, label = "Loading" }: { n?: number; label?: string }) {
  return (
    <div aria-busy="true" aria-label={label} className={kpiGrid}>
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className="h-[92px] rounded-lg" />
      ))}
    </div>
  );
}

const ratio = (v: number | null) => (v == null ? "—" : `${v.toFixed(2)}×`);

/** The standard KPI tiles for a current / previous pair (performance KPI shape, api.md §19). */
export function KpiTiles({ k, p }: { k: SalesKpis; p?: SalesKpis | null }) {
  const m = (v: string | null | undefined) => formatMoney(v, { compact: true });
  const tiles: { label: string; value: ReactNode; prev?: string; trend?: Trend; extra?: ReactNode }[] = [
    {
      label: "Actual sales",
      value: m(k.actual),
      prev: p ? m(p.actual) : undefined,
      trend: p ? trendOf(k.actual, p.actual) : null,
      extra: k.growth != null ? <span className="text-meta text-fg-3">Growth {formatPct(k.growth)}</span> : undefined,
    },
    { label: "Target", value: m(k.target), prev: p ? m(p.target) : undefined },
    {
      label: "Achievement",
      value: (
        <span className="inline-flex items-center gap-2">
          {formatPct(k.achievement)}
          <StatusDot status={k.status} />
        </span>
      ),
      prev: p ? formatPct(p.achievement) : undefined,
      trend: p ? trendOf(k.achievement, p.achievement) : null,
      extra: k.expected != null ? <span className="truncate text-meta text-fg-3">Expected so far {m(k.expected)}</span> : undefined,
    },
    { label: "Conversion rate", value: formatPct(k.winRate), prev: p ? formatPct(p.winRate) : undefined, trend: p ? trendOf(k.winRate, p.winRate) : null },
    { label: "Won / lost", value: `${k.wonCount} / ${k.lostCount}`, prev: p ? `${p.wonCount} / ${p.lostCount}` : undefined, trend: p ? trendOf(k.wonCount, p.wonCount) : null },
    { label: "Average deal", value: m(k.averageDealSize), prev: p ? m(p.averageDealSize) : undefined },
    { label: "Pipeline value", value: m(k.pipelineValue), prev: p ? m(p.pipelineValue) : undefined },
    { label: "Weighted pipeline", value: m(k.weightedPipeline), prev: p ? m(p.weightedPipeline) : undefined },
    { label: "Pipeline coverage", value: ratio(k.pipelineCoverage), prev: p ? ratio(p.pipelineCoverage) : undefined },
    { label: "New leads", value: String(k.newLeads), prev: p ? String(p.newLeads) : undefined, trend: p ? trendOf(k.newLeads, p.newLeads) : null },
    { label: "Lead → opportunity", value: formatPct(k.leadToOpportunityRate), prev: p ? formatPct(p.leadToOpportunityRate) : undefined },
    {
      label: "Follow-ups on time",
      value: formatPct(k.followUpPerformance),
      prev: p ? formatPct(p.followUpPerformance) : undefined,
      extra: <span className="text-meta text-fg-3">{k.followUpsOnTime} of {k.followUpsDue} due</span>,
    },
  ];
  return (
    <div className={kpiGrid}>
      {tiles.map((t) => (
        <KpiTile key={t.label} {...t} />
      ))}
    </div>
  );
}

/** A plain table that scrolls sideways on narrow screens. Columns from `rightFrom` on are right-aligned numbers. */
export function DataGrid({
  head,
  rows,
  keys,
  rightFrom,
  numeric,
  foot,
  label,
}: {
  head: ReactNode[];
  rows: ReactNode[][];
  keys: string[];
  rightFrom?: number;
  /** Per-column "is a number" (right-aligned); overrides `rightFrom`. */
  numeric?: boolean[];
  foot?: ReactNode[];
  label?: string;
}) {
  const align = (i: number) => ((numeric ? numeric[i] : rightFrom !== undefined && i >= rightFrom) ? "text-right" : "text-left");
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table aria-label={label} className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className={cn("whitespace-nowrap border-b border-line py-2 pr-3 font-medium text-fg-3 last:pr-0", align(i))}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={keys[ri]}>
              {r.map((c, ci) => (
                <td key={ci} className={cn("tabular whitespace-nowrap border-b border-line py-2 pr-3 last:pr-0", align(ci))}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {foot && (
          <tfoot>
            <tr>
              {foot.map((c, ci) => (
                <td key={ci} className={cn("tabular whitespace-nowrap py-2 pr-3 font-semibold last:pr-0", align(ci))}>
                  {c}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
