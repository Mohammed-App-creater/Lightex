import { describe, expect, it } from "vitest";
import {
  buildReportCsv,
  burndownSummary,
  csvCell,
  headerCaption,
  niceMax,
  normalizeCustom,
  parseRange,
  rangeLabel,
  rangeSearch,
  signed,
  spanLabel,
  yTicks,
} from "./lib";

const sp = (q: string) => new URLSearchParams(q);
const TODAY = "2026-10-07";

describe("niceMax / yTicks", () => {
  it("rounds up to the step", () => {
    expect(niceMax(47, 10)).toBe(50);
    expect(niceMax(48, 10)).toBe(50);
    expect(niceMax(33, 5)).toBe(35);
    expect(niceMax(12, 5)).toBe(15);
    expect(niceMax(50, 10)).toBe(50);
  });
  it("never goes below the step", () => {
    expect(niceMax(0, 10)).toBe(10);
    expect(niceMax(3, 10)).toBe(10);
    expect(niceMax(Number.NaN, 5)).toBe(5);
  });
  it("gives exactly three ticks with a rounded middle", () => {
    expect(yTicks(50)).toEqual([0, 25, 50]);
    expect(yTicks(35)).toEqual([0, 18, 35]);
    expect(yTicks(15)).toEqual([0, 8, 15]);
  });
});

describe("range labels", () => {
  it("labels presets and custom ranges", () => {
    expect(rangeLabel({ range: "last2" })).toBe("Last 2 sprints");
    expect(rangeLabel({ range: "last6" })).toBe("Last 6 sprints");
    expect(rangeLabel({ range: "last90" })).toBe("Last 90 days");
    expect(rangeLabel({ range: "custom", from: "2026-08-03", to: "2026-10-07" })).toBe("Aug 3 – Oct 7");
  });
  it("parses the URL with a Last 6 sprints default", () => {
    expect(parseRange(sp(""), TODAY)).toEqual({ range: "last6" });
    expect(parseRange(sp("range=bogus"), TODAY)).toEqual({ range: "last6" });
    expect(parseRange(sp("range=last90"), TODAY)).toEqual({ range: "last90" });
    expect(parseRange(sp("range=custom"), TODAY)).toEqual({ range: "custom", from: "2026-08-03", to: TODAY });
  });
  it("normalizes custom dates: swap, clamp to today, fall back on invalid", () => {
    expect(normalizeCustom("2026-09-30", "2026-09-01", TODAY)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(normalizeCustom("2026-09-01", "2026-12-01", TODAY)).toEqual({ from: "2026-09-01", to: TODAY });
    expect(normalizeCustom("", "2026-09-01", TODAY)).toEqual({ from: "2026-08-03", to: TODAY });
  });
  it("round-trips through the query string", () => {
    expect(rangeSearch({ range: "last6" })).toBe("");
    const q = rangeSearch({ range: "custom", from: "2026-08-03", to: "2026-10-01" });
    expect(parseRange(sp(q.slice(1)), TODAY)).toEqual({ range: "custom", from: "2026-08-03", to: "2026-10-01" });
  });
  it("builds the header caption and sprint span", () => {
    const sprint = { name: "Sprint 14", number: 14, startDate: "2026-10-01", endDate: "2026-10-14", dayIndex: 7, lengthDays: 14 };
    expect(headerCaption(sprint, { range: "last6" })).toBe("Sprint 14 · day 7 of 14 · Last 6 sprints");
    expect(headerCaption(null, { range: "last2" })).toBe("No active sprint · Last 2 sprints");
    expect(spanLabel("2026-10-01", "2026-10-14")).toBe("Oct 1–14");
    expect(spanLabel("2026-09-28", "2026-10-11")).toBe("Sep 28 – Oct 11");
  });
  it("signs scope change with a real minus", () => {
    expect(signed(6)).toBe("+6");
    expect(signed(-3)).toBe("−3");
    expect(signed(0)).toBe("0");
  });
});

describe("burndownSummary", () => {
  it("describes the last reached day", () => {
    const pts = [46, 43, 47, 40, 36, 27, 18].map((r, i) => ({ date: `2026-10-0${i + 1}`, remaining: r, ideal: [46, 42, 39, 35, 32, 28, 25][i]! }));
    pts.push({ date: "2026-10-08", remaining: null as unknown as number, ideal: 21 });
    const s = burndownSummary("Sprint 14", pts);
    expect(s.todayIdx).toBe(6);
    expect(s.text).toBe("Sprint 14 burndown: 18 of 46 points remaining on Oct 7, ideal 25, ahead of ideal.");
  });
});

describe("CSV", () => {
  it("escapes cells and neutralises formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(null)).toBe("");
  });
  it("builds sections from the loaded data", () => {
    const csv = buildReportCsv({
      project: { key: "PRJ", name: "Platform Rebuild" },
      range: { range: "last6" },
      generated: TODAY,
      kpis: {
        sprint: null,
        completedThisSprint: 23,
        plannedThisSprint: 31,
        avgCycleTimeDays: 3.7,
        p85CycleTimeDays: 6.3,
        overdueCount: 5,
        oldestOverdueKey: "PRJ-18",
        scopeChangePts: 6,
        completedSprints: 13,
      },
      velocity: [{ sprint: "S8", committed: 40, completed: 41 }],
      cycle: { bins: [{ label: "<1d", count: 18 }], total: 18, medianDays: 0.5 },
      throughput: [{ week: "2026-09-28", done: 11 }],
      progress: [{ id: "o1", kind: "objective", name: "Ship, beta", percent: 42, expected: 60 }],
    });
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe('Project,Platform Rebuild (PRJ)');
    expect(lines).toContain("Range,Last 6 sprints");
    expect(lines).toContain("Completed this sprint,23");
    expect(lines).toContain("Oldest overdue,PRJ-18");
    expect(lines).toContain("Sprint,Committed,Completed");
    expect(lines).toContain("S8,40,41");
    expect(lines).toContain("<1d,18");
    expect(lines).toContain("2026-09-28,11");
    expect(lines).toContain('objective,"Ship, beta",42,60,');
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv).not.toContain("Sprint burndown");
  });
});
