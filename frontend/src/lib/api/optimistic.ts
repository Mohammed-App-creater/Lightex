import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { Task } from "./types";

/*
 * Optimistic cache helpers. A task can appear in many caches (board, backlog, list,
 * my tasks, task detail, sub-task lists). These walk every cached shape and patch the
 * task in place, return a snapshot for rollback, and restore it on failure.
 */

export type Snapshot = [QueryKey, unknown][];

type TaskFn = (t: Task) => Task | null;

function isTask(x: unknown): x is Task {
  return !!x && typeof x === "object" && "id" in x && "key" in x && "statusId" in x && "version" in x;
}

function mapList(list: unknown[], fn: TaskFn): unknown[] {
  let changed = false;
  const out: unknown[] = [];
  for (const item of list) {
    if (isTask(item)) {
      const next = fn(item);
      if (next !== item) changed = true;
      if (next) out.push(next);
    } else out.push(item);
  }
  return changed ? out : list;
}

/** Applies fn to every task inside any known response shape. Returns the same object if unchanged. */
export function mapTasksIn(data: unknown, fn: TaskFn): unknown {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data)) return mapList(data, fn);
  const d = data as Record<string, unknown>;
  // TaskDetail: the task itself (+ its sub-tasks)
  if (isTask(d)) {
    const self = fn(d as unknown as Task);
    const subs = Array.isArray(d.subtasks) ? mapList(d.subtasks, fn) : d.subtasks;
    if (self === null) return { ...d, deletedAt: new Date().toISOString() };
    if (self === d && subs === d.subtasks) return d;
    return { ...self, subtasks: subs };
  }
  let changed = false;
  const next: Record<string, unknown> = { ...d };
  for (const k of ["data", "tasks", "backlog"]) {
    if (Array.isArray(d[k])) {
      const m = mapList(d[k] as unknown[], fn);
      if (m !== d[k]) {
        next[k] = m;
        changed = true;
      }
    }
  }
  if (Array.isArray(d.sprints)) {
    const sprints = (d.sprints as { tasks?: unknown[] }[]).map((s) => {
      if (!Array.isArray(s.tasks)) return s;
      const m = mapList(s.tasks, fn);
      return m === s.tasks ? s : { ...s, tasks: m };
    });
    if (sprints.some((s, i) => s !== (d.sprints as unknown[])[i])) {
      next.sprints = sprints;
      changed = true;
    }
  }
  return changed ? next : data;
}

/** Query-key prefixes that can contain tasks. */
export function taskCachePrefixes(projectId?: string): QueryKey[] {
  return [projectId ? ["p", projectId] : ["p"], ["task"], ["workspace"]];
}

export async function snapshotTasks(qc: QueryClient, projectId?: string): Promise<Snapshot> {
  const prefixes = taskCachePrefixes(projectId);
  await Promise.all(prefixes.map((queryKey) => qc.cancelQueries({ queryKey })));
  return prefixes.flatMap((queryKey) => qc.getQueriesData({ queryKey }));
}

export function patchTasks(qc: QueryClient, fn: TaskFn, projectId?: string) {
  for (const queryKey of taskCachePrefixes(projectId)) {
    qc.setQueriesData({ queryKey }, (old: unknown) => mapTasksIn(old, fn));
  }
}

export function restore(qc: QueryClient, snap: Snapshot) {
  for (const [key, data] of snap) qc.setQueryData(key, data);
}

/** Replace a task everywhere with the server's copy (new version, derived fields). */
export function commitTask(qc: QueryClient, server: Task) {
  patchTasks(qc, (t) => (t.id === server.id ? { ...t, ...server } : t), server.projectId);
}

type BoardShape = { statuses?: { id: string; category?: string }[]; tasks: unknown[]; sprintId?: string | null };
type BacklogShape = { sprints: { sprintId: string; tasks: unknown[] }[]; backlog: unknown[] };

function has(list: unknown[], id: string) {
  return list.some((t) => isTask(t) && t.id === id);
}

/**
 * Puts a freshly created task into every cached list for its project (task lists, the board,
 * the backlog) so it is on screen at once. The refetch that follows replaces it with the
 * server's ordering; this only covers the gap when that refetch is slow or fails.
 */
export function insertTask(qc: QueryClient, task: Task) {
  if (task.parentId) return; // sub-tasks live on the parent's detail, which is refetched
  qc.setQueriesData({ queryKey: ["p", task.projectId] }, (old: unknown) => {
    if (!old || typeof old !== "object" || Array.isArray(old)) return old;
    const d = old as Record<string, unknown>;
    // Paginated task list: { data: Task[] }
    if (Array.isArray(d.data) && (d.data.length === 0 || isTask(d.data[0]))) {
      return has(d.data, task.id) ? old : { ...d, data: [...d.data, task], total: typeof d.total === "number" ? d.total + 1 : d.total };
    }
    // Board: { statuses, tasks, sprintId }. A sprint board shows its sprint; the no-sprint board
    // shows everything whose status is not a backlog status.
    if (Array.isArray(d.tasks) && Array.isArray(d.statuses)) {
      const b = d as BoardShape;
      const category = b.statuses?.find((s) => s.id === task.statusId)?.category;
      const fits = b.sprintId ? task.sprintId === b.sprintId : category !== "backlog";
      if (!fits || has(b.tasks, task.id)) return old;
      return { ...b, tasks: [...b.tasks, task] };
    }
    // Backlog: { sprints: [{ sprintId, tasks }], backlog }
    if (Array.isArray(d.backlog) && Array.isArray(d.sprints)) {
      const b = d as BacklogShape;
      if (has(b.backlog, task.id) || b.sprints.some((s) => has(s.tasks, task.id))) return old;
      if (task.sprintId && b.sprints.some((s) => s.sprintId === task.sprintId)) {
        return { ...b, sprints: b.sprints.map((s) => (s.sprintId === task.sprintId ? { ...s, tasks: [...s.tasks, task] } : s)) };
      }
      return task.sprintId ? old : { ...b, backlog: [...b.backlog, task] };
    }
    return old;
  });
}
