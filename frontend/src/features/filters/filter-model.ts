import type { FilterField, FilterOp, FilterRule, Task } from "@/lib/api/types";
import { addDaysISO } from "@/lib/utils/dates";

/*
 * Shared filter model for Board and List (board 30): field · operator · value rows combined
 * with AND. Pure and framework-free (the mock backend reuses it to count saved-view matches).
 */

export const FILTER_FIELDS: { id: FilterField; label: string }[] = [
  { id: "status", label: "Status" },
  { id: "priority", label: "Priority" },
  { id: "assignee", label: "Assignee" },
  { id: "label", label: "Label" },
  { id: "sprint", label: "Sprint" },
  { id: "due", label: "Due date" },
  { id: "epic", label: "Epic" },
];

export const OP_LABEL: Record<FilterOp, string> = {
  is: "is",
  not: "is not",
  any: "is any of",
  empty: "is empty",
  before: "before",
  after: "after",
};

export const fieldLabel = (f: FilterField) => FILTER_FIELDS.find((x) => x.id === f)?.label ?? f;

/** Operators offered per field. Status is never empty; dates compare. */
export function opsFor(field: FilterField): FilterOp[] {
  if (field === "due") return ["before", "after", "empty"];
  if (field === "status") return ["is", "not", "any"];
  return ["is", "not", "any", "empty"];
}

export const isMulti = (op: FilterOp) => op === "any";
export const isComplete = (r: FilterRule) => r.op === "empty" || r.values.length > 0;
export const completeRules = (rules: FilterRule[]) => rules.filter(isComplete);

/** A new row for a field with its default operator and no value yet. */
export const newRule = (field: FilterField): FilterRule => ({ field, op: opsFor(field)[0]!, values: [] });

/** Changing the operator keeps what still makes sense (design: any keeps all, is/not keep one). */
export function withOp(r: FilterRule, op: FilterOp): FilterRule {
  if (op === "empty") return { ...r, op, values: [] };
  return { ...r, op, values: isMulti(op) ? r.values : r.values.slice(0, 1) };
}

export type MatchCtx = {
  meId: string;
  /** YYYY-MM-DD */
  today: string;
  /** Active sprint end, for the "sprint" due token. */
  sprintEnd?: string | null;
};

/** The task fields filters read (TaskRec in the mock satisfies this too). */
export type Filterable = Pick<Task, "statusId" | "priority" | "assigneeId" | "labelIds" | "sprintId" | "epicId" | "dueDate">;

export const DUE_TOKENS = ["today", "tomorrow", "week", "sprint"] as const;

/** Resolves a due value (ISO date or relative token) to an ISO date, or null if unknown. */
export function resolveDate(v: string, ctx: MatchCtx): string | null {
  if (v === "today") return ctx.today;
  if (v === "tomorrow") return addDaysISO(ctx.today, 1);
  if (v === "week") return addDaysISO(ctx.today, 7);
  if (v === "sprint") return ctx.sprintEnd ?? null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function taskValues(t: Filterable, field: FilterField): string[] {
  switch (field) {
    case "status":
      return [t.statusId];
    case "priority":
      return t.priority ? [String(t.priority)] : [];
    case "assignee":
      return t.assigneeId ? [t.assigneeId] : [];
    case "label":
      return t.labelIds;
    case "sprint":
      return t.sprintId ? [t.sprintId] : [];
    case "epic":
      return t.epicId ? [t.epicId] : [];
    case "due":
      return t.dueDate ? [t.dueDate] : [];
  }
}

export function matchRule(t: Filterable, r: FilterRule, ctx: MatchCtx): boolean {
  if (!isComplete(r)) return true;
  const own = taskValues(t, r.field);
  if (r.op === "empty") return own.length === 0;
  if (r.field === "due") {
    const d = resolveDate(r.values[0]!, ctx);
    if (!t.dueDate || !d) return false;
    return r.op === "before" ? t.dueDate < d : t.dueDate > d;
  }
  const wanted = r.values.map((v) => (r.field === "assignee" && v === "me" ? ctx.meId : v));
  const hit = own.some((x) => wanted.includes(x));
  return r.op === "not" ? !hit : hit;
}

export function matchAll(t: Filterable, rules: FilterRule[], ctx: MatchCtx) {
  return rules.every((r) => matchRule(t, r, ctx));
}

export function applyFilters<T extends Filterable>(tasks: T[], rules: FilterRule[], ctx: MatchCtx): T[] {
  const active = completeRules(rules);
  if (!active.length) return tasks;
  return tasks.filter((t) => matchAll(t, active, ctx));
}

/* ───────── URL: ?f=status:any:id1,id2&f=assignee:is:me ───────── */

const FIELD_IDS = new Set<string>(FILTER_FIELDS.map((f) => f.id));
const VALUE_RE = /^[\w.-]{1,80}$/;
export const MAX_RULES = 12;

export function serializeRule(r: FilterRule) {
  return `${r.field}:${r.op}:${r.values.join(",")}`;
}

export function parseRule(raw: string): FilterRule | null {
  const [field, op, vals = ""] = raw.split(":");
  if (!field || !op || !FIELD_IDS.has(field)) return null;
  const f = field as FilterField;
  if (!opsFor(f).includes(op as FilterOp)) return null;
  const values = op === "empty" ? [] : [...new Set(vals.split(",").filter((v) => VALUE_RE.test(v)))];
  return { field: f, op: op as FilterOp, values: isMulti(op as FilterOp) ? values : values.slice(0, 1) };
}

type ParamsLike = { getAll(name: string): string[]; get(name: string): string | null };

/** Reads rules from the URL. A legacy `?epic=<id>` link becomes "Epic is <id>". */
export function parseRules(params: ParamsLike): FilterRule[] {
  const rules = params
    .getAll("f")
    .map(parseRule)
    .filter((r): r is FilterRule => Boolean(r))
    .slice(0, MAX_RULES);
  const epic = params.get("epic");
  if (epic && VALUE_RE.test(epic) && !rules.some((r) => r.field === "epic")) rules.push({ field: "epic", op: "is", values: [epic] });
  return rules;
}

/** Returns a query string ("" or "?…") with the rules replacing any previous `f`/`epic`/`view`. */
export function withRules(search: string, rules: FilterRule[], viewId?: string | null) {
  const sp = new URLSearchParams(search);
  sp.delete("f");
  sp.delete("epic");
  sp.delete("view");
  for (const r of rules.slice(0, MAX_RULES)) sp.append("f", serializeRule(r));
  if (viewId) sp.set("view", viewId);
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export function sameRules(a: FilterRule[], b: FilterRule[]) {
  return a.length === b.length && a.every((r, i) => serializeRule(r) === serializeRule(b[i]!));
}
