"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, X } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Skeleton } from "@/components/ui/feedback";
import { PriorityIcon, StatusGlyph, glyphColor, glyphLabel, priorityMeta } from "@/components/ui/glyphs";
import { TopBarActions } from "@/components/shell/top-bar";
import { useMe } from "@/features/auth/session";
import { TaskPanelHost } from "@/features/tasks/task-panel-host";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { Project, Status, Task } from "@/lib/api/types";
import { usePrefersReducedMotion } from "@/lib/hooks/use-media-query";
import { useCurrentWorkspace } from "@/lib/permissions/can";
import { cn } from "@/lib/utils/cn";
import { todayISO } from "@/lib/utils/dates";
import { BOARD_COLUMNS, bucketTasks, byDueThenPriority, closedAt, closedRecently, dueLabel, parseKeys, weekEndISO } from "./my-work";
import { useWsMembers } from "./queries";
import { ScreenError } from "./screen-error";
import { StatusPicker, statusForDigit } from "./status-picker";
import { canChangeStatus, useSetStatus, useStatusMap, useTaskHref } from "./task-line";

type View = "open" | "bugs" | "due" | "done";
type Layout = "list" | "board";

const VIEW_LABEL: Record<Exclude<View, "open">, string> = { bugs: "Open bugs", due: "Due this week", done: "Done" };
const LEAVE_MS = 720;

/**
 * My tasks (board 25): 5 date groups + "Completed recently", List ⇄ Board, project chips, inline
 * status (click the glyph, or press 1–N on a focused row / in the menu). Also serves the sidebar's
 * pinned views (?view=bugs|due|done) and "Show X's tasks" from the palette (?assignee=<userId>).
 */
