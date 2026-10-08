"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Avatar, AvatarStack } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CountUp, Skeleton } from "@/components/ui/feedback";
import { PriorityIcon, StatusGlyph, priorityMeta } from "@/components/ui/glyphs";
import { Kbd } from "@/components/ui/kbd";
import { toast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/session";
import { useActiveSprint, useProjectMembers } from "@/features/projects/queries";
import { useSparking } from "@/features/tasks/task-bits";
import { TaskPanelHost } from "@/features/tasks/task-panel-host";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Project, Status, Task } from "@/lib/api/types";
import { daysUntil } from "@/lib/domain/progress";
import { templateDef } from "@/lib/domain/project-templates";
import { isTypingTarget } from "@/lib/hooks/use-hotkeys";
import { can, useCan, useCurrentWorkspace } from "@/lib/permissions/can";
import { pushUrl, replaceUrl, routes } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { todayISO } from "@/lib/utils/dates";
import { dueLabel, dueSoon, homeStats, longDate } from "./my-work";
import { NewProjectDialog } from "./new-project-dialog";
import { useMyTasks, useProjects, useRoles, useWsMembers } from "./queries";
import { ScreenError } from "./screen-error";
import { canChangeStatus, useSetStatus, useStatusMap, useTaskHref } from "./task-line";

/**
 * "P" opens New project (board 24). Hand-rolled instead of useHotkeys so the global "G then P"
 * (profile) sequence keeps working: a P right after G is left alone.
 */
