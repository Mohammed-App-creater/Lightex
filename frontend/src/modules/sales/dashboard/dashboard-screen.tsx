"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { isForbidden, isModuleDisabled } from "@/api/errors";
import { qk } from "@/api/query-keys";
import type { SalesDashboard } from "@/api/types";
import { useCan, useCurrentWorkspace } from "@/platform/roles/can";
import { ModuleDisabledScreen } from "@/platform/shell/module-screens";
import { Avatar } from "@/ui/avatar";
import { Panel } from "@/ui/card";
import { EmptyState, ErrorState } from "@/ui/feedback";
import { useEffectiveTargets, useRanking, useSalesDashboard } from "../api";
import { kindOfTarget, salesEntityHref } from "../shared/entity-link";
import { formatMoney, formatPct, toCents } from "../shared/money";
import { PeriodPicker, usePeriodParam } from "../shared/period-picker";
import { QuickActionsMenu } from "../shared/quick-actions";
import { salesRoutes } from "../shared/routes";
import { SalesGate, SalesPageFrame } from "../shared/sales-page";
import { useSalesScope } from "../shared/scope";
import { StatusDot } from "../shared/status-dot";
import { UserPicker, type Person } from "../shared/user-picker";
import { DataGrid, KpiSkeleton, KpiTiles, TeamSelect, useSearchParam } from "./kit";

const money = (v: string | null | undefined) => formatMoney(v, { compact: true });

/**
 * `/[workspace]/sales` (spec §10, api.md §21). Adapts to the caller's `sales.dashboard.view` scope: `all` → company
 * view with team and person filters, `team` → team view with a person filter, `own` → personal view with today's
 * target and run rate. Filters and period live in the URL (`?period=&team=&user=`).
 */
export function DashboardScreen() {
  return (
    <SalesGate permission="sales.dashboard.view" name="Sales">
      <Dashboard />
    </SalesGate>
  );
}

function Dashboard() {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const scope = useSalesScope("sales.dashboard.view");
  const [period, setPeriod] = usePeriodParam();
  const [team, setTeam] = useSearchParam("team");
  const [user, setUser] = useSearchParam("user");
  const teamId = scope.isAll ? (team ?? undefined) : undefined;
  const userId = scope.beyondOwn ? (user ?? undefined) : undefined;
  const dash = useSalesDashboard({ period, teamId, userId });

  const disabled = dash.isError && isModuleDisabled(dash.error);
  // The server says the module is off: refresh the workspace so the sidebar and guard catch up.
  useEffect(() => {
    if (disabled) void qc.invalidateQueries({ queryKey: qk.workspace(ws.slug), exact: true });
  }, [disabled, qc, ws.slug]);
  if (disabled) return <ModuleDisabledScreen name="Sales" />;

  const title = scope.isAll ? "Sales dashboard" : scope.beyondOwn ? "Team dashboard" : "My sales";
  return (
    <SalesPageFrame title={title} actions={<QuickActionsMenu />}>
      <div className="flex flex-wrap items-center gap-2">
        <PeriodPicker value={period} onChange={setPeriod} className="max-[760px]:w-full max-[760px]:[&>button]:flex-1" />
        {scope.isAll && <TeamSelect value={team} onChange={setTeam} />}
        {scope.beyondOwn && <PersonFilter value={user} onChange={setUser} />}
      </div>
      {dash.isPending ? (
        <KpiSkeleton label="Loading the sales dashboard" />
      ) : dash.isError ? (
        isForbidden(dash.error) ? (
          <EmptyState title="Outside your view" body="You can’t see the dashboard for this team or person. Clear the filters." />
        ) : (
          <ErrorState title="Couldn’t load the sales dashboard" onRetry={() => void dash.refetch()} retrying={dash.isFetching} />
        )
      ) : (
        <DashboardBody d={dash.data} personal={scope.isOwn} />
      )}
    </SalesPageFrame>
  );
}

