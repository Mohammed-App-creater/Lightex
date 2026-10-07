import { describe, expect, it } from "vitest";
import type { FilterRule, Task } from "@/lib/api/types";
import { applyFilters, completeRules, matchRule, parseRule, parseRules, resolveDate, sameRules, serializeRule, withOp, withRules, type MatchCtx } from "./filter-model";

const ctx: MatchCtx = { meId: "u1", today: "2026-10-07", sprintEnd: "2026-10-14" };
const t = (n: number, over: Partial<Task> = {}): Task =>
  ({ id: `t${n}`, number: n, statusId: "todo", priority: 0, assigneeId: null, labelIds: [], dueDate: null, epicId: null, sprintId: null, ...over }) as Task;

describe("filter model", () => {
  const tasks = [
    t(1, { statusId: "prog", assigneeId: "u1", labelIds: ["bug"], priority: 4, dueDate: "2026-10-09" }),
    t(2, { statusId: "review", assigneeId: "u2", labelIds: ["perf"], priority: 2, dueDate: "2026-10-20" }),
    t(3, { statusId: "done", labelIds: [], priority: 3 }),
  ];
  const ids = (rules: FilterRule[]) => applyFilters(tasks, rules, ctx).map((x) => x.number);

  it("combines rows with AND and ignores incomplete rows", () => {
    expect(ids([{ field: "status", op: "any", values: ["prog", "review"] }, { field: "assignee", op: "is", values: ["me"] }])).toEqual([1]);
    expect(ids([{ field: "label", op: "is", values: [] }])).toEqual([1, 2, 3]);
  });

  it("supports is not, is empty and date comparisons with relative tokens", () => {
    expect(ids([{ field: "status", op: "not", values: ["done"] }])).toEqual([1, 2]);
    expect(ids([{ field: "assignee", op: "empty", values: [] }])).toEqual([3]);
    expect(ids([{ field: "due", op: "before", values: ["week"] }])).toEqual([1]);
    expect(ids([{ field: "due", op: "after", values: ["sprint"] }])).toEqual([2]);
    expect(matchRule(tasks[2]!, { field: "due", op: "before", values: ["2030-01-01"] }, ctx)).toBe(false);
    expect(resolveDate("tomorrow", ctx)).toBe("2026-10-08");
    expect(resolveDate("sprint", { ...ctx, sprintEnd: null })).toBeNull();
  });

  it("round-trips through the URL and drops junk", () => {
    const rules: FilterRule[] = [
      { field: "status", op: "any", values: ["prog", "review"] },
      { field: "due", op: "empty", values: [] },
    ];
    const qs = withRules("task=PRJ-1&view=v1", rules);
    const sp = new URLSearchParams(qs.slice(1));
    expect(sp.get("task")).toBe("PRJ-1");
    expect(sp.get("view")).toBeNull();
    expect(sameRules(parseRules(sp), rules)).toBe(true);
    expect(parseRule("nope:is:x")).toBeNull();
    expect(parseRule("status:empty:x")).toBeNull();
    expect(parseRule("label:is:a,b")).toEqual({ field: "label", op: "is", values: ["a"] });
    expect(parseRule("label:any:a,<b>")).toEqual({ field: "label", op: "any", values: ["a"] });
    expect(serializeRule(rules[0]!)).toBe("status:any:prog,review");
  });

  it("turns a legacy ?epic= link into a rule and keeps view ids", () => {
    const sp = new URLSearchParams("epic=ep_1");
    expect(parseRules(sp)).toEqual([{ field: "epic", op: "is", values: ["ep_1"] }]);
    expect(new URLSearchParams(withRules("epic=ep_1", [], "v9").slice(1)).toString()).toBe("view=v9");
  });

  it("keeps values sensibly when the operator changes", () => {
    const r: FilterRule = { field: "label", op: "any", values: ["a", "b"] };
    expect(withOp(r, "is").values).toEqual(["a"]);
    expect(withOp(r, "empty").values).toEqual([]);
    expect(completeRules([withOp(r, "empty"), { field: "label", op: "is", values: [] }])).toHaveLength(1);
  });
});
