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
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery } from "@tanstack/react-query";
import { Filter, ListTodo, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { StatusGlyph } from "@/components/ui/glyphs";
import { FilterPills } from "@/components/ui/tabs";
import { Segmented } from "@/components/ui/choice";
import { TopBarActions } from "@/components/shell/top-bar";
import { shell } from "@/components/shell/shell-state";
import { useMe } from "@/features/auth/session";
import { applyFilters, completeRules } from "@/features/filters/filter-model";
import { ProjectFilterBar } from "@/features/filters/project-filter-bar";
import { useFilterOptions, useUrlFilters } from "@/features/filters/use-filters";
import { useLabels, useProjectMembers } from "@/features/projects/queries";
import { useMoveTask, useUpdateTask } from "@/features/tasks/mutations";
import { rememberOrigin, triggerSpark } from "@/features/tasks/task-origin";
import { POLL_MS } from "@/features/workspace/queries";
import { api } from "@/lib/api/endpoints";
import { qk } from "@/lib/api/query-keys";
import type { Label, Status, Task, User } from "@/lib/api/types";
import { usePrefersReducedMotion } from "@/lib/hooks/use-media-query";
import { canEditTask, useCan, useCurrentProject, useCurrentWorkspace } from "@/lib/permissions/can";
import { pushUrl, routes, withTaskParam } from "@/lib/routes";
import { cn } from "@/lib/utils/cn";
import { dateRange } from "@/lib/utils/dates";
import { comparePosition, keyBetween } from "@/lib/utils/fractional-index";
import { TaskCard } from "./task-card";

type Columns = Record<string, string[]>;
type Pill = "all" | "mine" | "unassigned";

const COL_PREFIX = "col:";

export function BoardScreen() {
  const project = useCurrentProject()!;
  const ws = useCurrentWorkspace()!;
  const me = useMe();
  const pathname = usePathname();
  const search = useSearchParams();
  const openKey = search.get("task")?.toUpperCase() ?? null;
  const reduced = usePrefersReducedMotion();
  const canMove = useCan("task.move");
  const canCreate = useCan("task.create");

  const [scope, setScope] = useState<"active" | "all">("active");
  const [pill, setPill] = useState<Pill>("all");
  // Field · operator · value filters live in the URL (?f=…) so a filtered board is linkable (board 30).
  const { rules, setRules, viewId } = useUrlFilters();
  const filterOpts = useFilterOptions(project.id);
  const [drag, setDrag] = useState<{ activeId: string; columns: Columns; overCol: string | null } | null>(null);
  const lastSwitch = useRef(0);

  const board = useQuery({
    queryKey: qk.board(project.id, scope),
    queryFn: () => api.board.get(project.id, scope),
    // No WebSockets: poll every 30s while visible; pause while a card is in the air.
    refetchInterval: drag ? false : POLL_MS,
    refetchIntervalInBackground: false,
  });
  const { data: members = [] } = useProjectMembers(project.id);
  const { data: labels = [] } = useLabels(project.id);
  const { data: sprint } = useQuery({
    queryKey: [...qk.sprints(project.id), "active"],
    queryFn: () => api.planning.activeSprint(project.id),
  });
  const move = useMoveTask();
  const update = useUpdateTask();

  const statuses = useMemo(() => board.data?.statuses ?? [], [board.data]);
  const columnStatuses = useMemo(() => statuses.filter((s) => s.glyph !== "backlog" && s.glyph !== "canceled"), [statuses]);
  const userById = useMemo(() => new Map(members.map((m) => [m.userId, m.user])), [members]);
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);

  const filtersActive = pill !== "all" || completeRules(rules).length > 0;
  const clearFilters = () => {
    setPill("all");
    setRules([]);
  };
  const visibleTasks = useMemo(() => {
    const all = (board.data?.tasks ?? []).filter((t) => !t.deletedAt);
    const byPill = all.filter((t) => {
      if (pill === "mine" && t.assigneeId !== me.id) return false;
      if (pill === "unassigned" && t.assigneeId) return false;
      return true;
    });
    return applyFilters(byPill, rules, filterOpts.ctx);
  }, [board.data, pill, rules, filterOpts.ctx, me.id]);
  const taskById = useMemo(() => new Map((board.data?.tasks ?? []).map((t) => [t.id, t])), [board.data]);

  const serverColumns = useMemo(() => {
    const cols: Columns = {};
    for (const s of columnStatuses) {
      cols[s.id] = visibleTasks
        .filter((t) => t.statusId === s.id)
        .sort(comparePosition)
        .map((t) => t.id);
    }
    return cols;
  }, [columnStatuses, visibleTasks]);
  const columns = drag?.columns ?? serverColumns;

  const counts = useMemo(() => {
    const all = (board.data?.tasks ?? []).filter((t) => columnStatuses.some((s) => s.id === t.statusId));
    return { all: all.length, mine: all.filter((t) => t.assigneeId === me.id).length, unassigned: all.filter((t) => !t.assigneeId).length };
  }, [board.data, columnStatuses, me.id]);

  /* ───── open / toggle ───── */

  const openTask = useCallback(
    (task: Task, el: HTMLElement) => {
      rememberOrigin(task.key, el);
      pushUrl(withTaskParam(pathname, search.toString(), task.key));
    },
    [pathname, search],
  );

  const toggleDone = useCallback(
    (task: Task) => {
      const cur = statuses.find((s) => s.id === task.statusId);
      const target = cur?.category === "done" ? statuses.find((s) => s.glyph === "todo") : statuses.find((s) => s.glyph === "done");
      if (!target) return;
      if (target.glyph === "done") triggerSpark(task.id);
      update.mutate({ task, patch: { statusId: target.id }, statuses });
    },
    [statuses, update],
  );

  /* ───── drag and drop ───── */

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const containerOf = (id: string, cols: Columns) => {
    if (id.startsWith(COL_PREFIX)) return id.slice(COL_PREFIX.length);
    return Object.keys(cols).find((c) => cols[c]!.includes(id)) ?? null;
  };

  const onDragStart = (e: DragStartEvent) => {
    setDrag({ activeId: String(e.active.id), columns: structuredClone(serverColumns), overCol: containerOf(String(e.active.id), serverColumns) });
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;
    // Re-parenting changes layout, which can immediately report a new "over" in the old column.
    // Throttle container switches so the card can't oscillate between columns (dnd-kit #900).
    const now = performance.now();
    setDrag((d) => {
      if (!d) return d;
      const from = containerOf(activeId, d.columns);
      const to = containerOf(overId, d.columns);
      if (!from || !to) return d;
      if (from === to) return d.overCol === to ? d : { ...d, overCol: to };
      if (now - lastSwitch.current < 80) return d;
      lastSwitch.current = now;
      const target = d.columns[to]!.filter((x) => x !== activeId);
      const overIndex = overId.startsWith(COL_PREFIX) ? target.length : Math.max(0, target.indexOf(overId));
      target.splice(overIndex, 0, activeId);
      return { ...d, columns: { ...d.columns, [from]: d.columns[from]!.filter((x) => x !== activeId), [to]: target }, overCol: to };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const state = drag;
    setDrag(null);
    if (!state || !over) return;
    const activeId = String(active.id);
    const task = taskById.get(activeId);
    if (!task) return;
    let cols = state.columns;
    const to = containerOf(String(over.id), cols);
    if (!to) return;
    const list = cols[to]!;
    const oldIndex = list.indexOf(activeId);
    const overIndex = String(over.id).startsWith(COL_PREFIX) ? list.length - 1 : list.indexOf(String(over.id));
    if (oldIndex !== -1 && overIndex !== -1 && oldIndex !== overIndex) {
      cols = { ...cols, [to]: arrayMove(list, oldIndex, overIndex) };
    }
    const finalList = cols[to]!;
    const idx = finalList.indexOf(activeId);
    const prev = idx > 0 ? taskById.get(finalList[idx - 1]!) : undefined;
    const nextT = idx < finalList.length - 1 ? taskById.get(finalList[idx + 1]!) : undefined;
    const sameSpot = task.statusId === to && serverColumns[to]?.indexOf(activeId) === idx;
    if (sameSpot) return;
    let position: string;
    try {
      position = keyBetween(prev?.position ?? null, nextT?.position ?? null);
    } catch {
      position = keyBetween(prev?.position ?? null, null);
    }
    const toStatus = statuses.find((s) => s.id === to);
    if (toStatus?.glyph === "done" && task.statusId !== to) triggerSpark(task.id);
    move.mutate({ task, move: { statusId: to !== task.statusId ? to : undefined, position } });
  };

  const statusName = (id: string | null) => statuses.find((s) => s.id === id)?.name ?? "";
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${taskById.get(String(active.id))?.key}. Use the arrow keys to move it, Space to drop, Escape to cancel.`,
    onDragOver: ({ active, over }) => {
      if (!over || !drag) return undefined;
      const col = containerOf(String(over.id), drag.columns);
      const pos = col ? drag.columns[col]!.indexOf(String(active.id)) + 1 : 0;
      return `${taskById.get(String(active.id))?.key} is in ${statusName(col)}, position ${pos} of ${col ? drag.columns[col]!.length : 0}.`;
    },
    onDragEnd: ({ active, over }) => (over ? `${taskById.get(String(active.id))?.key} dropped in ${statusName(containerOf(String(over.id), drag?.columns ?? serverColumns))}.` : "Dropped."),
    onDragCancel: ({ active }) => `Moving ${taskById.get(String(active.id))?.key} was cancelled.`,
  };

  const dropAnimation: DropAnimation | null = reduced ? null : { duration: 200, easing: "cubic-bezier(.16,1,.3,1)" };

  const activeTask = drag ? taskById.get(drag.activeId) : undefined;

  /* ───── render ───── */

  const shownCount = visibleTasks.filter((t) => columnStatuses.some((s) => s.id === t.statusId)).length;
  const toolbar = (
    <ProjectFilterBar
      slug={ws.slug}
      project={project}
      layout="board"
      rules={rules}
      setRules={setRules}
      viewId={viewId}
      opts={filterOpts}
      count={board.isPending ? null : shownCount}
      className="border-b-0 px-5 pt-3 max-[760px]:px-3"
      leading={
        <>
          {sprint !== undefined && (
            <Segmented
              label="Board scope"
              value={scope}
              onChange={setScope}
              options={[
                { value: "active", label: sprint ? `${sprint.name} · ${dateRange(sprint.startDate, sprint.endDate)}` : "Active sprint" },
                { value: "all", label: "All open" },
              ]}
            />
          )}
          <FilterPills
            label="Task filter"
            value={pill}
            onChange={setPill}
            items={[
              { value: "all", label: "All", count: counts.all },
              { value: "mine", label: "Mine", count: counts.mine },
              { value: "unassigned", label: "Unassigned", count: counts.unassigned },
            ]}
          />
          <span aria-hidden className="mx-1 h-5 w-px flex-none bg-line max-[760px]:hidden" />
        </>
      }
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {canCreate && (
        <TopBarActions>
          <Button size="sm" variant="primary" kbd="C" onClick={() => shell.openCreateTask({ projectId: project.id })}>
            <Plus size={14} aria-hidden /> New task
          </Button>
        </TopBarActions>
      )}
      {toolbar}
      {board.isPending ? (
        <BoardSkeleton />
      ) : board.isError ? (
        <div className="p-5">
          <ErrorState title="Couldn’t load the board" body="The request failed. Your changes are safe." refId={undefined} onRetry={() => void board.refetch()} />
        </div>
      ) : visibleTasks.length === 0 && !drag ? (
        <div className="flex flex-1 items-start justify-center px-6 py-16">
          {filtersActive ? (
            <EmptyState
              align="center"
              icon={<Filter size={20} aria-hidden />}
              title="No matching tasks"
              body="Nothing on this board matches the current filters."
              actions={
                <Button kbd="⇧F" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              align="center"
              icon={<ListTodo size={20} aria-hidden />}
              title={scope === "active" && sprint ? `No tasks in ${sprint.name}` : "No tasks yet"}
              body={scope === "active" && sprint ? "Pull work in from the backlog, or create a task." : "Create the first task for this project."}
              actions={
                <>
                  {canCreate && (
                    <Button variant="primary" kbd="C" onClick={() => shell.openCreateTask({ projectId: project.id })}>
                      New task
                    </Button>
                  )}
                  <Button variant="ghost" asChild>
                    <Link href={routes.project(ws.slug, project.key, "backlog")}>Open backlog</Link>
                  </Button>
                </>
              }
            />
          )}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDrag(null)}
          accessibility={{
            announcements,
            screenReaderInstructions: {
              draggable: "To move a card, press Space or Enter, use the arrow keys, then press Space to drop. Press O to open it.",
            },
          }}
        >
          <div
            role="region"
            aria-label={`${project.name} board`}
            className="flex min-h-0 flex-1 items-start gap-3.5 overflow-x-auto px-5 pb-6 pt-3 max-[760px]:snap-x max-[760px]:snap-mandatory max-[760px]:px-3"
          >
            {columnStatuses.map((s) => (
              <BoardColumn
                key={s.id}
                status={s}
                ids={columns[s.id] ?? []}
                taskById={taskById}
                userById={userById}
                labelById={labelById}
                openKey={openKey}
                canMove={canMove}
                canCreate={canCreate}
                isTarget={Boolean(drag && drag.overCol === s.id)}
                onOpen={openTask}
                onToggleDone={toggleDone}
                canToggleFor={(t) => canMove || canEditTask(t, project.my_permissions, me.id)}
                onAdd={() => shell.openCreateTask({ projectId: project.id, statusId: s.id })}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={dropAnimation}>
            {activeTask ? (
              <TaskCard
                task={activeTask}
                status={statuses.find((x) => x.id === activeTask.statusId)}
                assignee={activeTask.assigneeId ? userById.get(activeTask.assigneeId) ?? null : null}
                labels={activeTask.labelIds.map((id) => labelById.get(id)).filter((l): l is Label => Boolean(l))}
                overlay
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}

const BoardColumn = memo(function BoardColumn({
  status,
  ids,
  taskById,
  userById,
  labelById,
  openKey,
  canMove,
  canCreate,
  isTarget,
  onOpen,
  onToggleDone,
  canToggleFor,
  onAdd,
}: {
  status: Status;
  ids: string[];
  taskById: Map<string, Task>;
  userById: Map<string, User>;
  labelById: Map<string, Label>;
  openKey: string | null;
  canMove: boolean;
  canCreate: boolean;
  isTarget: boolean;
  onOpen: (t: Task, el: HTMLElement) => void;
  onToggleDone: (t: Task) => void;
  canToggleFor: (t: Task) => boolean;
  onAdd: () => void;
}) {
  const { setNodeRef } = useDroppable({ id: `${COL_PREFIX}${status.id}`, disabled: !canMove });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${status.name}, ${ids.length} ${ids.length === 1 ? "task" : "tasks"}`}
      className={cn(
        "group/col flex w-[272px] flex-none flex-col gap-2 rounded-lg border border-transparent p-1 transition-[background-color,border-color] duration-150 max-[760px]:w-[85vw] max-[760px]:snap-start",
        isTarget && "border-dashed border-accent bg-accent-s/40",
      )}
    >
      <header className="flex h-[30px] items-center gap-2 px-1 font-semibold">
        <StatusGlyph kind={status.glyph} color={status.color ?? undefined} />
        <h2 className="m-0 text-[13px] font-semibold">{status.name}</h2>
        <span className="font-mono text-[11px] font-normal text-fg-3">{ids.length}</span>
        {canCreate && (
          <button
            type="button"
            onClick={onAdd}
            aria-label={`Add task to ${status.name}`}
            className="ml-auto flex size-[26px] items-center justify-center rounded-sm text-fg-3 opacity-0 transition-opacity hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover/col:opacity-100 max-[1023px]:opacity-100"
          >
            <Plus size={13} aria-hidden />
          </button>
        )}
      </header>
      <SortableContext id={status.id} items={ids} strategy={verticalListSortingStrategy}>
        <ul role="list" className="m-0 flex min-h-[92px] list-none flex-col gap-2 p-0">
          {ids.map((id) => {
            const t = taskById.get(id);
            if (!t) return null;
            return (
              <SortableCard
                key={id}
                task={t}
                status={status}
                assignee={t.assigneeId ? userById.get(t.assigneeId) ?? null : null}
                labels={t.labelIds.map((l) => labelById.get(l)).filter((l): l is Label => Boolean(l))}
                selected={openKey === t.key}
                disabled={!canMove}
                canToggle={canToggleFor(t)}
                onOpen={onOpen}
                onToggleDone={onToggleDone}
              />
            );
          })}
          {ids.length === 0 && (
            <li className="flex min-h-[92px] items-center justify-center rounded-md border-[1.5px] border-dashed border-line-2 text-[12px] text-fg-3">
              {canMove ? "Drop tasks here" : "No tasks"}
            </li>
          )}
        </ul>
      </SortableContext>
    </section>
  );
});

