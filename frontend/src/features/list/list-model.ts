import type { Epic, Label, Milestone, Sprint, Status, Task, User } from "@/lib/api/types";

/* Pure list-view logic (board 15): columns, grouping, sorting, filtering. Unit-tested. */

export type ColumnId = "key" | "title" | "status" | "pri" | "asg" | "sprint" | "ms" | "due" | "labels";
export type GroupBy = "status" | "epic" | "sprint" | "assignee";
export type SortState = { col: ColumnId; dir: "asc" | "desc" } | null;

export const COLUMNS: { id: ColumnId; label: string; width: number; min: number }[] = [
  { id: "key", label: "Key", width: 70, min: 56 },
  { id: "title", label: "Title", width: 300, min: 140 },
  { id: "status", label: "Status", width: 120, min: 48 },
  { id: "pri", label: "Priority", width: 96, min: 44 },
  { id: "asg", label: "Assignee", width: 112, min: 44 },
  { id: "sprint", label: "Sprint", width: 92, min: 64 },
  { id: "ms", label: "Milestone", width: 120, min: 72 },
  { id: "due", label: "Due", width: 72, min: 56 },
  { id: "labels", label: "Labels", width: 140, min: 72 },
];
export const MAX_COL = 480;

export type Ctx = {
  statuses: Status[];
  users: Map<string, User>;
  sprints: Sprint[];
  milestones: Milestone[];
  epics: Epic[];
  labels: Map<string, Label>;
  meId: string;
  today: string;
  weekEnd: string;
};

export type Group = { id: string; name: string; tasks: Task[]; meta?: string; hue?: number; glyph?: Status["glyph"]; user?: User | null };

const statusIndex = (ctx: Ctx, id: string) => ctx.statuses.find((s) => s.id === id)?.position ?? 99;

export function sortValue(t: Task, col: ColumnId, ctx: Ctx): string | number {
  switch (col) {
    case "key":
      return t.number;
    case "title":
      return t.title.toLowerCase();
    case "status":
      return statusIndex(ctx, t.statusId);
    case "pri":
      return t.priority;
    case "asg":
      return t.assigneeId ? ctx.users.get(t.assigneeId)?.name ?? "~" : "~";
    case "sprint":
      return ctx.sprints.find((s) => s.id === t.sprintId)?.number ?? 99_999;
    case "ms": {
      const i = ctx.milestones.findIndex((m) => m.id === t.milestoneId);
      return i === -1 ? 99_999 : i;
    }
    case "due":
      return t.dueDate ?? "9999-99-99";
    case "labels":
      return t.labelIds.length ? ctx.labels.get(t.labelIds[0]!)?.name ?? "~" : "~";
  }
}

export function sortTasks(tasks: Task[], sort: SortState, ctx: Ctx) {
  const list = [...tasks];
  list.sort((a, b) => {
    if (!sort) return a.number - b.number;
    const av = sortValue(a, sort.col, ctx);
    const bv = sortValue(b, sort.col, ctx);
    const r = av < bv ? -1 : av > bv ? 1 : a.number - b.number;
    return sort.dir === "asc" ? r : -r;
  });
  return list;
}

export function groupTasks(tasks: Task[], by: GroupBy, ctx: Ctx): Group[] {
  if (by === "status") {
    const order = ["progress", "review", "todo", "backlog", "done", "canceled"];
    return [...ctx.statuses]
      .sort((a, b) => order.indexOf(a.glyph) - order.indexOf(b.glyph))
      .map((s) => ({ id: s.id, name: s.name, glyph: s.glyph, tasks: tasks.filter((t) => t.statusId === s.id) }));
  }
  if (by === "epic") {
    const groups: Group[] = ctx.epics.map((e) => ({ id: e.id, name: e.name, hue: e.hue, tasks: tasks.filter((t) => t.epicId === e.id) }));
    groups.push({ id: "none", name: "No epic", tasks: tasks.filter((t) => !t.epicId || !ctx.epics.some((e) => e.id === t.epicId)) });
    return groups;
  }
  if (by === "sprint") {
    const sprints = [...ctx.sprints].sort((a, b) => b.number - a.number);
    const groups: Group[] = sprints.map((s) => ({
      id: s.id,
      name: s.name,
      meta: s.state === "active" ? "Active" : s.state === "completed" ? "Completed" : "Planned",
      tasks: tasks.filter((t) => t.sprintId === s.id),
    }));
    groups.push({ id: "none", name: "No sprint", tasks: tasks.filter((t) => !t.sprintId) });
    return groups;
  }
  const ids = [...new Set(tasks.map((t) => t.assigneeId).filter((x): x is string => Boolean(x)))];
  const groups: Group[] = ids
    .map((id) => ({ id, name: ctx.users.get(id)?.name ?? "Former member", user: ctx.users.get(id) ?? null, tasks: tasks.filter((t) => t.assigneeId === id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  groups.push({ id: "none", name: "Unassigned", user: null, tasks: tasks.filter((t) => !t.assigneeId) });
  return groups;
}

/** How many label chips fit a column (board 15 §2.7). */
export function labelSlots(width: number) {
  return width >= 200 ? 3 : width >= 150 ? 2 : 1;
}

export function clampWidth(id: ColumnId, w: number) {
  const c = COLUMNS.find((x) => x.id === id)!;
  return Math.max(c.min, Math.min(MAX_COL, Math.round(w)));
}
