import { describe, expect, it } from "vitest";
import type { Sprint, Task } from "@/lib/api/types";
import { allState, completionPlan, contributors, defaultKeep, groupSprints, partitionCarry, reviewStats, sprintWhen } from "./sprint-model";

const NOW = new Date(2026, 9, 7, 10, 30); // Oct 7 2026

const sprint = (p: Partial<Sprint>): Sprint => ({
  id: "s",
  projectId: "p",
  name: "Sprint",
  number: 1,
  goal: "",
  startDate: "2026-10-01",
  endDate: "2026-10-14",
  state: "active",
  completedAt: null,
  progress: { done: 0, total: 0, percent: 0, points: 0, donePoints: 0 },
  ...p,
});

const task = (id: string, statusId: string, p: Partial<Task> = {}): Task =>
  ({ id, key: `PRJ-${id}`, number: Number(id), statusId, priority: 2, estimate: 3, assigneeId: null, createdAt: "2026-09-30T10:00:00Z", ...p }) as Task;

const G = { d: "done", c: "canceled", p: "progress", t: "todo" } as const;
const glyph = (id: string) => G[id as keyof typeof G] ?? "todo";

describe("sprintWhen", () => {
  it("labels active, planned and completed sprints like the board", () => {
    expect(sprintWhen(sprint({ endDate: "2026-10-14" }), NOW)).toEqual({ text: "7d left", tone: "default" });
    expect(sprintWhen(sprint({ endDate: "2026-10-09" }), NOW).tone).toBe("warn");
    expect(sprintWhen(sprint({ endDate: "2026-10-05" }), NOW)).toEqual({ text: "2d over", tone: "danger" });
    expect(sprintWhen(sprint({ state: "planned", startDate: "2026-10-15" }), NOW).text).toBe("starts in 8d");
    expect(sprintWhen(sprint({ state: "planned", startDate: "2026-10-07" }), NOW).text).toBe("starts today");
    expect(sprintWhen(sprint({ state: "completed", endDate: "2026-09-30" }), NOW).text).toBe("ended 7d ago");
  });
});

describe("groupSprints", () => {
  it("sorts planned by start and completed newest first", () => {
    const g = groupSprints([
      sprint({ id: "a", number: 12, state: "completed" }),
      sprint({ id: "b", number: 13, state: "completed" }),
      sprint({ id: "c", number: 16, state: "planned", startDate: "2026-11-01" }),
      sprint({ id: "d", number: 15, state: "planned", startDate: "2026-10-15" }),
      sprint({ id: "e", number: 14 }),
    ]);
    expect(g.active.map((s) => s.id)).toEqual(["e"]);
    expect(g.planned.map((s) => s.id)).toEqual(["d", "c"]);
    expect(g.completed.map((s) => s.id)).toEqual(["b", "a"]);
  });
});

describe("reviewStats", () => {
  it("separates done / open, ignores canceled, and finds mid-sprint scope", () => {
    const s = reviewStats(
      sprint({}),
      [task("1", "d", { estimate: 5 }), task("2", "c"), task("3", "p", { estimate: 2, createdAt: "2026-10-03T09:00:00Z" }), task("4", "t", { estimate: null })],
      glyph,
    );
    expect(s.done.map((t) => t.id)).toEqual(["1"]);
    expect(s.open.map((t) => t.id)).toEqual(["3", "4"]);
    expect([s.donePts, s.openPts, s.totalPts, s.addedPts]).toEqual([5, 2, 7, 2]);
    expect(s.added.map((t) => t.id)).toEqual(["3"]);
  });
});

describe("contributors", () => {
  it("sums done tasks by assignee, most points first", () => {
    const c = contributors([
      task("1", "d", { assigneeId: "a", estimate: 2 }),
      task("2", "d", { assigneeId: "b", estimate: 5 }),
      task("3", "d", { assigneeId: "a", estimate: 1 }),
      task("4", "d"),
    ]);
    expect(c).toEqual([
      { userId: "b", n: 1, pts: 5 },
      { userId: "a", n: 2, pts: 3 },
    ]);
  });
});

describe("carry-over", () => {
  const open = [task("1", "t", { priority: 4 }), task("2", "t", { priority: 1 }), task("3", "t", { priority: 2 })];
  it("checks medium priority and above by default", () => {
    expect(defaultKeep(open)).toEqual({ "1": true, "2": false, "3": true });
  });
  it("routes checked tasks to the destination and unchecked to the other", () => {
    const keep = defaultKeep(open);
    expect(partitionCarry(open, keep, "next", true)).toEqual({ toNext: ["1", "3"], toBacklog: ["2"] });
    expect(partitionCarry(open, keep, "backlog", true)).toEqual({ toNext: ["2"], toBacklog: ["1", "3"] });
    expect(partitionCarry(open, keep, "next", false)).toEqual({ toNext: [], toBacklog: ["1", "2", "3"] });
  });
  it("plans at most one bulk move before completing", () => {
    expect(completionPlan({ toNext: ["1"], toBacklog: ["2"] }, "s15")).toEqual({ preMove: { ids: ["2"], sprintId: null }, target: "s15" });
    expect(completionPlan({ toNext: ["1", "2"], toBacklog: [] }, "s15")).toEqual({ preMove: null, target: "s15" });
    expect(completionPlan({ toNext: [], toBacklog: ["1"] }, "s15")).toEqual({ preMove: null, target: "backlog" });
    expect(completionPlan({ toNext: [], toBacklog: ["1"] }, null)).toEqual({ preMove: null, target: "backlog" });
  });
  it("reports a tri-state select-all", () => {
    expect(allState(open, { "1": true, "2": true, "3": true })).toBe("true");
    expect(allState(open, {})).toBe("false");
    expect(allState(open, { "1": true })).toBe("mixed");
  });
});
