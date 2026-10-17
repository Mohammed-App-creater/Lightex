import { describe, expect, it } from "vitest";
import type { Epic, Task } from "@/lib/api/types";
import { EPIC_PALETTE, epicStats, nearestPaletteHue, pickable, splitEpics, validateEpicName } from "./epic-model";

const G = { d: "done", c: "canceled", p: "progress", r: "review", t: "todo", b: "backlog" } as const;
const glyph = (id: string) => G[id as keyof typeof G] ?? "todo";
const task = (id: string, statusId: string, p: Partial<Task> = {}) =>
  ({ id, key: `PRJ-${id}`, title: `T${id}`, statusId, epicId: null, parentId: null, deletedAt: null, ...p }) as Task;

describe("epicStats", () => {
  it("computes percent without canceled tasks and orders counts done to backlog", () => {
    const s = epicStats([task("1", "d"), task("2", "d"), task("3", "r"), task("4", "p"), task("5", "b"), task("6", "c")], glyph);
    expect(s.total).toBe(5);
    expect(s.pct).toBe(40);
    expect(s.visible).toEqual(["done", "review", "progress", "backlog"]);
    expect(s.segments.map((x) => [x.kind, x.width])).toEqual([
      ["done", 40],
      ["review", 20],
      ["progress", 20],
    ]);
    expect(s.aria).toBe("40% done: 2 done, 1 in review, 1 in progress, 1 backlog");
  });
  it("handles an empty epic", () => {
    const s = epicStats([], glyph);
    expect([s.total, s.pct, s.segments.length, s.aria]).toEqual([0, 0, 0, "0% done: no tasks"]);
  });
});

describe("validateEpicName", () => {
  const epics = [{ id: "a", name: "Auth overhaul" }];
  it("requires a unique title up to 60 chars", () => {
    expect(validateEpicName("  ", epics, null)).toBe("Title is required");
    expect(validateEpicName("auth OVERHAUL ", epics, null)).toBe("An epic with this name exists");
    expect(validateEpicName("Auth overhaul", epics, "a")).toBeNull();
    expect(validateEpicName("x".repeat(61), epics, null)).toMatch(/60/);
  });
});

describe("palette and picker", () => {
  it("has 8 colours and snaps random hues to the nearest", () => {
    expect(EPIC_PALETTE).toHaveLength(8);
    expect(nearestPaletteHue(165)).toBe(150);
    expect(nearestPaletteHue(355)).toBe(340);
    expect(nearestPaletteHue(5)).toBe(25);
  });
  it("offers only open top-level tasks without an epic", () => {
    const pool = pickable(
      [task("1", "t"), task("2", "d"), task("3", "t", { epicId: "e" }), task("4", "c"), task("5", "b", { parentId: "1" }), task("6", "p")],
      glyph,
    );
    expect(pool.map((t) => t.id)).toEqual(["1", "6"]);
  });
  it("splits archived epics out, newest archive first", () => {
    const e = (id: string, archivedAt: string | null) => ({ id, archivedAt }) as Epic;
    const r = splitEpics([e("a", null), e("b", "2026-09-01T00:00:00Z"), e("c", "2026-10-01T00:00:00Z")]);
    expect(r.active.map((x) => x.id)).toEqual(["a"]);
    expect(r.archived.map((x) => x.id)).toEqual(["c", "b"]);
  });
});
