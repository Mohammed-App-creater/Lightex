import type { Progress, Status, Task } from "@/lib/api/types";

/*
 * Progress for objectives, milestones, sprints and epics is computed from tasks and never
 * stored (brief + board 16 §1.7). The mock backend and any client-side previews use these
 * same functions so the numbers always agree.
 */

export const DAY = 86_400_000;

export function isDoneStatus(statusId: string, statuses: Pick<Status, "id" | "category" | "glyph">[]) {
  const s = statuses.find((x) => x.id === statusId);
  return s?.category === "done" && s.glyph !== "canceled";
}

export function isCanceled(statusId: string, statuses: Pick<Status, "id" | "glyph">[]) {
  return statuses.find((x) => x.id === statusId)?.glyph === "canceled";
}

/** done / total over tasks, ignoring canceled and deleted tasks. */
export function progressOf(tasks: Pick<Task, "statusId" | "deletedAt">[], statuses: Status[]): Progress {
  const live = tasks.filter((t) => !t.deletedAt && !isCanceled(t.statusId, statuses));
  const done = live.filter((t) => isDoneStatus(t.statusId, statuses)).length;
  const total = live.length;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

export function parseDate(d: string) {
  return new Date(`${d}T00:00:00`);
}

export function startOfToday(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Days from today to an ISO date (negative = overdue). */
export function daysUntil(date: string, now = new Date()) {
  return Math.round((parseDate(date).getTime() - startOfToday(now).getTime()) / DAY);
}

/** Share of the start→due window elapsed today, 0–100 (board 16 §1.7). */
export function expectedPercent(start: string, due: string, now = new Date()) {
  const s = parseDate(start).getTime();
  const d = parseDate(due).getTime();
  const t = startOfToday(now).getTime();
  if (d <= s) return t >= d ? 100 : 0;
  return Math.round(Math.min(1, Math.max(0, (t - s) / (d - s))) * 100);
}

/** "At risk = behind time": not done and progress below the expected share. */
export function isAtRisk(percent: number, expected: number, completed: boolean) {
  return !completed && percent < expected;
}

/** "14d left" / "Due today" / "3d over" / "Done" */
export function daysLabel(date: string, completed = false, now = new Date()) {
  if (completed) return { text: "Done", tone: "ok" as const };
  const d = daysUntil(date, now);
  if (d < 0) return { text: `${-d}d over`, tone: "danger" as const };
  if (d === 0) return { text: "Due today", tone: "warn" as const };
  return { text: `${d}d left`, tone: "muted" as const };
}
