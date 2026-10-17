"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/ui/toast";
import { api } from "@/api/endpoints";
import { errorMessage, isConflict } from "@/api/errors";
import { commitTask, insertTask, patchTasks, restore, snapshotTasks } from "@/api/optimistic";
import { qk } from "@/api/query-keys";
import type { ChecklistItem, ChecklistItemPatch, Status, Task, TaskCreate, TaskDetail, TaskMove, TaskPatch } from "@/api/types";
import { comparePosition } from "@/lib/utils/fractional-index";

/*
 * Task mutations. "Speed is the brand": the UI changes at 0ms; on failure the cache rolls back
 * and a toast explains; on a version conflict the card refetches and we say so.
 */

export function conflictToast() {
  toast({
    id: "conflict",
    tone: "warning",
    title: "Someone else changed this card",
    body: "We reloaded it with their changes. Try again.",
  });
}

function failToast(task: Pick<Task, "key">, e: unknown, retry?: () => void) {
  if (isConflict(e)) return conflictToast();
  toast({
    tone: "error",
    title: `Couldn’t save ${task.key}`,
    body: `${errorMessage(e)} Reverted.`,
    action: retry ? { label: "Retry", key: "R", onClick: retry } : undefined,
  });
}

function invalidateTaskViews(qc: ReturnType<typeof useQueryClient>, projectId: string) {
  void qc.invalidateQueries({ queryKey: qk.scope(projectId) });
  void qc.invalidateQueries({ queryKey: ["task"] });
  void qc.invalidateQueries({ queryKey: ["workspace"], predicate: (q) => q.queryKey.includes("my-tasks") });
}

type UpdateVars = { task: Task; patch: TaskPatch; statuses?: Status[] };

export function useUpdateTask() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: ({ task, patch }: UpdateVars) => api.tasks.update(task.id, patch, task.version),
    onMutate: async ({ task, patch, statuses }) => {
      const snap = await snapshotTasks(qc, task.projectId);
      patchTasks(
        qc,
        (t) => {
          if (t.id !== task.id) return t;
          const next = { ...t, ...patch } as Task;
          // Board 39: customFields is a merge (null clears a key), not a replacement.
          if (patch.customFields) {
            const merged = { ...(t.customFields ?? {}) };
            for (const [k, v] of Object.entries(patch.customFields)) {
              if (v === null) delete merged[k];
              else merged[k] = v;
            }
            next.customFields = merged;
          }
          if (patch.statusId && statuses) {
            const s = statuses.find((x) => x.id === patch.statusId);
            next.completedAt = s?.category === "done" && s.glyph !== "canceled" ? (t.completedAt ?? new Date().toISOString()) : null;
          }
          return next;
        },
        task.projectId,
      );
      return { snap };
    },
    onError: (e, vars, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      failToast(vars.task, e, () => m.mutate(vars));
      if (isConflict(e)) invalidateTaskViews(qc, vars.task.projectId);
    },
    onSuccess: (server) => commitTask(qc, server),
    onSettled: (_d, _e, vars) => {
      // Progress (sprints, objectives, milestones) and summaries derive from tasks.
      void qc.invalidateQueries({ queryKey: qk.sprints(vars.task.projectId) });
      void qc.invalidateQueries({ queryKey: qk.objectives(vars.task.projectId) });
      void qc.invalidateQueries({ queryKey: qk.milestones(vars.task.projectId) });
      void qc.invalidateQueries({ queryKey: qk.summary(vars.task.projectId) });
      void qc.invalidateQueries({ queryKey: qk.activity(vars.task.projectId) });
      // Board 39: values feed the field's "N tasks" count.
      if (vars.patch.customFields) void qc.invalidateQueries({ queryKey: qk.customFields(vars.task.projectId) });
    },
  });
  return m;
}

type MoveVars = { task: Task; move: Omit<TaskMove, "version"> };

type BacklogData = { sprints: { sprintId: string; tasks: Task[] }[]; backlog: Task[] };

/** Insert keeping the list ordered by fractional position (plain string compare, as the server does). */
function insertByPosition(list: Task[], task: Task): Task[] {
  const i = list.findIndex((t) => t.position > task.position);
  return i === -1 ? [...list, task] : [...list.slice(0, i), task, ...list.slice(i)];
}

