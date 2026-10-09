import type { BurndownPoint, ProgressRow, Status, Task, WorkloadReport, WorkloadRow } from "@/lib/api/types";
import { shortDate } from "@/features/reports/lib";

/*
 * Widget data helpers (spec §1.3). Pure; unit-tested in dashboards.test.ts.
 */

const DAY = 86_400_000;
const dayNum = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY;

/** My tasks: open by due date (no date last), then — with showDone — tasks done in the last 7 days. */
export function myTaskRows(tasks: readonly Task[], statuses: readonly Status[], showDone: boolean, today: string) {
  const cat = (t: Task) => statuses.find((s) => s.id === t.statusId);
  const isDone = (t: Task) => cat(t)?.category === "done";
  const open = tasks
    .filter((t) => !t.deletedAt && !isDone(t))
    .sort((a, b) => (a.dueDate ?? "9999-99-99").localeCompare(b.dueDate ?? "9999-99-99") || a.number - b.number);
  const weekAgo = dayNum(today) - 7;
  const done = showDone
    ? tasks
        .filter((t) => !t.deletedAt && isDone(t) && cat(t)?.glyph !== "canceled" && t.completedAt && dayNum(t.completedAt.slice(0, 10)) >= weekAgo)
        .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
    : [];
  return { open, done };
}

/** Warning tone: open and due within 2 days (overdue included). */
export function dueSoon(due: string | null, today: string, done: boolean) {
  if (!due || done) return false;
  return dayNum(due) - dayNum(today) <= 2;
}

/** Complete → the first done-category status that isn't canceled; Reopen → the first todo-category status (not Backlog). */
export function toggleTargets(statuses: readonly Status[]) {
  const sorted = [...statuses].sort((a, b) => a.position - b.position);
  const complete = sorted.find((s) => s.category === "done" && s.glyph !== "canceled") ?? null;
  const reopen = sorted.find((s) => s.category === "todo" && s.glyph !== "backlog") ?? sorted.find((s) => s.category === "todo") ?? null;
  return { complete, reopen };
}

/** Objective rows only, for one quarter (null = all). */
export function objectiveRows(rows: readonly ProgressRow[], quarter: string | null) {
  return rows.filter((r) => r.kind === "objective" && (quarter === null || r.quarter === quarter));
}

/** Danger tone: more than 10 points behind expected. */
export const behind = (r: Pick<ProgressRow, "percent" | "expected">) => r.expected !== null && r.expected - r.percent > 10;

export const overCapacity = (r: Pick<WorkloadRow, "inProgress" | "todo" | "capacity">) => r.capacity !== null && r.inProgress + r.todo > r.capacity;

/** Points as is; hours from minutes ("11/10" in hours, one decimal when needed). */
export function workloadValue(v: number, unit: WorkloadReport["unit"]) {
  if (unit === "points") return String(v);
  const h = v / 60;
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

/** Meta "pts · Sprint 14" / "h · Sprint 14". */
export function workloadMeta(r: Pick<WorkloadReport, "unit" | "sprint"> | undefined) {
  if (!r?.sprint) return "";
  return `${r.unit === "points" ? "pts" : "h"} · ${r.sprint.name}`;
}

/** "Sprint 14 burndown: 28 of 42 points remaining on Oct 7, ideal 31" (spec §1.3). */
export function burndownAria(name: string, points: readonly BurndownPoint[]) {
  let i = -1;
  points.forEach((p, k) => {
    if (p.remaining != null) i = k;
  });
  if (i < 0) return `${name} burndown: no data yet`;
  const p = points[i]!;
  return `${name} burndown: ${p.remaining} of ${points[0]?.ideal ?? 0} points remaining on ${shortDate(p.date)}, ideal ${p.ideal}`;
}

/** Mean of completed points ("avg 35"). */
export const velocityAvg = (pts: readonly { completed: number }[]) => (pts.length ? Math.round(pts.reduce((a, p) => a + p.completed, 0) / pts.length) : 0);

/** Rows that changed between two snapshots (by key), for the live flash. */
export function changedKeys<T>(prev: readonly T[] | undefined, next: readonly T[], key: (t: T) => string, sig: (t: T) => string) {
  if (!prev) return [] as string[];
  const before = new Map(prev.map((t) => [key(t), sig(t)]));
  return next.filter((t) => before.get(key(t)) !== sig(t)).map(key);
}
