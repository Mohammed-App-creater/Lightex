"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isConflict } from "@/lib/api/errors";
import { commitTask, insertTask, patchTasks, restore, snapshotTasks } from "@/lib/api/optimistic";
import { qk } from "@/lib/api/query-keys";
import type { Status, Task, TaskCreate, TaskMove, TaskPatch } from "@/lib/api/types";

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