/**
 * Moves a task between the backlog's sections (sprint ↔ backlog, or a reorder) so a drop stays where
 * it landed. patchTasks only edits a task in place, which would leave it in its old section.
 */
export function moveInBacklog(data: BacklogData, taskId: string, move: Omit<TaskMove, "version">): BacklogData {
  const current = data.backlog.find((t) => t.id === taskId) ?? data.sprints.flatMap((s) => s.tasks).find((t) => t.id === taskId);
  if (!current) return data;
  const sprintId = move.sprintId !== undefined ? move.sprintId : current.sprintId;
  const moved: Task = { ...current, position: move.position, sprintId, ...(move.statusId ? { statusId: move.statusId } : {}) };
  const without = (list: Task[]) => list.filter((t) => t.id !== taskId);
  return {
    ...data,
    sprints: data.sprints.map((s) => {
      const rest = without(s.tasks);
      return { ...s, tasks: s.sprintId === sprintId ? insertByPosition(rest, moved) : rest };
    }),
    // A sprint the cache doesn't list (e.g. completed) can't show the task; it just leaves the backlog.
    backlog: sprintId ? without(data.backlog) : insertByPosition(without(data.backlog), moved),
  };
}

/** Board / backlog move: status, sprint and fractional position, with version. */
export function useMoveTask() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: ({ task, move }: MoveVars) => api.board.move(task.id, { ...move, version: task.version }),
    onMutate: async ({ task, move }) => {
      const snap = await snapshotTasks(qc, task.projectId);
      patchTasks(
        qc,
        (t) =>
          t.id === task.id
            ? {
                ...t,
                position: move.position,
                ...(move.statusId ? { statusId: move.statusId } : {}),
                ...(move.sprintId !== undefined ? { sprintId: move.sprintId } : {}),
              }
            : t,
        task.projectId,
      );
      // The snapshot above already holds the backlog (it lives under ["p", projectId]), so restore() rolls this back too.
      qc.setQueryData<BacklogData>(qk.backlog(task.projectId), (old) => (old ? moveInBacklog(old, task.id, move) : old));
      return { snap };
    },
    onError: (e, vars, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      failToast(vars.task, e, () => m.mutate(vars));
      if (isConflict(e)) invalidateTaskViews(qc, vars.task.projectId);
    },
    onSuccess: (server) => commitTask(qc, server),
    onSettled: (_d, _e, vars) => {
      void qc.invalidateQueries({ queryKey: qk.backlog(vars.task.projectId) });
      void qc.invalidateQueries({ queryKey: qk.sprints(vars.task.projectId) });
      void qc.invalidateQueries({ queryKey: qk.summary(vars.task.projectId) });
    },
  });
  return m;
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, body }: { projectId: string; body: TaskCreate }) => api.tasks.create(projectId, body),
    onSuccess: (task) => {
      // Show the task at once; the invalidation below then reloads every list from the server.
      insertTask(qc, task);
      invalidateTaskViews(qc, task.projectId);
    },
  });
}

/** Soft delete with a 5s Undo toast that restores. */
export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (task: Task) => api.tasks.remove(task.id),
    onMutate: async (task) => {
      const snap = await snapshotTasks(qc, task.projectId);
      patchTasks(qc, (t) => (t.id === task.id ? null : t), task.projectId);
      return { snap };
    },
    onError: (e, task, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      failToast(task, e);
    },
    onSuccess: (_d, task) => {
      toast({
        title: `Deleted ${task.key}`,
        body: "Restorable for 30 days.",
        tone: "info",
        action: {
          label: "Undo",
          key: "Z",
          onClick: async () => {
            try {
              await api.tasks.restore(task.id);
              toast.success(`Restored ${task.key}`);
            } catch (e) {
              toast.error(`Couldn’t restore ${task.key}`, { body: errorMessage(e) });
            }
            invalidateTaskViews(qc, task.projectId);
          },
        },
      });
    },
    onSettled: (_d, _e, task) => invalidateTaskViews(qc, task.projectId),
  });
}

/* ───────── checklist (docs/tracking/checklist-assignees.md §2) ───────── */