function useNewProjectKey(run: () => void, enabled: boolean) {
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  });
  useEffect(() => {
    if (!enabled) return;
    let last = { key: "", at: 0 };
    const onKey = (e: KeyboardEvent) => {
      const prev = last;
      last = { key: e.key.toLowerCase(), at: Date.now() };
      if (e.key.toLowerCase() !== "p" || e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.defaultPrevented) return;
      if (prev.key === "g" && Date.now() - prev.at < 1000) return;
      if (isTypingTarget(e.target) || (e.target as HTMLElement | null)?.closest?.("[role='dialog'], [role='alertdialog']")) return;
      e.preventDefault();
      runRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const BODY = "mx-auto flex w-full max-w-[1080px] flex-col gap-7 px-8 pb-12 pt-7 max-[760px]:gap-6 max-[760px]:px-4 max-[760px]:pt-[18px]";

/** Workspace home (board 24): greeting + quick stats, recent projects, due soon; empty / no-access heroes. */
export function HomeScreen() {
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const pathname = usePathname();
  const search = useSearchParams();
  const canCreate = useCan("project.create");
  const projectsQ = useProjects(ws.slug);
  const mine = useMyTasks(ws.slug);
  const recents = useQuery({ queryKey: qk.recents(), queryFn: api.search.recents, staleTime: 10_000 });
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const dialogOpen = search.get("new-project") === "1" && canCreate;
  const openCreate = () => pushUrl(`${pathname}?new-project=1`);
  useNewProjectKey(openCreate, canCreate && !dialogOpen);

  const projects = useMemo(() => {
    const order = new Map<string, number>();
    (recents.data ?? []).forEach((r, i) => r.kind === "project" && !order.has(r.id) && order.set(r.id, i));
    return (projectsQ.data ?? [])
      .filter((p) => p.status === "active")
      .sort((a, b) => Number(b.key === createdKey) - Number(a.key === createdKey) || (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99) || a.name.localeCompare(b.name));
  }, [projectsQ.data, recents.data, createdKey]);
  const hasProjects = projects.length > 0;
  const showWork = hasProjects && projects.some((p) => can("task.edit_own", p.my_permissions) || can("task.edit_any", p.my_permissions) || can("task.move", p.my_permissions));

  const loading = projectsQ.isPending || (showWork && mine.isPending);
  const failed = projectsQ.isError ? projectsQ.error : showWork && mine.isError ? mine.error : null;

  return (
    <div className="flex min-h-full flex-col">
      {loading ? (
        <HomeSkeleton />
      ) : failed ? (
        <ScreenError
          title="Couldn’t load your home"
          error={failed}
          resource="workspace/home"
          onRetry={() => {
            void projectsQ.refetch();
            void mine.refetch();
          }}
        />
      ) : (
        <div className={cn(BODY, "motion-safe:animate-[fade-in_200ms_var(--ease)]")}>
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-[18px]">
            <div className="flex min-w-0 flex-col gap-2">
              <h1 className="m-0 text-[26px] font-semibold leading-8 tracking-[-0.025em] max-[760px]:text-[21px] max-[760px]:leading-[26px]">
                {greeting()}, {me.name.split(" ")[0]}
              </h1>
              <span className="font-mono text-[12px] leading-none text-fg-3">{longDate()}</span>
            </div>
            {showWork && <Stats tasks={mine.data ?? []} />}
          </div>

          {hasProjects && (
            <section aria-labelledby="hm-recent" className="flex min-w-0 flex-col gap-3">
              <SectionHead id="hm-recent" title="Recent projects" count={projects.length} />
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))] max-[760px]:-mx-4 max-[760px]:flex max-[760px]:snap-x max-[760px]:snap-mandatory max-[760px]:overflow-x-auto max-[760px]:px-4 max-[760px]:pb-1.5 max-[760px]:pt-0.5 max-[760px]:[scrollbar-width:none]">
                {projects.map((p) => (
                  <ProjectCard key={p.id} project={p} fresh={p.key === createdKey} />
                ))}
                {canCreate && (
                  <button
                    type="button"
                    onClick={openCreate}
                    className="group flex min-h-[166px] flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed border-line-2 bg-transparent p-3.5 text-[13px] font-medium text-fg-2 transition-[border-color,background-color,color] duration-[120ms] hover:border-accent hover:bg-accent-s hover:text-fg max-[760px]:flex-[0_0_232px] max-[760px]:snap-start"
                  >
                    <span className="inline-flex size-[38px] items-center justify-center rounded-[10px] border border-line-2 bg-surface transition-transform duration-[220ms] [transition-timing-function:var(--spring)] group-hover:rotate-90 group-hover:border-accent motion-reduce:group-hover:rotate-0">
                      <Plus size={16} strokeWidth={1.7} aria-hidden />
                    </span>
                    <span className="inline-flex items-center gap-2">
                      New project <Kbd>P</Kbd>
                    </span>
                  </button>
                )}
              </div>
            </section>
          )}

          {showWork && <DueSoon tasks={mine.data ?? []} />}

          {!hasProjects && canCreate && (
            <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-line-2 px-6 pb-12 pt-11 text-center">
              <EmptyArt />
              <h2 className="m-0 text-[18px] font-semibold leading-6 tracking-[-0.015em]">Create your first project</h2>
              <Button variant="primary" size="lg" kbd="P" onClick={openCreate}>
                <Plus size={14} strokeWidth={1.8} aria-hidden /> New project
              </Button>
            </div>
          )}

          {!hasProjects && !canCreate && <NoAccess />}
        </div>
      )}
      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={(o) => !o && replaceUrl(pathname)}
        onCreated={(p) => setCreatedKey(p.key)}
      />
      <TaskPanelHost />
    </div>
  );
}

function SectionHead({ id, title, count, children }: { id: string; title: string; count: number; children?: ReactNode }) {
  return (
    <div className="flex min-h-[26px] items-center gap-2">
      <h2 id={id} className="m-0 text-[13px] font-semibold">
        {title}
      </h2>
      <span className="font-mono text-[11px] font-medium text-fg-3">{count}</span>
      {children}
    </div>
  );
}

