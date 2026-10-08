"use client";

import { useQuery } from "@tanstack/react-query";
import { Target, UserPlus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";
import { Avatar, AvatarStack } from "@/components/ui/avatar";
import { CopyKey } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/card";
import { CountUp, ErrorState, ProgressBar, ProgressRing, Skeleton } from "@/components/ui/feedback";
import { StatusGlyph } from "@/components/ui/glyphs";
import { shell } from "@/components/shell/shell-state";
import { activityText } from "@/features/tasks/activity-text";
import { useEpics, useMilestones, useObjectives, useProjectMembers, useSprints, useStatuses } from "./queries";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { BurndownPoint, Milestone, Project, Status, Task } from "@/lib/api/types";
import { daysUntil, isDoneStatus } from "@/lib/domain/progress";
import { useIsTouch } from "@/lib/hooks/use-media-query";
import { can, useCurrentProject, useCurrentWorkspace } from "@/lib/permissions/can";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { addDaysISO, agoOrDate, shortDate, todayISO } from "@/lib/utils/dates";

/* Project overview (board 11), with the new-project setup checklist (board 12). */

export function ProjectOverview() {
  const project = useCurrentProject()!;
  const tasks = useQuery({
    queryKey: [...qk.taskList(project.id), "overview"],
    queryFn: () => api.tasks.list(project.id, { limit: 500 }),
    select: (r) => r.data,
  });
  const { data: statuses = [] } = useStatuses(project.id);
  if (tasks.isPending) return <OverviewSkeleton />;
  if (tasks.isError) {
    return (
      <Wrap>
        <Header project={project} />
        <ErrorState
          title="Couldn’t load the overview"
          body="The board and tasks still work; only these summaries failed."
          refId={(tasks.error as { ref?: string }).ref}
          onRetry={() => void tasks.refetch()}
        />
      </Wrap>
    );
  }
  return <Ready project={project} tasks={tasks.data} statuses={statuses} />;
}

function Wrap({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-8 pb-16 pt-7 max-[760px]:px-4 max-[760px]:pt-4">{children}</div>;
}

function Header({ project }: { project: Project }) {
  const ws = useCurrentWorkspace()!;
  const { data: members = [] } = useProjectMembers(project.id);
  return (
    <header className="flex flex-wrap items-start gap-4">
      <span aria-hidden className="flex size-11 flex-none items-center justify-center rounded-[10px] border border-line-2 bg-raised font-mono text-[13px] font-semibold">
        {project.key.slice(0, 2)}
      </span>
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="m-0 text-h2">{project.name}</h1>
          <CopyKey value={project.key} className="h-[22px] border-line-2" />
        </div>
        <p className="m-0 text-[13px] leading-5 text-fg-2">{project.description || <span className="text-fg-3">No description yet.</span>}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <AvatarStack people={members.map((m) => ({ id: m.userId, name: m.user.name, hue: m.user.hue }))} max={4} size={28} />
        {can("project.manage_members", project.my_permissions) && (
          <Button size="sm" asChild>
            <Link href={`${routes.project(ws.slug, project.key, "settings")}#members`}>
              <UserPlus size={13} aria-hidden /> Invite
            </Link>
          </Button>
        )}
        {can("task.create", project.my_permissions) && (
          <Button size="sm" variant="primary" kbd="C" onClick={() => shell.openCreateTask({ projectId: project.id })}>
            New task
          </Button>
        )}
      </div>
    </header>
  );
}

function Ready({ project, tasks, statuses }: { project: Project; tasks: Task[]; statuses: Status[] }) {
  const { data: objectives = [] } = useObjectives(project.id);
  const { data: milestones = [] } = useMilestones(project.id);
  const epics = (useEpics(project.id).data ?? []).filter((e) => !e.archivedAt);
  const { data: sprints = [] } = useSprints(project.id);
  const { data: members = [] } = useProjectMembers(project.id);
  const touch = useIsTouch();
  const today = todayISO();
  const open = tasks.filter((t) => !isDoneStatus(t.statusId, statuses) && statuses.find((s) => s.id === t.statusId)?.glyph !== "canceled");
  const overdue = open.filter((t) => t.dueDate && t.dueDate < today).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const weekAgo = addDaysISO(today, -7);
  const twoWeeks = addDaysISO(today, -14);
  const doneWeek = tasks.filter((t) => t.completedAt && t.completedAt.slice(0, 10) > weekAgo).length;
  const doneLastWeek = tasks.filter((t) => t.completedAt && t.completedAt.slice(0, 10) > twoWeeks && t.completedAt.slice(0, 10) <= weekAgo).length;
  const activeSprint = sprints.find((s) => s.state === "active");

  return (
    <Wrap>
      <Header project={project} />
      <SetupChecklist project={project} tasks={tasks.length} objectives={objectives.length} milestones={milestones.length} members={members.length} sprintStarted={sprints.some((s) => s.state !== "planned")} />
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr))]">
        <Stat label="Open tasks" value={open.length} foot={epics.length ? `across ${epics.length} epic${epics.length === 1 ? "" : "s"}` : touch ? "No epics yet" : "Create one with C"} />
        <Stat
          label="Overdue"
          value={overdue.length}
          pill={overdue.length > 0 ? "Needs attention" : undefined}
          foot={overdue[0] ? `oldest: ${overdue[0].key}, ${-daysUntil(overdue[0].dueDate!)} days late` : "Nothing late"}
        />
        <Stat label="Completed this week" value={doneWeek} foot={`${doneLastWeek} last week`} />
      </div>
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          <ObjectivesPanel project={project} />
          <MilestonesPanel project={project} milestones={milestones} />
          <EpicsPanel project={project} tasks={tasks} />
        </div>
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-6">
          <SprintPanel project={project} sprintId={activeSprint?.id} />
          <ActivityPanel project={project} />
        </div>
      </div>
    </Wrap>
  );
}

