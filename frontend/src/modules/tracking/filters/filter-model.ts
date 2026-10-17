import type { BaseFilterField, CustomField, CustomFieldType, FilterField, FilterOp, FilterRule, Task } from "@/lib/api/types";
import { addDaysISO } from "@/lib/utils/dates";

/*
 * Shared filter model for Board and List (board 30): field · operator · value rows combined
 * with AND. Pure and framework-free (the mock backend reuses it to count saved-view matches).
 * Board 39 adds `blocked` (is true/false) and `cf.<fieldId>` rules for custom fields.
 */

export const FILTER_FIELDS: { id: BaseFilterField | "blocked"; label: string }[] = [
  { id: "status", label: "Status" },
  { id: "priority", label: "Priority" },
  { id: "assignee", label: "Assignee" },
  { id: "label", label: "Label" },
  { id: "sprint", label: "Sprint" },
  { id: "due", label: "Due date" },
  { id: "epic", label: "Epic" },
  { id: "blocked", label: "Blocked" },
];

export const OP_LABEL: Record<FilterOp, string> = {
  is: "is",
  not: "is not",
  any: "is any of",
  empty: "is empty",
  before: "before",
  after: "after",
  set: "is not empty",
  gt: "greater than",
  lt: "less than",
};

/** Custom-field definitions the model needs (board 39): id → type, plus the name for labels. */
export type FieldDef = Pick<CustomField, "id" | "type"> & Partial<Pick<CustomField, "name">>;

export const CF_PREFIX = "cf.";
export const isCfField = (f: string): f is `cf.${string}` => f.startsWith(CF_PREFIX);
export const cfFieldId = (f: `cf.${string}`) => f.slice(CF_PREFIX.length);
export const cfField = (fieldId: string): `cf.${string}` => `cf.${fieldId}`;

/** "Status", "Blocked", a custom field's name, or "Removed field" when the field is gone. */
export function fieldLabel(f: FilterField, fields?: readonly FieldDef[]) {
  if (isCfField(f)) return fields?.find((x) => x.id === cfFieldId(f))?.name ?? "Removed field";
  return FILTER_FIELDS.find((x) => x.id === f)?.label ?? f;
}

/** Operators per custom-field type (board 39 §4.7). */
export const CF_OPS: Record<CustomFieldType, FilterOp[]> = {
  text: ["set", "empty"],
  number: ["gt", "lt", "set", "empty"],
  select: ["is", "not", "any", "empty"],
  user: ["is", "not", "any", "empty"],
  date: ["before", "after", "empty"],
};
const ALL_CF_OPS: FilterOp[] = ["is", "not", "any", "empty", "before", "after", "set", "gt", "lt"];

/**
 * Operators offered per field. Status is never empty; dates compare; Blocked is yes/no.
 * A custom field without a known type (definitions not loaded, or the field was deleted) allows
 * every custom-field operator, so a saved rule still parses.
 */
export function opsFor(field: FilterField, fields?: readonly FieldDef[]): FilterOp[] {
  if (field === "due") return ["before", "after", "empty"];
  if (field === "status") return ["is", "not", "any"];
  if (field === "blocked") return ["is"];
  if (isCfField(field)) {
    const def = fields?.find((x) => x.id === cfFieldId(field));
    return def ? CF_OPS[def.type] : ALL_CF_OPS;
  }
  return ["is", "not", "any", "empty"];
}

/** Operators that take no value. */
export const isValueless = (op: FilterOp) => op === "empty" || op === "set";
export const isMulti = (op: FilterOp) => op === "any";
export const isComplete = (r: FilterRule) => isValueless(r.op) || r.values.length > 0;
export const completeRules = (rules: FilterRule[]) => rules.filter(isComplete);

/** A new row for a field with its default operator and no value yet. */
export const newRule = (field: FilterField, fields?: readonly FieldDef[]): FilterRule => ({ field, op: opsFor(field, fields)[0]!, values: [] });

/** Changing the operator keeps what still makes sense (design: any keeps all, is/not keep one). */
export function withOp(r: FilterRule, op: FilterOp): FilterRule {
  if (isValueless(op)) return { ...r, op, values: [] };
  return { ...r, op, values: isMulti(op) ? r.values : r.values.slice(0, 1) };
}

export type MatchCtx = {
  meId: string;
  /** YYYY-MM-DD */
  today: string;
  /** Active sprint end, for the "sprint" due token. */
  sprintEnd?: string | null;
  /**
   * Custom-field definitions of the project (board 39). When given, a rule on a field that is not
   * listed (deleted after the view was saved) is ignored, i.e. it matches everything.
   */
  fields?: readonly FieldDef[];
};

