import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DashboardWidget, ProgressRow, Status, Task, WidgetType } from "@/lib/api/types";
import vectors from "./pack-vectors.json";
import { clampSize, hitIndex, layoutEquals, newWidget, pack, reorder, rowUnit, rowsFor, toDraft, toInput } from "./layout-lib";
import { behind, burndownAria, changedKeys, dueSoon, myTaskRows, objectiveRows, overCapacity, toggleTargets, velocityAvg, workloadMeta, workloadValue } from "./widget-lib";

describe("pack (shared vectors, spec §8.3)", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      expect(pack(c.widgets)).toEqual(c.rects);
    });
  }

  it("is the same file as the backend copy when both exist", () => {
    // Vitest runs from frontend/.
    const here = resolve(process.cwd(), "src/features/dashboards/pack-vectors.json");
    const backend = resolve(process.cwd(), "../backend/apps/dashboards/tests/pack_vectors.json");
    expect(existsSync(here)).toBe(true);
    if (!existsSync(backend)) return; // the backend copy lands with the backend's board 33 work
    const hash = (p: string) => createHash("sha256").update(readFileSync(p, "utf8").replace(/\r\n/g, "\n")).digest("hex");
    expect(hash(backend)).toBe(hash(here));
  });

  it("clamps widths above 12 like the design", () => {
    expect(pack([{ w: 14, h: 1 }])).toEqual([{ x: 0, y: 0, w: 12, h: 1 }]);
  });
});

