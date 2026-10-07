import { describe, expect, it } from "vitest";
import type { Status } from "@/lib/api/types";
import { daysLabel, expectedPercent, isAtRisk, progressOf } from "./progress";

const statuses: Status[] = [
  { id: "todo", projectId: "p", name: "Todo", category: "todo", glyph: "todo", position: 0 },
  { id: "done", projectId: "p", name: "Done", category: "done", glyph: "done", position: 1 },
  { id: "x", projectId: "p", name: "Canceled", category: "done", glyph: "canceled", position: 2 },
];

describe("progress", () => {
  it("ignores canceled and deleted tasks", () => {
    const p = progressOf(
      [
        { statusId: "done", deletedAt: null },
        { statusId: "todo", deletedAt: null },
        { statusId: "x", deletedAt: null },
        { statusId: "done", deletedAt: "2026-01-01" },
      ],
      statuses,
    );
    expect(p).toEqual({ done: 1, total: 2, percent: 50 });
  });

  it("computes expected share of elapsed time and at-risk", () => {
    const now = new Date(2026, 9, 7);
    // Beta: Sep 12 → Oct 21, today Oct 7 → 25/39 ≈ 64%
    expect(expectedPercent("2026-09-12", "2026-10-21", now)).toBe(64);
    expect(isAtRisk(40, 64, false)).toBe(true);
    expect(isAtRisk(40, 64, true)).toBe(false);
  });

  it("labels days left / over", () => {
    const now = new Date(2026, 9, 7);
    expect(daysLabel("2026-10-21", false, now).text).toBe("14d left");
    expect(daysLabel("2026-10-07", false, now).text).toBe("Due today");
    expect(daysLabel("2026-10-04", false, now).text).toBe("3d over");
    expect(daysLabel("2026-10-04", true, now).text).toBe("Done");
  });
});