function Stat({ label, value, foot, pill }: { label: string; value: number; foot: string; pill?: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface px-[18px] py-4">
      <span className="text-meta text-fg-3">{label}</span>
      <span className="flex items-center gap-2.5 text-[32px] font-semibold leading-10 tracking-[-0.02em]">
        <CountUp value={value} />
        {pill && (
          <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-danger px-2 text-[11px] font-medium tracking-normal text-fg">
            {pill}
          </span>
        )}
      </span>
      <span className="text-meta text-fg-3">{foot}</span>
    </div>
  );
}

function ViewAll({ href }: { href: string }) {
  return (
    <Button size="sm" variant="ghost" asChild>
      <Link href={href}>View all</Link>
    </Button>
  );
}

function ObjectivesPanel({ project }: { project: Project }) {
  const ws = useCurrentWorkspace()!;
  const { data: objectives = [], isPending } = useObjectives(project.id);
  const { data: members = [] } = useProjectMembers(project.id);
  const canManage = can("objective.manage", project.my_permissions);
  return (
    <Panel
      title={
        <span className="flex items-center gap-2.5">
          Objectives <span className="font-mono text-meta font-normal text-fg-3">{objectives.length}</span>
        </span>
      }
      actions={objectives.length > 0 && <ViewAll href={routes.project(ws.slug, project.key, "objectives")} />}
    >
      {isPending ? (
        <Skeleton className="h-28 w-full" />
      ) : objectives.length === 0 ? (
        <SmallEmpty icon={<Target size={18} aria-hidden />} title="No objectives yet" body="Define what success looks like.">
          {canManage && (
            <Button size="sm" kbd="O" asChild>
              <Link href={`${routes.project(ws.slug, project.key, "objectives")}?new=1`}>Add objective</Link>
            </Button>
          )}
        </SmallEmpty>
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))]">
          {objectives.slice(0, 3).map((o) => {
            const owner = members.find((m) => m.userId === o.ownerId)?.user;
            const pct = o.progress.percent;
            const color = pct >= 100 ? "var(--ok)" : pct >= 60 ? "var(--accent-t)" : "var(--warn)";
            return (
              <Link
                key={o.id}
                href={routes.project(ws.slug, project.key, "objectives")}
                className="flex flex-col gap-3 rounded-[10px] border border-line bg-bg p-4 transition-[border-color,transform,box-shadow] duration-150 [transition-timing-function:var(--spring)] hover:-translate-y-0.5 hover:border-line-2 hover:shadow-pop motion-reduce:hover:translate-y-0"
              >
                <div className="flex items-center gap-3.5">
                  <ProgressRing value={pct} size={56} stroke={5} color={color} label={o.title} showValue />
                  <span className="text-[14px] font-semibold leading-5">{o.title}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-meta text-fg-3">
                    {o.progress.total} tasks · {o.progress.done} done
                  </span>
                  {owner && <Avatar name={owner.name} hue={owner.hue} size={20} className="ml-auto" />}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function MilestonesPanel({ project, milestones }: { project: Project; milestones: Milestone[] }) {
  const ws = useCurrentWorkspace()!;
  const canManage = can("milestone.manage", project.my_permissions);
  const scale = useMemo(() => {
    if (!milestones.length) return null;
    const starts = milestones.map((m) => m.startDate).sort();
    const ends = milestones.map((m) => m.dueDate).sort();
    const s = new Date(`${starts[0]}T00:00:00`);
    s.setDate(1);
    const e = new Date(`${ends[ends.length - 1]}T00:00:00`);
    e.setMonth(e.getMonth() + 1, 1);
    const span = e.getTime() - s.getTime();
    const x = (iso: string) => Math.max(0, Math.min(100, ((new Date(`${iso}T00:00:00`).getTime() - s.getTime()) / span) * 100));
    return { x, label: `${shortDate(starts[0]!)} – ${shortDate(ends[ends.length - 1]!)}` };
  }, [milestones]);
  return (
    <Panel
      title={
        <span className="flex items-center gap-2.5">
          Milestones {scale && <span className="font-mono text-meta font-normal text-fg-3">{scale.label}</span>}
        </span>
      }
      actions={milestones.length > 0 && <ViewAll href={routes.project(ws.slug, project.key, "milestones")} />}
    >
      {!scale ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[13px] text-fg-2">No milestones yet.</span>
          {canManage && (
            <Button size="sm" kbd="M" asChild>
              <Link href={`${routes.project(ws.slug, project.key, "milestones")}?new=1`}>Add milestone</Link>
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto py-1">
          <div role="list" className="relative h-[150px] min-w-[620px]">
            <div className="absolute inset-x-0 top-[74px] h-0.5 rounded-full bg-line-2">
              <span className="block h-full origin-left rounded-full bg-fg-2 transition-transform duration-700 ease-out" style={{ transform: `scaleX(${scale.x(todayISO()) / 100})` }} />
            </div>
            <div className="absolute top-10 h-[70px] border-l border-dashed border-accent-t" style={{ left: `${scale.x(todayISO())}%` }}>
              <span className="absolute -left-5 -top-[18px] font-mono text-[11px] font-medium text-accent-t">Today</span>
            </div>
            {milestones.map((m, i) => {
              const done = Boolean(m.completedAt);
              const cur = !done && milestones.findIndex((x) => !x.completedAt) === i;
              const up = i % 2 === 1;
              const color = done ? "var(--ok)" : cur ? "var(--accent-t)" : "var(--text-2)";
              return (
                <div role="listitem" key={m.id} className="absolute inset-y-0 -ml-2 w-[150px]" style={{ left: `${scale.x(m.dueDate)}%` }}>
                  <span
                    aria-hidden
                    className={cn("absolute top-[67px] size-4 rounded-full border-2 border-control bg-surface", done && "border-ok bg-ok", cur && "border-accent shadow-[0_0_0_4px_var(--accent-s)]")}
                  />
                  <div className={cn("absolute left-0 flex w-[150px] flex-col gap-1", up ? "top-0" : "top-24")}>
                    <span className="truncate font-semibold">{m.name}</span>
                    <span className="font-mono text-meta text-fg-3">
                      {shortDate(m.dueDate)} · {m.progress.percent}%
                    </span>
                    <ProgressBar value={m.progress.percent} label={m.name} color={color} className="w-24" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}

function EpicsPanel({ project, tasks }: { project: Project; tasks: Task[] }) {
  const ws = useCurrentWorkspace()!;
  const { data: allEpics = [] } = useEpics(project.id);
  const epics = allEpics.filter((e) => !e.archivedAt);
  const { data: milestones = [] } = useMilestones(project.id);
  return (
    <Panel
      title={
        <span className="flex items-center gap-2.5">
          Epics <span className="font-mono text-meta font-normal text-fg-3">{epics.length}</span>
        </span>
      }
    >
      {epics.length === 0 ? (
        <span className="text-[13px] text-fg-2">No epics yet.</span>
      ) : (
        <ul role="list" className="m-0 flex list-none flex-col p-0">
          {epics.map((e) => {
            const et = tasks.filter((t) => t.epicId === e.id);
            const ms = milestones.find((m) => et.some((t) => t.milestoneId === m.id));
            const pct = e.progress.percent;
            return (
              <li key={e.id}>
                <Link
                  href={`${routes.project(ws.slug, project.key, "list")}?epic=${e.id}`}
                  className="-mx-2.5 grid min-h-11 grid-cols-[minmax(0,1.4fr)_minmax(120px,1fr)_64px_110px] items-center gap-4 rounded-md px-2.5 hover:bg-hover max-[760px]:grid-cols-[minmax(0,1fr)_64px]"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <StatusGlyph kind={pct >= 100 ? "done" : pct > 0 ? "progress" : "todo"} />
                    <span className="truncate font-medium">{e.name}</span>
                  </span>
                  <span className="flex items-center gap-2 max-[760px]:hidden">
                    <ProgressBar value={pct} label={e.name} className="flex-1" />
                    <span className="w-[34px] text-right font-mono text-meta text-fg-3">{pct}%</span>
                  </span>
                  <span className="font-mono text-meta text-fg-3">
                    {e.progress.done}/{e.progress.total}
                  </span>
                  <span className="max-[760px]:hidden">
                    {ms && <span className="inline-flex h-[22px] max-w-full items-center truncate rounded-sm border border-line-2 px-2 text-[12px] font-medium text-fg-2">{ms.name}</span>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function SprintPanel({ project, sprintId }: { project: Project; sprintId: string | undefined }) {
  const ws = useCurrentWorkspace()!;
  const { data: sprints = [] } = useSprints(project.id);
  const sprint = sprints.find((s) => s.id === sprintId);
  const canReport = can("report.view", project.my_permissions);
  const burndown = useQuery({
    queryKey: qk.reports(project.id, "burndown", sprintId),
    queryFn: () => api.reports.burndown(project.id, sprintId),
    enabled: Boolean(sprintId && canReport),
  });
  const planned = sprints.find((s) => s.state === "planned");
  if (!sprint) {
    return (
      <Panel title="Active sprint">
        <div className="flex flex-col gap-2">
          <b className="font-semibold">No active sprint</b>
          <span className="text-[13px] text-fg-2">{planned ? `${planned.name} is planned.` : "Add tasks first."}</span>
          {can("sprint.manage", project.my_permissions) && (
            <Button size="sm" className="w-fit" kbd="S" asChild>
              <Link href={routes.project(ws.slug, project.key, "sprints")}>Start sprint</Link>
            </Button>
          )}
        </div>
      </Panel>
    );
  }
  const left = Math.max(0, daysUntil(sprint.endDate));
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {sprint.name}
          <span className="inline-flex h-5 items-center gap-1.5 rounded-sm border border-line-2 px-2 text-[11px] font-medium text-fg-2">
            <StatusGlyph kind="progress" className="size-2.5" /> Active
          </span>
        </span>
      }
      actions={<span className="text-meta text-fg-3">{left} days left</span>}
      bodyClassName="gap-3"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[24px] font-semibold leading-[30px] tracking-[-0.02em]">
          <CountUp value={sprint.progress.donePoints} />
        </span>
        <span className="text-meta text-fg-3">of {sprint.progress.points} points done</span>
      </div>
      {canReport && burndown.data?.points.length ? (
        <MiniBurndown points={burndown.data.points} />
      ) : (
        <ProgressBar value={sprint.progress.percent} label={`${sprint.name} progress`} color="var(--accent-t)" />
      )}
      <div className="flex flex-wrap items-center gap-4">
        {canReport && (
          <>
            <span className="flex items-center gap-1.5 text-meta text-fg-3">
              <span aria-hidden className="h-0.5 w-4 bg-accent-t" /> Remaining
            </span>
            <span className="flex items-center gap-1.5 text-meta text-fg-3">
              <span aria-hidden className="w-4 border-t-[1.5px] border-dashed border-fg-3" /> Ideal
            </span>
          </>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" asChild>
          <Link href={routes.project(ws.slug, project.key, "board")}>Open sprint</Link>
        </Button>
      </div>
    </Panel>
  );
}

/** Board 11 sprint burndown: SVG with dashed ideal, remaining line, today marker and hover hits. */
function MiniBurndown({ points }: { points: BurndownPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 348;
  const H = 160;
  const left = 28;
  const top = 10;
  const base = 130;
  const max = Math.max(1, ...points.map((p) => Math.max(p.ideal, p.remaining ?? 0)));
  const x = (i: number) => left + (i / Math.max(1, points.length - 1)) * (W - left);
  const y = (v: number) => top + (1 - v / max) * (base - top);
  const reached = points.map((p, i) => ({ ...p, i })).filter((p) => p.remaining !== null);
  const lastIdx = reached.at(-1)?.i ?? 0;
  const line = reached.map((p) => `${x(p.i)},${y(p.remaining!)}`).join(" ");
  const last = reached.at(-1);
  return (
    <div className="relative h-[160px]">
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={last ? `Burndown: ${last.remaining} of ${max} points remaining on day ${lastIdx + 1}, ideal ${points[lastIdx]!.ideal}` : "Burndown"}
      >
        {[top, (top + base) / 2].map((gy) => (
          <line key={gy} x1={left} x2={W} y1={gy} y2={gy} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        <line x1={left} x2={W} y1={base} y2={base} stroke="var(--line-2)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <line x1={x(0)} y1={y(points[0]!.ideal)} x2={x(points.length - 1)} y2={base} stroke="var(--text-3)" strokeWidth="1.5" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <polyline points={line} fill="none" stroke="var(--accent-t)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" className="draw-line" pathLength={1} />
        <line x1={x(lastIdx)} x2={x(lastIdx)} y1={4} y2={base} stroke="var(--accent-t)" strokeWidth="1" strokeDasharray="2 3" opacity=".6" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="absolute left-0 top-0.5 font-mono text-[10px] text-fg-3">{max}</span>
      <span className="absolute left-0 top-[62px] font-mono text-[10px] text-fg-3">{Math.round(max / 2)}</span>
      <span className="absolute left-1 top-[122px] font-mono text-[10px] text-fg-3">0</span>
      <span className="absolute bottom-0 left-7 font-mono text-[10px] text-fg-3">{shortDate(points[0]!.date)}</span>
      <span className="absolute bottom-0 right-0 font-mono text-[10px] text-fg-3">{shortDate(points.at(-1)!.date)}</span>
      <div className="absolute bottom-[22px] left-7 right-0 top-0 flex">
        {points.map((p, i) => (
          <button
            key={p.date}
            type="button"
            aria-label={p.remaining === null ? `${shortDate(p.date)}: not started, ideal ${p.ideal}` : `${shortDate(p.date)}: ${p.remaining} pts left, ideal ${p.ideal}`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            className="flex-1 cursor-crosshair rounded-t-xs hover:bg-[rgba(128,128,150,.08)] focus-visible:bg-[rgba(128,128,150,.08)]"
          />
        ))}
      </div>
      {hover !== null && (
        <span
          className="pointer-events-none absolute top-1 z-[2] -translate-x-1/2 whitespace-nowrap rounded-sm border border-line-2 bg-raised px-2 py-1.5 text-[12px] shadow-pop"
          style={{ left: `${8 + (hover + 0.5) * (92 / points.length)}%` }}
        >
          {points[hover]!.remaining === null
            ? `${shortDate(points[hover]!.date)}: not started, ideal ${points[hover]!.ideal}`
            : `${shortDate(points[hover]!.date)}: ${points[hover]!.remaining} pts left, ideal ${points[hover]!.ideal}`}
        </span>
      )}
    </div>
  );
}

function ActivityPanel({ project }: { project: Project }) {
  const { data, isPending } = useQuery({ queryKey: qk.activity(project.id), queryFn: () => api.projects.activity(project.id, { limit: 8 }) });
  const { data: members = [] } = useProjectMembers(project.id);
  return (
    <Panel title="Recent activity">
      {isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : !data?.data.length ? (
        <span className="text-[13px] text-fg-2">Nothing yet. Activity shows up as the team works.</span>
      ) : (
        <div role="feed" aria-label="Recent activity" className="flex flex-col">
          {data.data.map((a) => {
            const actor = members.find((m) => m.userId === a.actorId)?.user;
            return (
              <article key={a.id} className="flex gap-2.5 py-2 text-[13px] leading-5 text-fg-2">
                <Avatar name={actor?.name ?? "Lightex"} hue={actor?.hue} size={20} className="mt-px" decorative />
                <span className="min-w-0 flex-1">
                  <b className="font-medium text-fg">{actor?.name ?? "Lightex"}</b> {activityText(a, a.taskKey ?? undefined)}
                  {a.taskTitle && a.verb === "created" ? ` · ${a.taskTitle}` : ""}
                </span>
                <span className="whitespace-nowrap text-meta text-fg-3">{agoOrDate(a.createdAt)}</span>
              </article>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function SmallEmpty({ icon, title, body, children }: { icon: ReactNode; title: string; body: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 py-1.5">
      <span className="flex size-9 items-center justify-center rounded-[9px] border border-dashed border-line-2 text-fg-2">{icon}</span>
      <b className="font-semibold">{title}</b>
      <span className="max-w-[420px] text-[13px] text-fg-2">{body}</span>
      {children}
    </div>
  );
}

/* ───────── setup checklist (board 12) ───────── */

const SKIP_KEY = (id: string) => `lightex-setup-skipped-${id}`;

function SetupChecklist({
  project,
  tasks,
  objectives,
  milestones,
  members,
  sprintStarted,
}: {
  project: Project;
  tasks: number;
  objectives: number;
  milestones: number;
  members: number;
  sprintStarted: boolean;
}) {
  const ws = useCurrentWorkspace()!;
  const router = useRouter();
  const [skipped, setSkipped] = useState(() => {
    try {
      return typeof window !== "undefined" && localStorage.getItem(SKIP_KEY(project.id)) === "1";
    } catch {
      return false;
    }
  });
  const perms = project.my_permissions;
  const steps = [
    { id: "create", title: "Create the project", desc: `${project.name} · key ${project.key}`, done: true },
    { id: "invite", title: "Invite your team", desc: "Members can create and edit", done: members > 1, cta: "Invite", kbd: "I", allowed: can("project.manage_members", perms), run: () => router.push(`${routes.project(ws.slug, project.key, "settings")}#members`) },
    { id: "objective", title: "Add an objective", desc: "What does success look like?", done: objectives > 0, cta: "Add objective", kbd: "O", allowed: can("objective.manage", perms), run: () => router.push(`${routes.project(ws.slug, project.key, "objectives")}?new=1`) },
    { id: "milestone", title: "Plan a milestone", desc: "A dated checkpoint", done: milestones > 0, cta: "Add milestone", kbd: "M", allowed: can("milestone.manage", perms), run: () => router.push(`${routes.project(ws.slug, project.key, "milestones")}?new=1`) },
    { id: "tasks", title: "Create your first tasks", desc: "Type them in, one per line or one at a time", done: tasks > 0, cta: "New task", kbd: "C", allowed: can("task.create", perms), run: () => shell.openCreateTask({ projectId: project.id }) },
    { id: "sprint", title: "Start a sprint", desc: "Plan the next 1–2 weeks", done: sprintStarted, cta: "Start sprint", kbd: "S", allowed: can("sprint.manage", perms), run: () => router.push(routes.project(ws.slug, project.key, "sprints")) },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const canDoAny = steps.some((s) => !s.done && s.allowed);
  if (doneCount === steps.length || skipped || !canDoAny) return null;
  const nextId = steps.find((s) => !s.done)?.id;
  const pct = Math.round((doneCount / steps.length) * 100);
  return (
    <section aria-labelledby="setup-title" className="flex flex-col gap-[18px] rounded-[14px] border border-line-2 bg-surface p-6 max-[760px]:p-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex flex-[1_1_320px] flex-col gap-1">
          <h2 id="setup-title" className="m-0 text-[18px] font-semibold leading-[26px] tracking-[-0.01em]">
            Set up your project
          </h2>
          <span className="text-[13px] text-fg-2">About 5 minutes</span>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-meta text-fg-3">
            {doneCount}/{steps.length}
          </span>
          <ProgressBar value={pct} label="Setup progress" color="var(--ok)" className="w-[180px]" />
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setSkipped(true);
            try {
              localStorage.setItem(SKIP_KEY(project.id), "1");
            } catch {
              /* private mode */
            }
          }}
        >
          Skip setup
        </Button>
      </div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {steps.map((s) => {
          const isNext = s.id === nextId;
          return (
            <li
              key={s.id}
              className={cn(
                "flex items-center gap-3.5 rounded-[10px] border border-line bg-bg px-3.5 py-3 transition-[border-color,background-color] duration-[var(--dur-fast)] max-[760px]:flex-wrap",
                isNext && "border-accent shadow-[0_0_0_3px_var(--accent-s)]",
              )}
            >
              {s.done ? <StatusGlyph kind="done" label="Done" className="size-[22px]" /> : <span role="img" aria-label="Not done" className="size-[22px] flex-none rounded-full border-2 border-control" />}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cn("font-semibold", s.done && "text-fg-3 line-through")}>{s.title}</span>
                <span className="text-[12px] leading-[18px] text-fg-3">{s.desc}</span>
              </div>
              {!s.done && s.allowed && s.cta && (
                <Button size="sm" variant={isNext ? "primary" : "secondary"} kbd={s.kbd} onClick={s.run} className="max-[760px]:w-full">
                  {s.cta}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function OverviewSkeleton() {
  return (
    <Wrap>
      <div aria-busy="true" aria-label="Loading overview" className="flex flex-col gap-6">
        <div className="flex gap-4">
          <Skeleton className="size-11 rounded-[10px]" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-3 w-96 max-w-full" />
          </div>
        </div>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr))]">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[88px] rounded-lg" />
          ))}
        </div>
        <div className="flex flex-wrap gap-6">
          <Skeleton className="h-[420px] flex-[999_1_560px] rounded-lg" />
          <Skeleton className="h-[420px] flex-[1_1_320px] rounded-lg" />
        </div>
      </div>
    </Wrap>
  );
}

