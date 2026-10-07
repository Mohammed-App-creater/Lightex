"use client";

import { Lock } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CountUp, EmptyState, Skeleton } from "@/components/ui/feedback";
import { toast } from "@/components/ui/toast";
import { useProjects } from "@/features/workspace/queries";
import { isApiError } from "@/lib/api/errors";
import type { Project, Workspace } from "@/lib/api/types";
import { useIsMobile, usePrefersReducedMotion } from "@/lib/hooks/use-media-query";
import { can, useCan, useCurrentProject, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { BurndownCard, CycleTimeCard, ThroughputCard, VelocityCard } from "./charts";
import { ExportMenu, ProjectSelect, RangeSelect } from "./controls";
import {
  buildReportCsv,
  csvFileName,
  headerCaption,
  isoDay,
  parseRange,
  rangeSearch,
  shortDate,
  type RangeState,
} from "./lib";
import { ProgressCard } from "./progress-card";
import { useReportQueries, type ReportQueries } from "./queries";

/* Reports (board 17): KPI tiles + five charts for one project and a date range. */

export function ReportsScreen() {
  const project = useCurrentProject();
  const ws = useCurrentWorkspace();
  const allowed = useCan("report.view");
  if (!project || !ws) return null;
  if (!allowed) return <NoAccess ws={ws} project={project} />;
  return <ReportsBody ws={ws} project={project} />;
}

function NoAccess({ ws, project }: { ws: Workspace; project: Project }) {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <EmptyState
        align="center"
        icon={<Lock size={18} strokeWidth={1.5} aria-hidden />}
        title="You don’t have access to reports"
        body={`Your role in ${project.name} doesn’t include viewing reports. Ask a project admin if you need them.`}
        actions={
          <Button asChild variant="secondary">
            <Link href={routes.project(ws.slug, project.key)}>Back to project overview</Link>
          </Button>
        }
      />
    </div>
  );
}

const Page = ({ children }: { children: ReactNode }) => (
  <div className="@container min-w-0 flex-1">
    <div className="mx-auto flex max-w-[1240px] flex-col gap-4 px-7 pb-10 pt-[22px] @max-[760px]:gap-3.5 @max-[760px]:px-4 @max-[760px]:pb-8 @max-[760px]:pt-3">
      {children}
    </div>
  </div>
);

function ReportsBody({ ws, project }: { ws: Workspace; project: Project }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const today = isoDay(new Date());
  const spKey = sp.toString();
  const range = useMemo(() => parseRange(new URLSearchParams(spKey), today), [spKey, today]);
  const rangeKey = `${range.range}|${range.from ?? ""}|${range.to ?? ""}`;

  const reduce = usePrefersReducedMotion();
  const mobile = useIsMobile();
  const projectsQ = useProjects(ws.slug);
  const projects = useMemo(
    () => (projectsQ.data ?? []).filter((p) => p.status === "active" && can("report.view", p.my_permissions)),
    [projectsQ.data],
  );
  const q = useReportQueries(project.id, range);

  const setRange = (r: RangeState) => router.replace(`${pathname}${rangeSearch(r)}`, { scroll: false });
  const switchProject = (key: string) => {
    if (key !== project.key) router.push(`${routes.project(ws.slug, key, "reports")}${rangeSearch(range)}`);
  };

  /* ── export ── */
  const [busy, setBusy] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const exportCsv = () => {
    setBusy("Preparing CSV…");
    timer.current = setTimeout(() => {
      try {
        const csv = buildReportCsv({
          project: { key: project.key, name: project.name },
          range,
          generated: today,
          kpis: q.kpis.data,
          burndown: q.burndown.data ? { sprintName: q.burndown.data.sprint?.name, points: q.burndown.data.points } : null,
          velocity: q.velocity.data && !q.velocity.data.insufficient ? q.velocity.data.points : null,
          cycle: q.cycle.data && !q.cycle.data.insufficient ? q.cycle.data : null,
          throughput: q.throughput.data && !q.throughput.data.insufficient ? q.throughput.data.points : null,
          progress: q.progress.data,
        });
        const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = csvFileName(project.key, range, today);
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast.success("CSV downloaded");
      } catch {
        toast.error("Couldn’t prepare the CSV");
      } finally {
        setBusy(null);
      }
    }, 700);
  };

  const kpis = q.kpis.data;
  const header = (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="m-0 text-[22px] font-semibold leading-[30px] tracking-[-0.02em]">Reports</h1>
        <p className="m-0 font-mono text-[12px] leading-4 text-fg-3">
          {kpis ? headerCaption(kpis.sprint, range) : <Skeleton className="mt-1 h-2.5 w-52" />}
        </p>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2 @max-[760px]:ml-0 @max-[760px]:w-full">
        <ProjectSelect projects={projects.length ? projects : [project]} current={project} onChange={switchProject} />
        <RangeSelect key={rangeKey} value={range} today={today} onChange={setRange} />
        <ExportMenu onCsv={exportCsv} busy={busy} />
      </div>
    </header>
  );

  if (q.kpis.isPending) {
    return (
      <Page>
        {header}
        <LoadingState />
      </Page>
    );
  }
  if (q.kpis.isError) {
    return (
      <Page>
        {header}
        <ReportsError error={q.kpis.error} q={q} />
      </Page>
    );
  }

  const k = kpis!;
  const completedSprints = k.completedSprints;
  return (
    <Page>
      {header}
      <div className="grid grid-cols-4 gap-3 @max-[760px]:grid-cols-2 @max-[760px]:gap-2.5">
        <Kpi
          label="Completed this sprint"
          value={<CountUp value={k.completedThisSprint} />}
          meta={`of ${k.plannedThisSprint} planned`}
        />
        <Kpi
          label="Avg cycle time"
          value={<CountUp value={k.avgCycleTimeDays} decimals={1} />}
          unit="d"
          meta={`p85 ${k.p85CycleTimeDays.toFixed(1)}d`}
        />
        <Kpi
          label="Overdue"
          alert={k.overdueCount > 0}
          value={<CountUp value={k.overdueCount} />}
          meta={k.oldestOverdueKey && k.overdueCount > 0 ? `oldest ${k.oldestOverdueKey}` : "none"}
        />
        <Kpi
          label="Scope change"
          value={
            <>
              {k.scopeChangePts > 0 ? "+" : k.scopeChangePts < 0 ? "−" : ""}
              <CountUp value={Math.abs(k.scopeChangePts)} />
            </>
          }
          unit="pts"
          meta={k.sprint ? `since ${shortDate(k.sprint.startDate)}` : "no active sprint"}
        />
      </div>
      <div className="grid grid-cols-3 items-start gap-4 @max-[1000px]:grid-cols-2 @max-[760px]:grid-cols-1">
        <BurndownCard key={`b${rangeKey}`} q={q.burndown} sprintNumber={k.sprint?.number} reduce={reduce} mobile={mobile} />
        <VelocityCard key={`v${rangeKey}`} q={q.velocity} reduce={reduce} mobile={mobile} />
        <CycleTimeCard key={`c${rangeKey}`} q={q.cycle} completedSprints={completedSprints} reduce={reduce} mobile={mobile} />
        <ThroughputCard key={`t${rangeKey}`} q={q.throughput} completedSprints={completedSprints} reduce={reduce} mobile={mobile} />
        <ProgressCard
          key={`p${rangeKey}`}
          q={q.progress}
          reduce={reduce}
          mobile={mobile}
          goalsHref={routes.project(ws.slug, project.key, "objectives")}
        />
      </div>
    </Page>
  );
}

