import { describe, expect, it } from "vitest";
import type { Status, Task } from "@/lib/api/types";
import { clampWidth, filterTasks, groupTasks, labelSlots, sortTasks, type Ctx } from "./list-model";

const statuses: Status[] = [
  { id: "todo", projectId: "p", name: "Todo", category: "todo", glyph: "todo", position: 1 },
  { id: "prog", projectId: "p", name: "In progress", category: "in_progress", glyph: "progress", position: 2 },
  { id: "done", projectId: "p", name: "Done", category: "done", glyph: "done", position: 4 },
];
const t = (n: number, over: Partial<Task> = {}): Task =>
  ({ id: `t${n}`, key: `PRJ-${n}`, number: n, title: `Task ${n}`, statusId: "todo", priority: 0, assigneeId: null, labelIds: [], dueDate: null, epicId: null, sprintId: null, milestoneId: null, ...over }) as Task;
const ctx: Ctx = {
  statuses,
  users: new Map([["u1", { id: "u1", name: "Alex Kim", email: "", hue: 1, avatarUrl: null, createdAt: "" }]]),
  sprints: [],
  milestones: [],
  epics: [],
  labels: new Map(),
  meId: "u1",
  today: "2026-10-07",
  weekEnd: "2026-10-11",
};

describe("list model", () => {
  it("sorts by key by default and by column with tie-break on key", () => {
    const list = [t(3, { priority: 2 }), t(1, { priority: 2 }), t(2, { priority: 4 })];
    expect(sortTasks(list, null, ctx).map((x) => x.number)).toEqual([1, 2, 3]);
    expect(sortTasks(list, { col: "pri", dir: "desc" }, ctx).map((x) => x.number)).toEqual([2, 3, 1]);
  });

  it("groups by status in flow order with empty groups kept", () => {
    const groups = groupTasks([t(1, { statusId: "prog" }), t(2)], "status", ctx);
    expect(groups.map((g) => [g.name, g.tasks.length])).toEqual([
      ["In progress", 1],
      ["Todo", 1],
      ["Done", 0],
    ]);
  });

  it("applies quick filters with AND", () => {
    const list = [t(1, { assigneeId: "u1", priority: 4, dueDate: "2026-10-09" }), t(2, { assigneeId: "u1", priority: 1 }), t(3, { priority: 4, dueDate: "2026-10-08" })];
    expect(filterTasks(list, new Set(["mine", "urgent"]), ctx).map((x) => x.number)).toEqual([1]);
    expect(filterTasks(list, new Set(["week"]), ctx).map((x) => x.number)).toEqual([1, 3]);
  });

  it("clamps column widths and picks label slots", () => {
    expect(clampWidth("title", 50)).toBe(140);
    expect(clampWidth("title", 900)).toBe(480);
    expect(labelSlots(210)).toBe(3);
    expect(labelSlots(120)).toBe(1);
  });
});
