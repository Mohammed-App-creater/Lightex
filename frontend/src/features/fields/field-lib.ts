import type { CustomField, CustomFieldType, CustomFieldValue, FieldColor, Task, User } from "@/lib/api/types";
import { FIELD_COLORS } from "@/lib/api/types";
import { shortDate, todayISO } from "@/lib/utils/dates";

/* Custom-field logic shared by the panel, board card, list and settings (board 39). Pure; unit-tested. */

export const TYPE_LABEL: Record<CustomFieldType, string> = { text: "Text", number: "Number", select: "Select", date: "Date", user: "Person" };
export const FIELD_TYPES: CustomFieldType[] = ["text", "number", "select", "date", "user"];
export const FIELD_NAME_MAX = 40;
export const OPTION_NAME_MAX = 32;
export const TEXT_MAX = 120;
export const NUMBER_MAX = 1_000_000_000;

export const COLOR_NAMES: Record<FieldColor, string> = {
  "var(--low)": "Teal",
  "var(--accent-t)": "Blue",
  "var(--info)": "Violet",
  "var(--warn)": "Amber",
  "var(--orange)": "Orange",
  "var(--danger)": "Red",
  "var(--ok)": "Green",
  "var(--text-3)": "Gray",
};
export const PALETTE = FIELD_COLORS.map((token) => ({ token, name: COLOR_NAMES[token] }));

export const hasValue = (v: unknown): v is CustomFieldValue => v !== undefined && v !== null && v !== "";

export type Display = {
  text: string;
  /** Option colour (select). */
  color?: string;
  /** Resolved person (user). */
  user?: Pick<User, "id" | "name" | "hue">;
  /** Rendered in text-fg-3: "Removed option", "Former member". */
  muted?: boolean;
};

/** "Safari", "1,240", "Oct 9 · today", "Riley Chen", or the fallbacks for dangling values. Null when empty. */
export function displayValue(field: Pick<CustomField, "type" | "options">, value: CustomFieldValue | null | undefined, members: ReadonlyMap<string, Pick<User, "id" | "name" | "hue">>, today = todayISO()): Display | null {
  if (!hasValue(value)) return null;
  switch (field.type) {
    case "select": {
      const o = field.options.find((x) => x.id === value);
      return o ? { text: o.name, color: o.color } : { text: "Removed option", muted: true };
    }
    case "user": {
      const u = members.get(String(value));
      return u ? { text: u.name, user: u } : { text: "Former member", muted: true };
    }
    case "number":
      return { text: Number(value).toLocaleString("en-US") };
    case "date":
      return { text: `${shortDate(String(value))}${value === today ? " · today" : ""}` };
    default:
      return { text: String(value) };
  }
}

export type Validated = { ok: true; value: CustomFieldValue | null } | { ok: false; error: string };

/**
 * Client-side value check with the server's messages (§4.2). Text is trimmed and cut to 120; numbers
 * are clamped to 0…1e9 and rounded to 2 decimals (§8 #9–10). Empty means clear (null).
 */
export function validateValue(field: Pick<CustomField, "type" | "required" | "options">, raw: unknown, isMember: (id: string) => boolean = () => true): Validated {
  let v = raw;
  if (typeof v === "string") v = v.trim();
  if (v === null || v === undefined || v === "") return field.required ? { ok: false, error: "This field is required" } : { ok: true, value: null };
  switch (field.type) {
    case "text":
      return { ok: true, value: String(v).slice(0, TEXT_MAX) };
    case "number": {
      const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
      if (!Number.isFinite(n)) return { ok: false, error: "Enter a number from 0 to 1,000,000,000" };
      return { ok: true, value: Math.round(Math.min(NUMBER_MAX, Math.max(0, n)) * 100) / 100 };
    }
    case "select":
      return field.options.some((o) => o.id === v) ? { ok: true, value: String(v) } : { ok: false, error: "Pick one of the options" };
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? { ok: true, value: String(v) } : { ok: false, error: "Pick a date" };
    case "user":
      return isMember(String(v)) ? { ok: true, value: String(v) } : { ok: false, error: "Pick someone on this project" };
  }
}

/** Board card chip: the first select field by position that has a value ("Browser: Safari"). */
export function cardChip(task: Pick<Task, "customFields">, fields: readonly CustomField[]) {
  const sorted = [...fields].sort((a, b) => a.position - b.position);
  for (const f of sorted) {
    if (f.type !== "select") continue;
    const v = task.customFields?.[f.id];
    if (!hasValue(v)) continue;
    const o = f.options.find((x) => x.id === v);
    if (o) return { field: f.name, option: o.name, color: o.color };
  }
  return null;
}

/** Sort key for a list column; empty values sort last ascending. */
export function cfSortValue(task: Pick<Task, "customFields">, field: CustomField, users: ReadonlyMap<string, Pick<User, "name">>): string | number {
  const v = task.customFields?.[field.id];
  const num = field.type === "number" || field.type === "select";
  if (!hasValue(v)) return num ? Number.MAX_SAFE_INTEGER : "￿";
  if (field.type === "number") return Number(v);
  if (field.type === "select") return field.options.find((o) => o.id === v)?.position ?? Number.MAX_SAFE_INTEGER - 1;
  if (field.type === "user") return (users.get(String(v))?.name ?? "￾").toLowerCase();
  return String(v).toLowerCase();
}

/** Panel rows: fields with a value, required fields, and fields revealed this session through "Add property". */
export function visibleRows(fields: readonly CustomField[], task: Pick<Task, "customFields">, revealed: ReadonlySet<string>) {
  return [...fields].sort((a, b) => a.position - b.position).filter((f) => hasValue(task.customFields?.[f.id]) || f.required || revealed.has(f.id));
}

/** Name problem for the create/edit dialog, or null. */
export function fieldNameError(name: string, fields: readonly Pick<CustomField, "id" | "name">[], exceptId?: string): string | null {
  const n = name.trim();
  if (!n) return "Name is required";
  if (n.length > FIELD_NAME_MAX) return "Up to 40 characters";
  if (fields.some((f) => f.id !== exceptId && f.name.toLowerCase() === n.toLowerCase())) return "A field with this name exists";
  return null;
}

/** Options problem for a select field (blank rows ignored), or null. */
export function optionsError(options: readonly { name: string }[]): string | null {
  const names = options.map((o) => o.name.trim()).filter(Boolean);
  if (!names.length) return "Add at least one option";
  if (names.length > 50) return "Up to 50 options";
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return "Options must be unique";
  if (names.some((n) => n.length > OPTION_NAME_MAX)) return "Up to 32 characters";
  return null;
}

export const tasksText = (n: number) => (n === 1 ? "1 task" : `${n} tasks`);
