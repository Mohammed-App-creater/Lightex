import { describe, expect, it } from "vitest";
import vectors from "./span-vectors.json";
import {
  addDays,
  agendaDays,
  applyDelta,
  axisTicks,
  barGeometry,
  calendarKey,
  calendarMove,
  changedDates,
  datesForSpan,
  dayAtX,
  dayCenter,
  dayIndex,
  dayToX,
  defaultAnchor,
  derivedSpan,
  diffDays,
  dragModeAt,
  fillPercent,
  fmtDow,
  fromDayIndex,
  gridlines,
  inRange,
  isDependencyConflict,
  isValidISODate,
  monthGrid,
  normaliseCalendarAt,
  overlaps,
  parseCalendarParams,
  parseTimelineParams,
  pxToDays,
  sortBySpan,
  sortDay,
  spanOf,
  splitOverflow,
  timelineKey,
  weekendBands,
  windowOf,
  withCalendarParams,
  withTimelineParams,
  ZOOM,
} from "./schedule-lib";

describe("shared span/overlap vectors (§7.3)", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const from = c.from ?? "0000-01-01";
      const to = c.to ?? "9999-12-31";
      expect(inRange({ startDate: c.startDate, dueDate: c.dueDate }, from, to)).toBe(c.expected);
    });
  }

  it("derives the effective span from either date", () => {
    expect(spanOf({ startDate: null, dueDate: "2026-10-09" })).toEqual({ start: "2026-10-09", end: "2026-10-09" });
    expect(spanOf({ startDate: "2026-10-01", dueDate: null })).toEqual({ start: "2026-10-01", end: "2026-10-01" });
    expect(spanOf({ startDate: null, dueDate: null })).toBeNull();
    expect(overlaps({ start: "2026-10-01", end: "2026-10-05" }, "2026-10-05", "2026-10-06")).toBe(true);
  });
});

