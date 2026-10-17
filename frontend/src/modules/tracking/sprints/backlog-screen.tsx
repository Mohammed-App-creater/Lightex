"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, GripVertical, MoreHorizontal, Plus } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { memo, useMemo, useRef, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { PriorityIcon, StatusGlyph } from "@/components/ui/glyphs";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { shell } from "@/components/shell/shell-state";
import { TopBarActions } from "@/components/shell/top-bar";
import { useProjectMembers, useSprints, useStatuses } from "@/features/projects/queries";
import { useMoveTask } from "@/features/tasks/mutations";
import { rememberOrigin } from "@/features/tasks/task-origin";
import { api } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/errors";
import { qk } from "@/lib/api/query-keys";
import type { Sprint, Status, Task, User } from "@/lib/api/types";
import { usePrefersReducedMotion } from "@/lib/hooks/use-media-query";
import { useCan, useCurrentProject } from "@/lib/permissions/can";
import { pushUrl, withTaskParam } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { dateRange } from "@/lib/utils/dates";
import { keyBetween } from "@/lib/utils/fractional-index";
import { DeleteSprintDialog, EditSprintDialog, StartSprintDialog } from "./sprint-dialogs";
import { CompleteSprintDialog } from "./sprint-review";

const BACKLOG = "backlog";
type Cols = Record<string, string[]>;

