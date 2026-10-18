"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { isNotFound } from "@/api/errors";
import type { SalesEffectiveTargets } from "@/api/types";
import { useCan } from "@/platform/roles/can";
import { Avatar } from "@/ui/avatar";
import { Panel } from "@/ui/card";
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/feedback";
import { useEffectiveTargets, usePerformance, useSlug } from "../api";
import { DataGrid, KpiSkeleton, KpiTiles } from "../dashboard/kit";
import { formatMoney, formatPct } from "../shared/money";
import { PeriodPicker, toKpiPeriod, usePeriodParam } from "../shared/period-picker";
import { salesRoutes } from "../shared/routes";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { StatusDot } from "../shared/status-dot";

/** `/[workspace]/sales/performance/[userId]`: one person's KPIs vs the previous period, status and targets. */
export function PerformanceUserScreen({ userId }: { userId: string }) {
  return (
    <SalesGate permission="sales.performance.view" name="Performance">
      <UserPerformance userId={userId} />
    </SalesGate>
  );
}

function UserPerformance({ userId }: { userId: string }) {
  const ws = useSlug();
  const canTargets = useCan("sales.target.view");
  const [period, setPeriod] = usePeriodParam();
  const q = usePerformance(userId, { period: toKpiPeriod(period) });
  const back = (
    <Link href={salesRoutes.performance(ws)} className="inline-flex items-center gap-1 text-[13px] text-fg-3 hover:text-fg">
      <ArrowLeft size={14} aria-hidden /> Ranking
    </Link>
  );
  if (q.isError && isNotFound(q.error)) {
    return (
      <SalesPageFrame title="Performance" actions={back}>
        <EmptyState title="Person not found" body="They’re not in your performance view, or no longer in this workspace." />
      </SalesPageFrame>
    );
  }
  const d = q.data;
  return (
    <SalesPageFrame
      title={
        d ? (
          <span className="inline-flex items-center gap-2">
            <Avatar name={d.user.name} hue={d.user.hue} size={24} decorative />
            {d.user.name}
          </span>
        ) : (
          "Performance"
        )
      }
      actions={back}
    >
      <div className="flex flex-wrap items-center gap-3">
        <PeriodPicker value={period} onChange={setPeriod} className="max-[760px]:w-full max-[760px]:[&>button]:flex-1" />
        {d && <StatusDot status={d.current.status} showLabel />}
      </div>
      {q.isPending ? (
        <KpiSkeleton label="Loading performance" />
      ) : q.isError ? (
        <ErrorState title="Couldn’t load performance" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <>
          <p className="m-0 text-meta text-fg-3">
            {q.data.current.period.start} – {q.data.current.period.end} · previous {q.data.previous.period.start} – {q.data.previous.period.end}
          </p>
          <KpiTiles k={q.data.current} p={q.data.previous} />
        </>
      )}
      {canTargets && <Targets userId={userId} />}
    </SalesPageFrame>
  );
}

const PERIODS: [keyof Pick<SalesEffectiveTargets, "day" | "week" | "month" | "quarter" | "year">, string][] = [
  ["day", "Today"],
  ["week", "Week"],
  ["month", "Month"],
  ["quarter", "Quarter"],
  ["year", "Year"],
];

/** Effective targets (targets §18): day … year with actual so far and the daily run rate still needed. */
function Targets({ userId }: { userId: string }) {
  const q = useEffectiveTargets({ userId });
  return (
    <Panel title="Targets">
      {q.isPending ? (
        <SkeletonRows rows={5} label="Loading targets" />
      ) : q.isError ? (
        isNotFound(q.error) ? (
          <p className="m-0 text-meta text-fg-3">Targets aren’t in your view for this person.</p>
        ) : (
          <ErrorState title="Couldn’t load targets" onRetry={() => void q.refetch()} retrying={q.isFetching} />
        )
      ) : (
        <DataGrid
          label="Effective targets"
          head={["Period", "Target", "Actual", "Achievement", "Days left", "Run rate / day"]}
          rightFrom={1}
          keys={PERIODS.map(([k]) => k)}
          rows={PERIODS.map(([k, label]) => {
            const b = q.data[k];
            return [
              <span key="l" className="flex flex-col">
                <span>{label}</span>
                <span className="text-meta text-fg-3">
                  {b.start === b.end ? b.start : `${b.start} – ${b.end}`}
                </span>
              </span>,
              formatMoney(b.target),
              formatMoney(b.actual),
              formatPct(b.achievement),
              b.remainingWorkingDays,
              formatMoney(b.requiredDailyRunRate),
            ];
          })}
        />
      )}
    </Panel>
  );
}