describe("day maths", () => {
  it("round-trips day indexes and never drifts across DST changes", () => {
    for (const iso of ["2026-03-29", "2026-03-30", "2026-10-25", "2026-10-26", "2026-03-08", "2026-11-01", "2026-11-02"]) {
      expect(fromDayIndex(dayIndex(iso))).toBe(iso);
    }
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29"); // EU spring forward
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30");
    expect(addDays("2026-10-24", 2)).toBe("2026-10-26"); // EU fall back
    expect(addDays("2026-03-07", 2)).toBe("2026-03-09"); // US spring forward
    expect(addDays("2026-10-31", 2)).toBe("2026-11-02"); // US fall back
    expect(diffDays("2026-03-01", "2026-04-01")).toBe(31);
    expect(diffDays("2026-10-01", "2026-11-01")).toBe(31);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("validates ISO dates", () => {
    expect(isValidISODate("2026-10-07")).toBe(true);
    expect(isValidISODate("2026-02-30")).toBe(false);
    expect(isValidISODate("2026-1-7")).toBe(false);
    expect(isValidISODate(null)).toBe(false);
  });

  it("formats with the weekday", () => {
    expect(fmtDow("2026-10-08")).toBe("Thu Oct 8");
  });
});

describe("zoom windows", () => {
  it("default anchors for today = 2026-10-07", () => {
    expect(defaultAnchor("week", "2026-10-07")).toBe("2026-09-28");
    expect(defaultAnchor("month", "2026-10-07")).toBe("2026-09-01");
    expect(defaultAnchor("quarter", "2026-10-07")).toBe("2026-07-01");
  });

  it("rolls the quarter and month back over a year boundary", () => {
    expect(defaultAnchor("quarter", "2027-01-15")).toBe("2026-10-01");
    expect(defaultAnchor("month", "2027-01-15")).toBe("2026-12-01");
    expect(defaultAnchor("week", "2027-01-03")).toBe("2026-12-21");
  });

  it("window lengths and pan steps", () => {
    expect([ZOOM.week.days, ZOOM.month.days, ZOOM.quarter.days]).toEqual([28, 91, 273]);
    expect([ZOOM.week.step, ZOOM.month.step, ZOOM.quarter.step]).toEqual([7, 28, 91]);
    expect(windowOf("month", "2026-09-01")).toEqual({ from: "2026-09-01", to: "2026-11-30", days: 91 });
    expect(windowOf("week", "2026-09-28").to).toBe("2026-10-25");
  });
});

describe("axis", () => {
  it("month zoom: month labels on top, Monday dates below, majors at month starts", () => {
    const win = windowOf("month", "2026-09-01");
    const t = axisTicks("month", win, "2026-10-07");
    expect(t.row1.map((x) => x.label)).toEqual(["Sep 2026", "Oct 2026", "Nov 2026"]);
    expect(t.row1[0]!.w).toBeCloseTo((30 / 91) * 100);
    // Sep 1 2026 is a Tuesday, so the first week segment has no label; the next starts Monday Sep 7.
    expect(t.row2[0]!.label).toBe("");
    expect(t.row2[1]!.label).toBe("7");
    const g = gridlines(t);
    expect(g.filter((x) => x.major)).toHaveLength(3);
  });

  it("week zoom crosses a month boundary with day ticks, weekends and today", () => {
    const win = windowOf("week", "2026-09-28");
    const t = axisTicks("week", win, "2026-10-07");
    expect(t.row1.map((x) => x.label)).toEqual(["Sep 2026", "Oct 2026"]);
    expect(t.row2).toHaveLength(28);
    expect(t.row2[3]!.label).toBe("1");
    expect(t.row2[9]!.today).toBe(true);
    expect(t.row2[5]!.weekend).toBe(true); // Sat Oct 3
    expect(weekendBands("week", win)).toHaveLength(4);
    expect(weekendBands("quarter", windowOf("quarter", "2026-07-01"))).toEqual([]);
  });

  it("quarter zoom crosses a year boundary", () => {
    const t = axisTicks("quarter", windowOf("quarter", "2026-10-01"), "2026-10-07");
    expect(t.row1.map((x) => x.label)).toEqual(["Q4 2026", "Q1 2027", "Q2 2027"]);
    expect(t.row2.slice(2, 4).map((x) => x.label)).toEqual(["Dec", "Jan"]);
  });

  it("day centres are inside the window or null", () => {
    const win = windowOf("week", "2026-09-28");
    expect(dayCenter("2026-09-28", win)).toBeCloseTo((0.5 / 28) * 100);
    expect(dayCenter("2026-10-26", win)).toBeNull();
  });
});

describe("date ↔ pixel geometry", () => {
  const win = windowOf("week", "2026-09-28"); // 28 days
  it("bar left/width in % of the window", () => {
    const g = barGeometry({ start: "2026-10-06", end: "2026-10-10" }, win);
    expect(g.left).toBeCloseTo((8 / 28) * 100);
    expect(g.width).toBeCloseTo((5 / 28) * 100);
  });

  it("snaps pixel deltas to whole days and maps x to the day under it", () => {
    // 560 px lane → 20 px a day
    expect(pxToDays(29, 560, win)).toBe(1);
    expect(pxToDays(31, 560, win)).toBe(2);
    expect(pxToDays(-9, 560, win)).toBe(0);
    expect(pxToDays(-11, 560, win)).toBe(-1);
    expect(dayAtX(0, 560, win)).toBe("2026-09-28");
    expect(dayAtX(199, 560, win)).toBe("2026-10-07");
    expect(dayAtX(5000, 560, win)).toBe("2026-10-25"); // clamped
    expect(dayToX("2026-10-08", 560, win)).toBe(200);
  });

  it("edge zones pick the resize handle; tiny bars only move", () => {
    expect(dragModeAt(4, 100, 9)).toBe("start");
    expect(dragModeAt(95, 100, 9)).toBe("end");
    expect(dragModeAt(50, 100, 9)).toBe("move");
    expect(dragModeAt(2, 20, 9)).toBe("move");
  });
});

describe("drag and keyboard reschedule", () => {
  const span = { start: "2026-10-06", end: "2026-10-10" };
  it("move, resize-left clamped to due, resize-right clamped to start", () => {
    expect(applyDelta(span, "move", 2)).toEqual({ start: "2026-10-08", end: "2026-10-12" });
    expect(applyDelta(span, "start", -3)).toEqual({ start: "2026-10-03", end: "2026-10-10" });
    expect(applyDelta(span, "start", 9)).toEqual({ start: "2026-10-10", end: "2026-10-10" });
    expect(applyDelta(span, "end", -9)).toEqual({ start: "2026-10-06", end: "2026-10-06" });
  });

  it("maps spans back to the dates the task has", () => {
    const both = { startDate: "2026-10-06", dueDate: "2026-10-10" };
    const dueOnly = { startDate: null, dueDate: "2026-10-12" };
    expect(datesForSpan(both, { start: "2026-10-08", end: "2026-10-12" }, "move")).toEqual({ startDate: "2026-10-08", dueDate: "2026-10-12" });
    expect(datesForSpan(dueOnly, { start: "2026-10-14", end: "2026-10-14" }, "move")).toEqual({ startDate: null, dueDate: "2026-10-14" });
    expect(datesForSpan(dueOnly, { start: "2026-10-12", end: "2026-10-15" }, "end")).toEqual({ startDate: "2026-10-12", dueDate: "2026-10-15" });
    expect(datesForSpan(dueOnly, { start: "2026-10-12", end: "2026-10-12" }, "start")).toEqual({ startDate: null, dueDate: "2026-10-12" });
    expect(changedDates(both, { startDate: "2026-10-03", dueDate: "2026-10-10" })).toEqual({ startDate: "2026-10-03" });
  });

  it("keyboard reducer: arrows move, Shift resizes the due edge, other keys ignored", () => {
    expect(timelineKey(span, "ArrowRight", false)).toEqual({ span: { start: "2026-10-07", end: "2026-10-11" }, mode: "move" });
    expect(timelineKey(span, "ArrowLeft", true)).toEqual({ span: { start: "2026-10-06", end: "2026-10-09" }, mode: "end" });
    expect(timelineKey({ start: "2026-10-06", end: "2026-10-06" }, "ArrowLeft", true)!.span.end).toBe("2026-10-06");
    expect(timelineKey(span, "Escape", false)).toBeNull();
    expect([calendarKey("ArrowLeft"), calendarKey("ArrowDown"), calendarKey("Enter")]).toEqual([-1, 7, null]);
  });

  it("calendar move keeps the duration", () => {
    expect(calendarMove({ startDate: "2026-10-06", dueDate: "2026-10-10" }, "2026-10-08")).toEqual({ startDate: "2026-10-04", dueDate: "2026-10-08" });
    expect(calendarMove({ startDate: null, dueDate: "2026-10-10" }, "2026-10-17")).toEqual({ startDate: null, dueDate: "2026-10-17" });
    expect(calendarMove({ startDate: null, dueDate: null }, "2026-10-12")).toEqual({ startDate: null, dueDate: "2026-10-12" });
  });
});

describe("calendar grid", () => {
  it("Oct 2026 starts Sep 28 with 5 rows", () => {
    expect(monthGrid("2026-10-19")).toMatchObject({ start: "2026-09-28", rows: 5, first: "2026-10-01", last: "2026-10-31" });
  });
  it("Feb 2027 starts on a Monday: exactly 4 rows", () => {
    expect(monthGrid("2027-02-10")).toMatchObject({ start: "2027-02-01", rows: 4 });
  });
  it("Aug 2026 needs 6 rows", () => {
    expect(monthGrid("2026-08-01")).toMatchObject({ start: "2026-07-27", rows: 6 });
  });
  it("normalises `at` to the 1st or the Monday", () => {
    expect(normaliseCalendarAt("month", "2026-10-19")).toBe("2026-10-01");
    expect(normaliseCalendarAt("week", "2026-10-08")).toBe("2026-10-05");
  });
});

describe("ordering, overflow, conflicts, fill", () => {
  it("day sort: progress, review, todo, backlog, done; then priority desc; then number", () => {
    const glyph: Record<string, "progress" | "review" | "todo" | "done" | "backlog"> = { p: "progress", r: "review", t: "todo", d: "done", b: "backlog" };
    const tasks = [
      { statusId: "d", priority: 4 as const, number: 1 },
      { statusId: "t", priority: 1 as const, number: 2 },
      { statusId: "t", priority: 3 as const, number: 3 },
      { statusId: "p", priority: 0 as const, number: 4 },
      { statusId: "b", priority: 4 as const, number: 5 },
      { statusId: "r", priority: 0 as const, number: 6 },
      { statusId: "t", priority: 3 as const, number: 0 },
    ];
    expect(sortDay(tasks, (id) => glyph[id]).map((t) => t.number)).toEqual([4, 6, 0, 3, 2, 5, 1]);
  });

  it("overflow split: 3 → 3, 4 → 2 + “+2”", () => {
    expect(splitOverflow([1, 2, 3])).toEqual({ shown: [1, 2, 3], more: 0 });
    expect(splitOverflow([1, 2, 3, 4])).toEqual({ shown: [1, 2], more: 2 });
  });

  it("dependency conflict when the blocked task starts on or before the blocker ends", () => {
    const blocker = { start: "2026-10-05", end: "2026-10-09" };
    expect(isDependencyConflict(blocker, { start: "2026-10-01", end: "2026-10-21" })).toBe(true);
    expect(isDependencyConflict(blocker, { start: "2026-10-09", end: "2026-10-21" })).toBe(true);
    expect(isDependencyConflict(blocker, { start: "2026-10-10", end: "2026-10-21" })).toBe(false);
  });

  it("fill by glyph", () => {
    expect(["done", "review", "progress", "todo", "backlog"].map((g) => fillPercent(g as "done"))).toEqual([100, 80, 45, 0, 0]);
  });

  it("orders bars by start then number; derives epic spans", () => {
    const a = { number: 2, startDate: "2026-10-03", dueDate: null };
    const b = { number: 1, startDate: null, dueDate: "2026-10-03" };
    const c = { number: 3, startDate: "2026-09-30", dueDate: "2026-10-12" };
    expect(sortBySpan([a, b, c]).map((t) => t.number)).toEqual([3, 1, 2]);
    expect(derivedSpan([a, b, c, { startDate: null, dueDate: null }])).toEqual({ start: "2026-09-30", end: "2026-10-12" });
    expect(derivedSpan([])).toBeNull();
  });

  it("agenda: the selected day plus days with tasks, up to 4 within 21 days", () => {
    const busy = new Set(["2026-10-08", "2026-10-09", "2026-10-12", "2026-10-20"]);
    expect(agendaDays("2026-10-07", (d) => busy.has(d))).toEqual(["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12"]);
    expect(agendaDays("2026-10-30", () => false)).toEqual(["2026-10-30"]);
  });
});

describe("URL state", () => {
  it("parses defaults and ignores invalid values", () => {
    expect(parseTimelineParams(new URLSearchParams("zoom=decade&at=2026-13-01&group=x&deps=1"))).toEqual({ zoom: "month", at: null, group: "epic", deps: true, tray: false });
    expect(parseTimelineParams(new URLSearchParams("zoom=week&at=2026-09-28&group=assignee&deps=0&tray=1"))).toEqual({
      zoom: "week",
      at: "2026-09-28",
      group: "assignee",
      deps: false,
      tray: true,
    });
    expect(parseCalendarParams(new URLSearchParams("mode=year&day=nope"))).toEqual({ mode: "month", at: null, day: null, tray: false });
  });

  it("serialises a round trip, omits defaults and keeps other params", () => {
    const qs = withTimelineParams("f=x&task=PRJ-1", { zoom: "quarter", at: "2026-07-01", group: "assignee", deps: false, tray: true });
    expect(parseTimelineParams(new URLSearchParams(qs))).toEqual({ zoom: "quarter", at: "2026-07-01", group: "assignee", deps: false, tray: true });
    expect(new URLSearchParams(qs).get("task")).toBe("PRJ-1");
    expect(withTimelineParams(qs, { zoom: "month", at: null, group: "epic", deps: true, tray: false })).toBe("?f=x&task=PRJ-1");
    const cq = withCalendarParams("", { mode: "week", at: "2026-10-05", day: "2026-10-07" });
    expect(parseCalendarParams(new URLSearchParams(cq))).toEqual({ mode: "week", at: "2026-10-05", day: "2026-10-07", tray: false });
    expect(withCalendarParams(cq, { mode: "month", at: null, day: null })).toBe("");
  });
});