function Stats({ tasks }: { tasks: Task[] }) {
  const { statuses } = useStatusMap();
  const s = homeStats(tasks, (t) => statuses.get(t.statusId), todayISO());
  const items: [string, number, boolean][] = [
    ["Due today", s.dueToday, false],
    ["Overdue", s.overdue, s.overdue > 0],
    ["In progress", s.inProgress, false],
    ["Done this week", s.doneThisWeek, false],
  ];
  return (
    <div role="list" aria-label="Quick stats" className="grid flex-[0_1_520px] grid-cols-4 gap-2 max-[760px]:flex-[1_1_100%] max-[760px]:grid-cols-2">
      {items.map(([label, v, late]) => (
        <div key={label} role="listitem" aria-label={`${v} ${label}`} className="flex min-w-0 flex-col gap-[7px] rounded-[10px] border border-line bg-surface px-3 py-[11px]">
          <span aria-hidden className={cn("font-mono text-[22px] font-semibold leading-none tracking-[-0.03em]", late && "text-danger")}>
            <CountUp value={v} />
          </span>
          <span aria-hidden className="truncate text-[12px] leading-[14px] text-fg-3">
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}

function ProjectCard({ project, fresh }: { project: Project; fresh: boolean }) {
  const ws = useCurrentWorkspace()!;
  const sprint = useActiveSprint(project.activeSprintId ? project.id : undefined);
  const members = useProjectMembers(project.id);
  const s = project.activeSprintId ? sprint.data : null;
  const done = project.doneTaskCount ?? 0;
  const total = done + project.openTaskCount;
  const pct = Math.round(s ? s.progress.percent : total ? (done / total) * 100 : 0);
  const people = (members.data ?? []).map((m) => ({ id: m.userId, name: m.user.name, hue: m.user.hue }));
  const chip = s ? `${s.name} · ${Math.max(0, daysUntil(s.endDate))}d` : project.template === "scrum" ? "No active sprint" : templateDef(project.template).name;
  return (
    <Link
      href={routes.project(ws.slug, project.key)}
      aria-label={`${project.name}, ${pct} percent done`}
      className={cn(
        "relative flex min-h-[166px] min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-3.5 text-fg no-underline",
        "transition-[border-color,transform] duration-[160ms] [transition-timing-function:var(--spring)] hover:-translate-y-0.5 hover:border-line-2 motion-reduce:hover:translate-y-0",
        "max-[760px]:flex-[0_0_232px] max-[760px]:snap-start",
        fresh && "border-accent motion-safe:animate-[rise-in_400ms_var(--spring)]",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="inline-flex size-7 flex-none items-center justify-center rounded-[7px] font-mono text-[11px] font-semibold leading-none"
          style={{ background: `oklch(var(--pk-l) var(--pk-c) ${project.hue})`, color: `oklch(var(--pkt-l) var(--pkt-c) ${project.hue})` }}
        >
          {project.key.slice(0, 2)}
        </span>
        <Ring pct={pct} />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="truncate text-[14px] font-semibold leading-[18px] tracking-[-0.01em]">{project.name}</span>
        <span className="font-mono text-[11.5px] font-medium leading-none text-fg-3">{project.key}</span>
      </div>
      <div className="mt-auto flex min-w-0 items-center gap-2">
        {people.length > 0 && <AvatarStack people={people} max={3} size={20} />}
        <span className="ml-auto inline-flex h-[22px] min-w-0 items-center gap-1.5 truncate whitespace-nowrap rounded-[6px] bg-raised px-[7px] font-mono text-[11px] font-medium text-fg-2">
          {s && <span aria-hidden className="size-1.5 flex-none rounded-full bg-ok" />}
          <span className="truncate">{chip}</span>
        </span>
      </div>
    </Link>
  );
}

function Ring({ pct }: { pct: number }) {
  const c = 2 * Math.PI * 18;
  const [drawn, setDrawn] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(pct));
    return () => cancelAnimationFrame(id);
  }, [pct]);
  return (
    <span aria-hidden className="relative ml-auto size-11 flex-none">
      <svg width="44" height="44" viewBox="0 0 44 44" fill="none" className="block">
        <circle cx="22" cy="22" r="18" stroke="var(--hover)" strokeWidth="4" />
        <circle
          cx="22"
          cy="22"
          r="18"
          stroke={pct >= 100 ? "var(--ok)" : "var(--accent-t)"}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - drawn / 100)}
          transform="rotate(-90 22 22)"
          className="transition-[stroke-dashoffset] duration-1000 ease-out motion-reduce:transition-none"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-mono text-[11px] font-semibold text-fg-2">{pct}</span>
    </span>
  );
}

function DueSoon({ tasks }: { tasks: Task[] }) {
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const { statuses, byProject, projects } = useStatusMap();
  const setStatus = useSetStatus(byProject);
  const href = useTaskHref();
  const [keep, setKeep] = useState<ReadonlySet<string>>(new Set());
  const [prev, setPrev] = useState<Record<string, string>>({});
  const today = todayISO();
  const list = dueSoon(tasks, (t) => statuses.get(t.statusId), keep, today);
  const openCount = list.filter((t) => statuses.get(t.statusId)?.category !== "done").length;

  const toggle = (t: Task) => {
    const cur = statuses.get(t.statusId);
    const opts = byProject.get(t.projectId) ?? [];
    if (cur?.category === "done") {
      const back = opts.find((s) => s.id === prev[t.id]) ?? opts.find((s) => s.glyph === "todo") ?? opts[0];
      if (back) setStatus(t, back);
    } else {
      const done = opts.find((s) => s.glyph === "done");
      if (!done) return;
      setPrev((p) => ({ ...p, [t.id]: t.statusId }));
      setKeep((k) => new Set(k).add(t.id));
      setStatus(t, done);
    }
  };

  return (
    <section aria-labelledby="hm-due" className="flex min-w-0 flex-col gap-3">
      <SectionHead id="hm-due" title="Due soon" count={openCount}>
        <span className="flex-1" />
        <Link href={routes.myTasks(ws.slug)} className="inline-flex items-center gap-1 rounded-xs text-[12.5px] font-medium text-accent-t hover:underline">
          My tasks <ChevronRight size={12} strokeWidth={1.6} aria-hidden />
        </Link>
      </SectionHead>
      <div role="list" className="overflow-hidden rounded-lg border border-line bg-surface">
        {list.length === 0 ? (
          <div className="flex h-12 items-center gap-2.5 px-4 text-fg-3">
            <StatusGlyph kind="done" /> Nothing due this week
          </div>
        ) : (
          list.map((t) => (
            <DueRow
              key={t.id}
              task={t}
              status={statuses.get(t.statusId)}
              project={projects.get(t.projectId)}
              canEdit={canChangeStatus(t, projects.get(t.projectId), me.id) && Boolean(byProject.get(t.projectId)?.length)}
              onToggle={() => toggle(t)}
              href={href(t.key)}
              today={today}
            />
          ))
        )}
      </div>
    </section>
  );
}

function DueRow({
  task,
  status,
  project,
  canEdit,
  onToggle,
  href,
  today,
}: {
  task: Task;
  status: Status | undefined;
  project: Project | undefined;
  canEdit: boolean;
  onToggle: () => void;
  href: string;
  today: string;
}) {
  const spark = useSparking(task.id);
  const done = status?.category === "done";
  const due = dueLabel(task.dueDate, done, today);
  const glyph = <StatusGlyph kind={status?.glyph ?? "todo"} spark={spark} />;
  const toggleLabel = done ? `Reopen ${task.key}` : `Mark ${task.key} done`;
  return (
    <div role="listitem" className="relative flex h-[42px] items-center gap-2.5 border-b border-line pl-1.5 pr-3.5 transition-colors duration-100 last:border-b-0 hover:bg-raised max-[760px]:h-[52px] max-[760px]:pl-0.5">
      {canEdit ? (
        <button
          type="button"
          aria-pressed={done}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={onToggle}
          className="relative z-[2] inline-flex size-[30px] flex-none items-center justify-center rounded-[7px] hover:bg-hover max-[760px]:size-11"
        >
          {glyph}
        </button>
      ) : (
        <span className="inline-flex size-[30px] flex-none items-center justify-center max-[760px]:size-11" role="img" aria-label={status?.name}>
          {glyph}
        </span>
      )}
      <Link
        href={href}
        scroll={false}
        aria-label={`Open ${task.key} ${task.title}`}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-sm text-fg no-underline after:absolute after:inset-0 after:content-['']"
      >
        <span className="min-w-12 flex-none font-mono text-[12px] font-medium text-fg-3 max-[760px]:min-w-0">{task.key}</span>
        <span className={cn("min-w-0 flex-1 truncate font-medium transition-colors duration-200", done && "text-fg-3 line-through")}>{task.title}</span>
      </Link>
      {project && (
        <span
          title={project.name}
          aria-hidden
          className="inline-flex size-[18px] flex-none items-center justify-center rounded-[5px] font-mono text-[8.5px] font-semibold leading-none"
          style={{ background: `oklch(var(--pk-l) var(--pk-c) ${project.hue})`, color: `oklch(var(--pkt-l) var(--pkt-c) ${project.hue})` }}
        >
          {project.key.slice(0, 2)}
        </span>
      )}
      <span className="max-[760px]:hidden" title={priorityMeta[task.priority].label}>
        <PriorityIcon level={task.priority} bars />
      </span>
      <span
        className={cn(
          "min-w-16 flex-none text-right font-mono text-[12px] font-medium text-fg-2",
          due.tone === "late" && "text-danger",
          due.tone === "soon" && "text-warn",
          due.tone === "muted" && "text-fg-3",
        )}
      >
        {due.text}
      </span>
    </div>
  );
}

function EmptyArt() {
  return (
    <div aria-hidden className="relative h-[92px] w-[176px]">
      <i className="absolute left-0.5 top-2.5 h-[66px] w-[92px] -rotate-[8deg] rounded-[10px] border border-line-2 bg-surface opacity-55" />
      <i className="absolute right-0.5 top-2.5 h-[66px] w-[92px] rotate-[8deg] rounded-[10px] border border-line-2 bg-surface opacity-55" />
      <i className="absolute left-[42px] top-1 flex h-[66px] w-[92px] items-center justify-center rounded-[10px] border border-dashed border-accent bg-accent-s text-accent-t">
        <Plus size={20} strokeWidth={1.7} />
      </i>
    </div>
  );
}

function NoAccess() {
  const ws = useCurrentWorkspace()!;
  const qc = useQueryClient();
  const { data: members = [] } = useWsMembers(ws.slug);
  const { data: roles = [] } = useRoles(ws.slug);
  const mine = useQuery({ queryKey: qk.wsAccessRequest(ws.slug), queryFn: () => api.workspaces.myAccessRequest(ws.slug) });
  const requested = Boolean(mine.data?.request);
  const set = (v: boolean) => qc.setQueryData(qk.wsAccessRequest(ws.slug), { request: v ? { id: "pending", workspaceId: ws.id, userId: "", createdAt: "" } : null });
  const request = useMutation({
    mutationFn: () => api.workspaces.requestAccess(ws.slug),
    onMutate: () => set(true),
    onError: (e) => {
      set(false);
      toast.error("Couldn’t send the request", { body: errorMessage(e) });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.wsAccessRequest(ws.slug) }),
  });
  const withdraw = useMutation({
    mutationFn: () => api.workspaces.withdrawAccessRequest(ws.slug),
    onMutate: () => set(false),
    onError: (e) => {
      set(true);
      toast.error("Couldn’t withdraw the request", { body: errorMessage(e) });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.wsAccessRequest(ws.slug) }),
  });
  const adminRoles = new Map(roles.filter((r) => r.scope === "workspace" && r.permissions.includes("workspace.manage_members")).map((r) => [r.id, r.name]));
  const admins = members.filter((m) => m.status === "active" && adminRoles.has(m.roleId)).slice(0, 4);
  // Both mutations flip the UI optimistically, so the button on screen belongs to whichever is in flight.
  const busy = request.isPending || withdraw.isPending;

  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-line-2 px-6 pb-12 pt-11 text-center">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM3 20c.7-3.3 3-5.5 6-5.5 1.4 0 2.6.4 3.6 1.2M17.5 14v6M14.5 17h6" />
      </svg>
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-[18px] font-semibold leading-6 tracking-[-0.015em]">You’re not on a project yet</h2>
        <span className="text-fg-2">Ask an admin to add you.</span>
      </div>
      {admins.length > 0 && (
        <div role="list" aria-label="Workspace admins" className="flex w-full max-w-[340px] flex-col rounded-[10px] border border-line bg-surface p-1 text-left">
          {admins.map((m) => (
            <div key={m.userId} role="listitem" className="flex h-10 items-center gap-2.5 px-2">
              <Avatar name={m.user.name} hue={m.user.hue} size={24} decorative />
              <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="truncate font-medium">{m.user.name}</span>
                <span className="truncate font-mono text-[11px] text-fg-3">{m.user.email}</span>
              </span>
              <span className={cn("rounded-[5px] bg-raised px-1.5 py-1 font-mono text-[10.5px] font-medium leading-none text-fg-2", requested && "bg-ok-s text-ok")}>
                {requested ? "Notified" : adminRoles.get(m.roleId)}
              </span>
            </div>
          ))}
        </div>
      )}
      {mine.isPending ? (
        <Skeleton className="h-10 w-36 rounded-md" />
      ) : requested ? (
        <div role="status" className="flex items-center gap-1.5">
          <span className="inline-flex h-10 items-center gap-2 rounded-md bg-ok-s px-4 text-[13px] font-medium text-ok">
            <Check size={14} strokeWidth={1.8} aria-hidden /> Request sent
          </span>
          <Button variant="ghost" loading={busy} onClick={() => withdraw.mutate()} className="text-accent-t">
            Withdraw
          </Button>
        </div>
      ) : (
        <Button variant="primary" size="lg" loading={busy} onClick={() => request.mutate()}>
          Request access
        </Button>
      )}
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className={BODY} aria-busy="true" aria-label="Loading home" role="status">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-[18px]">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-[22px] w-60 rounded-[6px] max-[760px]:w-48" />
          <Skeleton className="w-[120px]" />
        </div>
        <div className="grid flex-[0_1_520px] grid-cols-4 gap-2 max-[760px]:flex-[1_1_100%] max-[760px]:grid-cols-2">
          {[
            [22, 64],
            [18, 52],
            [22, 70],
            [18, 84],
          ].map(([a, b], i) => (
            <div key={i} className="flex flex-col gap-[11px] rounded-[10px] border border-line bg-surface px-3 py-[11px]">
              <Skeleton className="h-[18px]" style={{ width: a }} />
              <Skeleton style={{ width: b }} />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="my-2 w-[118px]" />
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
          {[72, 54, 40].map((w) => (
            <div key={w} className="flex min-h-[166px] flex-col gap-3 rounded-lg border border-line bg-surface p-3.5">
              <div className="flex items-start">
                <Skeleton className="size-7 rounded-[7px]" />
                <Skeleton className="ml-auto size-11 rounded-full" />
              </div>
              <Skeleton className="h-3" style={{ width: `${w}%` }} />
              <Skeleton className="w-9" />
              <div className="mt-auto flex items-center gap-1">
                <Skeleton className="size-5 rounded-full" />
                <Skeleton className="size-5 rounded-full" />
                <Skeleton className="ml-auto h-[18px] w-[76px] rounded-[6px]" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="my-2 w-[86px]" />
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {[46, 30, 52, 38].map((w) => (
            <div key={w} className="flex h-[42px] items-center gap-2.5 border-b border-line px-3.5 last:border-b-0">
              <Skeleton className="size-3.5 rounded-full" />
              <Skeleton className="w-[46px]" />
              <Skeleton style={{ width: `${w}%` }} />
              <Skeleton className="ml-auto w-12" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
