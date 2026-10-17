"use client";

import { useMutation, useMutationState, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createElement, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "@/components/ui/toast";
import { conflictToast } from "@/features/tasks/mutations";
import { api } from "@/lib/api/endpoints";
import { errorMessage, isApiError, isConflict } from "@/lib/api/errors";
import { commitTask, mapTasksIn, patchTasks, restore, snapshotTasks, type Snapshot } from "@/lib/api/optimistic";
import { qk } from "@/lib/api/query-keys";
import type { Epic, Task, TaskPatch } from "@/lib/api/types";
import { createStore } from "@/lib/utils/store";
import { changedDates, sameDates, type Dates, type DragMode } from "./schedule-lib";

/*
 * Board 32 rescheduling (§6.6). Drag frames and keyboard bursts are a local *preview* (an external
 * store keyed by task id, so a drag re-renders one bar and its arrows only). A commit is one
 * optimistic PATCH with rollback and the v1 toasts; reschedules run in order through a TanStack
 * mutation scope, and the PATCH reads `version` from the cache when it executes, so a second
 * quick commit carries the version the first one returned.
 */

/* ───────── previews ───────── */

export type Preview = { dates: Dates; mode: DragMode; source: "drag" | "key" };
const previews = createStore<Record<string, Preview>>({});
export function setPreview(id: string, p: Preview | null) {
  previews.set((all) => {
    if (!p) {
      if (!(id in all)) return all;
      const next = { ...all };
      delete next[id];
      return next;
    }
    return { ...all, [id]: p };
  });
}
export const getPreview = (id: string) => previews.get()[id];
/** The preview for one bar / chip (undefined when it shows its cached dates). */
export function usePreview(id: string) {
  return useSyncExternalStore(previews.subscribe, () => previews.get()[id], () => undefined);
}
/** Every preview (dependency arrows follow the dragged bar). */
export function usePreviews() {
  return useSyncExternalStore(previews.subscribe, previews.get, () => EMPTY);
}
const EMPTY: Record<string, Preview> = {};

/* ───────── live region ───────── */

const live = createStore({ msg: "", n: 0 });
/** Polite announcement (drops, keyboard moves, Undo). */
export function announce(msg: string) {
  live.set((s) => ({ msg, n: s.n + 1 }));
}
export function useAnnouncement() {
  return useSyncExternalStore(live.subscribe, live.get, live.get);
}

/* ───────── cache lookups ───────── */

/** The freshest cached copy of a task (highest version) across every project cache. */
export function currentTask(qc: QueryClient, id: string, projectId?: string): Task | undefined {
  let best: Task | undefined;
  const look = (t: Task) => {
    if (t.id === id && (!best || t.version >= best.version)) best = t;
    return t;
  };
  for (const key of [projectId ? ["p", projectId] : ["p"], ["task"], ["workspace"]]) {
    for (const [, data] of qc.getQueriesData({ queryKey: key })) mapTasksIn(data, look);
  }
  return best;
}

const datesOf = (t: Pick<Task, "startDate" | "dueDate">): Dates => ({ startDate: t.startDate ?? null, dueDate: t.dueDate ?? null });

/* ───────── pending markers ───────── */

type Vars = { task: Task; patch: TaskPatch; fromTray?: boolean };

/** True while a reschedule PATCH for this task is in flight (design `cl-sync` dot). */
export function useReschedulePending(taskId: string) {
  const pending = useMutationState({
    filters: { mutationKey: ["reschedule"], status: "pending", predicate: (m) => (m.state.variables as Vars | undefined)?.task.id === taskId },
    select: () => true,
  });
  return pending.length > 0;
}

/* ───────── errors (§4.6) ───────── */

function failToast(task: Task, e: unknown, retry: () => void) {
  if (isConflict(e)) return conflictToast();
  if (isApiError(e) && [403, 409, 422].includes(e.status)) {
    const field = Object.values(e.fieldErrors)[0];
    toast({ tone: "error", title: `Couldn’t save ${task.key}`, body: `${field ?? e.message} Reverted.` });
    return;
  }
  toast({ tone: "error", title: `Couldn’t save ${task.key}`, body: `${errorMessage(e)} Reverted.`, action: { label: "Retry", key: "R", onClick: retry } });
}

/* ───────── keyboard bursts (600 ms, §1.4) ───────── */

type Burst = { timer: ReturnType<typeof setTimeout>; origin: Dates; send: () => void };
const bursts = new Map<string, Burst>();
export const BURST_MS = 600;

/* ───────── the hook ───────── */

export type CommitOpts = { toast: ReactNode; announce: string; fromTray?: boolean };

export function useReschedule(projectId: string) {
  const qc = useQueryClient();

  const m = useMutation({
    mutationKey: ["reschedule"],
    // One scope per project: commits run strictly in order (so two on one task never race).
    scope: { id: `reschedule:${projectId}` },
    mutationFn: ({ task, patch }: Vars) => api.tasks.update(task.id, patch, (currentTask(qc, task.id, task.projectId) ?? task).version),
    onMutate: async ({ task, patch, fromTray }): Promise<{ snap: Snapshot }> => {
      const snap = await snapshotTasks(qc, task.projectId);
      patchTasks(qc, (t) => (t.id === task.id ? ({ ...t, ...patch } as Task) : t), task.projectId);
      // A tray task isn't in any window yet: add it so it shows at once (each view's select re-filters).
      if (fromTray) {
        const moved = { ...task, ...patch } as Task;
        qc.setQueriesData<{ data: Task[] }>({ queryKey: qk.schedules(task.projectId) }, (old) =>
          old && Array.isArray(old.data) && !old.data.some((t) => t.id === task.id) ? { ...old, data: [...old.data, moved] } : old,
        );
      }
      // The bar's preview clears in the same tick the optimistic dates land: no flicker.
      setPreview(task.id, null);
      return { snap };
    },
    onError: (e, vars, ctx) => {
      if (ctx) restore(qc, ctx.snap);
      failToast(vars.task, e, () => m.mutate(vars));
      if (isApiError(e) && e.status === 409) {
        void qc.invalidateQueries({ queryKey: qk.scope(vars.task.projectId) });
        void qc.invalidateQueries({ queryKey: ["task"] });
      }
    },
    onSuccess: (server, vars) => {
      // Another reschedule of this task is queued: keep its optimistic dates, take only the version.
      const queued = qc
        .getMutationCache()
        .findAll({ mutationKey: ["reschedule"], status: "pending" })
        .filter((x) => (x.state.variables as Vars | undefined)?.task.id === vars.task.id).length;
      if (queued > 1) patchTasks(qc, (t) => (t.id === server.id ? { ...t, version: server.version, updatedAt: server.updatedAt } : t), server.projectId);
      else commitTask(qc, server);
    },
    onSettled: (_d, _e, vars) => {
      const pid = vars.task.projectId;
      for (const key of [qk.sprints(pid), qk.objectives(pid), qk.milestones(pid), qk.summary(pid), qk.activity(pid)]) void qc.invalidateQueries({ queryKey: key });
      if (vars.fromTray) {
        void qc.invalidateQueries({ queryKey: qk.unscheduled(pid) });
        void qc.invalidateQueries({ queryKey: qk.schedules(pid) });
      }
    },
  });

  const epicM = useMutation({
    mutationFn: ({ epic, next }: { epic: Epic; next: Dates; prev: Dates }) => api.planning.updateEpic(epic.id, { startDate: next.startDate, dueDate: next.dueDate }),
    onMutate: async ({ epic, next }) => {
      await qc.cancelQueries({ queryKey: qk.epics(projectId) });
      const prev = qc.getQueryData<Epic[]>(qk.epics(projectId));
      qc.setQueryData<Epic[]>(qk.epics(projectId), (list) => list?.map((e) => (e.id === epic.id ? { ...e, ...next } : e)));
      setPreview(`epic:${epic.id}`, null);
      return { prev };
    },
    onError: (e, { epic }, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.epics(projectId), ctx.prev);
      const field = isApiError(e) ? Object.values(e.fieldErrors)[0] : undefined;
      toast({ tone: "error", title: `Couldn’t save ${epic.name}`, body: `${field ?? errorMessage(e)} Reverted.` });
    },
    onSuccess: (saved) => qc.setQueryData<Epic[]>(qk.epics(projectId), (list) => list?.map((e) => (e.id === saved.id ? saved : e))),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.epics(projectId) }),
  });

  /** Sends one PATCH with only the changed keys; nothing when the dates equal the cached ones. */
  function send(task: Task, next: Dates, fromTray?: boolean) {
    const cur = currentTask(qc, task.id, task.projectId) ?? task;
    const patch = changedDates(datesOf(cur), next);
    if (!Object.keys(patch).length) return false;
    m.mutate({ task: cur, patch, fromTray });
    return true;
  }

  function undoToast(id: string, title: ReactNode, onUndo: () => void) {
    toast({ id: `resched-${id}`, tone: "success", title, duration: 5000, action: { label: "Undo", key: "Z", onClick: onUndo } });
  }

  /** Pointer drop (or tray drop): optimistic PATCH now, toast with Undo. */
  function commit(task: Task, next: Dates, opts: CommitOpts) {
    const before = datesOf(currentTask(qc, task.id, task.projectId) ?? task);
    if (sameDates(before, next) || !send(task, next, opts.fromTray)) {
      setPreview(task.id, null);
      return;
    }
    announce(opts.announce);
    undoToast(task.id, opts.toast, () => {
      send(task, before, opts.fromTray);
      announce("Undone");
    });
  }

  /**
   * Keyboard burst: the bar moves at once (preview) and is announced; one write goes 600 ms after
   * the last key (or on blur). Undo inside the window cancels it and sends nothing.
   */
  function burst(id: string, origin0: Dates, next: Dates, mode: DragMode, opts: CommitOpts, write: (d: Dates) => boolean) {
    const prev = bursts.get(id);
    if (prev) clearTimeout(prev.timer);
    const origin = prev?.origin ?? origin0;
    setPreview(id, { dates: next, mode, source: "key" });
    announce(opts.announce);
    const fire = () => {
      bursts.delete(id);
      // Nothing to send (back where it started): drop the preview; otherwise onMutate clears it.
      if (sameDates(origin, next) || !write(next)) setPreview(id, null);
    };
    bursts.set(id, { timer: setTimeout(fire, BURST_MS), origin, send: fire });
    if (sameDates(origin, next)) {
      toast.dismiss(`resched-${id}`);
      return;
    }
    undoToast(id, opts.toast, () => {
      const b = bursts.get(id);
      if (b) {
        clearTimeout(b.timer);
        bursts.delete(id);
        setPreview(id, null);
      } else write(origin);
      announce("Undone");
    });
  }

  function nudge(task: Task, next: Dates, mode: DragMode, opts: CommitOpts) {
    burst(task.id, datesOf(currentTask(qc, task.id, task.projectId) ?? task), next, mode, opts, (d) => send(task, d));
  }

  function nudgeEpic(epic: Epic, next: Dates, mode: DragMode, opts: CommitOpts) {
    const cur = qc.getQueryData<Epic[]>(qk.epics(projectId))?.find((e) => e.id === epic.id) ?? epic;
    burst(`epic:${epic.id}`, { startDate: cur.startDate, dueDate: cur.dueDate }, next, mode, opts, (d) => {
      const now = qc.getQueryData<Epic[]>(qk.epics(projectId))?.find((e) => e.id === epic.id) ?? epic;
      if (sameDates({ startDate: now.startDate, dueDate: now.dueDate }, d)) return false;
      epicM.mutate({ epic: now, next: d, prev: { startDate: now.startDate, dueDate: now.dueDate } });
      return true;
    });
  }

  /** Blur: send a pending burst now. */
  function flush(id: string) {
    bursts.get(id)?.send();
  }
  /** Esc before the send: revert, send nothing. */
  function cancel(id: string) {
    const b = bursts.get(id);
    if (b) {
      clearTimeout(b.timer);
      bursts.delete(id);
      toast.dismiss(`resched-${id}`);
    }
    setPreview(id, null);
  }

  /** Epic bar drop / resize: both dates, last write wins (no version), same Undo toast. */
  function commitEpic(epic: Epic, next: Dates, opts: CommitOpts) {
    const prev = { startDate: epic.startDate, dueDate: epic.dueDate };
    if (sameDates(prev, next)) {
      setPreview(`epic:${epic.id}`, null);
      return;
    }
    epicM.mutate({ epic, next, prev });
    announce(opts.announce);
    undoToast(`epic:${epic.id}`, opts.toast, () => {
      epicM.mutate({ epic, next: prev, prev: next });
      announce("Undone");
    });
  }

  return { commit, nudge, nudgeEpic, flush, cancel, commitEpic };
}

export type Rescheduler = ReturnType<typeof useReschedule>;

/** "PRJ-34" in mono + text, for toast titles. */
export function keyTitle(key: string, text: string): ReactNode {
  return createElement("span", null, createElement("span", { className: "font-mono font-semibold" }, key), " ", text);
}
