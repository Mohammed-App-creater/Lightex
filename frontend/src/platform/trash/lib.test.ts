import { describe, expect, it } from "vitest";
import type { TrashItem } from "@/lib/api/types";
import {
  agoLabel,
  canOpenTrash,
  countByKind,
  daysLeft,
  filterByTab,
  itemLabel,
  itemSub,
  leftLabel,
  pruneSelection,
  purgeWarning,
  refKey,
  restoredMessage,
  selectionState,
} from "./lib";

const DAY = 86_400_000;
const now = Date.parse("2026-10-07T12:00:00Z");

function item(p: Partial<TrashItem> & Pick<TrashItem, "kind" | "id">): TrashItem {
  return {
    title: "Thing",
    key: null,
    hue: null,
    parentKey: null,
    taskCount: null,
    project: null,
    deletedBy: null,
    deletedAt: new Date(now).toISOString(),
    purgeAt: new Date(now + 30 * DAY).toISOString(),
    ...p,
  };
}

describe("trash lib", () => {
  it("counts days left, rounding up and clamping at zero", () => {
    expect(daysLeft(new Date(now + 30 * DAY).toISOString(), now)).toBe(30);
    expect(daysLeft(new Date(now + 2.2 * DAY).toISOString(), now)).toBe(3);
    expect(daysLeft(new Date(now - DAY).toISOString(), now)).toBe(0);
    expect(leftLabel(1)).toBe("1 day left");
    expect(leftLabel(12)).toBe("12 days left");
    expect(leftLabel(0)).toBe("Today");
  });

  it("formats relative times", () => {
    expect(agoLabel(new Date(now - 30_000).toISOString(), now)).toBe("just now");
    expect(agoLabel(new Date(now - 2 * 3_600_000).toISOString(), now)).toBe("2h ago");
    expect(agoLabel(new Date(now - 3 * DAY).toISOString(), now)).toBe("3d ago");
  });

  it("labels items per kind", () => {
    expect(itemLabel(item({ kind: "task", id: "t", key: "PRJ-88", title: "Remove cookies" }))).toBe("PRJ-88 Remove cookies");
    expect(itemLabel(item({ kind: "comment", id: "c", parentKey: "PRJ-112" }))).toBe("comment on PRJ-112");
    expect(itemLabel(item({ kind: "project", id: "p", title: "Legacy API" }))).toBe("Legacy API");
    expect(itemSub(item({ kind: "project", id: "p", taskCount: 1 }))).toBe("1 task");
    expect(itemSub(item({ kind: "comment", id: "c", parentKey: "IN-9" }))).toBe("on IN-9");
  });

  it("filters, counts and tracks selection", () => {
    const list = [item({ kind: "task", id: "1" }), item({ kind: "comment", id: "2" }), item({ kind: "task", id: "3" })];
    expect(countByKind(list)).toEqual({ all: 3, task: 2, comment: 1, project: 0 });
    const tasks = filterByTab(list, "task");
    expect(tasks.map((i) => i.id)).toEqual(["1", "3"]);
    const sel = new Set([refKey(list[0]!), refKey(list[1]!)]);
    expect(selectionState(tasks, sel)).toBe("some");
    expect(selectionState(tasks, new Set(tasks.map(refKey)))).toBe("all");
    expect(selectionState(tasks, new Set())).toBe("none");
    expect([...pruneSelection(sel, tasks)]).toEqual(["task:1"]);
  });

  it("builds toast and warning copy", () => {
    expect(restoredMessage([item({ kind: "task", id: "1", key: "PRJ-1" })])).toBe("Restored PRJ-1");
    expect(restoredMessage([item({ kind: "task", id: "1" }), item({ kind: "comment", id: "2" })])).toBe("Restored 2 items");
    expect(purgeWarning([{ kind: "task" }])).toBe("Can’t be undone");
    expect(purgeWarning([{ kind: "project" }])).toBe("Can’t be undone · includes its tasks");
  });

  it("gates access like the server", () => {
    expect(canOpenTrash(["workspace.view"], [{ my_permissions: ["project.view"] }])).toBe(false);
    expect(canOpenTrash(["workspace.view"], [{ my_permissions: ["project.view", "comment.edit_own"] }])).toBe(true);
    expect(canOpenTrash(["workspace.view", "project.assign_admin"], [])).toBe(true);
  });
});