/** People the caller may filter by: everyone for `all`, else the ranking's people (their scope). */
function PersonFilter({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const { isAll } = useSalesScope("sales.dashboard.view");
  const canRank = useCan("sales.performance.view");
  return isAll || !canRank ? <PersonPicker value={value} onChange={onChange} /> : <TeamPersonFilter value={value} onChange={onChange} />;
}

function TeamPersonFilter({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const ranking = useRanking({});
  return <PersonPicker value={value} onChange={onChange} people={(ranking.data?.rows ?? []).map((r) => r.user)} />;
}

function PersonPicker({ value, onChange, people }: { value: string | null; onChange: (id: string | null) => void; people?: Person[] }) {
  return <UserPicker value={value} onChange={onChange} noneLabel="Everyone" people={people} className="max-[760px]:w-full" />;
}

function DashboardBody({ d, personal }: { d: SalesDashboard; personal: boolean }) {
  const ws = useCurrentWorkspace()!.slug;
  const canFollowUps = useCan("sales.followup.view");
  const canTargets = useCan("sales.target.view");
  return (
    <>
      <p className="m-0 text-meta text-fg-3">
        {d.kpis.period.start} – {d.kpis.period.end} · {d.userCount} {d.userCount === 1 ? "person" : "people"}
      </p>
      {personal && canTargets && <TodayPanel />}
      <KpiTiles k={d.kpis} p={d.previous} />

      <div className="grid gap-4 min-[900px]:grid-cols-2">
        <Panel title="Pipeline by stage">
          <StageBars d={d} />
        </Panel>
        {!personal || d.ranking.length > 1 ? (
          <Panel title="Ranking">
            <Ranking rows={d.ranking} />
          </Panel>
        ) : (
          <Panel title="Follow-ups">
            <FollowUpCounts d={d} link={canFollowUps ? salesRoutes.followUps(ws) : null} />
          </Panel>
        )}
      </div>

      {(!personal || d.ranking.length > 1) && (
        <Panel title="Follow-ups">
          <FollowUpCounts d={d} link={canFollowUps ? salesRoutes.followUps(ws) : null} />
        </Panel>
      )}

      <div className="grid gap-4 min-[900px]:grid-cols-2">
        <Attention title="Overdue follow-ups" count={d.attention.overdueFollowUps.count}>
          {d.attention.overdueFollowUps.items.map((f) => {
            const kind = kindOfTarget(f.targetType);
            return (
              <AttentionItem
                key={f.id}
                href={kind ? salesEntityHref(ws, kind, f.targetId) : null}
                title={f.title}
                meta={`Due ${f.dueDate}${f.ownerName ? ` · ${f.ownerName}` : ""}`}
              />
            );
          })}
        </Attention>
        <Attention title="Quotations awaiting response" count={d.attention.quotationsAwaitingResponse.count}>
          {d.attention.quotationsAwaitingResponse.items.map((q) => (
            <AttentionItem
              key={q.id}
              href={salesRoutes.opportunity(ws, q.opportunityId)}
              title={`${q.number} · ${q.title}`}
              meta={`${q.companyName} · ${formatMoney(q.amount)}${q.validUntil ? ` · valid until ${q.validUntil}` : ""}`}
            />
          ))}
        </Attention>
        {(
          [
            ["Large deals closing this week", d.attention.largeClosingThisWeek],
            ["No next step", d.attention.noNextStep],
            ["Stale", d.attention.stale],
          ] as const
        ).map(([title, group]) => (
          <Attention key={title} title={title} count={group.count}>
            {group.items.map((o) => (
              <AttentionItem
                key={o.id}
                href={salesRoutes.opportunity(ws, o.id)}
                title={o.title}
                meta={`${o.companyName} · ${o.stageName} · ${formatMoney(o.expectedValue)}${o.ownerName && !personal ? ` · ${o.ownerName}` : ""}`}
              />
            ))}
          </Attention>
        ))}
      </div>
    </>
  );
}

/** Salesperson view: today's target, actual and the daily run rate still needed this month (targets §18). */
function TodayPanel() {
  const eff = useEffectiveTargets({});
  if (eff.isError) return null;
  if (eff.isPending) return <KpiSkeleton n={3} label="Loading today’s target" />;
  const t = eff.data;
  return (
    <Panel title="Today" className="bg-raised">
      <div className="grid grid-cols-2 gap-4 min-[760px]:grid-cols-4">
        <Fact label="Today’s target" value={formatMoney(t.day.target)} />
        <Fact label="Sold today" value={formatMoney(t.day.actual)} />
        <Fact label="Required daily run rate" value={formatMoney(t.month.requiredDailyRunRate)} sub={`${t.month.remainingWorkingDays} working days left`} />
        <Fact label="This month" value={formatPct(t.month.achievement)} sub={`${money(t.month.actual)} of ${money(t.month.target)}`} />
      </div>
    </Panel>
  );
}

function Fact({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-meta text-fg-3">{label}</span>
      <span className="tabular truncate text-[18px] font-semibold">{value}</span>
      {sub && <span className="truncate text-meta text-fg-3">{sub}</span>}
    </div>
  );
}

/** Horizontal bars, widths from the stage values in cents (no float money). */
function StageBars({ d }: { d: SalesDashboard }) {
  const stages = d.pipeline.stages;
  if (stages.length === 0) return <EmptyState title="No open stages" />;
  const max = stages.reduce((m, s) => (toCents(s.value) > m ? toCents(s.value) : m), toCents("0"));
  const width = (v: string) => (max > toCents("0") ? Number((toCents(v) * BigInt(1000)) / max) / 10 : 0);
  return (
    <div className="flex flex-col gap-3">
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0" aria-label="Pipeline by stage">
        {stages.map((s) => (
          <li key={s.stageId} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2 text-[13px]">
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="tabular text-fg-3">{s.count}</span>
              <span className="tabular w-[92px] text-right">{money(s.value)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-hover">
              <div className="h-full rounded-full bg-accent" style={{ width: `${width(s.value)}%` }} />
            </div>
          </li>
        ))}
      </ul>
      <p className="m-0 text-meta text-fg-3">
        Open leads: {d.pipeline.leads.count} · {money(d.pipeline.leads.value)}
      </p>
    </div>
  );
}

function Ranking({ rows }: { rows: SalesDashboard["ranking"] }) {
  const ws = useCurrentWorkspace()!.slug;
  const canPerf = useCan("sales.performance.view");
  if (rows.length === 0) return <EmptyState title="Nobody to rank yet" />;
  return (
    <DataGrid
      label="Ranking"
      head={["#", "Person", "Actual", "Achievement"]}
      rightFrom={2}
      keys={rows.map((r) => r.user.id)}
      rows={rows.map((r) => [
        r.rank,
        <span key="p" className="flex min-w-0 items-center gap-2">
          <StatusDot status={r.status} />
          <Avatar name={r.user.name} hue={r.user.hue} size={20} decorative />
          {canPerf ? (
            <Link href={salesRoutes.performanceUser(ws, r.user.id)} className="truncate hover:underline">
              {r.user.name}
            </Link>
          ) : (
            <span className="truncate">{r.user.name}</span>
          )}
        </span>,
        money(r.actual),
        formatPct(r.achievement),
      ])}
    />
  );
}

function FollowUpCounts({ d, link }: { d: SalesDashboard; link: string | null }) {
  const items: [string, number, string][] = [
    ["Overdue", d.followUps.overdue, "text-danger"],
    ["Today", d.followUps.today, "text-warn"],
    ["Upcoming", d.followUps.upcoming, "text-fg"],
  ];
  return (
    <div className="flex flex-wrap items-end gap-6">
      {items.map(([label, n, tone]) => (
        <div key={label} className="flex flex-col">
          <span className="text-meta text-fg-3">{label}</span>
          <span className={`tabular text-[22px] font-semibold ${n ? tone : "text-fg-3"}`}>{n}</span>
        </div>
      ))}
      {link && (
        <Link href={link} className="ml-auto text-[13px] text-accent hover:underline">
          Open follow-ups
        </Link>
      )}
    </div>
  );
}

const ATTENTION_LIMIT = 5;

function Attention({ title, count, children }: { title: string; count: number; children: ReactNode[] }) {
  return (
    <Panel title={`${title} (${count})`}>
      {count === 0 ? (
        <p className="m-0 text-meta text-fg-3">Nothing here.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">{children.slice(0, ATTENTION_LIMIT)}</ul>
      )}
    </Panel>
  );
}

function AttentionItem({ title, meta, href }: { title: string; meta: string; href: string | null }) {
  return (
    <li className="flex min-w-0 flex-col">
      {href ? (
        <Link href={href} className="truncate text-[14px] hover:underline">
          {title}
        </Link>
      ) : (
        <span className="truncate text-[14px]">{title}</span>
      )}
      <span className="truncate text-meta text-fg-3">{meta}</span>
    </li>
  );
}
