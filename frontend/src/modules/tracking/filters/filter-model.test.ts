import { describe, expect, it } from "vitest";
import type { FilterRule, Task } from "@/lib/api/types";
import { applyFilters, cleanRulesFor, completeRules, fieldLabel, matchRule, opsFor, parseRule, parseRules, resolveDate, sameRules, serializeRule, withOp, withRules, type FieldDef, type MatchCtx } from "./filter-model";

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

describe("board 39 filters: blocked and custom fields (shared vectors with the backend)", () => {
  const fields: FieldDef[] = [
    { id: "br", type: "select", name: "Browser" },
    { id: "n", type: "number", name: "Accounts" },
    { id: "tx", type: "text", name: "Found in" },
    { id: "d", type: "date", name: "QA sign-off" },
    { id: "u", type: "user", name: "QA owner" },
  ];
  const c: MatchCtx = { ...ctx, fields };
  const tasks = [
    t(1, { isBlocked: true, customFields: { br: "safari", n: 1240, tx: "v2.3.1", u: "u1" } }),
    t(2, { isBlocked: false, customFields: { br: "chrome", n: 12.5, d: "2026-10-01" } }),
    t(3, { isBlocked: false, customFields: {} }),
  ];
  const ids = (rules: FilterRule[], x: MatchCtx = c) => applyFilters(tasks, rules, x).map((y) => y.number);

  it("matches blocked is yes / no", () => {
    expect(ids([{ field: "blocked", op: "is", values: ["true"] }])).toEqual([1]);
    expect(ids([{ field: "blocked", op: "is", values: ["false"] }])).toEqual([2, 3]);
  });

  it("matches every custom-field operator, with not matching empty and comparisons not", () => {
    expect(ids([{ field: "cf.tx", op: "set", values: [] }])).toEqual([1]);
    expect(ids([{ field: "cf.tx", op: "empty", values: [] }])).toEqual([2, 3]);
    expect(ids([{ field: "cf.n", op: "gt", values: ["100"] }])).toEqual([1]);
    expect(ids([{ field: "cf.n", op: "lt", values: ["12.6"] }])).toEqual([2]);
    expect(ids([{ field: "cf.br", op: "is", values: ["safari"] }])).toEqual([1]);
    expect(ids([{ field: "cf.br", op: "any", values: ["safari", "chrome"] }])).toEqual([1, 2]);
    expect(ids([{ field: "cf.br", op: "not", values: ["safari"] }])).toEqual([2, 3]);
    expect(ids([{ field: "cf.u", op: "is", values: ["me"] }])).toEqual([1]);
    expect(ids([{ field: "cf.d", op: "before", values: ["today"] }])).toEqual([2]);
    expect(ids([{ field: "cf.d", op: "after", values: ["2026-09-01"] }])).toEqual([2]);
    expect(ids([{ field: "cf.d", op: "empty", values: [] }])).toEqual([1, 3]);
  });

  it("ignores rules on deleted fields once definitions are known", () => {
    expect(ids([{ field: "cf.gone", op: "set", values: [] }])).toEqual([1, 2, 3]);
    expect(ids([{ field: "cf.gone", op: "set", values: [] }], ctx)).toEqual([]);
    expect(fieldLabel("cf.gone", fields)).toBe("Removed field");
    expect(fieldLabel("cf.br", fields)).toBe("Browser");
  });

  it("offers operators per type and round-trips cf rules through the URL", () => {
    expect(opsFor("cf.tx", fields)).toEqual(["set", "empty"]);
    expect(opsFor("cf.n", fields)).toEqual(["gt", "lt", "set", "empty"]);
    expect(opsFor("cf.d", fields)).toEqual(["before", "after", "empty"]);
    expect(opsFor("blocked")).toEqual(["is"]);
    const rules: FilterRule[] = [
      { field: "cf.p_prj-cf-accounts", op: "gt", values: ["12.5"] },
      { field: "blocked", op: "is", values: ["true"] },
      { field: "cf.tx", op: "set", values: [] },
    ];
    expect(parseRules(new URLSearchParams(withRules("", rules).slice(1)))).toEqual(rules);
    expect(parseRule("blocked:is:maybe")).toBeNull();
    expect(parseRule("cf.tx:set:junk")).toEqual({ field: "cf.tx", op: "set", values: [] });
    expect(withOp({ field: "cf.n", op: "gt", values: ["3"] }, "set").values).toEqual([]);
  });

  it("cleans saved-view rules for a project", () => {
    const raw: FilterRule[] = [
      { field: "cf.tx", op: "gt", values: ["1"] },
      { field: "cf.gone", op: "set", values: [] },
      { field: "cf.n", op: "gt", values: ["1"] },
      { field: "blocked", op: "is", values: ["true"] },
      { field: "status", op: "is", values: ["x"] },
    ];
    expect(cleanRulesFor(raw, fields).map((r) => r.field)).toEqual(["cf.n", "blocked", "status"]);
  });
});