describe("layout helpers", () => {
  it("row unit: 152 px at ≥ 1024 px, 128 px below", () => {
    expect([1023, 1024, 1400].map(rowUnit)).toEqual([128, 152, 152]);
  });

  it("reorder moves an item and clamps the target", () => {
    expect(reorder(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(reorder(["a", "b", "c"], 2, -5)).toEqual(["c", "a", "b"]);
    const same = ["a", "b"];
    expect(reorder(same, 1, 1)).toBe(same);
  });

  it("clampSize keeps 3–12 columns and minH–4 rows per type", () => {
    expect(clampSize("burndown", 2, 1)).toEqual({ w: 3, h: 2 });
    expect(clampSize("my_tasks", 13, 1)).toEqual({ w: 12, h: 1 });
    expect(clampSize("velocity", 6, 9)).toEqual({ w: 6, h: 4 });
    expect(clampSize("workload", 6, 1)).toEqual({ w: 6, h: 2 });
  });

  it("rowsFor: My tasks shows 3, 7, 11, 15 rows", () => {
    expect([1, 2, 3, 4].map(rowsFor)).toEqual([3, 7, 11, 15]);
  });

  it("layoutEquals compares order, sizes and configs", () => {
    const widgets: DashboardWidget[] = [
      { id: "a", type: "burndown", w: 6, h: 2, config: { sprintId: null } },
      { id: "b", type: "velocity", w: 3, h: 2, config: { range: "last6" } },
    ];
    const base = toDraft(widgets).map(toInput);
    expect(layoutEquals(base, toDraft(widgets).map(toInput))).toBe(true);
    expect(layoutEquals(base, [...base].reverse())).toBe(false);
    expect(layoutEquals(base, [base[0]!, { ...base[1]!, w: 4 }])).toBe(false);
    expect(layoutEquals(base, [base[0]!, { ...base[1]!, config: { range: "last2" } } as never])).toBe(false);
    const added = newWidget("activity");
    expect(toInput(added)).toEqual({ type: "activity", w: 3, h: 2, config: {} });
    expect(layoutEquals(base, [...base, toInput(added)])).toBe(false);
  });

  it("hitIndex finds the widget under a grid cell", () => {
    const rects = pack(vectors.cases[0]!.widgets);
    expect(hitIndex(rects, 7, 1)).toBe(1);
    expect(hitIndex(rects, 0, 3)).toBe(3);
    expect(hitIndex(rects, 0, 9)).toBe(-1);
  });
});

describe("widget data", () => {
  const st = (id: string, category: Status["category"], glyph: Status["glyph"], position: number) => ({ id, category, glyph, position, name: id, projectId: "p" }) as Status;
  const statuses = [st("bl", "todo", "backlog", 0), st("todo", "todo", "todo", 1), st("prog", "in_progress", "progress", 2), st("done", "done", "done", 4), st("cx", "done", "canceled", 5)];
  const t = (n: number, over: Partial<Task>) => ({ id: `t${n}`, key: `PRJ-${n}`, number: n, statusId: "todo", dueDate: null, completedAt: null, deletedAt: null, ...over }) as Task;

  it("My tasks: open by due date (no date last), then done in the last 7 days", () => {
    const tasks = [
      t(1, { dueDate: null }),
      t(2, { dueDate: "2026-10-12" }),
      t(3, { dueDate: "2026-10-09", statusId: "prog" }),
      t(4, { statusId: "done", completedAt: "2026-10-05T10:00:00Z" }),
      t(5, { statusId: "done", completedAt: "2026-09-20T10:00:00Z" }),
      t(6, { statusId: "cx", completedAt: "2026-10-06T10:00:00Z" }),
    ];
    const r = myTaskRows(tasks, statuses, true, "2026-10-09");
    expect(r.open.map((x) => x.key)).toEqual(["PRJ-3", "PRJ-2", "PRJ-1"]);
    expect(r.done.map((x) => x.key)).toEqual(["PRJ-4"]);
    expect(myTaskRows(tasks, statuses, false, "2026-10-09").done).toEqual([]);
  });

  it("due soon: open and within 2 days (overdue too)", () => {
    expect(dueSoon("2026-10-11", "2026-10-09", false)).toBe(true);
    expect(dueSoon("2026-10-12", "2026-10-09", false)).toBe(false);
    expect(dueSoon("2026-10-01", "2026-10-09", false)).toBe(true);
    expect(dueSoon("2026-10-09", "2026-10-09", true)).toBe(false);
  });

  it("toggle targets: first done status that isn't canceled; first todo status (not Backlog)", () => {
    const { complete, reopen } = toggleTargets(statuses);
    expect([complete?.id, reopen?.id]).toEqual(["done", "todo"]);
  });

  it("objectives: objective rows only, by quarter; behind when > 10 points under expected", () => {
    const rows: ProgressRow[] = [
      { id: "o1", kind: "objective", name: "A", percent: 62, expected: 70, quarter: "Q4" },
      { id: "o2", kind: "objective", name: "B", percent: 40, expected: 55, quarter: "Q3" },
      { id: "m1", kind: "milestone", name: "M", percent: 10, expected: 10, quarter: null },
    ];
    expect(objectiveRows(rows, "Q4").map((r) => r.id)).toEqual(["o1"]);
    expect(objectiveRows(rows, null).map((r) => r.id)).toEqual(["o1", "o2"]);
    expect([behind(rows[0]!), behind(rows[1]!)]).toEqual([false, true]);
  });

  it("workload: over capacity, hours from minutes, meta", () => {
    expect(overCapacity({ inProgress: 5, todo: 6, capacity: 10 })).toBe(true);
    expect(overCapacity({ inProgress: 5, todo: 5, capacity: 10 })).toBe(false);
    expect(overCapacity({ inProgress: 9, todo: 9, capacity: null })).toBe(false);
    expect([workloadValue(11, "points"), workloadValue(90, "hours"), workloadValue(120, "hours")]).toEqual(["11", "1.5", "2"]);
    const sprint = { id: "s", name: "Sprint 14", number: 14, startDate: "", endDate: "" };
    expect(workloadMeta({ unit: "points", sprint })).toBe("pts · Sprint 14");
    expect(workloadMeta({ unit: "hours", sprint })).toBe("h · Sprint 14");
  });

  it("burndown aria text and velocity average", () => {
    const points = [
      { date: "2026-10-01", remaining: 42, ideal: 42 },
      { date: "2026-10-07", remaining: 28, ideal: 31 },
      { date: "2026-10-14", remaining: null, ideal: 0 },
    ];
    expect(burndownAria("Sprint 14", points)).toBe("Sprint 14 burndown: 28 of 42 points remaining on Oct 7, ideal 31");
    expect(velocityAvg([{ completed: 30 }, { completed: 35 }, { completed: 40 }])).toBe(35);
  });

  it("changedKeys finds rows that changed or arrived", () => {
    const sig = (r: { id: string; v: number }) => String(r.v);
    expect(changedKeys(undefined, [{ id: "a", v: 1 }], (r) => r.id, sig)).toEqual([]);
    expect(changedKeys([{ id: "a", v: 1 }], [{ id: "a", v: 2 }, { id: "b", v: 1 }], (r) => r.id, sig)).toEqual(["a", "b"]);
  });

  it("the catalogue covers the six types", () => {
    const types: WidgetType[] = ["burndown", "my_tasks", "objectives", "workload", "velocity", "activity"];
    expect(types.map((x) => newWidget(x).type)).toEqual(types);
  });
});
