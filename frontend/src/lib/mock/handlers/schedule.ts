import type { ListQuery } from "@/lib/api/transport";
import type { MockDB, TaskRec } from "../db-types";
import { filterValues, invalid } from "../router";

/*
 * Board 32 (v2): timeline & calendar. REQUESTED API ADDITIONS, implemented from
 * docs/v2/32-timeline-calendar.md §4 with the same codes and messages:
 *   L1  GET /projects/:id/tasks gains filter[from], filter[to], filter[scheduled] and sort=startDate
 *   T1  PATCH /tasks/:id accepts startDate (format + order checks)
 *   T2  POST /projects/:id/tasks accepts startDate
 *   T3  POST /projects/:id/tasks/bulk refuses patch.startDate, checks patch.dueDate against starts
 *   P2  POST /projects/:id/epics, PATCH /epics/:id accept startDate/dueDate (both or neither)
 * The routes stay in tasks.ts / planning.ts; the rules live here so they can be unit-tested.
 */

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400;

/** A real calendar date in YYYY-MM-DD (2026-02-30 is refused). */
export function isISODate(v: unknown): v is string {
  if (typeof v !== "string" || !ISO_RE.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toISOString().slice(0, 10) === v;
}

const dayNo = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};

/** Effective span (§2.1): [startDate ?? dueDate, dueDate ?? startDate]; null when unscheduled. */
export function spanOf(t: { startDate?: string | null; dueDate?: string | null }): { start: string; end: string } | null {
  const start = t.startDate ?? t.dueDate ?? null;
  const end = t.dueDate ?? t.startDate ?? null;
  return start && end ? { start, end } : null;
}

/**
 * Parses and validates the L1 range parameters. Returns a predicate over task records, or null
 * when none of the three filters is present. Throws 422 `validation_failed` (§4.1 messages).
 */
export function scheduleFilter(query: ListQuery): ((t: Pick<TaskRec, "startDate" | "dueDate">) => boolean) | null {
  const from = filterValues(query, "from")[0];
  const to = filterValues(query, "to")[0];
  const scheduled = filterValues(query, "scheduled")[0];
  if (from === undefined && to === undefined && scheduled === undefined) return null;
  const errors: Record<string, string> = {};
  if (from !== undefined && !isISODate(from)) errors["filter[from]"] = "Pick a date";
  if (to !== undefined && !isISODate(to)) errors["filter[to]"] = "Pick a date";
  if (scheduled !== undefined && scheduled !== "true" && scheduled !== "false") errors["filter[scheduled]"] = "Use true or false";
  if (!errors["filter[from]"] && !errors["filter[to]"] && from !== undefined && to !== undefined) {
    if (to < from) errors["filter[to]"] = "End must be on or after the start";
    else if (dayNo(to) - dayNo(from) + 1 > MAX_RANGE_DAYS) errors["filter[to]"] = `Pick a range of ${MAX_RANGE_DAYS} days or less`;
  }
  if (Object.keys(errors).length) invalid(errors);
  return (t) => {
    const hasDate = Boolean(t.startDate || t.dueDate);
    if (scheduled === "true" && !hasDate) return false;
    if (scheduled === "false" && hasDate) return false;
    if (from === undefined && to === undefined) return true;
    const s = spanOf(t);
    if (!s) return false; // unscheduled tasks never match from/to
    if (from !== undefined && s.end < from) return false;
    if (to !== undefined && s.start > to) return false;
    return true;
  };
}

/** Sort value with a sentinel so missing dates sort last ascending (and first descending), §4.1. */
export function dateSortValue(v: unknown) {
  return typeof v === "string" && v ? v : "9999-99-99";
}

/**
 * Task date checks for PATCH and POST (§4.2): format first, then order on the resulting pair
 * (the sent value, else the stored one). The field key depends on which key was sent.
 */
export function checkTaskDates(body: Record<string, unknown>, stored: { startDate?: string | null; dueDate?: string | null } | null) {
  const sentStart = "startDate" in body && body.startDate !== undefined;
  const sentDue = "dueDate" in body && body.dueDate !== undefined;
  const errors: Record<string, string> = {};
  if (sentStart && body.startDate !== null && !isISODate(body.startDate)) errors.startDate = "Pick a date";
  if (sentDue && body.dueDate !== null && !isISODate(body.dueDate)) errors.dueDate = "Pick a date";
  if (Object.keys(errors).length) invalid(errors);
  const start = sentStart ? (body.startDate as string | null) : (stored?.startDate ?? null);
  const due = sentDue ? (body.dueDate as string | null) : (stored?.dueDate ?? null);
  if (start && due && start > due) {
    if (sentStart) invalid({ startDate: "Start date must be on or before the due date" });
    invalid({ dueDate: "Due date must be on or after the start date" });
  }
  return { start, due, sentStart, sentDue };
}

/** Bulk (§4.3): startDate is not bulk-editable; a dueDate before any selected task's start fails the request. */
export function checkBulkDates(patch: Record<string, unknown>, tasks: TaskRec[]) {
  if ("startDate" in patch) invalid({ "patch.startDate": "This field can’t be bulk-edited" });
  if (!("dueDate" in patch) || patch.dueDate === undefined || patch.dueDate === null) return;
  if (!isISODate(patch.dueDate)) invalid({ "patch.dueDate": "Pick a date" });
  const due = patch.dueDate;
  const bad = [...tasks].sort((a, b) => a.number - b.number).find((t) => t.startDate && t.startDate > due);
  if (bad) invalid({ "patch.dueDate": `${bad.key} starts after this date` });
}