export function MyTasksScreen() {
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const reduced = usePrefersReducedMotion();
  const raw = search.get("view");
  const view: View = raw === "bugs" || raw === "due" || raw === "done" ? raw : "open";
  const layout: Layout = search.get("layout") === "board" ? "board" : "list";
  const assignee = search.get("assignee") ?? "me";
  const projectKeys = parseKeys(search.get("project"));
  const { data: members = [] } = useWsMembers(ws.slug);
  const who = assignee === "me" || assignee === me.id ? null : members.find((m) => m.userId === assignee)?.user;

  const q = useQuery({
    queryKey: assignee === "me" ? qk.myTasks(ws.slug) : [...qk.myTasks(ws.slug), assignee],
    queryFn: () => (assignee === "me" ? api.workspaces.myTasks(ws.slug) : api.workspaces.assignedTasks(ws.slug, assignee)),
    select: (r) => r.data,
  });
  const { statuses, byProject, projects, pending: statusesPending } = useStatusMap();
  const setStatus = useSetStatus(byProject);
  const href = useTaskHref();

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const sp = new URLSearchParams(search.toString());
      Object.entries(patch).forEach(([k, v]) => (v ? sp.set(k, v) : sp.delete(k)));
      const qs = sp.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, search],
  );

  /* Closing animation: a row that just closed stays in place, fades, then moves to Completed. */
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [bump, setBump] = useState(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  const closed = useCallback((t: Task) => statuses.get(t.statusId)?.category === "done", [statuses]);
  const today = todayISO();
  const weekEnd = weekEndISO(today);

  const pick = useCallback(
    (task: Task, s: Status) => {
      if (task.statusId === s.id) return;
      const closing = !closed(task) && s.category === "done";
      if (closing && layout === "list" && !reduced) {
        setLeaving((l) => new Set(l).add(task.id));
        clearTimeout(timers.current.get(task.id));
        timers.current.set(
          task.id,
          setTimeout(() => {
            setLeaving((l) => {
              const n = new Set(l);
              n.delete(task.id);
              return n;
            });
            setBump((b) => b + 1);
          }, LEAVE_MS),
        );
      } else if (closing) setBump((b) => b + 1);
      setStatus(task, s);
    },
    [closed, layout, reduced, setStatus],
  );

  const data = useMemo(() => {
    const all = q.data ?? [];
    const inView = all.filter((t) => {
      if (view === "bugs") return t.type === "bug";
      if (view === "due") return closed(t) || (Boolean(t.dueDate) && t.dueDate! <= weekEnd);
      return true;
    });
    const counts = new Map<string, number>();
    inView.filter((t) => !closed(t)).forEach((t) => counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1));
    const keyOf = (t: Task) => projects.get(t.projectId)?.key ?? "";
    const shown = projectKeys.length ? inView.filter((t) => projectKeys.includes(keyOf(t))) : inView;
    const open = shown.filter((t) => !closed(t));
    const openOrLeaving = shown.filter((t) => !closed(t) || leaving.has(t.id));
    const completed = shown
      .filter((t) => closed(t) && !leaving.has(t.id) && (view === "done" || closedRecently(t, today)))
      .sort((a, b) => closedAt(b).localeCompare(closedAt(a)));
    const chipProjects = [...projects.values()].filter((p) => p.status === "active" && (counts.has(p.id) || projectKeys.includes(p.key)));
    return { counts, open, openOrLeaving, completed, chipProjects };
  }, [q.data, view, closed, weekEnd, projects, projectKeys, leaving, today]);

  const loading = q.isPending || (statusesPending && !q.isError);
  const ready = !loading && !q.isError;
  const filterNames = data.chipProjects.filter((p) => projectKeys.includes(p.key)).map((p) => p.name);

  return (
    <section aria-label={who ? `${who.name}’s tasks` : "My tasks"} className="flex h-full min-h-0 flex-col">
      <TopBarActions>
        <span className="whitespace-nowrap font-mono text-[11.5px] font-medium text-fg-3" aria-label={ready ? `${data.open.length} open` : undefined}>
          {ready ? `${data.open.length} open` : "—"}
        </span>
        <LayoutToggle value={layout} onChange={(v) => setParams({ layout: v === "board" ? "board" : null })} />
      </TopBarActions>

      <div role="group" aria-label="Filter by project" className="flex h-[46px] flex-none items-center gap-1.5 overflow-x-auto border-b border-line px-4 [scrollbar-width:none] max-[760px]:h-[52px] max-[760px]:px-3">
        {loading ? (
          <>
            <Skeleton className="h-7 w-[132px] rounded-full" />
            <Skeleton className="h-7 w-[110px] rounded-full" />
            <Skeleton className="h-7 w-[72px] rounded-full" />
          </>
        ) : q.isError ? null : (
          <>
            {who && <RemovableChip label={`${who.name}’s tasks`} onRemove={() => setParams({ assignee: null })} />}
            {view !== "open" && <RemovableChip label={VIEW_LABEL[view]} onRemove={() => setParams({ view: null })} />}
            {data.chipProjects.map((p) => {
              const on = projectKeys.includes(p.key);
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setParams({ project: (on ? projectKeys.filter((k) => k !== p.key) : [...projectKeys, p.key]).join(",") || null })}
                  className={cn(
                    "inline-flex h-7 flex-none items-center gap-[7px] whitespace-nowrap rounded-full border border-line-2 pl-[5px] pr-2.5 text-[12.5px] font-medium text-fg-2 transition-[border-color,background-color,color,transform] duration-[120ms] hover:border-control hover:text-fg active:scale-[.97] max-[760px]:h-[34px] max-[760px]:pr-3",
                    on && "border-accent bg-accent-s text-fg hover:border-accent",
                  )}
                >
                  <ProjectDot project={p} round />
                  {p.name}
                  <span className="font-mono text-[11px] font-medium text-fg-3">{data.counts.get(p.id) ?? 0}</span>
                </button>
              );
            })}
            {projectKeys.length > 0 && (
              <button type="button" onClick={() => setParams({ project: null })} className="ml-1 flex-none rounded-xs px-1 text-[12.5px] font-medium text-accent-t hover:underline">
                Clear
              </button>
            )}
          </>
        )}
      </div>

      {loading ? (
        <ListSkeleton />
      ) : q.isError ? (
        <ScreenError title="Couldn’t load your tasks" error={q.error} resource="me/tasks" onRetry={() => void q.refetch()} />
      ) : layout === "list" ? (
        <TaskList
          key={view}
          view={view}
          data={data}
          leaving={leaving}
          bump={bump}
          today={today}
          statuses={statuses}
          byProject={byProject}
          projects={projects}
          meId={me.id}
          href={href}
          onPick={pick}
          clearMeta={filterNames.length ? `Nothing open in ${filterNames.join(", ")}` : `${data.completed.length} completed recently`}
        />
      ) : (
        <TaskBoard data={data} bump={bump} today={today} statuses={statuses} byProject={byProject} projects={projects} meId={me.id} href={href} onPick={pick} />
      )}
      <TaskPanelHost />
    </section>
  );
}