function Kpi({
  label,
  value,
  unit,
  meta,
  alert,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  meta: string;
  alert?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface px-4 py-3.5 @max-[760px]:px-3.5 @max-[760px]:py-3">
      <span className="flex items-center gap-1.5 text-[12px] leading-4 text-fg-2">
        {label}
        {alert && (
          <span
            role="img"
            aria-label="Needs attention"
            className="inline-flex size-3.5 flex-none items-center justify-center rounded-full bg-danger text-[9px] font-bold leading-none text-bg"
          >
            !
          </span>
        )}
      </span>
      <span className="whitespace-nowrap text-[28px] font-semibold leading-9 tracking-[-0.02em] @max-[760px]:text-[24px] @max-[760px]:leading-[30px]">
        {value}
        {unit && <small className="ml-[3px] text-[15px] font-medium tracking-normal text-fg-2">{unit}</small>}
      </span>
      <span className="truncate font-mono text-[12px] leading-4 text-fg-3">{meta}</span>
    </div>
  );
}

function LoadingState() {
  const card = (title: number, sub: number | null, span2 = false) => (
    <div
      className={
        "flex flex-col gap-2.5 rounded-lg border border-line bg-surface px-[18px] py-3.5 @max-[760px]:px-3.5 @max-[760px]:py-3" +
        (span2 ? " col-span-2 @max-[760px]:col-span-1" : "")
      }
    >
      <Skeleton className="h-3.5 rounded-md" style={{ width: title }} />
      {sub && <Skeleton className="h-2.5 rounded-md" style={{ width: sub }} />}
      <Skeleton className="h-[200px] w-full rounded-md" />
    </div>
  );
  return (
    <div role="status" aria-busy="true" aria-label="Loading reports" className="flex flex-col gap-4 @max-[760px]:gap-3.5">
      <div className="grid grid-cols-4 gap-3 @max-[760px]:grid-cols-2 @max-[760px]:gap-2.5">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[86px] rounded-lg" />
        ))}
      </div>
      <div className="grid grid-cols-3 items-start gap-4 @max-[1000px]:grid-cols-2 @max-[760px]:grid-cols-1">
        {card(120, 180, true)}
        {card(90, 150)}
        {card(100, null)}
        {card(90, null)}
        {card(140, null)}
      </div>
    </div>
  );
}

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M13 8a5 5 0 11-1.5-3.5M13 2.5v3h-3" />
  </svg>
);

function ReportsError({ error, q }: { error: unknown; q: ReportQueries }) {
  const status = isApiError(error) ? error.status : null;
  const ref = isApiError(error) ? error.ref : null;
  const retrying = q.kpis.isFetching;
  const retry = () => {
    void q.kpis.refetch();
    for (const x of [q.burndown, q.velocity, q.cycle, q.throughput, q.progress]) if (x.isError) void x.refetch();
  };
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-8 @max-[760px]:p-5">
      <span
        aria-hidden
        className="inline-flex size-3.5 items-center justify-center rounded-full bg-danger text-[9px] font-bold leading-none text-bg"
      >
        !
      </span>
      <span className="text-[15px] font-semibold">Couldn’t load reports</span>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" loading={retrying} onClick={retry}>
          {!retrying && <RefreshIcon />}
          Retry
        </Button>
        {(status || ref) && (
          <span className="font-mono text-[12px] leading-4 text-fg-3">
            {[status, ref ? `ref ${ref}` : null].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>
    </div>
  );
}
