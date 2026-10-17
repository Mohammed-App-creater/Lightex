import type { GlyphKind } from "@/components/ui/glyphs";
import type { Sprint, Status, Task } from "@/lib/api/types";
import { daysUntil } from "@/lib/domain/progress";

/* Pure helpers for the Sprints screen and the 3-step review (board 26). React-free, unit-tested. */

export const pts = (t: Pick<Task, "estimate">) => t.estimate ?? 0;
export const sumPts = (ts: Pick<Task, "estimate">[]) => ts.reduce((a, t) => a + pts(t), 0);

/** Active / Planned / Completed, in the order the board lists them. */
export function groupSprints(sprints: Sprint[]) {
  return {
    active: sprints.filter((s) => s.state === "active"),
    planned: sprints.filter((s) => s.state === "planned").sort((a, b) => a.startDate.localeCompare(b.startDate) || a.number - b.number),
    completed: sprints.filter((s) => s.state === "completed").sort((a, b) => b.number - a.number),
  };
}

/** The planned sprint that comes next (earliest start). */
export function nextPlanned(sprints: Sprint[]) {
  return groupSprints(sprints).planned[0];
}

/** "6d left" (warn ≤2), "starts in 8d" / "starts today", "ended 7d ago" / "ended today". */
export function sprintWhen(s: Pick<Sprint, "state" | "startDate" | "endDate" | "completedAt">, now = new Date()): { text: string; tone: "warn" | "danger" | "muted" | "default" } {
  if (s.state === "active") {
    const left = daysUntil(s.endDate, now);
    if (left < 0) return { text: `${-left}d over`, tone: "danger" };
    return { text: `${left}d left`, tone: left <= 2 ? "warn" : "default" };
  }
  if (s.state === "planned") {
    const d = daysUntil(s.startDate, now);
    return { text: d <= 0 ? "starts today" : `starts in ${d}d`, tone: "muted" };
  }
  const end = s.completedAt ? s.completedAt.slice(0, 10) : s.endDate;
  const ago = -daysUntil(end, now);
  return { text: ago <= 0 ? "ended today" : `ended ${ago}d ago`, tone: "muted" };
}

export type GlyphOf = (statusId: string) => GlyphKind;
export const glyphLookup = (statuses: Pick<Status, "id" | "glyph">[]): GlyphOf => {
  const m = new Map(statuses.map((s) => [s.id, s.glyph]));
  return (id) => m.get(id) ?? "todo";
};

const isClosed = (g: GlyphKind) => g === "done" || g === "canceled";

/** Step 1 numbers: completed vs open, velocity, scope added after the start date. */
export function reviewStats(sprint: Pick<Sprint, "startDate">, tasks: Task[], glyphOf: GlyphOf) {
  const done = tasks.filter((t) => glyphOf(t.statusId) === "done");
  const open = tasks.filter((t) => !isClosed(glyphOf(t.statusId)));
  const added = tasks.filter((t) => addedMidSprint(sprint, t)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const donePts = sumPts(done);
  const openPts = sumPts(open);
  return {
    done,
    open,
    added,
    donePts,
    openPts,
    totalPts: donePts + openPts,
    addedPts: sumPts(added),
    donePct: done.length + open.length ? (done.length / (done.length + open.length)) * 100 : 0,
  };
}

/** A task created after the sprint started counts as scope added mid-sprint. */
export function addedMidSprint(sprint: Pick<Sprint, "startDate">, t: Pick<Task, "createdAt">) {
  return t.createdAt.slice(0, 10) > sprint.startDate;
}

/** Done tasks per assignee, most points first. */
export function contributors(done: Task[]) {
  const by = new Map<string, { userId: string; n: number; pts: number }>();
  for (const t of done) {
    if (!t.assigneeId) continue;
    const c = by.get(t.assigneeId) ?? { userId: t.assigneeId, n: 0, pts: 0 };
    c.n += 1;
    c.pts += pts(t);
    by.set(t.assigneeId, c);
  }
  return [...by.values()].sort((a, b) => b.pts - a.pts || b.n - a.n);
}

/** Default carry-over selection (board 26): medium priority and above are checked. */
export function defaultKeep(open: Pick<Task, "id" | "priority">[]) {
  return Object.fromEntries(open.map((t) => [t.id, t.priority >= 2])) as Record<string, boolean>;
}

export type Dest = "next" | "backlog";

/**
 * Where each unfinished task ends up. Checked tasks go to the chosen destination, unchecked
 * ones to the other. Without a next sprint everything returns to the backlog.
 */
export function partitionCarry(open: Pick<Task, "id">[], keep: Record<string, boolean>, dest: Dest, hasNext: boolean) {
  if (!hasNext) return { toNext: [] as string[], toBacklog: open.map((t) => t.id) };
  const toNext: string[] = [];
  const toBacklog: string[] = [];
  for (const t of open) {
    const goesNext = (dest === "next") === Boolean(keep[t.id]);
    (goesNext ? toNext : toBacklog).push(t.id);
  }
  return { toNext, toBacklog };
}

/**
 * The existing API completes a sprint by moving every open task to ONE target. To honour the
 * per-task split we first bulk-move the minority group, then complete with the other target.
 */
export function completionPlan(split: { toNext: string[]; toBacklog: string[] }, nextId: string | null) {
  if (!nextId || split.toNext.length === 0) return { preMove: null, target: "backlog" as const };
  if (split.toBacklog.length === 0) return { preMove: null, target: nextId };
  return { preMove: { ids: split.toBacklog, sprintId: null as string | null }, target: nextId };
}

/** Tri-state for the "select all" checkbox. */
export function allState(open: Pick<Task, "id">[], keep: Record<string, boolean>): "true" | "false" | "mixed" {
  const on = open.filter((t) => keep[t.id]).length;
  return on === 0 ? "false" : on === open.length ? "true" : "mixed";
}

/** Board columns for the sprint board: Todo (incl. backlog) · In progress · In review · Done. */
export const SPRINT_COLUMNS: { kind: GlyphKind; glyphs: GlyphKind[]; name: string }[] = [
  { kind: "todo", glyphs: ["todo", "backlog"], name: "Todo" },
  { kind: "progress", glyphs: ["progress"], name: "In progress" },
  { kind: "review", glyphs: ["review"], name: "In review" },
  { kind: "done", glyphs: ["done"], name: "Done" },
];