/** The task fields filters read. Board 39 adds customFields and isBlocked (derived by the server). */
export type Filterable = Pick<Task, "statusId" | "priority" | "assigneeId" | "labelIds" | "sprintId" | "epicId" | "dueDate"> &
  Partial<Pick<Task, "customFields" | "isBlocked">>;

export const DUE_TOKENS = ["today", "tomorrow", "week", "sprint"] as const;

/** Resolves a due value (ISO date or relative token) to an ISO date, or null if unknown. */
export function resolveDate(v: string, ctx: MatchCtx): string | null {
  if (v === "today") return ctx.today;
  if (v === "tomorrow") return addDaysISO(ctx.today, 1);
  if (v === "week") return addDaysISO(ctx.today, 7);
  if (v === "sprint") return ctx.sprintEnd ?? null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function taskValues(t: Filterable, field: BaseFilterField): string[] {
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

const hasValue = (v: unknown) => v !== undefined && v !== null && v !== "";

/** Custom-field rule (board 39 §4.7). `not` matches an empty value; comparisons never do. */
function matchCustom(t: Filterable, field: `cf.${string}`, r: FilterRule, ctx: MatchCtx): boolean {
  const id = cfFieldId(field);
  if (ctx.fields && !ctx.fields.some((f) => f.id === id)) return true;
  const v = t.customFields?.[id];
  const has = hasValue(v);
  switch (r.op) {
    case "empty":
      return !has;
    case "set":
      return has;
    case "gt":
    case "lt": {
      const raw = r.values[0] ?? "";
      const n = Number(raw);
      if (!has || raw === "" || Number.isNaN(n) || typeof v !== "number") return false;
      return r.op === "gt" ? v > n : v < n;
    }
    case "before":
    case "after": {
      const d = resolveDate(r.values[0] ?? "", ctx);
      if (!has || !d) return false;
      return r.op === "before" ? String(v) < d : String(v) > d;
    }
    default: {
      const wanted = r.values.map((x) => (x === "me" ? ctx.meId : x));
      const hit = has && wanted.includes(String(v));
      return r.op === "not" ? !hit : hit;
    }
  }
}

export function matchRule(t: Filterable, r: FilterRule, ctx: MatchCtx): boolean {
  if (!isComplete(r)) return true;
  if (r.field === "blocked") return Boolean(t.isBlocked) === (r.values[0] === "true");
  if (isCfField(r.field)) return matchCustom(t, r.field, r, ctx);
  const field = r.field as BaseFilterField;
  const own = taskValues(t, field);
  if (r.op === "empty") return own.length === 0;
  if (field === "due") {
    const d = resolveDate(r.values[0]!, ctx);
    if (!t.dueDate || !d) return false;
    return r.op === "before" ? t.dueDate < d : t.dueDate > d;
  }
  const wanted = r.values.map((v) => (field === "assignee" && v === "me" ? ctx.meId : v));
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

/* ───────── URL: ?f=status:any:id1,id2&f=assignee:is:me&f=cf.<id>:gt:12.5 ───────── */

const FIELD_IDS = new Set<string>(FILTER_FIELDS.map((f) => f.id));
const VALUE_RE = /^[\w.-]{1,80}$/;
const CF_RE = /^cf\.[\w.-]{1,80}$/;
export const MAX_RULES = 12;

export function serializeRule(r: FilterRule) {
  return `${r.field}:${r.op}:${r.values.join(",")}`;
}

export function parseRule(raw: string): FilterRule | null {
  const [field, op, vals = ""] = raw.split(":");
  if (!field || !op || !(FIELD_IDS.has(field) || CF_RE.test(field))) return null;
  const f = field as FilterField;
  if (!opsFor(f).includes(op as FilterOp)) return null;
  const values = isValueless(op as FilterOp) ? [] : [...new Set(vals.split(",").filter((v) => VALUE_RE.test(v)))];
  if (f === "blocked" && values.some((v) => v !== "true" && v !== "false")) return null;
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

/**
 * Server-side rule cleaning for a project (board 39): `cf.<id>` rules are kept only when the field
 * exists and the operator suits its type; `blocked` rules need true/false. Invalid rows are dropped.
 */
export function cleanRulesFor(rules: FilterRule[], fields: readonly FieldDef[]): FilterRule[] {
  return rules.filter((r) => {
    if (r.field === "blocked") return r.op === "is" && r.values.length === 1 && (r.values[0] === "true" || r.values[0] === "false");
    if (isCfField(r.field)) {
      const def = fields.find((f) => f.id === cfFieldId(r.field as `cf.${string}`));
      if (!def || !CF_OPS[def.type].includes(r.op)) return false;
      if ((r.op === "gt" || r.op === "lt") && Number.isNaN(Number(r.values[0]))) return false;
      return true;
    }
    return true;
  });
}
