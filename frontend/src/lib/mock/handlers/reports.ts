import type { BurndownPoint, CycleBin, ProgressRow, ThroughputPoint, VelocityPoint } from "@/lib/api/types";
import { DAY, isDoneStatus, parseDate, startOfToday } from "@/lib/domain/progress";
import type { MockDB } from "../db-types";
import { liveTasks, statusesOf, toMilestone, toObjective } from "../derive";
import { memberProject } from "./projects";
import { requireProject, route, type Ctx } from "../router";

/*
 * Reports. Burndown, KPIs and objective/milestone progress are computed live from tasks.
 * Older history (velocity before the first completed sprint, cycle-time and throughput history)
 * comes from the design's deterministic series because the seed has only a few weeks of data.
 */

type Range = "last2" | "last6" | "last90" | "custom";
const RANGE_FACTOR: Record<Range, number> = { last2: 1, last6: 3, last90: 3.4, custom: 2.3 };
const RANGE_SPRINTS: Record<Range, number> = { last2: 2, last6: 6, last90: 7, custom: 4 };
const RANGE_WEEKS: Record<Range, number> = { last2: 4, last6: 12, last90: 13, custom: 9 };

const HISTORY: Record<string, { committed: number[]; completed: number[]; cycle: number[]; weekly: number[] }> = {
  PRJ: {
    committed: [38, 42, 40, 44, 42, 46, 48, 46],
    completed: [30, 36, 41, 38, 42, 39, 45, 47],
    cycle: [6, 11, 9, 8, 4, 2],
    weekly: [8, 8, 10, 10, 8, 9, 12, 9, 13, 11, 9, 13, 12, 10, 10, 10, 8, 12, 10, 12, 8, 12, 9, 9, 11],
  },
  MOB: {
    committed: [30, 28, 32, 34, 30, 33, 35, 34],
    completed: [24, 27, 30, 29, 31, 30, 33, 32],
    cycle: [9, 12, 7, 4, 2, 1],
    weekly: [8, 6, 8, 8, 6, 9, 9, 8, 7, 10, 9, 10, 8, 6, 8, 8, 6, 9, 9, 8, 7, 10, 9, 10, 9],
  },
  INF: {
    committed: [36, 34, 38, 40, 36, 38, 40, 40],
    completed: [28, 31, 26, 33, 30, 29, 34, 31],
    cycle: [2, 5, 7, 9, 8, 6],
    weekly: [4, 4, 6, 6, 5, 5, 5, 5, 7, 8, 5, 7, 4, 4, 6, 6, 5, 5, 5, 5, 7, 8, 5, 7, 6],
  },
};

function rangeOf(ctx: Ctx): Range {
  const r = String(ctx.query.filter?.range ?? "last6");
  return (["last2", "last6", "last90", "custom"] as Range[]).includes(r as Range) ? (r as Range) : "last6";
}

