"use client";

import Link from "next/link";
import { Avatar } from "@/ui/avatar";
import { Card } from "@/ui/card";
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/feedback";
import { useRanking, useSlug } from "../api";
import { DataGrid, TeamSelect, useSearchParam } from "../dashboard/kit";
import { formatMoney, formatPct } from "../shared/money";
import { PeriodPicker, toKpiPeriod, usePeriodParam } from "../shared/period-picker";
import { salesRoutes } from "../shared/routes";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { useSalesScope } from "../shared/scope";
import { StatusDot } from "../shared/status-dot";

/** `/[workspace]/sales/performance`: the ranking (api.md §19) for a period, optionally one team. */
export function PerformanceScreen() {
  return (
    <SalesGate permission="sales.performance.view" name="Performance">
      <Ranking />
    </SalesGate>
  );
}

function Ranking() {
  const ws = useSlug();
  const { beyondOwn } = useSalesScope("sales.performance.view");
  const [period, setPeriod] = usePeriodParam();
  const [team, setTeam] = useSearchParam("team");
  const q = useRanking({ period: toKpiPeriod(period), teamId: beyondOwn ? (team ?? undefined) : undefined });
  const rows = q.data?.rows ?? [];
  const name = (r: (typeof rows)[number]) => (
    <Link href={salesRoutes.performanceUser(ws, r.user.id)} className="flex min-w-0 items-center gap-2 hover:underline">
      <Avatar name={r.user.name} hue={r.user.hue} size={20} decorative />
      <span className="truncate">{r.user.name}</span>
    </Link>
  );
  return (
    <SalesPageFrame title="Performance">
      <div className="flex flex-wrap items-center gap-2">
        <PeriodPicker value={period} onChange={setPeriod} className="max-[760px]:w-full max-[760px]:[&>button]:flex-1" />
        {beyondOwn && <TeamSelect value={team} onChange={setTeam} />}
      </div>
      {q.isPending ? (
        <SkeletonRows rows={6} label="Loading the ranking" />
      ) : q.isError ? (
        <ErrorState title="Couldn’t load the ranking" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : rows.length === 0 ? (
        <EmptyState title="Nobody to rank" body="No salespeople sold or had a target in this period." />
      ) : (
        <>
          <p className="m-0 text-meta text-fg-3">
            {q.data.period.start} – {q.data.period.end}
          </p>
          {/* Desktop: a table; phones: cards. */}
          <Card className="p-4 max-[760px]:hidden">
            <DataGrid
              label="Ranking"
              head={["#", "Salesperson", "Status", "Actual", "Target", "Achievement", "Won"]}
              rightFrom={3}
              keys={rows.map((r) => r.user.id)}
              rows={rows.map((r) => [
                r.rank,
                name(r),
                <StatusDot key="s" status={r.status} showLabel />,
                formatMoney(r.actual),
                formatMoney(r.target),
                formatPct(r.achievement),
                r.wonCount,
              ])}
            />
          </Card>
          <ul className="m-0 hidden list-none flex-col gap-2 p-0 max-[760px]:flex" aria-label="Ranking">
            {rows.map((r) => (
              <li key={r.user.id} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
                <div className="flex min-w-0 items-center gap-2 text-[14px]">
                  <span className="tabular w-6 text-fg-3">{r.rank}</span>
                  {name(r)}
                  <StatusDot status={r.status} className="ml-auto" />
                </div>
                <div className="flex justify-between text-meta text-fg-3">
                  <span>
                    <span className="tabular text-fg">{formatMoney(r.actual, { compact: true })}</span> of {formatMoney(r.target, { compact: true })}
                  </span>
                  <span className="tabular">{formatPct(r.achievement)} · {r.wonCount} won</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </SalesPageFrame>
  );
}
