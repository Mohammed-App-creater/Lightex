import { describe, expect, it } from "vitest";
import {
  barGeometry,
  defaultMilestoneId,
  groupTasksByStatus,
  matchTask,
  monthLabelStep,
  shortDate,
  timelineScale,
} from "./helpers";

const NOW = new Date(2026, 9, 7, 10, 30); // Oct 7 2026

describe("timelineScale", () => {
  const ms = [
    { startDate: "2026-08-10", dueDate: "2026-09-12" },
    { startDate: "2026-09-12", dueDate: "2026-10-21" },
    { startDate: "2026-10-21", dueDate: "2026-12-09" },
  ];

  it("pads the domain to whole months", () => {
    const s = timelineScale(ms, NOW);
    expect(s.start).toBe("2026-08-01");
    expect(s.end).toBe("2027-01-01");
    expect(s.months.map((m) => m.label)).toEqual(["Aug", "Sep", "Oct", "Nov", "Dec"]);
    expect(s.months[0]!.pct).toBe(0);
  });

  it("maps dates linearly and clamps", () => {
    const s = timelineScale(ms, NOW);
    expect(s.x("2026-08-01")).toBe(0);
    expect(s.x("2027-01-01")).toBe(100);
    expect(s.x("2025-01-01")).toBe(0);
    expect(s.x("2030-01-01")).toBe(100);
    expect(s.today).toBeGreaterThan(s.x("2026-10-01"));
    expect(s.today).toBeLessThan(s.x("2026-10-21"));
  });

  it("matches the design's fixed Sep–Jan scale when the data spans it", () => {
    const s = timelineScale([{ startDate: "2026-09-01", dueDate: "2026-12-09" }], NOW);
    expect(s.start).toBe("2026-09-01");
    expect(s.end).toBe("2027-01-01");
    expect(s.x("2026-11-01")).toBeCloseTo(50, 0);
    expect(s.today).toBeCloseTo(29.51, 1);
  });

  it("includes today and spans at least two months", () => {
    const s = timelineScale([], NOW);
    expect(s.start).toBe("2026-10-01");
    expect(s.end).toBe("2026-12-01");
  });

  it("labels years when the range crosses one", () => {
    const s = timelineScale([{ startDate: "2026-11-10", dueDate: "2027-02-01" }], NOW);
    expect(s.months.map((m) => m.label)).toEqual(["Oct 2026", "Nov", "Dec", "Jan 2027", "Feb"]);
  });
});

describe("barGeometry", () => {
  const s = timelineScale([{ startDate: "2026-09-01", dueDate: "2026-12-09" }], NOW);
  it("spans start→due and flips labels past 80%", () => {
    const g = barGeometry(s, "2026-10-21", "2026-12-09");
    expect(g.left).toBeCloseTo(40.98, 1);
    expect(g.end).toBeCloseTo(81.15, 1);
    expect(g.flip).toBe(true);
    expect(barGeometry(s, "2026-09-12", "2026-10-21").flip).toBe(false);
  });
  it("keeps a minimum width", () => {
    expect(barGeometry(s, "2026-10-21", "2026-10-21").width).toBe(0.6);
  });
});

describe("groupTasksByStatus", () => {
  const statuses = [
    { id: "s_back", name: "Backlog", glyph: "backlog" as const, position: 0 },
    { id: "s_todo", name: "Todo", glyph: "todo" as const, position: 1 },
    { id: "s_prog", name: "In progress", glyph: "progress" as const, position: 2 },
    { id: "s_rev", name: "In review", glyph: "review" as const, position: 3 },
    { id: "s_done", name: "Done", glyph: "done" as const, position: 4 },
  ];
  it("orders groups In progress → In review → Todo → Backlog → Done and omits empty ones", () => {
    const tasks = [
      { statusId: "s_done", number: 41 },
      { statusId: "s_back", number: 63 },
      { statusId: "s_done", number: 38 },
      { statusId: "s_prog", number: 44 },
      { statusId: "s_gone", number: 1 },
    ];
    const g = groupTasksByStatus(tasks, statuses);
    expect(g.map((x) => x.status.name)).toEqual(["In progress", "Backlog", "Done"]);
    expect(g[2]!.tasks.map((t) => t.number)).toEqual([38, 41]);
  });
});

describe("misc", () => {
  it("matchTask searches key and title", () => {
    const t = { key: "PRJ-44", title: "Batch status updates" };
    expect(matchTask(t, "prj-4")).toBe(true);
    expect(matchTask(t, "BATCH")).toBe(true);
    expect(matchTask(t, "nope")).toBe(false);
    expect(matchTask(t, "  ")).toBe(true);
  });
  it("shortDate", () => {
    expect(shortDate("2026-10-21", NOW)).toBe("Oct 21");
    expect(shortDate("2027-01-05", NOW)).toBe("Jan 5, 2027");
    expect(shortDate(null, NOW)).toBe("No date");
  });
  it("defaultMilestoneId picks the first open milestone", () => {
    expect(defaultMilestoneId([{ id: "a", completedAt: "x" }, { id: "b", completedAt: null }])).toBe("b");
    expect(defaultMilestoneId([{ id: "a", completedAt: "x" }])).toBe("a");
    expect(defaultMilestoneId([])).toBeNull();
  });
  it("monthLabelStep thins labels on narrow tracks", () => {
    expect(monthLabelStep(4, 800)).toBe(1);
    expect(monthLabelStep(12, 240)).toBe(3);
  });
});