type Data = { open: Task[]; openOrLeaving: Task[]; completed: Task[] };
type RowCtx = {
  today: string;
  statuses: Map<string, Status>;
  byProject: Map<string, Status[]>;
  projects: Map<string, Project>;
  meId: string;
  href: (key: string) => string;
  onPick: (t: Task, s: Status) => void;
};

function LayoutToggle({ value, onChange }: { value: Layout; onChange: (v: Layout) => void }) {
  const items: { v: Layout; label: string; icon: string }[] = [
    { v: "list", label: "List", icon: "M2.5 4h11M2.5 8h11M2.5 12h11" },
    { v: "board", label: "Board", icon: "M2.5 3h3v10h-3zM6.5 3h3v7h-3zM10.5 3h3v5h-3z" },
  ];
  return (
    <div role="group" aria-label="Layout" className="relative inline-flex flex-none rounded-md border border-line bg-surface p-0.5">
      <i
        aria-hidden
        className="absolute bottom-0.5 left-0.5 top-0.5 w-[76px] rounded-[6px] bg-raised shadow-[inset_0_0_0_1px_var(--line-2)] transition-transform duration-[260ms] [transition-timing-function:var(--spring)] motion-reduce:transition-none max-[760px]:w-11"
        style={{ transform: value === "board" ? "translateX(100%)" : "none" }}
      />
      {items.map((it) => (
        <button
          key={it.v}
          type="button"
          aria-pressed={value === it.v}
          aria-label={it.label}
          onClick={() => onChange(it.v)}
          className="relative z-[1] inline-flex h-[26px] w-[76px] items-center justify-center gap-1.5 rounded-[6px] text-[12.5px] font-medium text-fg-3 transition-colors duration-[160ms] hover:text-fg-2 aria-pressed:text-fg max-[760px]:h-[34px] max-[760px]:w-11"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d={it.icon} />
          </svg>
          <span className="max-[760px]:hidden">{it.label}</span>
        </button>
      ))}
    </div>
  );
}

function RemovableChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-7 flex-none items-center gap-1 whitespace-nowrap rounded-full border border-accent bg-accent-s pl-2.5 pr-0.5 text-[12.5px] font-medium text-fg max-[760px]:h-[34px]">
      {label}
      <button type="button" aria-label={`Remove ${label}`} onClick={onRemove} className="inline-flex size-6 items-center justify-center rounded-full text-fg-2 hover:bg-hover hover:text-fg">
        <X size={12} aria-hidden />
      </button>
    </span>
  );
}

function ProjectDot({ project, round, title }: { project: Project; round?: boolean; title?: string }) {
  return (
    <span
      aria-hidden
      title={title}
      className={cn("inline-flex size-[18px] flex-none items-center justify-center font-mono text-[8.5px] font-semibold leading-none", round ? "rounded-full" : "rounded-[5px]")}
      style={{ background: `oklch(var(--pk-l) var(--pk-c) ${project.hue})`, color: `oklch(var(--pkt-l) var(--pkt-c) ${project.hue})` }}
    >
      {project.key.slice(0, 2)}
    </span>
  );
}

/* ───────────────────────── List ───────────────────────── */

