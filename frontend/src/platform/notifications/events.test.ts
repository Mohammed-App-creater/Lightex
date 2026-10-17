import { describe, expect, it } from "vitest";
import type { Notification } from "@/lib/api/types";
import { dueLabel, glyphForStatusName, groupByDay, rowLabel, verbText } from "./events";

const base: Notification = {
  id: "n1",
  type: "mention",
  actorId: "u1",
  projectId: "p",
  projectName: "Platform Rebuild",
  taskId: "t",
  taskKey: "PRJ-48",
  taskTitle: "Token refresh race on cold start",
  payload: {},
  createdAt: new Date().toISOString(),
  readAt: null,
};
const mk = (p: Partial<Notification>): Notification => ({ ...base, ...p });

describe("groupByDay", () => {
  it("splits Today / Earlier by local day and drops empty groups", () => {
    const now = new Date(2026, 9, 7, 15, 0);
    const today = mk({ id: "a", createdAt: new Date(2026, 9, 7, 9, 0).toISOString() });
    const old = mk({ id: "b", createdAt: new Date(2026, 9, 6, 23, 0).toISOString() });
    const g = groupByDay([today, old], now);
    expect(g.map((x) => [x.label, x.items.map((i) => i.id)])).toEqual([
      ["Today", ["a"]],
      ["Earlier", ["b"]],
    ]);
    expect(groupByDay([old], now).map((x) => x.id)).toEqual(["earlier"]);
    expect(groupByDay([], now)).toEqual([]);
  });
});

describe("verb text", () => {
  it("renders actor + verb per type", () => {
    expect(verbText(mk({ type: "mention" }), "Sam Patel")).toBe("Sam Patel mentioned you");
    expect(verbText(mk({ type: "assigned" }), "Jordan Lee")).toBe("Jordan Lee assigned you");
    expect(verbText(mk({ type: "comment" }), "Morgan Diaz")).toBe("Morgan Diaz commented");
    expect(verbText(mk({ type: "status", payload: { toStatus: "In review" } }), "Riley Chen")).toBe("Riley Chen moved to In review");
    expect(verbText(mk({ type: "sprint", payload: { sprintName: "Sprint 14" } }), "Jordan Lee")).toBe("Jordan Lee started Sprint 14");
  });

  it("uses the due label for system events", () => {
    expect(verbText(mk({ type: "due", actorId: null, payload: { dueDate: "2026-10-08" } }), null, "2026-10-07")).toBe("Due tomorrow");
    expect(dueLabel("2026-10-07", "2026-10-07")).toBe("Due today");
    expect(dueLabel("2026-10-01", "2026-10-07")).toBe("Overdue");
  });

  it("builds the row aria-label", () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    const n = mk({ createdAt: "2026-10-07T11:48:00Z" });
    expect(rowLabel(n, "Sam Patel", now)).toBe("Unread. Sam Patel mentioned you, PRJ-48 Token refresh race on cold start, 12m ago");
    expect(rowLabel({ ...n, readAt: n.createdAt }, "Sam Patel", now).startsWith("Sam Patel")).toBe(true);
  });

  it("maps status names to glyphs", () => {
    expect(glyphForStatusName("In review")).toBe("review");
    expect(glyphForStatusName("In progress")).toBe("progress");
    expect(glyphForStatusName("Done")).toBe("done");
    expect(glyphForStatusName("QA", [{ name: "QA", glyph: "review" }])).toBe("review");
  });
});
