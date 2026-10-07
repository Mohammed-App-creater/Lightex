"use client";

import { Archive, ArrowLeft, ChevronRight, Flag, Layers, Pencil, Plus, RotateCcw, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useMemo, useState } from "react";
import { Avatar, UnassignedAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { PriorityIcon, StatusGlyph, glyphLabel, priorityMeta, type GlyphKind, type PriorityLevel } from "@/components/ui/glyphs";
import { useProjectTasks } from "@/features/goals/queries";
import { useOpenTask } from "@/features/goals/parts";
import { useEpics, useMilestones, useProjectMembers, useStatuses } from "@/features/projects/queries";
import { errorMessage } from "@/lib/api/errors";
import type { Epic, Milestone, Task, User } from "@/lib/api/types";
import { useCan, useCurrentProject } from "@/lib/permissions/can";
import { cn } from "@/lib/utils/cn";
import { shortDate } from "@/lib/utils/dates";
import { AddTasksPicker } from "./add-tasks-picker";
import { EpicPanel } from "./epic-panel";
import { GROUP_ORDER, epicStats, epicSwatch, epicTint, glyphMap, pickable, splitEpics } from "./epic-model";
import { useArchiveEpic, useAssignEpic } from "./queries";

type People = Map<string, Pick<User, "id" | "name" | "hue">>;
type PanelState = { epic: Epic | null } | null;

/** Epics (board 27): card grid with computed progress + status counts, epic detail, archive. */
export function EpicsScreen() {
  return (
    <Suspense fallback={null}>
      <EpicsInner />
    </Suspense>
  );
}

function EpicsInner() {
  const project = useCurrentProject()!;
  const canManage = useCan("epic.manage");
  const epicsQ = useEpics(project.id);
  const tasksQ = useProjectTasks(project.id);
  const statusesQ = useStatuses(project.id);
  const membersQ = useProjectMembers(project.id);
  const milestonesQ = useMilestones(project.id);
  const archive = useArchiveEpic(project.id);
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [panel, setPanel] = useState<PanelState>(null);
  const [fresh, setFresh] = useState<string | null>(null);

  const glyphOf = useMemo(() => glyphMap(statusesQ.data ?? []), [statusesQ.data]);
  const people: People = useMemo(() => new Map((membersQ.data ?? []).map((m) => [m.userId, m.user])), [membersQ.data]);
  const milestones = useMemo(() => new Map((milestonesQ.data ?? []).map((m) => [m.id, m])), [milestonesQ.data]);
  const tasks = useMemo(() => (tasksQ.data ?? []).filter((t) => !t.deletedAt), [tasksQ.data]);
  const epics = useMemo(() => epicsQ.data ?? [], [epicsQ.data]);
  const openId = search.get("epic");
  const open = openId ? epics.find((e) => e.id === openId) : undefined;

  const setOpen = useCallback(
    (id: string | null) => {
      const sp = new URLSearchParams(window.location.search);
      if (id) sp.set("epic", id);
      else sp.delete("epic");
      sp.delete("task");
      const qs = sp.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  const pending = epicsQ.isPending || tasksQ.isPending || statusesQ.isPending;
  const error = epicsQ.error ?? tasksQ.error ?? statusesQ.error;
  const retry = () => {
    void epicsQ.refetch();
    void tasksQ.refetch();
    void statusesQ.refetch();
  };
  const doArchive = (e: Epic) => {
    setPanel(null);
    if (openId === e.id) setOpen(null);
    archive.mutate({ epic: e, archived: true });
  };

  return (
    <>
      {open && !pending && !error ? (
        <EpicDetail
          key={open.id}
          epic={open}
          tasks={tasks}
          glyphOf={glyphOf}
          people={people}
          milestone={open.milestoneId ? milestones.get(open.milestoneId) : undefined}
          canManage={canManage}
          onBack={() => setOpen(null)}
          onEdit={() => setPanel({ epic: open })}
          onArchive={() => doArchive(open)}
          onRestore={() => archive.mutate({ epic: open, archived: false })}
        />
      ) : (
        <EpicList
          epics={epics}
          tasks={tasks}
          glyphOf={glyphOf}
          people={people}
          milestones={milestones}
          pending={pending}
          error={error}
          retrying={epicsQ.isFetching || tasksQ.isFetching}
          onRetry={retry}
          canManage={canManage}
          fresh={fresh}
          onOpen={setOpen}
          onNew={() => setPanel({ epic: null })}
          onRestore={(e) => {
            setFresh(e.id);
            archive.mutate({ epic: e, archived: false });
          }}
        />
      )}
      {panel && canManage && (
        <EpicPanel
          epic={panel.epic}
          projectId={project.id}
          epics={epics}
          members={membersQ.data ?? []}
          milestones={milestonesQ.data ?? []}
          onClose={() => setPanel(null)}
          onSaved={(e, created) => {
            setPanel(null);
            if (created) setFresh(e.id);
          }}
          onArchive={doArchive}
        />
      )}
    </>
  );
}

/* ───────────── list ───────────── */

function EpicList({
  epics,
  tasks,
  glyphOf,
  people,
  milestones,
  pending,
  error,
  retrying,
  onRetry,
  canManage,
  fresh,
  onOpen,
  onNew,
  onRestore,
}: {
  epics: Epic[];
  tasks: Task[];
  glyphOf: (id: string) => GlyphKind;
  people: People;
  milestones: Map<string, Milestone>;
  pending: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  canManage: boolean;
  fresh: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRestore: (e: Epic) => void;
}) {
  const [archOpen, setArchOpen] = useState(false);
  const { active, archived } = splitEpics(epics);
  const byEpic = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks) if (t.epicId) m.set(t.epicId, [...(m.get(t.epicId) ?? []), t]);
    return m;
  }, [tasks]);

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-8 pb-16 pt-5 max-[760px]:px-3 max-[760px]:pt-3">
      <div className="flex items-center gap-2">
        <h1 className="m-0 text-h3">Epics</h1>
        {!pending && !error && <span className="font-mono text-[12px] text-fg-3">{active.length}</span>}
        <span className="flex-1" />
        {canManage && (
          <Button size="sm" variant="primary" onClick={onNew} aria-label="New epic" className="max-[760px]:h-11">
            <Plus size={13} aria-hidden /> <span className="max-[760px]:hidden">New epic</span>
          </Button>
        )}
      </div>
      {pending ? (
        <div aria-busy="true" aria-label="Loading epics" className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {[120, 150, 96, 132, 110, 140].map((w, i) => (
            <div key={i} className="flex flex-col gap-3.5 rounded-xl border border-line bg-surface p-3.5">
              <span className="flex items-center gap-2.5">
                <Skeleton className="size-3 rounded-[4px]" />
                <Skeleton className="h-2.5" style={{ width: w }} />
                <span className="flex-1" />
                <Skeleton className="size-5 rounded-full" />
              </span>
              <Skeleton className="h-2.5 w-24" />
              <Skeleton className="h-1.5 w-full" />
              <Skeleton className="h-2.5 w-[150px] opacity-60" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="flex justify-center py-10">
          <ErrorState className="w-full max-w-[440px]" title="Couldn’t load epics" body={`${errorMessage(error)} · nothing was lost`} onRetry={onRetry} retrying={retrying} />
        </div>
      ) : epics.length === 0 ? (
        <div className="flex justify-center py-14">
          <EmptyState
            align="center"
            icon={<Layers size={20} aria-hidden />}
            title="No epics yet"
            body="Group related tasks toward a milestone."
            actions={
              canManage ? (
                <Button variant="primary" onClick={onNew}>
                  <Plus size={13} aria-hidden /> Create epic
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }} className="flex flex-col gap-4">
          {active.length > 0 ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3 max-[760px]:grid-cols-1">
              {active.map((e) => (
                <EpicCard
                  key={e.id}
                  epic={e}
                  tasks={byEpic.get(e.id) ?? []}
                  glyphOf={glyphOf}
                  owner={e.ownerId ? people.get(e.ownerId) : undefined}
                  milestone={e.milestoneId ? milestones.get(e.milestoneId) : undefined}
                  fresh={fresh === e.id}
                  onOpen={() => onOpen(e.id)}
                />
              ))}
            </div>
          ) : (
            <p className="m-0 py-6 text-center font-mono text-[12px] text-fg-3">All epics archived</p>
          )}
          {archived.length > 0 && (
            <section aria-label="Archived epics">
              <button
                type="button"
                aria-expanded={archOpen}
                aria-controls="epics-archived"
                onClick={() => setArchOpen((o) => !o)}
                className="flex h-9 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[13px] font-semibold text-fg transition-colors hover:bg-hover max-[760px]:h-11"
              >
                <ChevronRight size={12} aria-hidden className={cn("text-fg-3 transition-transform duration-200 ease-out", archOpen && "rotate-90")} />
                Archived
                <span className="font-mono text-[11px] font-medium text-fg-3">{archived.length}</span>
              </button>
              <AnimatePresence initial={false}>
                {archOpen && (
                  <motion.ul
                    id="epics-archived"
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="m-0 flex list-none flex-col p-0 pt-1"
                  >
                    {archived.map((e) => {
                      const s = epicStats(byEpic.get(e.id) ?? [], glyphOf);
                      const owner = e.ownerId ? people.get(e.ownerId) : undefined;
                      const ms = e.milestoneId ? milestones.get(e.milestoneId) : undefined;
                      return (
                        <li key={e.id} className="flex min-h-11 items-center gap-2.5 border-b border-line px-2 text-[13px] last:border-b-0">
                          <i aria-hidden className="size-3 flex-none rounded-[4px] opacity-45" style={{ background: epicSwatch(e.hue) }} />
                          <span className="min-w-0 flex-1 truncate font-medium text-fg-2">{e.name}</span>
                          <span className="w-[150px] truncate text-[12px] text-fg-3 max-[760px]:hidden">{ms?.name ?? "—"}</span>
                          <span className="font-mono text-[11.5px] text-fg-3">
                            {s.counts.done}/{s.total}
                          </span>
                          {owner ? <Avatar name={owner.name} hue={owner.hue} size={20} ring={false} /> : <UnassignedAvatar size={20} label="No owner" />}
                          <span className="flex w-[92px] justify-end max-[760px]:w-auto">
                            {canManage && (
                              <Button size="sm" variant="ghost" onClick={() => onRestore(e)} aria-label={`Restore ${e.name}`} className="max-[760px]:h-11">
                                <RotateCcw size={12} aria-hidden /> <span className="max-[760px]:hidden">Restore</span>
                              </Button>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </motion.ul>
                )}
              </AnimatePresence>
            </section>
          )}
        </motion.div>
      )}
    </div>
  );
}

function SegBar({ segments, aria, height = 6 }: { segments: { kind: GlyphKind; width: number }[]; aria: string; height?: number }) {
  return (
    <span role="img" aria-label={aria} className="flex min-w-0 flex-1 gap-0.5 overflow-hidden rounded-full bg-raised" style={{ height }}>
      {segments.map((s) => (
        <motion.span
          key={s.kind}
          className="block h-full origin-left"
          style={{ width: `${s.width}%`, background: `var(--${s.kind === "done" ? "ok" : s.kind === "review" ? "info" : "warn"})` }}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        />
      ))}
    </span>
  );
}

function Counts({ stats }: { stats: ReturnType<typeof epicStats> }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11.5px] text-fg-2">
      {stats.visible.map((k) => (
        <span key={k} title={glyphLabel[k]} className="inline-flex items-center gap-1.5">
          <StatusGlyph kind={k} className="scale-[.85]" />
          {stats.counts[k]}
          <span className="sr-only">{glyphLabel[k]}</span>
        </span>
      ))}
    </span>
  );
}

function EpicCard({
  epic,
  tasks,
  glyphOf,
  owner,
  milestone,
  fresh,
  onOpen,
}: {
  epic: Epic;
  tasks: Task[];
  glyphOf: (id: string) => GlyphKind;
  owner?: Pick<User, "name" | "hue">;
  milestone?: Milestone;
  fresh: boolean;
  onOpen: () => void;
}) {
  const s = epicStats(tasks, glyphOf);
  return (
    <motion.article
      initial={fresh ? { opacity: 0, scale: 0.97 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 380, damping: 26 }}
      className="relative flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-3.5 transition-[border-color,transform,box-shadow] duration-150 ease-out hover:-translate-y-0.5 hover:border-line-2 hover:shadow-pop has-[:focus-visible]:border-line-2 motion-reduce:hover:translate-y-0 max-[760px]:hover:translate-y-0"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${epic.name}, ${s.pct} percent${owner ? `, owner ${owner.name}` : ""}. Open epic`}
          className="flex min-w-0 items-center gap-2.5 rounded-sm text-left after:absolute after:inset-0 after:rounded-xl after:content-['']"
        >
          <i aria-hidden className="size-3 flex-none rounded-[4px]" style={{ background: epicSwatch(epic.hue) }} />
          <span className="truncate text-[14px] font-semibold">{epic.name}</span>
        </button>
        <span className="flex-1" />
        {owner ? (
          <span title={`Owner: ${owner.name}`} className="flex">
            <Avatar name={owner.name} hue={owner.hue} size={20} ring={false} />
          </span>
        ) : (
          <UnassignedAvatar size={20} label="No owner" />
        )}
      </div>
      <div className="flex items-center gap-2 text-[12px] text-fg-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
          <Flag size={12} className="flex-none text-fg-3" aria-hidden />
          <span className="truncate">{milestone?.name ?? "No milestone"}</span>
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[11.5px] text-fg-3">{s.total} tasks</span>
      </div>
      <div className="flex items-center gap-2.5">
        <SegBar segments={s.segments} aria={s.aria} />
        <span className="w-[34px] text-right font-mono text-[11.5px] text-fg-2">{s.pct}%</span>
      </div>
      <Counts stats={s} />
    </motion.article>
  );
}

/* ───────────── detail ───────────── */

function EpicDetail({
  epic,
  tasks,
  glyphOf,
  people,
  milestone,
  canManage,
  onBack,
  onEdit,
  onArchive,
  onRestore,
}: {
  epic: Epic;
  tasks: Task[];
  glyphOf: (id: string) => GlyphKind;
  people: People;
  milestone?: Milestone;
  canManage: boolean;
  onBack: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const project = useCurrentProject()!;
  const canEditTasks = useCan("task.edit_any");
  const canAssign = canManage && canEditTasks;
  const assign = useAssignEpic(project.id);
  const openTask = useOpenTask();
  const [picking, setPicking] = useState(false);
  const [freshTasks, setFreshTasks] = useState<string[]>([]);
  const [closed, setClosed] = useState<Partial<Record<GlyphKind, boolean>>>({ canceled: true });
  const mine = tasks.filter((t) => t.epicId === epic.id);
  const s = epicStats(mine, glyphOf);
  const owner = epic.ownerId ? people.get(epic.ownerId) : undefined;
  const archived = Boolean(epic.archivedAt);
  const groups = GROUP_ORDER.map((k) => ({
    kind: k,
    rows: mine.filter((t) => glyphOf(t.statusId) === k).sort((a, b) => b.priority - a.priority || a.number - b.number),
  })).filter((g) => g.rows.length);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <header className="flex h-[52px] flex-none items-center gap-2 border-b border-line px-6 max-[760px]:px-2">
        <Button variant="secondary" size="sm" onClick={onBack} aria-label="Back to epics" className="max-[760px]:h-11">
          <ArrowLeft size={13} aria-hidden /> <span className="max-[760px]:hidden">Epics</span>
        </Button>
        <span className="ml-1 flex min-w-0 items-center gap-2 font-semibold max-[760px]:hidden" aria-hidden>
          <i className="size-3 flex-none rounded-[4px]" style={{ background: epicSwatch(epic.hue) }} />
          <span className="truncate text-[13px]">{epic.name}</span>
        </span>
        <span className="flex-1" />
        {canManage &&
          (archived ? (
            <Button size="sm" variant="secondary" onClick={onRestore} className="max-[760px]:h-11">
              <RotateCcw size={13} aria-hidden /> Restore
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={onArchive} aria-label="Archive epic" className="max-[760px]:size-11 max-[760px]:px-0">
                <Archive size={13} aria-hidden /> <span className="max-[760px]:hidden">Archive</span>
              </Button>
              <Button size="sm" variant="secondary" onClick={onEdit} className="max-[760px]:h-11">
                <Pencil size={12} aria-hidden /> Edit
              </Button>
              {canAssign && (
                <Button
                  size="sm"
                  variant="primary"
                  data-add-tasks-trigger
                  aria-haspopup="dialog"
                  aria-expanded={picking}
                  onClick={() => setPicking((p) => !p)}
                  className="max-[760px]:h-11"
                >
                  <Plus size={13} aria-hidden /> Add tasks
                </Button>
              )}
            </>
          ))}
      </header>
      {picking && canAssign && (
        <AddTasksPicker
          epicName={epic.name}
          pool={pickable(tasks, glyphOf)}
          glyphOf={glyphOf}
          people={people}
          onClose={() => setPicking(false)}
          onAdd={(ids) => {
            setPicking(false);
            setFreshTasks(ids);
            assign.mutate({ ids, epicId: epic.id, label: `Added ${ids.length} ${ids.length === 1 ? "task" : "tasks"} to ${epic.name}`, undoOf: null });
          }}
        />
      )}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[920px] flex-col gap-3.5 px-8 pb-4 pt-6 max-[760px]:px-3 max-[760px]:pt-4">
          {archived && (
            <p role="status" className="m-0 rounded-md border border-line bg-raised px-3 py-2 text-[12.5px] text-fg-2">
              This epic is archived. Restore it to plan new work.
            </p>
          )}
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex size-[30px] flex-none items-center justify-center rounded-lg border"
              style={{ background: epicTint(epic.hue), borderColor: `oklch(var(--ep-l) var(--ep-c) ${epic.hue} / .35)` }}
            >
              <i className="size-3 rounded-[4px]" style={{ background: epicSwatch(epic.hue) }} />
            </span>
            <h1 className="m-0 min-w-0 text-[20px] font-semibold leading-7 tracking-[-0.01em]">{epic.name}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-fg-2">
            <span className="inline-flex items-center gap-2">
              {owner ? <Avatar name={owner.name} hue={owner.hue} size={20} ring={false} decorative /> : <UnassignedAvatar size={20} label="No owner" />}
              {owner?.name ?? "No owner"}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Flag size={13} className="text-fg-3" aria-hidden />
              {milestone?.name ?? "No milestone"}
              {milestone && <span className="font-mono text-[11.5px] text-fg-3">{shortDate(milestone.dueDate)}</span>}
            </span>
            <Counts stats={s} />
          </div>
          <div className="flex items-center gap-2.5">
            <SegBar segments={s.segments} aria={s.aria} height={8} />
            <span className="font-mono text-[12px] text-fg">{s.pct}%</span>
            <span className="font-mono text-[12px] text-fg-3">
              {s.counts.done}/{s.total}
            </span>
          </div>
          {epic.description && <p className="m-0 max-w-[640px] whitespace-pre-line text-[13.5px] leading-[21px] text-fg-2">{epic.description}</p>}
        </div>
        <div className="mx-auto flex w-full max-w-[920px] flex-col px-8 pb-16 max-[760px]:px-3">
          {groups.map((g) => {
            const isOpen = !closed[g.kind];
            const id = `epic-group-${g.kind}`;
            return (
              <section key={g.kind} aria-label={glyphLabel[g.kind]}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={id}
                  onClick={() => setClosed((c) => ({ ...c, [g.kind]: isOpen }))}
                  className="mt-2 flex h-9 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[13px] font-semibold transition-colors hover:bg-hover max-[760px]:h-11"
                >
                  <ChevronRight size={12} aria-hidden className={cn("text-fg-3 transition-transform duration-200 ease-out", isOpen && "rotate-90")} />
                  <StatusGlyph kind={g.kind} />
                  {glyphLabel[g.kind]}
                  <span className="font-mono text-[11px] font-medium text-fg-3">{g.rows.length}</span>
                </button>
                {isOpen && (
                  <ul id={id} className="m-0 list-none p-0">
                    {g.rows.map((t) => {
                      const a = t.assigneeId ? people.get(t.assigneeId) : undefined;
                      return (
                        <motion.li
                          key={t.id}
                          initial={freshTasks.includes(t.id) ? { opacity: 0, x: -6 } : false}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ duration: 0.25 }}
                          className="group relative flex min-h-10 items-center gap-2.5 rounded-md px-2 text-[13px] hover:bg-hover max-[760px]:min-h-12"
                        >
                          <StatusGlyph kind={glyphOf(t.statusId)} />
                          <span className="w-[62px] flex-none font-mono text-[11.5px] font-medium text-fg-3 max-[760px]:hidden">{t.key}</span>
                          <button
                            type="button"
                            onClick={() => openTask(t.key)}
                            className={cn(
                              "min-w-0 flex-1 truncate text-left font-medium after:absolute after:inset-0 after:content-['']",
                              g.kind === "done" && "text-fg-2",
                            )}
                          >
                            {t.title}
                          </button>
                          <PriorityIcon level={t.priority as PriorityLevel} label={`${priorityMeta[t.priority as PriorityLevel].label} priority`} />
                          {a ? <Avatar name={a.name} hue={a.hue} size={20} ring={false} /> : <UnassignedAvatar size={20} />}
                          <span className="relative z-[1] flex w-7 justify-end max-[760px]:w-11">
                            {canAssign && !archived && (
                              <Button
                                variant="ghost"
                                size="sm"
                                icon
                                aria-label={`Remove ${t.key} from epic`}
                                onClick={() => assign.mutate({ ids: [t.id], epicId: null, undoOf: epic.id, label: `Removed ${t.key}` })}
                                className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 max-[1023px]:opacity-100 max-[760px]:size-11"
                              >
                                <X size={13} aria-hidden />
                              </Button>
                            )}
                          </span>
                        </motion.li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
          {mine.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <span className="font-mono text-[12px] text-fg-3">No tasks in this epic</span>
              {canAssign && !archived && (
                <Button size="sm" variant="secondary" data-add-tasks-trigger onClick={() => setPicking(true)}>
                  Add tasks
                </Button>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