type ChecklistTask = Pick<TaskDetail, "id" | "key" | "projectId">;

const checklistCounts = (items: ChecklistItem[]) => ({ checklistCount: items.length, checklistDoneCount: items.filter((i) => i.done).length });

/** Applies `fn` to the cached detail's checklist (position order kept) and the x/y counts on every cached copy. */
function patchChecklist(qc: ReturnType<typeof useQueryClient>, task: ChecklistTask, fn: (items: ChecklistItem[]) => ChecklistItem[]) {
  let counts: ReturnType<typeof checklistCounts> | null = null;
  qc.setQueriesData({ queryKey: ["task"] }, (old: unknown) => {
    const d = old as TaskDetail | undefined;
    if (!d || typeof d !== "object" || d.id !== task.id || !Array.isArray(d.checklist)) return old;
    const checklist = [...fn(d.checklist)].sort(comparePosition);
    counts = checklistCounts(checklist);
    return { ...d, checklist, ...counts };
  });
  const c = counts as ReturnType<typeof checklistCounts> | null;
  if (c) patchTasks(qc, (t) => (t.id === task.id ? { ...t, ...c } : t), task.projectId);
}

function checklistFail(task: ChecklistTask, what: string, e: unknown, retry: () => void) {
  toast({ tone: "error", title: `Couldn’t ${what} on ${task.key}`, body: `${errorMessage(e)} Reverted.`, action: { label: "Retry", key: "R", onClick: retry } });
}

/**
 * Checklist writes, optimistic with rollback + toast. They don't bump the task's `version`, so nothing else
 * on the task conflicts; the server's item replaces the optimistic one.
 */
export function useChecklistMutations(task: ChecklistTask) {
  const qc = useQueryClient();
  // After a failure, refetch the detail (the server may hold something else now, e.g. another tab's edit).
  const settle = () => {
    void qc.invalidateQueries({ queryKey: ["task"], predicate: (q) => (q.state.data as { id?: string } | undefined)?.id === task.id });
  };
  const add = useMutation({
    mutationFn: ({ text, position }: { tempId: string; text: string; position: string }) => api.tasks.checklist.add(task.id, { text, position }),
    onMutate: async ({ tempId, text, position }) => {
      const snap = await snapshotTasks(qc, task.projectId);
      const now = new Date().toISOString();
      patchChecklist(qc, task, (items) => [
        ...items,
        { id: tempId, taskId: task.id, text, done: false, position, doneAt: null, doneById: null, createdAt: now, createdById: null },
      ]);
      return { snap };
    },
    onError: (e, vars, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      settle();
      checklistFail(task, "add the item", e, () => add.mutate(vars));
    },
    onSuccess: (item, vars) => patchChecklist(qc, task, (items) => items.map((i) => (i.id === vars.tempId ? item : i))),
  });
  const update = useMutation({
    mutationFn: ({ item, patch }: { item: ChecklistItem; patch: ChecklistItemPatch }) => api.tasks.checklist.update(task.id, item.id, patch),
    onMutate: async ({ item, patch }) => {
      const snap = await snapshotTasks(qc, task.projectId);
      patchChecklist(qc, task, (items) =>
        items.map((i) =>
          i.id === item.id
            ? { ...i, ...patch, ...(patch.done !== undefined ? { doneAt: patch.done ? new Date().toISOString() : null } : {}) }
            : i,
        ),
      );
      return { snap };
    },
    onError: (e, vars, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      settle();
      checklistFail(task, "save the checklist", e, () => update.mutate(vars));
    },
    onSuccess: (item) => patchChecklist(qc, task, (items) => items.map((i) => (i.id === item.id ? item : i))),
  });
  const remove = useMutation({
    mutationFn: (item: ChecklistItem) => api.tasks.checklist.remove(task.id, item.id),
    onMutate: async (item) => {
      const snap = await snapshotTasks(qc, task.projectId);
      patchChecklist(qc, task, (items) => items.filter((i) => i.id !== item.id));
      return { snap };
    },
    onError: (e, item, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      settle();
      checklistFail(task, "delete the item", e, () => remove.mutate(item));
    },
  });
  return { add, update, remove };
}
