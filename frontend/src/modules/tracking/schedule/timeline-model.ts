import type { Epic, ProjectMember, Task, TimelineGroup, User } from "@/lib/api/types";
import { derivedSpan, isDependencyConflict, overlaps, sortBySpan, spanOf, type Span, type Window } from "./schedule-lib";

/* Board 32 timeline model: groups (epic / assignee), the flat row list, dependency arrows. Pure. */

export const ROW_H = { milestones: 40, sprints: 36, error: 32, group: 44, task: 32 } as const;

export type TlGroup = {
  id: string;
  kind: "epic" | "none" | "user" | "unassigned";
  name: string;
  hue: number | null;
  epic?: Epic;
  user?: User | null;
  former?: boolean;
  tasks: Task[];
  /** Epic bar span (explicit or derived); null = no bar. */
  span: Span | null;
  derived: boolean;
  collapsible: boolean;
};

export type TlRow =
  | { kind: "milestones"; key: string }
  | { kind: "sprints"; key: string }
  | { kind: "error"; key: string; what: string }
  | { kind: "group"; key: string; group: TlGroup; open: boolean }
  | { kind: "task"; key: string; task: Task; group: TlGroup; first: boolean };

export const rowHeight = (r: TlRow) => ROW_H[r.kind];

/**
 * Epic grouping: epics in API order (shown when they have tasks in the response, or explicit dates
 * overlapping the window), then "No epic". Assignee grouping: members by name, former members,
 * then "Unassigned". Tasks inside a group: effective start, then number.
 */
export function buildGroups(tasks: Task[], by: TimelineGroup, epics: Epic[], members: ProjectMember[], win: Window): TlGroup[] {
  const known = new Set(epics.map((e) => e.id));
  if (by === "epic") {
    const out: TlGroup[] = [];
    for (const e of epics) {
      const list = sortBySpan(tasks.filter((t) => t.epicId === e.id));
      const explicit = e.startDate && e.dueDate ? { start: e.startDate, end: e.dueDate } : null;
      if (!list.length && !(explicit && overlaps(explicit, win.from, win.to))) continue;
      const span = explicit ?? derivedSpan(list);
      out.push({ id: e.id, kind: "epic", name: e.name, hue: e.hue, epic: e, tasks: list, span, derived: !explicit, collapsible: true });
    }
    const none = sortBySpan(tasks.filter((t) => !t.epicId || !known.has(t.epicId)));
    if (none.length) out.push({ id: "none", kind: "none", name: "No epic", hue: null, tasks: none, span: null, derived: false, collapsible: true });
    return out;
  }
  const byUser = new Map<string, Task[]>();
  for (const t of tasks) {
    const k = t.assigneeId ?? "";
    byUser.set(k, [...(byUser.get(k) ?? []), t]);
  }
  const memberIds = new Set(members.map((m) => m.userId));
  const out: TlGroup[] = [...members]
    .sort((a, b) => a.user.name.localeCompare(b.user.name))
    .filter((m) => byUser.has(m.userId))
    .map((m) => ({ id: m.userId, kind: "user" as const, name: m.user.name, hue: m.user.hue, user: m.user, tasks: sortBySpan(byUser.get(m.userId)!), span: null, derived: false, collapsible: false }));
  for (const [id, list] of byUser) {
    if (!id || memberIds.has(id)) continue;
    out.push({ id, kind: "user", name: "Former member", hue: null, user: null, former: true, tasks: sortBySpan(list), span: null, derived: false, collapsible: false });
  }
  const none = byUser.get("");
  if (none?.length) out.push({ id: "unassigned", kind: "unassigned", name: "Unassigned", hue: null, tasks: sortBySpan(none), span: null, derived: false, collapsible: false });
  // Task bars keep their epic hue in this grouping (resolved by the renderer); `hue` here is the avatar's.
  return out;
}

/** Flat row list: the lanes, then each group header and (when open) its task rows. */
export function buildRows(groups: TlGroup[], collapsed: ReadonlySet<string>, lanes: { milestones: boolean; sprints: boolean; error: string | null }): TlRow[] {
  const rows: TlRow[] = [];
  if (lanes.error) rows.push({ kind: "error", key: "lanes-error", what: lanes.error });
  if (lanes.milestones) rows.push({ kind: "milestones", key: "milestones" });
  if (lanes.sprints) rows.push({ kind: "sprints", key: "sprints" });
  for (const g of groups) {
    const open = !g.collapsible || !collapsed.has(g.id);
    rows.push({ kind: "group", key: `g:${g.id}`, group: g, open });
    if (open) g.tasks.forEach((task, i) => rows.push({ kind: "task", key: `t:${g.id}:${task.id}`, task, group: g, first: i === 0 }));
  }
  return rows;
}

/** Top offset of every row and the total height (rows have fixed heights). */
export function rowOffsets(rows: TlRow[]) {
  const tops: number[] = [];
  let y = 0;
  for (const r of rows) {
    tops.push(y);
    y += rowHeight(r);
  }
  return { tops, total: y };
}

export type Arrow = { id: string; from: string; to: string; d: string; conflict: boolean };

/**
 * Dependency arrows (§1.6): from the right end of each open blocker's bar to the left end of the
 * blocked bar, when both rows are on screen. Orthogonal with an elbow; danger tone on conflict.
 * `spanFor` returns the span to draw (a dragged bar's preview, else its dates).
 */
export function buildArrows(rows: TlRow[], tops: number[], laneWidth: number, win: Window, spanFor: (t: Task) => Span | null): Arrow[] {
  if (laneWidth <= 0) return [];
  const pos = new Map<string, { y: number; task: Task }>();
  rows.forEach((r, i) => {
    if (r.kind === "task" && !pos.has(r.task.id)) pos.set(r.task.id, { y: tops[i]! + ROW_H.task / 2, task: r.task });
  });
  const ppd = laneWidth / win.days;
  const x = (iso: string) => ((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(+win.from.slice(0, 4), +win.from.slice(5, 7) - 1, +win.from.slice(8, 10))) / 86_400_000) * ppd;
  const out: Arrow[] = [];
  for (const { y: y2, task } of pos.values()) {
    for (const b of task.openBlockers ?? []) {
      const from = pos.get(b.id);
      if (!from) continue;
      const bs = spanFor(from.task);
      const ts = spanFor(task);
      if (!bs || !ts) continue;
      const x1 = x(bs.end) + ppd;
      const x2 = x(ts.start);
      const y1 = from.y;
      const elbow = x1 + 8;
      const f = (n: number) => n.toFixed(1);
      // Room to come in from the left: one elbow. Otherwise (overlap / conflict) run along the row
      // boundary above the blocked bar and enter its start from the left, so the line never hides under it.
      const d =
        x2 >= elbow + 6
          ? `M${f(x1)} ${f(y1)} H${f(elbow)} V${f(y2)} H${f(x2)}`
          : `M${f(x1)} ${f(y1)} H${f(elbow)} V${f(y2 + (y2 > y1 ? -1 : 1) * (ROW_H.task / 2))} H${f(x2 - 10)} V${f(y2)} H${f(x2)}`;
      out.push({ id: `${b.id}>${task.id}`, from: b.id, to: task.id, d, conflict: isDependencyConflict(bs, ts) });
    }
  }
  return out;
}

export const taskSpan = (t: Task) => spanOf(t);
