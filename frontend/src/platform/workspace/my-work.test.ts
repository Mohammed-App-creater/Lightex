import { describe, expect, it } from "vitest";
import type { Status, Task } from "@/lib/api/types";
import { bucketTasks, deriveKey, dueLabel, dueSoon, homeStats, longDate, parseKeys, validateKey, weekEndISO, weekStartISO } from "./my-work";

const TODAY = "2026-10-07"; // Wednesday

const t = (id: string, dueDate: string | null, extra: Partial<Task> = {}) =>
  ({ id, key: id, dueDate, priority: 2, statusId: "todo", completedAt: null, updatedAt: "2026-10-01T00:00:00Z", ...extra }) as Task;

const ST: Record<string, Status> = {
  todo: { id: "todo", projectId: "p", name: "Todo", category: "todo", glyph: "todo", position: 1 },
  prog: { id: "prog", projectId: "p", name: "In progress", category: "in_progress", glyph: "progress", position: 2 },
  done: { id: "done", projectId: "p", name: "Done", category: "done", glyph: "done", position: 4 },
  cancel: { id: "cancel", projectId: "p", name: "Canceled", category: "done", glyph: "canceled", position: 5 },
};
const statusOf = (x: Task) => ST[x.statusId];

describe("week bounds", () => {
  it("runs Monday to Sunday", () => {
    expect(weekStartISO(TODAY)).toBe("2026-10-05");
    expect(weekEndISO(TODAY)).toBe("2026-10-11");
    expect(weekEndISO("2026-10-11")).toBe("2026-10-11");
    expect(longDate(TODAY)).toBe("Wednesday, Oct 7");
  });
});

describe("bucketTasks", () => {
  it("groups into the 5 date groups and drops empty ones", () => {
    const b = bucketTasks([t("a", "2026-10-01"), t("b", TODAY), t("c", "2026-10-11"), t("d", "2026-10-12"), t("e", null)], TODAY);
    expect(b.map((x) => [x.id, x.tasks.map((y) => y.id)])).toEqual([
      ["overdue", ["a"]],
      ["today", ["b"]],
      ["week", ["c"]],
      ["later", ["d"]],
      ["nodate", ["e"]],
    ]);
    expect(b[1]!.meta).toBe("Wed, Oct 7");
    expect(b[2]!.meta).toBe("Oct 8–11");
    expect(bucketTasks([t("x", null)], TODAY).map((x) => x.id)).toEqual(["nodate"]);
  });
  it("sorts by due date then priority", () => {
    const b = bucketTasks([t("lo", "2026-10-09", { priority: 1 }), t("hi", "2026-10-09", { priority: 4 }), t("early", "2026-10-08")], TODAY);
    expect(b[0]!.tasks.map((x) => x.id)).toEqual(["early", "hi", "lo"]);
  });
});

describe("dueLabel", () => {
  it("uses relative words near today and tones overdue/today", () => {
    expect(dueLabel("2026-10-07", false, TODAY)).toEqual({ text: "Today", tone: "soon" });
    expect(dueLabel("2026-10-08", false, TODAY)).toEqual({ text: "Tomorrow", tone: "" });
    expect(dueLabel("2026-10-06", false, TODAY)).toEqual({ text: "Yesterday", tone: "late" });
    expect(dueLabel("2026-10-09", false, TODAY).text).toBe("Fri");
    expect(dueLabel("2026-10-23", false, TODAY).text).toBe("Oct 23");
    expect(dueLabel("2026-10-05", true, TODAY).tone).toBe("muted");
    expect(dueLabel(null, false, TODAY)).toEqual({ text: "—", tone: "muted" });
  });
});

describe("home stats and due soon", () => {
  const tasks = [
    t("over", "2026-10-05"),
    t("today", TODAY, { statusId: "prog" }),
    t("later", "2026-10-20"),
    t("doneWk", "2026-10-06", { statusId: "done", completedAt: "2026-10-06T10:00:00Z" }),
    t("doneOld", "2026-09-20", { statusId: "done", completedAt: "2026-09-21T10:00:00Z" }),
    t("canceled", TODAY, { statusId: "cancel", completedAt: null }),
  ];
  it("counts the four stats", () => {
    expect(homeStats(tasks, statusOf, TODAY)).toEqual({ dueToday: 1, overdue: 1, inProgress: 1, doneThisWeek: 1 });
  });
  it("lists open tasks due this week, keeping just-closed ones", () => {
    expect(dueSoon(tasks, statusOf, new Set(), TODAY).map((x) => x.id)).toEqual(["over", "today"]);
    expect(dueSoon(tasks, statusOf, new Set(["doneWk"]), TODAY).map((x) => x.id)).toEqual(["over", "doneWk", "today"]);
  });
});

describe("new project key", () => {
  it("derives a key from the name like the design", () => {
    expect(deriveKey("Mobile Web")).toBe("MW");
    expect(deriveKey("Infra")).toBe("INF");
    expect(deriveKey("a b c d e f")).toBe("ABCDE");
    expect(deriveKey("")).toBe("");
  });
  it("validates format and taken keys", () => {
    expect(validateKey("", [])).toBe("Key required");
    expect(validateKey("A", [])).toBe("2–5 letters, A–Z");
    expect(validateKey("AB1", [])).toBe("2–5 letters, A–Z");
    expect(validateKey("PRJ", ["PRJ"])).toBe("PRJ is taken");
    expect(validateKey("MW", ["PRJ"])).toBeNull();
  });
  it("parses project filter keys", () => {
    expect(parseKeys("prj, mo,")).toEqual(["PRJ", "MO"]);
    expect(parseKeys(null)).toEqual([]);
  });
});