function SortableCard({
  task,
  status,
  assignee,
  labels,
  selected,
  disabled,
  canToggle,
  onOpen,
  onToggleDone,
}: {
  task: Task;
  status: Status;
  assignee: User | null;
  labels: Label[];
  selected: boolean;
  disabled: boolean;
  canToggle: boolean;
  onOpen: (t: Task, el: HTMLElement) => void;
  onToggleDone: (t: Task) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled,
    transition: { duration: 220, easing: "cubic-bezier(.16,1,.3,1)" },
  });
  return (
    <li className="list-none">
      <TaskCard
        task={task}
        status={status}
        assignee={assignee}
        labels={labels}
        selected={selected}
        dragging={isDragging}
        canToggle={canToggle}
        onOpen={onOpen}
        onToggleDone={onToggleDone}
        cardRef={setNodeRef}
        style={{ transform: CSS.Translate.toString(transform), transition }}
        dragHandleProps={{ ...attributes, ...listeners, "aria-roledescription": disabled ? undefined : "draggable task card" }}
      />
    </li>
  );
}

function BoardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading board" className="flex gap-3.5 overflow-hidden px-5 pt-3">
      {[3, 2, 2, 1].map((n, c) => (
        <div key={c} className="flex w-[272px] flex-none flex-col gap-2 p-1">
          <div className="flex h-[30px] items-center gap-2 px-1">
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-2.5 w-20" />
          </div>
          {Array.from({ length: n }, (_, i) => (
            <div key={i} className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3">
              <div className="flex justify-between">
                <Skeleton className="h-2.5 w-12" />
                <Skeleton className="size-5 rounded-full" />
              </div>
              <Skeleton className="h-2.5 w-[85%]" />
              <Skeleton className="h-2.5 w-[55%]" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

