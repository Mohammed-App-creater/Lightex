import { describe, expect, it } from "vitest";
import { activityCategory, dayLabel, groupByDay } from "./activity-feed";

describe("activity feed grouping", () => {
  const now = new Date(2026, 9, 7, 15, 0);
  it("labels days relative to now", () => {
    expect(dayLabel(new Date(2026, 9, 7, 9).toISOString(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 6, 23).toISOString(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 5, 10).toISOString(), now)).toBe("Mon, Oct 5");
  });
  it("groups consecutive entries by day and categorises verbs", () => {
    const items = [new Date(2026, 9, 7, 10), new Date(2026, 9, 7, 9), new Date(2026, 9, 6, 9)].map((d) => ({ createdAt: d.toISOString() }));
    expect(groupByDay(items, now).map((g) => [g.label, g.items.length])).toEqual([["Today", 2], ["Yesterday", 1]]);
    expect(activityCategory({ verb: "status_changed" })).toBe("status");
    expect(activityCategory({ verb: "member_added" })).toBe("member");
    expect(activityCategory({ verb: "created" })).toBe("other");
  });
});
