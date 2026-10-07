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
