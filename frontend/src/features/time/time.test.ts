import { describe, expect, it } from "vitest";
import type { Timesheet } from "@/lib/api/types";
import { checkEntry, checkEstimate, checkLogDate, formatClock, formatHours, formatMinutes, logHint, parseDuration } from "./duration";
import { canExport, cellText, csvName, heat, shiftWeek, timesheetCsv, weekLabel, weekStart } from "./timesheet-lib";

describe("parseDuration (§6.6)", () => {
  it.each([
    ["1:30", 90],
    ["1.5", 90],
    ["2", 120],
    ["12", 720],
    ["45", 45],
    ["1h 30m", 90],
    ["1h", 60],
    ["30m", 30],
    ["1.5h", 90],
    ["2 hours 5 mins", 125],
    ["  1H30M ", 90],
  ])("%s → %i minutes", (input, minutes) => {
    expect(parseDuration(input)).toEqual({ minutes });
  });

  it("reports empty and malformed input", () => {
    expect(parseDuration("")).toEqual({ error: "Enter a duration" });
    expect(parseDuration("   ")).toEqual({ error: "Enter a duration" });
    expect(parseDuration("soon")).toEqual({ error: "Use a format like 1h 30m" });
    expect(parseDuration("1:75")).toEqual({ error: "Use a format like 1h 30m" });
    expect(parseDuration("h")).toEqual({ error: "Use a format like 1h 30m" });
  });

  it("range-checks entries and estimates in order", () => {
    expect(checkEntry("")).toEqual({ error: "Enter a duration" });
    expect(checkEntry("0")).toEqual({ error: "Duration must be over 0" });
    expect(checkEntry("25h")).toEqual({ error: "Max 24h per entry" });
    expect(checkEntry("24h")).toEqual({ minutes: 1440 });
    expect(checkEstimate("0m")).toEqual({ error: "Estimate is 1 minute to 1000 hours" });
    expect(checkEstimate("1001h")).toEqual({ error: "Estimate is 1 minute to 1000 hours" });
    expect(checkEstimate("6h")).toEqual({ minutes: 360 });
  });

  it("checks log dates against local today and the 365-day floor", () => {
    expect(checkLogDate("", "2026-10-07")).toBe("Pick a date");
    expect(checkLogDate("2026-10-08", "2026-10-07")).toBe("Can’t log future time");
    expect(checkLogDate("2025-10-06", "2026-10-07")).toBe("Date is too far back");
    expect(checkLogDate("2025-10-07", "2026-10-07")).toBeNull();
    expect(checkLogDate("2026-10-07", "2026-10-07")).toBeNull();
  });
});

describe("time formatting", () => {
  it("formats minutes, clocks and hours", () => {
    expect([formatMinutes(265), formatMinutes(45), formatMinutes(360), formatMinutes(0), formatMinutes(-5)]).toEqual(["4h 25m", "45m", "6h", "0m", "0m"]);
    expect([formatClock(0), formatClock(754_000), formatClock(3_723_000)]).toEqual(["00:00", "12:34", "1:02:03"]);
    expect([formatHours(390), formatHours(480), formatHours(20)]).toEqual(["6.5", "8", "0.3"]);
    expect(logHint(90, "2026-10-07")).toMatch(/^= 1h 30m · Oct 7/);
  });
});

describe("timesheet lib", () => {
  it("does week maths with Monday starts", () => {
    expect(weekStart("2026-10-07")).toBe("2026-10-05");
    expect(weekStart("2026-10-11")).toBe("2026-10-05");
    expect(weekStart("2026-10-05")).toBe("2026-10-05");
    expect(shiftWeek("2026-10-05", -1)).toBe("2026-09-28");
    expect(weekLabel("2026-10-05")).toBe("Oct 5 – 11");
    expect(weekLabel("2026-09-28")).toBe("Sep 28 – Oct 4");
  });

  it("steps the heat scale from 0 to 8 h+", () => {
    expect(heat(0)).toEqual({ percent: 0, hi: false });
    expect(heat(60).percent).toBe(21);
    expect(heat(240)).toEqual({ percent: 47, hi: false });
    expect(heat(390)).toEqual({ percent: 69, hi: true });
    expect(heat(480).percent).toBe(82);
    expect(heat(900).percent).toBe(82);
    expect([cellText(0, false), cellText(390, false), cellText(390, true)]).toEqual(["–", "6.5", ""]);
  });

  const ts: Timesheet = {
    weekStart: "2026-10-05",
    days: ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"],
    projects: [
      { id: "p1", key: "PRJ", name: "Platform", hue: 1, my_permissions: ["project.view", "report.view"] },
      { id: "p2", key: "INF", name: "Infra", hue: 2, my_permissions: ["project.view"] },
    ],
    rows: [
      {
        user: { id: "u1", name: "Alex Kim", hue: 1, avatarUrl: null },
        cells: [390, 0, 120, 0, 0, 0, 0].map((minutes, i) => ({ date: `2026-10-0${5 + i}`.replace("-010", "-10"), minutes, breakdown: [] })),
        totalMinutes: 510,
      },
    ],
    dayTotals: [390, 0, 120, 0, 0, 0, 0],
    totalMinutes: 510,
  };

  it("builds the CSV with blank future days", () => {
    expect(timesheetCsv(ts, "2026-10-07").split("\n")).toEqual([
      "Person,Mon Oct 5,Tue Oct 6,Wed Oct 7,Thu Oct 8,Fri Oct 9,Sat Oct 10,Sun Oct 11,Total",
      "Alex Kim,6.5,0,2,,,,,8.5",
      "Total,6.5,0,2,,,,,8.5",
    ]);
    expect(csvName("PRJ", "2026-10-05")).toBe("timesheet-prj-2026-10-05.csv");
    expect(csvName(null, "2026-10-05")).toBe("timesheet-all-2026-10-05.csv");
  });

  it("neutralises spreadsheet formulas in person names", () => {
    const evil = { ...ts, rows: [{ ...ts.rows[0]!, user: { ...ts.rows[0]!.user, name: '=HYPERLINK("x","y")' } }] };
    expect(timesheetCsv(evil, "2026-10-07").split("\n")[1]).toBe(`"'=HYPERLINK(""x"",""y"")",6.5,0,2,,,,,8.5`);
  });

  it("gates export on report.view", () => {
    expect(canExport(ts, null)).toBe(true);
    expect(canExport(ts, "p1")).toBe(true);
    expect(canExport(ts, "p2")).toBe(false);
    expect(canExport({ projects: [ts.projects[1]!] }, null)).toBe(false);
    expect(canExport(undefined, null)).toBe(false);
  });
});