function iso(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function activeSprint(db: MockDB, projectId: string) {
  return db.sprints.find((s) => s.projectId === projectId && s.state === "active") ?? null;
}

function completedSprintCount(db: MockDB, projectId: string, key: string) {
  return db.sprints.filter((s) => s.projectId === projectId && s.state === "completed").length + (HISTORY[key] ? 8 : 0);
}

export function registerReports() {
  const guard = (ctx: Ctx) => {
    const p = memberProject(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "report.view");
    return p;
  };

  route("GET", "/projects/:id/reports/kpis", (ctx) => {
    const p = guard(ctx);
    const statuses = statusesOf(ctx.db, p.id);
    const tasks = liveTasks(ctx.db, p.id);
    const sprint = activeSprint(ctx.db, p.id);
    const inSprint = sprint ? tasks.filter((t) => t.sprintId === sprint.id) : [];
    const done = tasks.filter((t) => isDoneStatus(t.statusId, statuses) && t.startedAt && t.completedAt);
    const cycles = done.map((t) => (new Date(t.completedAt!).getTime() - new Date(t.startedAt!).getTime()) / DAY).sort((a, b) => a - b);
    const avg = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : 0;
    const p85 = cycles.length ? cycles[Math.min(cycles.length - 1, Math.floor(cycles.length * 0.85))]! : 0;
    const today = iso(startOfToday());
    const overdue = tasks
      .filter((t) => t.dueDate && t.dueDate < today && !isDoneStatus(t.statusId, statuses) && statuses.find((s) => s.id === t.statusId)?.glyph !== "canceled")
      .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
    const scope = sprint
      ? inSprint.filter((t) => t.createdAt.slice(0, 10) > sprint.startDate).reduce((a, t) => a + (t.estimate ?? 0), 0)
      : 0;
    const dayIndex = sprint ? Math.min(lengthDays(sprint.startDate, sprint.endDate), Math.max(1, Math.round((startOfToday().getTime() - parseDate(sprint.startDate).getTime()) / DAY) + 1)) : 0;
    return {
      sprint: sprint ? { name: sprint.name, number: sprint.number, startDate: sprint.startDate, endDate: sprint.endDate, dayIndex, lengthDays: lengthDays(sprint.startDate, sprint.endDate) } : null,
      completedThisSprint: inSprint.filter((t) => isDoneStatus(t.statusId, statuses)).length,
      plannedThisSprint: inSprint.length,
      avgCycleTimeDays: Math.round(avg * 10) / 10,
      p85CycleTimeDays: Math.round(p85 * 10) / 10,
      overdueCount: overdue.length,
      oldestOverdueKey: overdue[0]?.key ?? null,
      scopeChangePts: scope,
      completedSprints: completedSprintCount(ctx.db, p.id, p.key),
    };
  });

  route("GET", "/projects/:id/reports/burndown", (ctx) => {
    const p = guard(ctx);
    const sprintId = String(ctx.query.filter?.sprint ?? "");
    const sprint = (sprintId && ctx.db.sprints.find((s) => s.id === sprintId)) || activeSprint(ctx.db, p.id);
    if (!sprint) return { sprint: null, points: [] as BurndownPoint[] };
    const statuses = statusesOf(ctx.db, p.id);
    const tasks = liveTasks(ctx.db, p.id).filter((t) => t.sprintId === sprint.id && statuses.find((s) => s.id === t.statusId)?.glyph !== "canceled");
    const len = lengthDays(sprint.startDate, sprint.endDate);
    const start = parseDate(sprint.startDate).getTime();
    const today = startOfToday().getTime();
    const pts = (t: (typeof tasks)[number]) => t.estimate ?? 1;
    const startTotal = tasks.filter((t) => t.createdAt.slice(0, 10) <= sprint.startDate).reduce((a, t) => a + pts(t), 0) || tasks.reduce((a, t) => a + pts(t), 0);
    const points: BurndownPoint[] = [];
    for (let i = 0; i < len; i++) {
      const dayEnd = start + (i + 1) * DAY;
      const date = iso(new Date(start + i * DAY));
      const reached = start + i * DAY <= today;
      const remaining = tasks
        .filter((t) => new Date(t.createdAt).getTime() < dayEnd)
        .filter((t) => !(t.completedAt && new Date(t.completedAt).getTime() < dayEnd && isDoneStatus(t.statusId, statuses)))
        .reduce((a, t) => a + pts(t), 0);
      points.push({ date, remaining: reached ? remaining : null, ideal: Math.round(startTotal * (1 - i / Math.max(1, len - 1))) });
    }
    return { sprint: { id: sprint.id, name: sprint.name, startDate: sprint.startDate, endDate: sprint.endDate }, points };
  });

  route("GET", "/projects/:id/reports/velocity", (ctx) => {
    const p = guard(ctx);
    const range = rangeOf(ctx);
    const statuses = statusesOf(ctx.db, p.id);
    const current = activeSprint(ctx.db, p.id)?.number ?? (ctx.db.sprints.filter((s) => s.projectId === p.id).reduce((a, s) => Math.max(a, s.number), 0) + 1);
    const real = new Map<number, VelocityPoint>();
    ctx.db.sprints
      .filter((s) => s.projectId === p.id && s.state === "completed")
      .forEach((s) => {
        const ts = liveTasks(ctx.db, p.id).filter((t) => t.sprintId === s.id || (t.completedAt && t.completedAt.slice(0, 10) >= s.startDate && t.completedAt.slice(0, 10) <= s.endDate && t.sprintId === s.id));
        const committed = ts.reduce((a, t) => a + (t.estimate ?? 1), 0);
        const completed = ts.filter((t) => isDoneStatus(t.statusId, statuses)).reduce((a, t) => a + (t.estimate ?? 1), 0);
        real.set(s.number, { sprint: `S${s.number}`, committed, completed });
      });
    const h = HISTORY[p.key];
    const n = RANGE_SPRINTS[range];
    const out: VelocityPoint[] = [];
    for (let k = n; k >= 1; k--) {
      const num = current - k;
      if (num < 1) continue;
      const r = real.get(num);
      if (r && r.committed > 0) out.push(r);
      else if (h) {
        const idx = h.committed.length - k;
        if (idx >= 0) out.push({ sprint: `S${num}`, committed: h.committed[idx]!, completed: h.completed[idx]! });
      }
    }
    return { points: out, insufficient: out.length < 3, completedSprints: completedSprintCount(ctx.db, p.id, p.key) };
  });

  route("GET", "/projects/:id/reports/cycle-time", (ctx) => {
    const p = guard(ctx);
    const range = rangeOf(ctx);
    const labels = ["<1d", "1–2d", "2–3d", "3–5d", "5–8d", "8d+"];
    const edges = [1, 2, 3, 5, 8, Infinity];
    const statuses = statusesOf(ctx.db, p.id);
    const real = labels.map(() => 0);
    liveTasks(ctx.db, p.id)
      .filter((t) => isDoneStatus(t.statusId, statuses) && t.startedAt && t.completedAt)
      .forEach((t) => {
        const d = (new Date(t.completedAt!).getTime() - new Date(t.startedAt!).getTime()) / DAY;
        real[edges.findIndex((e) => d < e)]! += 1;
      });
    const base = HISTORY[p.key]?.cycle;
    const bins: CycleBin[] = labels.map((label, i) => ({ label, count: Math.round((base?.[i] ?? 0) * RANGE_FACTOR[range]) + real[i]! }));
    const total = bins.reduce((a, b) => a + b.count, 0);
    // median from the binned distribution (midpoint of the bin containing the 50th percentile)
    const mids = [0.5, 1.5, 2.5, 4, 6.5, 10];
    let acc = 0;
    let median = 0;
    for (let i = 0; i < bins.length; i++) {
      acc += bins[i]!.count;
      if (acc >= total / 2) {
        median = mids[i]!;
        break;
      }
    }
    return { bins, total, medianDays: median, insufficient: total < 10 };
  });

  route("GET", "/projects/:id/reports/throughput", (ctx) => {
    const p = guard(ctx);
    const range = rangeOf(ctx);
    const weeks = RANGE_WEEKS[range];
    const statuses = statusesOf(ctx.db, p.id);
    const h = HISTORY[p.key]?.weekly ?? [];
    // Week starts on Monday; last point = last completed week.
    const today = startOfToday();
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const done = liveTasks(ctx.db, p.id).filter((t) => t.completedAt && isDoneStatus(t.statusId, statuses));
    const points: ThroughputPoint[] = [];
    for (let k = weeks; k >= 1; k--) {
      const ws = new Date(monday.getTime() - k * 7 * DAY);
      const we = ws.getTime() + 7 * DAY;
      const real = done.filter((t) => {
        const c = new Date(t.completedAt!).getTime();
        return c >= ws.getTime() && c < we;
      }).length;
      const synthetic = h.length ? h[h.length - k] ?? 0 : 0;
      points.push({ week: iso(ws), done: Math.max(real, synthetic) });
    }
    return { points, insufficient: points.reduce((a, b) => a + b.done, 0) < 5 };
  });

  route("GET", "/projects/:id/reports/progress", (ctx) => {
    const p = guard(ctx);
    const rows: ProgressRow[] = [];
    ctx.db.objectives
      .filter((o) => o.projectId === p.id)
      .map((o) => toObjective(ctx.db, o))
      .forEach((o) => {
        const created = o.createdAt.slice(0, 10);
        const expected = o.dueDate ? expectedBetween(created, o.dueDate) : null;
        // Board 33 (additive): the objective's quarter, for the dashboard's objectives widget.
        rows.push({ id: o.id, kind: "objective", name: o.title, percent: o.progress.percent, expected, quarter: o.quarter ?? null });
      });
    ctx.db.milestones
      .filter((m) => m.projectId === p.id)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .map((m) => toMilestone(ctx.db, m))
      .forEach((m) => rows.push({ id: m.id, kind: "milestone", name: m.name, percent: m.progress.percent, expected: m.progress.expected, ...{ dueDate: m.dueDate }, quarter: null }));
    return rows;
  });
}

function lengthDays(start: string, end: string) {
  return Math.round((parseDate(end).getTime() - parseDate(start).getTime()) / DAY) + 1;
}

function expectedBetween(start: string, due: string) {
  const s = parseDate(start).getTime();
  const d = parseDate(due).getTime();
  const t = startOfToday().getTime();
  if (d <= s) return t >= d ? 100 : 0;
  return Math.round(Math.min(1, Math.max(0, (t - s) / (d - s))) * 100);
}