/**
 * Epic dates (§4.4): both or neither, ordered. Returns the resulting pair, or undefined when the
 * body sends neither key (nothing to change).
 */
export function checkEpicDates(body: Record<string, unknown>, stored: { startDate?: string | null; dueDate?: string | null } | null) {
  const sentStart = "startDate" in body && body.startDate !== undefined;
  const sentDue = "dueDate" in body && body.dueDate !== undefined;
  if (!sentStart && !sentDue) return undefined;
  const errors: Record<string, string> = {};
  if (sentStart && body.startDate !== null && !isISODate(body.startDate)) errors.startDate = "Pick a date";
  if (sentDue && body.dueDate !== null && !isISODate(body.dueDate)) errors.dueDate = "Pick a date";
  if (Object.keys(errors).length) invalid(errors);
  const start = sentStart ? (body.startDate as string | null) : (stored?.startDate ?? null);
  const due = sentDue ? (body.dueDate as string | null) : (stored?.dueDate ?? null);
  if (Boolean(start) !== Boolean(due)) invalid({ startDate: "Set both dates or neither" });
  if (start && due && start > due) invalid({ dueDate: "Target date must be on or after the start date" });
  return { startDate: start, dueDate: due };
}

/* ───────── upgrade + seed (§6.9) ───────── */

const ANCHOR_UTC = Date.UTC(2026, 9, 7);

/** Design date (relative to 2026-10-07) → the same offset from the viewer's local today (as seed.ts D()). */
function designDate(iso: string) {
  const now = new Date();
  const todayUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const shift = Math.round((todayUTC - ANCHOR_UTC) / 86_400_000);
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + shift)).toISOString().slice(0, 10);
}

/** [task number, startDate, dueDate (the v1 seed value)], design dates. */
const PRJ_DATES: [number, string, string][] = [
  [31, "2026-09-24", "2026-09-30"],
  [33, "2026-10-02", "2026-10-14"],
  [34, "2026-10-06", "2026-10-10"],
  [38, "2026-10-09", "2026-10-16"],
  [40, "2026-09-22", "2026-10-02"],
  [42, "2026-10-01", "2026-10-21"],
  [44, "2026-10-05", "2026-10-08"],
  [48, "2026-10-05", "2026-10-09"],
  [49, "2026-09-03", "2026-09-10"],
  [50, "2026-09-29", "2026-10-06"],
  [52, "2026-10-14", "2026-10-20"],
  [53, "2026-09-25", "2026-09-29"],
  [54, "2026-10-12", "2026-10-14"],
  [57, "2026-10-05", "2026-10-15"],
  [58, "2026-10-12", "2026-10-17"],
  [60, "2026-09-01", "2026-09-08"],
  [61, "2026-09-24", "2026-10-01"],
  [62, "2026-09-21", "2026-09-28"],
  [65, "2026-10-01", "2026-10-05"],
  [66, "2026-10-13", "2026-10-18"],
  [67, "2026-10-20", "2026-10-26"],
  [71, "2026-10-14", "2026-10-19"],
];

const EPIC_DATES: Record<string, [string, string]> = {
  ep_auth: ["2026-09-14", "2026-10-23"],
  ep_board: ["2026-09-21", "2026-11-06"],
  ep_sprint: ["2026-09-01", "2026-10-30"],
  ep_bill: ["2026-09-01", "2026-11-20"],
};

/**
 * Runs once per database (marker `ext32`): from createSeed(), when a cached database loads and on
 * the first task-list request. Fills PRJ start dates only where startDate is still empty and the
 * due date still equals the seeded one (user edits in a cached DB survive), sets the four design
 * epic dates when the epic has none, and adds PRJ-50 → PRJ-52 (a satisfied-order arrow) when
 * board 39's dependencies exist. No SCHEMA bump.
 */
export function ensureExt32(db: MockDB) {
  if (db.ext32) return;
  db.ext32 = true;
  if (!db.projects.some((p) => p.id === "p_prj")) return;
  const task = (n: number) => db.tasks.find((t) => t.id === `p_prj-t${n}`);
  for (const [n, start, due] of PRJ_DATES) {
    const t = task(n);
    if (!t || t.startDate || t.dueDate !== designDate(due)) continue;
    t.startDate = designDate(start);
  }
  for (const [id, [start, due]] of Object.entries(EPIC_DATES)) {
    const e = db.epics.find((x) => x.id === id);
    if (!e || e.startDate || e.dueDate) continue;
    e.startDate = designDate(start);
    e.dueDate = designDate(due);
  }
  const a = task(50);
  const b = task(52);
  if (db.dependencies && a && b && !db.dependencies.some((d) => d.blockerId === a.id && d.blockedId === b.id)) {
    db.dependencies.push({ id: "dep_seed_32", projectId: "p_prj", blockerId: a.id, blockedId: b.id, createdById: "u_jordan", createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
  }
}