export function BacklogScreen() {
  const project = useCurrentProject()!;
  const qc = useQueryClient();
  const pathname = usePathname();
  const search = useSearchParams();
  const reduced = usePrefersReducedMotion();
  const canMove = useCan("task.move");
  const canCreate = useCan("task.create");
  const canSprint = useCan("sprint.manage");
  const q = useQuery({ queryKey: qk.backlog(project.id), queryFn: () => api.backlog.get(project.id) });
  const { data: sprints = [] } = useSprints(project.id);
  const { data: statuses = [] } = useStatuses(project.id);
  const { data: members = [] } = useProjectMembers(project.id);
  const move = useMoveTask();
  const [drag, setDrag] = useState<{ id: string; cols: Cols } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const lastSwitch = useRef(0);

  const createSprint = useMutation({
    mutationFn: () => api.planning.createSprint(project.id),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: qk.scope(project.id) });
      toast.success(`${s.name} created`, { body: dateRange(s.startDate, s.endDate) });
    },
    onError: (e) => toast.error("Couldn’t create a sprint", { body: errorMessage(e) }),
  });

  const sections = useMemo(() => {
    if (!q.data) return [];
    const bySprint = new Map(q.data.sprints.map((s) => [s.sprintId, s.tasks]));
    const list = sprints
      .filter((s) => s.state !== "completed")
      .sort((a, b) => (a.state === "active" ? -1 : b.state === "active" ? 1 : a.number - b.number))
      .map((s) => ({ id: s.id, sprint: s as Sprint | null, tasks: bySprint.get(s.id) ?? [] }));
    list.push({ id: BACKLOG, sprint: null, tasks: q.data.backlog });
    return list;
  }, [q.data, sprints]);

  const taskById = useMemo(() => new Map(sections.flatMap((s) => s.tasks.map((t) => [t.id, t] as const))), [sections]);
  const serverCols: Cols = useMemo(() => Object.fromEntries(sections.map((s) => [s.id, s.tasks.map((t) => t.id)])), [sections]);
  const cols = drag?.cols ?? serverCols;
  const userById = useMemo(() => new Map(members.map((m) => [m.userId, m.user])), [members]);
  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);

  const containerOf = (id: string, c: Cols) => (id.startsWith("sec:") ? id.slice(4) : Object.keys(c).find((k) => c[k]!.includes(id)) ?? null);

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    const a = String(active.id);
    const o = String(over.id);
    if (a === o) return;
    const now = performance.now();
    setDrag((d) => {
      if (!d) return d;
      const from = containerOf(a, d.cols);
      const to = containerOf(o, d.cols);
      if (!from || !to || from === to || now - lastSwitch.current < 80) return d;
      lastSwitch.current = now;
      const target = d.cols[to]!.filter((x) => x !== a);
      const idx = o.startsWith("sec:") ? target.length : Math.max(0, target.indexOf(o));
      target.splice(idx, 0, a);
      return { ...d, cols: { ...d.cols, [from]: d.cols[from]!.filter((x) => x !== a), [to]: target } };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const state = drag;
    setDrag(null);
    if (!state || !over) return;
    const id = String(active.id);
    const task = taskById.get(id);
    const to = containerOf(String(over.id), state.cols);
    if (!task || !to) return;
    let list = state.cols[to]!;
    const from = list.indexOf(id);
    const overIdx = String(over.id).startsWith("sec:") ? list.length - 1 : list.indexOf(String(over.id));
    if (from !== -1 && overIdx !== -1 && from !== overIdx) list = arrayMove(list, from, overIdx);
    const i = list.indexOf(id);
    const targetSprint = to === BACKLOG ? null : to;
    if ((task.sprintId ?? BACKLOG) === to && serverCols[to]?.indexOf(id) === i) return;
    const prev = i > 0 ? taskById.get(list[i - 1]!) : undefined;
    const next = i < list.length - 1 ? taskById.get(list[i + 1]!) : undefined;
    let position: string;
    try {
      position = keyBetween(prev?.position ?? null, next?.position ?? null);
    } catch {
      position = keyBetween(prev?.position ?? null, null);
    }
    move.mutate({ task, move: { sprintId: targetSprint, position } });
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const open = (t: Task, el: HTMLElement) => {
    rememberOrigin(t.key, el);
    pushUrl(withTaskParam(pathname, search.toString(), t.key));
  };

  const activeSprint = sprints.find((s) => s.state === "active");

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-8 pb-16 pt-6 max-[760px]:px-3">
      {canCreate && (
        <TopBarActions>
          <Button size="sm" variant="primary" kbd="C" onClick={() => shell.openCreateTask({ projectId: project.id, sprintId: null })}>
            <Plus size={14} aria-hidden /> New task
          </Button>
        </TopBarActions>
      )}
      <div className="flex items-center gap-3">
        <h1 className="m-0 text-h3">Backlog</h1>
        <span className="text-meta text-fg-3">Drag tasks between the backlog and sprints to plan.</span>
        <span className="flex-1" />
        {canSprint && (
          <Button size="sm" loading={createSprint.isPending} onClick={() => createSprint.mutate()}>
            <Plus size={13} aria-hidden /> Create sprint
          </Button>
        )}
      </div>
      {q.isPending ? (
        <div aria-busy="true" aria-label="Loading backlog" className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-40 rounded-lg" />
          ))}
        </div>
      ) : q.isError ? (
        <ErrorState title="Couldn’t load the backlog" body={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={(e) => setDrag({ id: String(e.active.id), cols: structuredClone(serverCols) })}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDrag(null)}
          accessibility={{
            screenReaderInstructions: { draggable: "Press Space to pick up a task, use the arrow keys to move it between the backlog and sprints, then Space to drop." },
            announcements: {
              onDragStart: ({ active }) => `Picked up ${taskById.get(String(active.id))?.key}.`,
              onDragOver: ({ active, over }) => (over ? `${taskById.get(String(active.id))?.key} is over ${sectionName(containerOf(String(over.id), drag?.cols ?? serverCols), sprints)}.` : undefined),
              onDragEnd: ({ active, over }) => (over ? `${taskById.get(String(active.id))?.key} moved to ${sectionName(containerOf(String(over.id), drag?.cols ?? serverCols), sprints)}.` : "Dropped."),
              onDragCancel: () => "Move cancelled.",
            },
          }}
        >
          {sections.map((s) => (
            <Section
              key={s.id}
              id={s.id}
              sprint={s.sprint}
              ids={cols[s.id] ?? []}
              taskById={taskById}
              userById={userById}
              statusById={statusById}
              collapsed={collapsed.has(s.id)}
              onToggle={() => setCollapsed((c) => {
                const n = new Set(c);
                if (n.has(s.id)) n.delete(s.id);
                else n.add(s.id);
                return n;
              })}
              canMove={canMove}
              canSprint={canSprint}
              canCreate={canCreate}
              hasActive={Boolean(activeSprint)}
              nextSprint={sprints.filter((x) => x.state === "planned").sort((a, b) => a.number - b.number)[0]}
              statuses={statuses}
              onOpen={open}
              projectId={project.id}
              isTarget={Boolean(drag) && containerOf(drag!.id, drag!.cols) === s.id && containerOf(drag!.id, serverCols) !== s.id}
            />
          ))}
          <DragOverlay dropAnimation={reduced ? null : { duration: 200, easing: "cubic-bezier(.16,1,.3,1)" }}>
            {drag && taskById.get(drag.id) ? (
              <div className="-rotate-[1deg] scale-[1.02] rounded-md border border-line-2 bg-surface shadow-modal motion-reduce:rotate-0 motion-reduce:scale-100">
                <RowBody task={taskById.get(drag.id)!} status={statusById.get(taskById.get(drag.id)!.statusId)} user={userById.get(taskById.get(drag.id)!.assigneeId ?? "")} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

function sectionName(id: string | null, sprints: Sprint[]) {
  if (!id || id === BACKLOG) return "the backlog";
  return sprints.find((s) => s.id === id)?.name ?? "a sprint";
}

function Section({
  id,
  sprint,
  ids,
  taskById,
  userById,
  statusById,
  collapsed,
  onToggle,
  canMove,
  canSprint,
  canCreate,
  hasActive,
  nextSprint,
  statuses: _statuses,
  onOpen,
  projectId,
  isTarget,
}: {
  id: string;
  sprint: Sprint | null;
  ids: string[];
  taskById: Map<string, Task>;
  userById: Map<string, User>;
  statusById: Map<string, Status>;
  collapsed: boolean;
  onToggle: () => void;
  canMove: boolean;
  canSprint: boolean;
  canCreate: boolean;
  hasActive: boolean;
  nextSprint: Sprint | undefined;
  statuses: Status[];
  onOpen: (t: Task, el: HTMLElement) => void;
  projectId: string;
  isTarget: boolean;
}) {
  const { setNodeRef } = useDroppable({ id: `sec:${id}`, disabled: !canMove });
  const [dialog, setDialog] = useState<"start" | "complete" | "edit" | "delete" | null>(null);
  const tasks = ids.map((x) => taskById.get(x)).filter((t): t is Task => Boolean(t));
  const points = tasks.reduce((a, t) => a + (t.estimate ?? 0), 0);
  const openCount = tasks.filter((t) => statusById.get(t.statusId)?.category !== "done").length;

  const startReason = !sprint || sprint.state !== "planned" ? undefined : hasActive ? "Complete the active sprint first" : tasks.length === 0 ? "Add tasks to the sprint before starting it" : undefined;

  return (
    <section
      ref={setNodeRef}
      aria-label={sprint ? sprint.name : "Backlog"}
      className={cn("rounded-lg border border-line bg-surface transition-[border-color,background-color] duration-150", isTarget && "border-dashed border-accent bg-accent-s/30")}
    >
      <header className="flex flex-wrap items-center gap-2.5 border-b border-line px-3 py-2.5">
        <button type="button" aria-expanded={!collapsed} onClick={onToggle} className="flex items-center gap-2 rounded-sm px-1 py-0.5 text-[14px] font-semibold hover:bg-hover">
          <ChevronRight size={13} aria-hidden className={cn("text-fg-3 transition-transform duration-200", !collapsed && "rotate-90")} />
          {sprint ? sprint.name : "Backlog"}
        </button>
        {sprint && (
          <>
            <span className={cn("inline-flex h-5 items-center rounded-sm border px-1.5 text-[11px] font-medium", sprint.state === "active" ? "border-warn text-warn" : "border-line-2 text-fg-3")}>
              {sprint.state === "active" ? "Active" : "Planned"}
            </span>
            <span className="font-mono text-meta text-fg-3">{dateRange(sprint.startDate, sprint.endDate)}</span>
          </>
        )}
        <span className="font-mono text-meta text-fg-3">
          {tasks.length} {tasks.length === 1 ? "task" : "tasks"} · {points} pts
        </span>
        {sprint?.goal && <span className="min-w-0 flex-1 truncate text-meta text-fg-2">{sprint.goal}</span>}
        <span className="ml-auto flex items-center gap-1.5">
          {sprint && canSprint && sprint.state === "planned" && (
            <Button size="sm" variant={startReason ? "secondary" : "primary"} disabledReason={startReason} onClick={() => setDialog("start")}>
              Start sprint
            </Button>
          )}
          {sprint && canSprint && sprint.state === "active" && (
            <Button size="sm" onClick={() => setDialog("complete")}>
              Complete sprint
            </Button>
          )}
          {sprint && canSprint && (
            <Menu>
              <MenuTrigger asChild>
                <Button size="sm" variant="ghost" icon aria-label={`${sprint.name} actions`}>
                  <MoreHorizontal size={14} aria-hidden />
                </Button>
              </MenuTrigger>
              <MenuContent align="end" width={190}>
                <MenuItem onSelect={() => setDialog("edit")}>Edit sprint</MenuItem>
                {sprint.state === "planned" && (
                  <MenuItem danger onSelect={() => setDialog("delete")}>
                    Delete sprint
                  </MenuItem>
                )}
              </MenuContent>
            </Menu>
          )}
          {!sprint && canCreate && (
            <Button size="sm" variant="ghost" onClick={() => shell.openCreateTask({ projectId, sprintId: null })}>
              <Plus size={13} aria-hidden /> Add task
            </Button>
          )}
        </span>
      </header>
      {!collapsed && (
        <SortableContext id={id} items={ids} strategy={verticalListSortingStrategy}>
          <ul role="list" className="m-0 flex min-h-12 list-none flex-col p-1">
            {tasks.map((t) => (
              <SortableRow key={t.id} task={t} status={statusById.get(t.statusId)} user={userById.get(t.assigneeId ?? "")} disabled={!canMove} onOpen={onOpen} />
            ))}
            {tasks.length === 0 && (
              <li className="flex h-12 items-center justify-center rounded-md border border-dashed border-line-2 text-meta text-fg-3">
                {sprint ? (canMove ? "Drag tasks here to plan this sprint" : "No tasks in this sprint") : "The backlog is empty"}
              </li>
            )}
          </ul>
        </SortableContext>
      )}
      {sprint && dialog === "start" && <StartSprintDialog sprint={sprint} open onOpenChange={(o) => !o && setDialog(null)} />}
      {sprint && dialog === "complete" && <CompleteSprintDialog sprint={sprint} next={nextSprint} openCount={openCount} open onOpenChange={(o) => !o && setDialog(null)} />}
      {sprint && dialog === "edit" && <EditSprintDialog sprint={sprint} open onOpenChange={(o) => !o && setDialog(null)} />}
      {sprint && dialog === "delete" && <DeleteSprintDialog sprint={sprint} open onOpenChange={(o) => !o && setDialog(null)} />}
    </section>
  );
}

const RowBody = memo(function RowBody({ task, status, user }: { task: Task; status: Status | undefined; user: User | undefined }) {
  return (
    <div className="flex h-10 items-center gap-3 px-2">
      <GripVertical size={13} aria-hidden className="flex-none text-fg-3" />
      <StatusGlyph kind={status?.glyph ?? "todo"} label={status?.name} />
      <span className="w-[60px] flex-none font-mono text-[11.5px] font-medium text-fg-3">{task.key}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
      <PriorityIcon level={task.priority} bars />
      <span className="w-12 text-right font-mono text-[11px] text-fg-3">{task.estimate !== null ? `${task.estimate} pts` : "—"}</span>
      {user ? <Avatar name={user.name} hue={user.hue} size={20} /> : <span className="size-5" />}
    </div>
  );
});

function SortableRow({ task, status, user, disabled, onOpen }: { task: Task; status: Status | undefined; user: User | undefined; disabled: boolean; onOpen: (t: Task, el: HTMLElement) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, disabled, transition: { duration: 220, easing: "cubic-bezier(.16,1,.3,1)" } });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      role="button"
      aria-roledescription={disabled ? undefined : "draggable task"}
      aria-label={`Open ${task.key}: ${task.title}`}
      tabIndex={0}
      onClick={(e) => onOpen(task, e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "o") onOpen(task, e.currentTarget);
        (listeners?.onKeyDown as ((ev: typeof e) => void) | undefined)?.(e);
      }}
      className={cn("cursor-grab rounded-md outline-none hover:bg-hover focus-visible:shadow-[var(--focus-ring)] active:cursor-grabbing", isDragging && "opacity-0")}
    >
      <RowBody task={task} status={status} user={user} />
    </li>
  );
}

