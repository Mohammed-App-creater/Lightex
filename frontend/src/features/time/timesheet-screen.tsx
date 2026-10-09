"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarClock, ChevronDown, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Avatar, ProjectBadge } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useProjects } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Timesheet, TimesheetCell } from "@/lib/api/types";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { replaceUrl } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { todayISO } from "@/lib/utils/dates";
import { formatHours } from "./duration";
import { DOW, LEGEND, canExport, cellText, csvName, dayLabel, heat, heatBg, shiftWeek, timesheetCsv, weekLabel, weekStart } from "./timesheet-lib";

const GRID = "grid grid-cols-[minmax(150px,1.6fr)_repeat(7,minmax(54px,1fr))_minmax(64px,1fr)] min-w-[640px]";

/**
 * Timesheet (board 39): week × person heat grid for the workspace or one project, with a hover /
 * focus breakdown and a client-built CSV export (report.view). Week and project live in the URL.
 */
export function TimesheetScreen() {
  return (
    <Suspense fallback={null}>
      <TimesheetInner />
    </Suspense>
  );
}

function TimesheetInner() {
  const ws = useCurrentWorkspace()!;
  const pathname = usePathname();
  const params = useSearchParams();
  const today = todayISO();
  const thisWeek = weekStart(today);
  const rawWeek = params.get("week");
  const week = rawWeek && /^\d{4}-\d{2}-\d{2}$/.test(rawWeek) ? weekStart(rawWeek) : thisWeek;
  const projectId = params.get("project");
  const { data: wsProjects = [] } = useProjects(ws.slug);

  const q = useQuery({
    queryKey: qk.timesheet(ws.slug, week, projectId ?? undefined),
    queryFn: () => api.time.timesheet(ws.slug, week, projectId ?? undefined),
    placeholderData: (prev) => prev,
  });
  const data = q.isPlaceholderData ? undefined : q.data;
  const projects = q.data?.projects ?? wsProjects.map((p) => ({ id: p.id, key: p.key, name: p.name, hue: p.hue, my_permissions: p.my_permissions }));
  const selected = projects.find((p) => p.id === projectId) ?? null;

  const go = (next: { week?: string; project?: string | null }) => {
    const sp = new URLSearchParams(params.toString());
    const w = next.week ?? week;
    if (w === thisWeek) sp.delete("week");
    else sp.set("week", w);
    const p = next.project === undefined ? projectId : next.project;
    if (p) sp.set("project", p);
    else sp.delete("project");
    const qs = sp.toString();
    replaceUrl(qs ? `${pathname}?${qs}` : pathname);
  };

  const exportCsv = () => {
    if (!data) return;
    const blob = new Blob([timesheetCsv(data, today)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvName(selected?.key ?? null, data.weekStart);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const onThisWeek = week === thisWeek;
  const label = weekLabel(week);

  return (
    <div className="flex min-h-full flex-col gap-3.5 px-6 pb-7 pt-[22px] max-[760px]:px-4 max-[760px]:pt-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="m-0 mr-auto text-[20px] font-semibold leading-7 tracking-[-0.015em] max-[760px]:w-full max-[760px]:text-[17px]">Timesheet</h1>
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label={`Project: ${selected?.name ?? "All projects"}`}
              className="inline-flex h-8 max-w-[240px] items-center gap-2 whitespace-nowrap rounded-[7px] border border-line-2 bg-raised px-2.5 text-[13px] font-medium text-fg hover:border-control hover:bg-hover data-[state=open]:border-control data-[state=open]:bg-hover max-[760px]:h-10"
            >
              {selected && <ProjectBadge code={selected.key.slice(0, 2)} hue={selected.hue} size={18} />}
              <span className="truncate">{selected?.name ?? "All projects"}</span>
              <ChevronDown size={12} aria-hidden className="text-fg-3" />
            </button>
          </MenuTrigger>
          <MenuContent align="start" width={240} aria-label="Project">
            <MenuRadioGroup value={projectId ?? ""} onValueChange={(v) => go({ project: v || null })}>
              <MenuRadioItem value="">All projects</MenuRadioItem>
              {projects.length > 0 && <MenuSeparator />}
              {projects.map((p) => (
                <MenuRadioItem key={p.id} value={p.id} icon={<ProjectBadge code={p.key.slice(0, 2)} hue={p.hue} size={18} />}>
                  {p.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
        <div className="inline-flex h-8 items-center gap-0.5 rounded-[7px] border border-line-2 bg-raised px-0.5 max-[760px]:h-10" role="group" aria-label="Week">
          <button type="button" aria-label="Previous week" onClick={() => go({ week: shiftWeek(week, -1) })} className="flex size-[26px] items-center justify-center rounded-[5px] text-fg-2 hover:bg-hover hover:text-fg max-[760px]:size-9">
            <ChevronLeft size={14} aria-hidden />
          </button>
          <span className="whitespace-nowrap px-1.5 font-mono text-[12px] font-medium" aria-live="polite">
            {label}
          </span>
          {!onThisWeek && (
            <button type="button" aria-label="Next week" onClick={() => go({ week: shiftWeek(week, 1) })} className="flex size-[26px] items-center justify-center rounded-[5px] text-fg-2 hover:bg-hover hover:text-fg max-[760px]:size-9">
              <ChevronRight size={14} aria-hidden />
            </button>
          )}
        </div>
        {!onThisWeek && (
          <Button size="sm" variant="ghost" onClick={() => go({ week: thisWeek })} className="max-[760px]:h-10">
            This week
          </Button>
        )}
        {canExport(data, projectId) && (
          <Button size="sm" variant="secondary" onClick={exportCsv} className="max-[760px]:h-10">
            <Download size={13} aria-hidden /> Export
          </Button>
        )}
      </div>

      {q.isError && !q.isPlaceholderData ? (
        <ErrorState
          title="Couldn’t load timesheet"
          body={errorMessage(q.error)}
          refId={isApiError(q.error) ? q.error.ref : undefined}
          onRetry={() => void q.refetch()}
          retrying={q.isRefetching}
        />
      ) : !data ? (
        <TimesheetSkeleton />
      ) : data.rows.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface">
          <EmptyState
            align="center"
            className="min-h-[220px] justify-center p-6"
            icon={<CalendarClock size={20} aria-hidden />}
            title="No time logged"
            body={<span className="font-mono text-[12px]">{label}</span>}
            actions={
              !onThisWeek ? (
                <Button variant="secondary" onClick={() => go({ week: thisWeek })}>
                  Go to this week
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <Grid ts={data} today={today} perTask={Boolean(projectId)} />
      )}

      {data && data.rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex items-center gap-1.5 font-mono text-[11px] font-medium text-fg-3" aria-label="Heat scale, hours per day">
            <span>0h</span>
            {LEGEND.map((p) => (
              <i key={p} aria-hidden className="block h-2.5 w-[18px] rounded-[3px]" style={{ background: heatBg(p) }} />
            ))}
            <span>8h+</span>
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[11px] font-medium text-fg-3">
            <i aria-hidden className="block h-2.5 w-[18px] rounded-[3px] border border-line bg-[repeating-linear-gradient(135deg,transparent_0_3px,var(--line-2)_3px_4px)]" />
            upcoming
          </span>
        </div>
      )}
    </div>
  );
}

function Grid({ ts, today, perTask }: { ts: Timesheet; today: string; perTask: boolean }) {
  const [hover, setHover] = useState<string | null>(null);
  const fut = (i: number) => ts.days[i]! > today;
  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="overflow-x-auto rounded-xl" onMouseLeave={() => setHover(null)}>
        <div role="table" aria-label={`Timesheet, ${weekLabel(ts.weekStart)}`} className={GRID}>
          <div role="row" className="contents">
            <span role="columnheader" className="flex h-10 items-center border-b border-line pl-3.5 font-mono text-[11px] font-medium text-fg-3">
              Person
            </span>
            {ts.days.map((d, i) => {
              const isToday = d === today;
              return (
                <span key={d} role="columnheader" className={cn("flex h-10 flex-col items-center justify-center gap-[3px] border-b border-line font-mono text-[11px] font-medium text-fg-3", isToday && "shadow-[inset_0_-2px_0_var(--accent)]")}>
                  <b className={cn("font-medium text-fg-2", isToday && "text-accent-t")}>{DOW[i]}</b>
                  {dayLabel(d, i).split(" ").slice(1).join(" ")}
                </span>
              );
            })}
            <span role="columnheader" className="flex h-10 items-center justify-end border-b border-l border-line pr-3.5 font-mono text-[11px] font-medium text-fg-3">
              Total
            </span>
          </div>
          {ts.rows.map((r, ri) => (
            <div role="row" key={r.user.id} className="contents">
              <span role="rowheader" className="flex h-11 min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap border-b border-line px-3.5 font-medium">
                <Avatar name={r.user.name} hue={r.user.hue} size={20} decorative />
                <span className="truncate">{r.user.name}</span>
              </span>
              {r.cells.map((c, d) => (
                <Cell key={c.date} cell={c} name={r.user.name} index={d} future={fut(d)} perTask={perTask} open={hover === `${ri}-${d}`} up={ri >= 2} right={d >= 5} onShow={() => setHover(`${ri}-${d}`)} onHide={() => setHover(null)} />
              ))}
              <span role="cell" className="flex h-11 items-center justify-end border-b border-l border-line pr-3.5 font-mono text-[12px] font-semibold tabular-nums">
                {formatHours(r.totalMinutes)}h
              </span>
            </div>
          ))}
          <div role="row" className="contents">
            <span role="rowheader" className="flex h-10 items-center rounded-bl-xl bg-raised pl-3.5 font-semibold">
              Total
            </span>
            {ts.dayTotals.map((m, i) => (
              <span key={i} role="cell" className="flex h-10 items-center justify-center bg-raised font-mono text-[12px] font-medium tabular-nums text-fg-2">
                {fut(i) ? "" : formatHours(m)}
              </span>
            ))}
            <span role="cell" className="flex h-10 items-center justify-end rounded-br-xl border-l border-line bg-raised pr-3.5 font-mono text-[12px] font-semibold tabular-nums">
              {formatHours(ts.totalMinutes)}h
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Cell({
  cell,
  name,
  index,
  future,
  perTask,
  open,
  up,
  right,
  onShow,
  onHide,
}: {
  cell: TimesheetCell;
  name: string;
  index: number;
  future: boolean;
  perTask: boolean;
  open: boolean;
  up: boolean;
  right: boolean;
  onShow: () => void;
  onHide: () => void;
}) {
  const h = heat(future ? 0 : cell.minutes);
  const day = dayLabel(cell.date, index);
  const tipId = `ts-tip-${name.replace(/\W+/g, "")}-${cell.date}`;
  const showTip = open && !future && cell.minutes > 0;
  return (
    <span role="cell" className="relative h-11 border-b border-line p-[3px]">
      <button
        type="button"
        aria-label={`${name}, ${day}: ${future ? "upcoming" : `${formatHours(cell.minutes)} hours`}`}
        aria-describedby={showTip ? tipId : undefined}
        onMouseEnter={onShow}
        onFocus={onShow}
        onBlur={onHide}
        className={cn(
          "flex size-full cursor-default items-center justify-center rounded-md font-mono text-[12px] font-medium tabular-nums text-fg transition-shadow duration-[var(--dur-fast)] hover:shadow-[0_0_0_1.5px_var(--text-2)]",
          !future && !cell.minutes && "text-fg-3",
          h.hi && "font-semibold",
          future && "bg-[repeating-linear-gradient(135deg,transparent_0_5px,var(--raised)_5px_6px)]",
          open && "shadow-[0_0_0_1.5px_var(--text-2)]",
        )}
        style={future ? undefined : { background: heatBg(h.percent) }}
      >
        {cellText(cell.minutes, future)}
      </button>
      {showTip && (
        <span
          id={tipId}
          role="tooltip"
          className={cn(
            "pointer-events-none absolute z-[8] flex min-w-[170px] animate-[fade-in_120ms_var(--ease)] flex-col gap-[5px] whitespace-nowrap rounded-lg border border-line-2 bg-raised px-2.5 py-2 text-left shadow-pop",
            up ? "bottom-[calc(100%+2px)]" : "top-[calc(100%+2px)]",
            right ? "right-0" : "left-1/2 -translate-x-1/2",
          )}
        >
          <span className="font-mono text-[11px] font-medium text-fg-3">
            {name.split(" ")[0]} · {day} · {formatHours(cell.minutes)}h
          </span>
          {cell.breakdown.map((s) => (
            <span key={`${s.projectId}-${s.taskId ?? "p"}`} className="flex items-center gap-2 text-[12px] text-fg-2">
              {perTask ? <span className="font-mono text-[11px] text-fg-3">{s.key}</span> : <ProjectBadge code={s.key.slice(0, 2)} hue={s.hue} size={18} />}
              <span className="max-w-[180px] truncate">{s.name}</span>
              <b className="ml-auto font-mono text-[12px] font-semibold text-fg">{formatHours(s.minutes)}h</b>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

function TimesheetSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading timesheet" className="rounded-xl border border-line bg-surface py-2">
      {[70, 55, 80, 60, 75, 50].map((w) => (
        <div key={w} className="grid grid-cols-[1.6fr_repeat(8,minmax(0,1fr))] items-center gap-1.5 px-3 py-2">
          <span className="flex items-center gap-2">
            <Skeleton className="size-5 rounded-full" />
            <Skeleton className="h-2.5" style={{ width: `${w}%` }} />
          </span>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-7 rounded-md" />
          ))}
        </div>
      ))}
    </div>
  );
}