function TaskList({
  view,
  data,
  leaving,
  bump,
  clearMeta,
  ...ctx
}: RowCtx & { view: View; data: Data; leaving: ReadonlySet<string>; bump: number; clearMeta: string }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ done: view !== "done" });
  const buckets = view === "done" ? [] : bucketTasks(data.openOrLeaving, ctx.today);
  const groups = [
    ...buckets.map((b) => ({ id: b.id as string, title: b.title, meta: b.meta, tasks: b.tasks, count: b.tasks.filter((t) => !leaving.has(t.id)).length })),
    ...(data.completed.length
      ? [{ id: "done", title: view === "done" ? "Completed" : "Completed recently", meta: view === "done" ? "" : "7 days", tasks: data.completed, count: data.completed.length }]
      : []),
  ];
  const allClear = view !== "done" && data.open.length === 0 && leaving.size === 0;

  return (
    <div className="relative min-h-0 flex-1 overflow-auto [scrollbar-width:thin]">
      <div role="list" aria-label="Tasks by due date" className="motion-safe:animate-[fade-in_280ms_var(--ease)]">
        {allClear && <AllClear meta={clearMeta} />}
        {view === "done" && !groups.length && <div className="px-6 py-14 text-center text-fg-3">Nothing completed yet.</div>}
        {groups.map((g) => {
          const open = !collapsed[g.id];
          const warn = g.id === "overdue";
          const cmp = g.id === "done";
          return (
            <div key={g.id} role="listitem">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setCollapsed((c) => ({ ...c, [g.id]: open }))}
                className={cn(
                  "sticky top-0 z-[3] flex h-9 w-full items-center gap-2 border-b border-line bg-surface pl-3 pr-4 text-left text-[13px] font-semibold leading-none text-fg transition-colors duration-[120ms] hover:bg-raised max-[760px]:h-11 max-[760px]:pl-3.5",
                  warn && "bg-[color-mix(in_oklab,var(--danger)_10%,var(--surface))] text-danger hover:bg-[color-mix(in_oklab,var(--danger)_15%,var(--surface))]",
                  cmp && "font-medium text-fg-2",
                )}
              >
                <ChevronRight size={12} strokeWidth={1.7} aria-hidden className={cn("flex-none text-fg-3 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-90", warn && "text-danger")} />
                {warn && (
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M8 2.5a5.5 5.5 0 110 11 5.5 5.5 0 010-11zM8 5v3.5M8 10.8v.1" />
                  </svg>
                )}
                {g.title}
                <CountPill n={g.count} warn={warn} bump={cmp ? bump : 0} />
                <span className="flex-1" />
                <span className="font-mono text-[11px] font-medium text-fg-3">{g.meta}</span>
              </button>
              {open && (
                <div role="list" aria-label={g.title}>
                  {g.tasks.map((t) => (
                    <TaskRow key={t.id} task={t} leaving={leaving.has(t.id)} {...ctx} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CountPill({ n, warn, bump }: { n: number; warn?: boolean; bump?: number }) {
  return (
    <motion.span
      key={bump}
      initial={bump ? { scale: 1.35 } : false}
      animate={{ scale: 1 }}
      transition={{ type: "spring", stiffness: 500, damping: 18 }}
      className={cn(
        "inline-flex h-[18px] min-w-5 items-center justify-center rounded-[9px] bg-raised px-1.5 font-mono text-[11px] font-semibold leading-none text-fg-2",
        warn && "bg-danger text-bg",
      )}
    >
      {n}
    </motion.span>
  );
}

function rowKeyDown(e: KeyboardEvent, task: Task, options: Status[], canChange: boolean, onPick: RowCtx["onPick"]) {
  if (e.defaultPrevented || !canChange || e.metaKey || e.ctrlKey || e.altKey) return;
  const s = statusForDigit(e.key, options);
  if (!s) return;
  e.preventDefault();
  onPick(task, s);
}

function TaskRow({ task, leaving, today, statuses, byProject, projects, meId, href, onPick }: RowCtx & { task: Task; leaving: boolean }) {
  const status = statuses.get(task.statusId);
  const project = projects.get(task.projectId);
  const options = byProject.get(task.projectId) ?? [];
  const isClosed = status?.category === "done";
  const due = dueLabel(task.dueDate, isClosed, today, 5);
  const canChange = canChangeStatus(task, project, meId);
  return (
    <div
      role="listitem"
      onKeyDown={(e) => rowKeyDown(e, task, options, canChange, onPick)}
      className={cn(
        "relative flex h-10 items-center gap-2.5 overflow-hidden border-b border-line pl-2.5 pr-4 transition-[background-color,opacity] duration-100 hover:bg-surface focus-within:bg-surface max-[760px]:h-[54px] max-[760px]:gap-2 max-[760px]:pl-1 max-[760px]:pr-3.5",
        leaving && "pointer-events-none opacity-40 duration-[720ms]",
      )}
    >
      <StatusPicker task={task} status={status} statuses={options} canChange={canChange} onPick={(s) => onPick(task, s)} />
      <Link
        href={href(task.key)}
        scroll={false}
        aria-label={`Open ${task.key} ${task.title}`}
        aria-keyshortcuts={canChange && options.length ? options.slice(0, 9).map((_, i) => String(i + 1)).join(" ") : undefined}
        className="flex h-full min-w-0 flex-1 items-center gap-2.5 text-fg no-underline outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:after:shadow-[inset_0_0_0_1px_var(--accent),inset_0_0_0_3px_var(--ring)]"
      >
        <span className="min-w-[52px] flex-none font-mono text-[12px] font-medium text-fg-3 max-[760px]:min-w-0 max-[760px]:text-[11px]">{task.key}</span>
        <span className={cn("min-w-0 flex-1 truncate font-medium", isClosed && "text-fg-3 line-through")}>{task.title}</span>
      </Link>
      {project && (
        <span className="inline-flex w-[140px] min-w-0 flex-none items-center gap-[7px] text-[12.5px] text-fg-2 max-[760px]:w-auto">
          <ProjectDot project={project} title={project.name} />
          <span className="truncate max-[760px]:hidden">{project.name}</span>
        </span>
      )}
      <span className="max-[760px]:hidden" title={priorityMeta[task.priority].label}>
        <PriorityIcon level={task.priority} bars />
      </span>
      <DueCell text={due.text} tone={due.tone} className="min-w-[68px] max-[760px]:min-w-0" />
    </div>
  );
}

function DueCell({ text, tone, className }: { text: string; tone: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex-none text-right font-mono text-[12px] font-medium text-fg-2",
        tone === "late" && "text-danger",
        tone === "soon" && "text-warn",
        tone === "muted" && "text-fg-3",
        className,
      )}
    >
      {text}
    </span>
  );
}

function AllClear({ meta }: { meta: string }) {
  const [burst, setBurst] = useState(0);
  const reduced = usePrefersReducedMotion();
  const dots = [0, 45, 90, 135, 180, 225, 270, 315];
  return (
    <div role="status" className="flex flex-col items-center justify-center gap-2.5 px-6 pb-10 pt-11 text-center">
      <button type="button" aria-label="Celebrate again" onClick={() => setBurst((b) => b + 1)} className="relative size-24 rounded-full">
        <span key={burst} aria-hidden className="absolute inset-0">
          {[0, 22.5].map((offset, ring) =>
            dots.map((deg) => {
              const r = ring ? 32 : 40;
              const a = ((deg + offset) * Math.PI) / 180;
              return (
                <motion.span
                  key={`${ring}-${deg}`}
                  className={cn("absolute left-1/2 top-1/2 rounded-full", ring ? "-ml-0.5 -mt-0.5 size-1 bg-ok" : "-ml-[3px] -mt-[3px] size-1.5 bg-spark")}
                  initial={reduced ? { opacity: 0 } : { x: 0, y: 0, opacity: 1, scale: 0.4 }}
                  animate={reduced ? { opacity: 0 } : { x: Math.sin(a) * r, y: -Math.cos(a) * r, opacity: 0, scale: 1 }}
                  transition={{ duration: 0.9, delay: ring ? 0.26 : 0.16, ease: [0.16, 1, 0.3, 1] }}
                />
              );
            }),
          )}
          <motion.span
            className="absolute inset-[22px] flex items-center justify-center rounded-full bg-ok shadow-[0_0_0_8px_color-mix(in_oklab,var(--ok)_14%,transparent)]"
            initial={reduced ? false : { scale: 0.3, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 420, damping: 16 }}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--bg)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <motion.path d="M6 12.5l4 4 8-9" initial={reduced ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.32, delay: 0.22 }} />
            </svg>
          </motion.span>
        </span>
      </button>
      <h2 className="m-0 mt-1.5 text-[20px] font-semibold leading-[26px] tracking-[-0.02em]">All clear</h2>
      <span className="font-mono text-[11.5px] text-fg-3">{meta}</span>
    </div>
  );
}

/* ───────────────────────── Board ───────────────────────── */

function TaskBoard({ data, bump, ...ctx }: RowCtx & { data: Data; bump: number }) {
  const cols = BOARD_COLUMNS.map((g) => {
    const list =
      g === "done"
        ? data.completed.filter((t) => ctx.statuses.get(t.statusId)?.glyph === "done")
        : data.open.filter((t) => ctx.statuses.get(t.statusId)?.glyph === g).sort(byDueThenPriority);
    return { g, list };
  });
  return (
    <div className="relative min-h-0 flex-1 overflow-auto [scrollbar-width:thin] max-[760px]:snap-x max-[760px]:snap-mandatory max-[760px]:scroll-px-4">
      <div
        role="list"
        aria-label="Tasks by status"
        className="grid h-full min-w-min grid-cols-[repeat(5,minmax(196px,1fr))] gap-3 px-4 pb-4 pt-3.5 motion-safe:animate-[fade-in_280ms_var(--ease)] max-[760px]:grid-cols-[repeat(5,272px)] max-[760px]:pb-10 max-[760px]:pt-3"
      >
        {cols.map(({ g, list }) => (
          <div key={g} role="listitem" aria-label={`${glyphLabel[g]}, ${list.length}`} className="flex min-h-0 flex-col rounded-lg border border-line bg-surface max-[760px]:snap-start">
            <div className="flex h-[42px] flex-none items-center gap-2 px-3 font-semibold max-[760px]:h-[46px]">
              <StatusGlyph kind={g} color={glyphColor[g]} />
              {glyphLabel[g]}
              <CountPill n={list.length} bump={g === "done" ? bump : 0} />
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 [scrollbar-width:none]">
              {list.map((t) => (
                <BoardCard key={t.id} task={t} {...ctx} />
              ))}
              {!list.length && <div className="flex h-14 flex-none items-center justify-center rounded-[10px] border border-dashed border-line-2 text-[12px] text-fg-3">None</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BoardCard({ task, today, statuses, byProject, projects, meId, href, onPick }: RowCtx & { task: Task }) {
  const status = statuses.get(task.statusId);
  const project = projects.get(task.projectId);
  const options = byProject.get(task.projectId) ?? [];
  const isClosed = status?.category === "done";
  const due = dueLabel(task.dueDate, isClosed, today, 5);
  const canChange = canChangeStatus(task, project, meId);
  return (
    <div
      onKeyDown={(e) => rowKeyDown(e, task, options, canChange, onPick)}
      className={cn(
        "relative flex flex-none flex-col gap-[9px] rounded-[10px] border border-line bg-bg pb-2 pl-3 pr-2 pt-2.5 transition-[border-color,transform] duration-[160ms] [transition-timing-function:var(--spring)] hover:-translate-y-px hover:border-line-2 focus-within:border-accent motion-reduce:hover:translate-y-0",
        !isClosed && due.tone === "late" && "shadow-[inset_0_2px_0_-1px_var(--danger)]",
      )}
    >
      <div className="flex min-w-0 items-center gap-[7px]">
        {project && <ProjectDot project={project} title={project.name} />}
        <span className="min-w-0 truncate font-mono text-[12px] font-medium text-fg-3">{task.key}</span>
        <span className="-my-1 ml-auto max-[760px]:-my-2.5 max-[760px]:-mr-1.5">
          <StatusPicker task={task} status={status} statuses={options} canChange={canChange} onPick={(s) => onPick(task, s)} />
        </span>
      </div>
      <Link
        href={href(task.key)}
        scroll={false}
        className={cn(
          "line-clamp-2 pr-1 font-medium leading-[18px] text-fg no-underline outline-none after:absolute after:inset-0 after:rounded-[10px] after:content-[''] focus-visible:after:shadow-[inset_0_0_0_1px_var(--accent),inset_0_0_0_3px_var(--ring)]",
          isClosed && "text-fg-3 line-through",
        )}
      >
        {task.title}
      </Link>
      <div className="flex min-w-0 items-center gap-[7px]">
        <span title={priorityMeta[task.priority].label}>
          <PriorityIcon level={task.priority} bars />
        </span>
        <span className="flex-1" />
        <DueCell text={due.text} tone={due.tone} />
      </div>
    </div>
  );
}

/* ───────────────────────── Loading ───────────────────────── */

function ListSkeleton() {
  const groups = [
    { w: 64, rows: [62, 44] },
    { w: 44, rows: [48, 66, 38] },
    { w: 72, rows: [56, 74, 50] },
  ];
  return (
    <div className="min-h-0 flex-1 overflow-hidden" role="status" aria-busy="true" aria-label="Loading tasks">
      {groups.map((g, gi) => (
        <div key={gi}>
          <div className="flex h-9 items-center gap-2 border-b border-line bg-surface pl-3 pr-4">
            <Skeleton className="size-3 rounded-[3px]" />
            <Skeleton style={{ width: g.w }} />
            <Skeleton className="h-4 w-5 rounded-lg" />
          </div>
          {g.rows.map((w, i) => (
            <div key={i} className="flex h-10 items-center gap-2.5 border-b border-line pl-[17px] pr-4">
              <Skeleton className="size-3.5 rounded-full" />
              <Skeleton className="ml-[7px] w-[46px]" />
              <Skeleton style={{ width: `${w}%` }} />
              <span className="flex-1" />
              <Skeleton className="max-[760px]:hidden" style={{ width: i % 2 ? 84 : 110 }} />
              <Skeleton className="w-11" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
