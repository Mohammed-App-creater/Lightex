import type {
  AuditChange,
  CustomField,
  CustomFieldOption,
  CustomFieldType,
  CustomFieldValue,
  DependencyItem,
  FieldColor,
  FilterRule,
  Permission,
  RunningTimer,
  TaskDependencies,
  TimeEntry,
  Timesheet,
  TimesheetSlice,
} from "@/lib/api/types";
import { FIELD_COLORS } from "@/lib/api/types";
import { nowISO, uid } from "../db";
import type { CustomFieldRec, DependencyRec, MockDB, TaskRec } from "../db-types";
import { openBlockersOf, projectMembership, projectPermissions, wsMembership } from "../derive";
import { fail, filterValues, invalid, requireProject, requireUser, route, wsBySlug, type Ctx } from "../router";
import { logActivity } from "./common";
import { memberProject } from "./projects";
import { canEditTask } from "./tasks";
import { store as viewStore } from "./views";

/*
 * Board 39 (v2): custom fields, dependencies, time tracking. REQUESTED API ADDITIONS, implemented
 * from docs/v2/39-fields-dependencies-time.md §4 with the same status codes, codes and messages:
 *   F1–F5  /projects/:id/custom-fields (+ /order), /custom-fields/:id
 *   D1–D3  /tasks/:id/dependencies (+ /:dependencyId)
 *   E1–E3  /tasks/:id/time-entries, /time-entries/:id
 *   R1–R3  /me/timer, /tasks/:id/timer, /me/timer/stop
 *   S1     /workspaces/:slug/timesheet
 * PATCH /tasks/:id (customFields, timeEstimateMinutes) goes through applyTaskExtPatch below.
 */

export const FIELD_LIMIT = 50;
export const OPTION_LIMIT = 50;
export const DEP_LIMIT = 50;
const TYPES: CustomFieldType[] = ["text", "number", "select", "date", "user"];
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ───────── upgrade + seed ───────── */

const NEW_GRANTS: Record<string, Permission[]> = {
  project_admin: ["field.manage", "time.log", "time.delete_any"],
  manager: ["field.manage", "time.log", "time.delete_any"],
  project_member: ["time.log"],
};

/**
 * Runs once per database (marker `ext39`): from createSeed(), when a cached v1 database loads, and
 * on first use of any board 39 route. 1) adds the new permissions to cached system roles by key
 * (custom roles untouched), 2) seeds PRJ fields, values, dependencies and time, 3) adds a personal
 * pinned "Blocked" view for every PRJ member who has no view named "Blocked".
 */
export function ensureExt39(db: MockDB) {
  db.customFields ??= [];
  db.dependencies ??= [];
  db.timeEntries ??= [];
  db.timers ??= [];
  if (db.ext39) return;
  db.ext39 = true;
  for (const r of db.roles) {
    if (!r.isSystem || !r.key) continue;
    for (const p of NEW_GRANTS[r.key] ?? []) if (!r.permissions.includes(p)) r.permissions.push(p);
  }
  if (db.projects.some((p) => p.id === "p_prj")) {
    seedPrj(db);
    seedBlockedViews(db);
  }
}

const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** Seed date relative to the design's "today" (2026-10-07), shifted to the real today. */
function rel(daysFromToday: number) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + daysFromToday);
  return isoOf(d);
}

function seedPrj(db: MockDB) {
  const P = "p_prj";
  const opt = (id: string, name: string, color: FieldColor, position: number): CustomFieldOption => ({ id: `p_prj-cf-browser-${id}`, name, color, position });
  const created = new Date(Date.now() - 6 * 86_400_000).toISOString();
  const defs: CustomFieldRec[] = [
    {
      id: "p_prj-cf-browser",
      projectId: P,
      name: "Browser",
      type: "select",
      required: false,
      position: 0,
      options: [opt("chrome", "Chrome", "var(--low)", 0), opt("safari", "Safari", "var(--accent-t)", 1), opt("firefox", "Firefox", "var(--orange)", 2), opt("edge", "Edge", "var(--info)", 3)],
      createdAt: created,
    },
    { id: "p_prj-cf-found", projectId: P, name: "Found in", type: "text", required: true, position: 1, options: [], createdAt: created },
    { id: "p_prj-cf-accounts", projectId: P, name: "Accounts affected", type: "number", required: false, position: 2, options: [], createdAt: created },
    { id: "p_prj-cf-qasignoff", projectId: P, name: "QA sign-off", type: "date", required: false, position: 3, options: [], createdAt: created },
    { id: "p_prj-cf-qaowner", projectId: P, name: "QA owner", type: "user", required: false, position: 4, options: [], createdAt: created },
  ];
  if (!db.customFields!.some((f) => f.projectId === P)) db.customFields!.push(...defs);

  const task = (n: number) => db.tasks.find((t) => t.id === `${P}-t${n}`);
  const values: [number, Record<string, CustomFieldValue>][] = [
    [42, { "p_prj-cf-browser": "p_prj-cf-browser-safari", "p_prj-cf-found": "v2.3.1", "p_prj-cf-accounts": 1240, "p_prj-cf-qaowner": "u_riley" }],
    [48, { "p_prj-cf-browser": "p_prj-cf-browser-chrome", "p_prj-cf-found": "v2.3.0", "p_prj-cf-accounts": 310, "p_prj-cf-qaowner": "u_sam" }],
    [53, { "p_prj-cf-browser": "p_prj-cf-browser-firefox", "p_prj-cf-found": "v2.2.4", "p_prj-cf-accounts": 18, "p_prj-cf-qasignoff": rel(-9), "p_prj-cf-qaowner": "u_morgan" }],
    [51, { "p_prj-cf-browser": "p_prj-cf-browser-safari", "p_prj-cf-found": "v2.3.1" }],
    [33, { "p_prj-cf-found": "v2.3.0", "p_prj-cf-qaowner": "u_jordan" }],
  ];
  for (const [n, v] of values) {
    const t = task(n);
    if (t) t.customFields = { ...v, ...(t.customFields ?? {}) };
  }

  const deps: [number, number][] = [
    [48, 42],
    [40, 42],
    [42, 47],
    [42, 68],
    [57, 58],
  ];
  deps.forEach(([blocker, blocked], i) => {
    const a = task(blocker);
    const b = task(blocked);
    if (!a || !b || db.dependencies!.some((d) => d.blockerId === a.id && d.blockedId === b.id)) return;
    db.dependencies!.push({ id: `dep_seed_${i + 1}`, projectId: P, blockerId: a.id, blockedId: b.id, createdById: "u_jordan", createdAt: new Date(Date.now() - (5 - i) * 3_600_000).toISOString() });
  });

  const t42 = task(42);
  if (t42) {
    t42.timeEstimateMinutes = 360;
    const at = (iso: string, h: number) => new Date(`${iso}T${String(h).padStart(2, "0")}:40:00`).toISOString();
    db.timeEntries!.push(
      { id: "te_seed_1", taskId: t42.id, projectId: P, userId: "u_alex", minutes: 90, date: rel(-2), note: "Repro + profiling", source: "manual", createdAt: at(rel(-2), 16) },
      { id: "te_seed_2", taskId: t42.id, projectId: P, userId: "u_jordan", minutes: 45, date: rel(-1), note: "Safari check", source: "manual", createdAt: at(rel(-1), 11) },
      { id: "te_seed_3", taskId: t42.id, projectId: P, userId: "u_alex", minutes: 120, date: rel(0), note: "ResizeObserver fix", source: "timer", createdAt: at(rel(0), 9) },
    );
  }
  seedTimesheet(db);
}

/** Small integer hash (no Math.random): the same inputs always give the same entries. */
function mix(...n: number[]) {
  let h = 2166136261;
  for (const x of n) {
    h ^= x + 0x9e3779b9;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/** Weekday entries (1–4 h, 30-minute steps) for this and last week up to today, PRJ/MOB/INF members, on their open assigned tasks. */
function seedTimesheet(db: MockDB) {
  const projects = ["p_prj", "p_mob", "p_inf"];
  const today = rel(0);
  const monday = weekStartOf(today);
  const start = addDays(monday, -7);
  let n = 0;
  projects.forEach((pid, pi) => {
    const done = new Set(db.statuses.filter((s) => s.projectId === pid && s.category === "done").map((s) => s.id));
    const members = db.projectMembers.filter((m) => m.projectId === pid);
    members.forEach((m) => {
      const ui = db.users.findIndex((u) => u.id === m.userId);
      const open = db.tasks.filter((t) => t.projectId === pid && t.assigneeId === m.userId && !t.deletedAt && !done.has(t.statusId) && t.id !== "p_prj-t42");
      if (!open.length) return;
      for (let d = 0; d < 14; d++) {
        const date = addDays(start, d);
        if (date > today || d % 7 >= 5) continue;
        const h = mix(ui, d, pi);
        if (h % 10 < 4) continue;
        const minutes = 60 + ((h >>> 4) % 7) * 30;
        const t = open[(h >>> 8) % open.length]!;
        n += 1;
        db.timeEntries!.push({
          id: `te_gen_${n}`,
          taskId: t.id,
          projectId: pid,
          userId: m.userId,
          minutes,
          date,
          note: (h >>> 12) % 3 === 0 ? "" : ["Implementation", "Review fixes", "Pairing", "Investigation", "Tests"][(h >>> 14) % 5]!,
          source: (h >>> 16) % 4 === 0 ? "timer" : "manual",
          createdAt: new Date(`${date}T17:${String(10 + (h % 40)).padStart(2, "0")}:00`).toISOString(),
        });
      }
    });
  });
}

function seedBlockedViews(db: MockDB) {
  const { views, pins } = viewStore(db);
  for (const m of db.projectMembers.filter((x) => x.projectId === "p_prj")) {
    const ws = db.projects.find((p) => p.id === "p_prj")!.workspaceId;
    if (!wsMembership(db, m.userId, ws)) continue;
    if (views.some((v) => v.ownerId === m.userId && v.name.toLowerCase() === "blocked")) continue;
    const id = `vw_blocked_${m.userId}`;
    const filters: FilterRule[] = [{ field: "blocked", op: "is", values: ["true"] }];
    views.push({ id, workspaceId: ws, projectId: "p_prj", ownerId: m.userId, name: "Blocked", icon: "flag", visibility: "me", layout: "board", filters, createdAt: nowISO() });
    const last = Math.max(-1, ...pins.filter((p) => p.userId === m.userId).map((p) => p.position));
    pins.push({ userId: m.userId, viewId: id, position: last + 1 });
  }
}

/* ───────── date helpers (calendar dates, no time zone drift) ───────── */

function toUTC(iso: string) {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}
const fromUTC = (d: Date) => d.toISOString().slice(0, 10);
export function addDays(iso: string, days: number) {
  const d = toUTC(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUTC(d);
}
/** Monday of the week containing `iso`. */
export function weekStartOf(iso: string) {
  const d = toUTC(iso);
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}
function validISO(v: unknown): v is string {
  if (typeof v !== "string" || !ISO_RE.test(v)) return false;
  return fromUTC(toUTC(v)) === v;
}
const utcToday = () => new Date().toISOString().slice(0, 10);

/* ───────── audit (board 31 shape) ───────── */

function audit(db: MockDB, projectId: string, actorId: string, action: string, target: string, extra: { key?: string | null; changes?: AuditChange[]; data?: Record<string, unknown> } = {}) {
  const p = db.projects.find((x) => x.id === projectId);
  if (!p) return;
  db.audit.unshift({
    id: uid("au"),
    workspaceId: p.workspaceId,
    actorId,
    actorName: db.users.find((u) => u.id === actorId)?.name ?? null,
    actorKind: "user",
    action,
    target,
    entityType: action.split(".")[0],
    entityKey: extra.key ?? null,
    source: "web",
    requestId: `req_${uid("").slice(-10)}`,
    changes: extra.changes ?? (extra.data ? Object.entries(extra.data).map(([field, v]) => ({ field, kind: "value" as const, before: null, after: v === null || v === undefined ? null : typeof v === "number" ? v : String(v) })) : undefined),
    createdAt: nowISO(),
  });
}
const change = (field: string, before: AuditChange["before"], after: AuditChange["after"], kind: AuditChange["kind"] = "value"): AuditChange => ({ field, kind, before, after });

/* ───────── custom fields ───────── */

const fieldsOf = (db: MockDB, projectId: string) => (db.customFields ?? []).filter((f) => f.projectId === projectId).sort((a, b) => a.position - b.position);

export function toField(db: MockDB, f: CustomFieldRec): CustomField {
  const { createdById: _c, ...rest } = f;
  const taskCount = db.tasks.filter((t) => t.projectId === f.projectId && !t.deletedAt && t.customFields && f.id in t.customFields).length;
  return { ...rest, options: [...f.options].sort((a, b) => a.position - b.position), taskCount };
}

function fieldById(ctx: Ctx, id: string) {
  const userId = requireUser(ctx);
  const f = (ctx.db.customFields ?? []).find((x) => x.id === id);
  if (!f || !projectPermissions(ctx.db, userId, f.projectId).includes("project.view")) fail(404, "not_found", "Custom field not found.");
  return f;
}

type OptIn = { id?: unknown; name?: unknown; color?: unknown };

/** Validates name/options for create (F2) and update (F3). Returns cleaned values or throws 422. */
function cleanField(db: MockDB, projectId: string, body: Record<string, unknown>, existing: CustomFieldRec | null) {
  const errors: Record<string, string> = {};
  let name: string | undefined;
  if (!existing || "name" in body) {
    name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) errors.name = "Name is required";
    else if (name.length > 40) errors.name = "Up to 40 characters";
    else if (fieldsOf(db, projectId).some((f) => f.id !== existing?.id && f.name.toLowerCase() === name!.toLowerCase())) errors.name = "A field with this name exists";
  }
  let type: CustomFieldType;
  if (existing) {
    type = existing.type;
    if ("type" in body && body.type !== existing.type) errors.type = "A field’s type can’t be changed";
  } else {
    type = body.type as CustomFieldType;
    if (!TYPES.includes(type)) errors.type = "Pick text, number, select, date or person";
  }
  let options: CustomFieldOption[] | undefined;
  if (type === "select" && (!existing || "options" in body)) {
    const raw = Array.isArray(body.options) ? (body.options as OptIn[]) : [];
    const kept = raw.map((o, i) => ({ o, i, name: typeof o?.name === "string" ? o.name.trim() : "" })).filter((x) => x.name);
    if (!kept.length) errors.options = "Add at least one option";
    else if (kept.length > OPTION_LIMIT) errors.options = "Up to 50 options";
    else if (new Set(kept.map((x) => x.name.toLowerCase())).size !== kept.length) errors.options = "Options must be unique";
    options = kept.map(({ o, i, name: n }, position) => {
      if (n.length > 32) errors[`options.${i}.name`] = "Up to 32 characters";
      if (!FIELD_COLORS.includes(o.color as FieldColor)) errors[`options.${i}.color`] = "Pick a colour from the palette";
      let id: string;
      if (o.id !== undefined && o.id !== null) {
        if (!existing || !existing.options.some((x) => x.id === o.id)) errors[`options.${i}.id`] = "Unknown option";
        id = String(o.id);
      } else id = uid("opt");
      return { id, name: n, color: o.color as FieldColor, position };
    });
  }
  if (Object.keys(errors).length) invalid(errors);
  return { name, type, options, required: typeof body.required === "boolean" ? body.required : undefined };
}

/* ───────── dependencies ───────── */

function depTask(db: MockDB, t: TaskRec) {
  const s = db.statuses.find((x) => x.id === t.statusId);
  return {
    id: t.id,
    key: t.key,
    title: t.title,
    statusId: t.statusId,
    status: { name: s?.name ?? "", glyph: s?.glyph ?? "todo", category: s?.category ?? "todo" },
    assigneeId: t.assigneeId,
  };
}

const liveTask = (db: MockDB, id: string) => {
  const t = db.tasks.find((x) => x.id === id);
  return t && !t.deletedAt ? t : null;
};

export function dependenciesOf(db: MockDB, taskId: string): TaskDependencies {
  const rows = (db.dependencies ?? []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const item = (d: DependencyRec, otherId: string): DependencyItem | null => {
    const o = liveTask(db, otherId);
    return o ? { id: d.id, task: depTask(db, o), createdAt: d.createdAt, createdById: d.createdById } : null;
  };
  const blockedBy = rows.filter((d) => d.blockedId === taskId).map((d) => item(d, d.blockerId)).filter((x): x is DependencyItem => Boolean(x));
  const blocks = rows.filter((d) => d.blockerId === taskId).map((d) => item(d, d.blockedId)).filter((x): x is DependencyItem => Boolean(x));
  return { taskId, isBlocked: openBlockersOf(db, taskId).length > 0, blockedBy, blocks };
}

/**
 * Cycle check for a new row "blocker blocks blocked": refused when `blocked` already reaches
 * `blocker` by following blocks edges over live rows. Returns the loop's keys in blocking order,
 * first key repeated at the end, or null.
 */
export function findCycle(db: MockDB, blockerId: string, blockedId: string): string[] | null {
  const live = (db.dependencies ?? []).filter((d) => liveTask(db, d.blockerId) && liveTask(db, d.blockedId));
  const prev = new Map<string, string | null>([[blockedId, null]]);
  const queue = [blockedId];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === blockerId) {
      const path: string[] = [];
      for (let x: string | null = cur; x !== null; x = prev.get(x) ?? null) path.unshift(x);
      const keys = path.map((id) => db.tasks.find((t) => t.id === id)!.key);
      return [...keys, keys[0]!];
    }
    for (const d of live) {
      if (d.blockerId === cur && !prev.has(d.blockedId)) {
        prev.set(d.blockedId, cur);
        queue.push(d.blockedId);
      }
    }
  }
  return null;
}

function depTaskById(ctx: Ctx, id: string) {
  const t = ctx.db.tasks.find((x) => x.id === id);
  if (!t) fail(404, "not_found", "Task not found.");
  requireProject(ctx, t.projectId, "project.view");
  return t;
}

/* ───────── time ───────── */

function validateLogDate(date: unknown, field = "date") {
  if (!validISO(date)) invalid({ [field]: "Pick a date" });
  const today = utcToday();
  if (date > addDays(today, 1)) invalid({ [field]: "Can’t log future time" });
  if (date < addDays(today, -365)) invalid({ [field]: "Date is too far back" });
  return date;
}

function toTimer(db: MockDB, r: { userId: string; taskId: string; startedAt: string }): RunningTimer | null {
  const t = db.tasks.find((x) => x.id === r.taskId);
  if (!t) return null;
  return { taskId: t.id, taskKey: t.key, taskTitle: t.title, projectId: t.projectId, startedAt: r.startedAt };
}

function logEntry(db: MockDB, actorId: string, t: TaskRec, minutes: number, date: string, note: string, source: TimeEntry["source"]) {
  const e: TimeEntry = { id: uid("te"), taskId: t.id, projectId: t.projectId, userId: actorId, minutes, date, note: note.trim().slice(0, 140), source, createdAt: nowISO() };
  db.timeEntries!.push(e);
  audit(db, t.projectId, actorId, "task.time_logged", t.title, { key: t.key, data: { minutes, date, source } });
  return e;
}

/** Stops the user's timer. `logIt`: logs the entry when allowed; otherwise the timer is discarded. */
function stopTimer(db: MockDB, userId: string, date: string) {
  const r = db.timers!.find((x) => x.userId === userId);
  if (!r) return { entry: null as TimeEntry | null, reason: "none" as const };
  db.timers = db.timers!.filter((x) => x.userId !== userId);
  const t = db.tasks.find((x) => x.id === r.taskId);
  if (!t || t.deletedAt) return { entry: null, reason: "deleted" as const };
  if (!projectPermissions(db, userId, t.projectId).includes("time.log")) return { entry: null, reason: "forbidden" as const };
  const minutes = Math.min(1440, Math.max(1, Math.round((Date.now() - new Date(r.startedAt).getTime()) / 60_000)));
  return { entry: logEntry(db, userId, t, minutes, date, "", "timer"), reason: "ok" as const };
}

/* ───────── PATCH /tasks/:id extension (customFields, timeEstimateMinutes) ───────── */

/** Keys PATCH accepts beyond v1. */
export const EXT_PATCH_KEYS = ["customFields", "timeEstimateMinutes"] as const;

/**
 * Validates the board 39 keys of a task PATCH (before anything is written) and returns an apply
 * function. Throws 422 with `details.fields` on the first invalid key set.
 */
export function prepareTaskExtPatch(db: MockDB, t: TaskRec, body: Record<string, unknown>) {
  ensureExt39(db);
  const errors: Record<string, string> = {};
  const sets: Record<string, CustomFieldValue | null> = {};
  if ("customFields" in body) {
    const cf = body.customFields;
    if (!cf || typeof cf !== "object" || Array.isArray(cf)) invalid({ customFields: "Send an object of field ids" });
    const fields = fieldsOf(db, t.projectId);
    for (const [id, raw] of Object.entries(cf as Record<string, unknown>)) {
      const path = `customFields.${id}`;
      const f = fields.find((x) => x.id === id);
      if (!f) {
        errors[path] = "This field was deleted";
        continue;
      }
      let v: unknown = raw;
      if (f.type === "text" && typeof v === "string") v = v.trim();
      if (v === null || v === "") {
        if (f.required) errors[path] = "This field is required";
        else sets[id] = null;
        continue;
      }
      switch (f.type) {
        case "text":
          if (typeof v !== "string") errors[path] = "Up to 120 characters";
          else if (v.length > 120) errors[path] = "Up to 120 characters";
          else sets[id] = v;
          break;
        case "number":
          if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1_000_000_000) errors[path] = "Enter a number from 0 to 1,000,000,000";
          else sets[id] = Math.round(v * 100) / 100;
          break;
        case "select":
          if (typeof v !== "string" || !f.options.some((o) => o.id === v)) errors[path] = "Pick one of the options";
          else sets[id] = v;
          break;
        case "date":
          if (!validISO(v)) errors[path] = "Pick a date";
          else sets[id] = v;
          break;
        case "user":
          if (typeof v !== "string" || !projectMembership(db, v, t.projectId)) errors[path] = "Pick someone on this project";
          else sets[id] = v;
          break;
      }
    }
  }
  let estimate: number | null | undefined;
  if ("timeEstimateMinutes" in body) {
    const v = body.timeEstimateMinutes;
    if (v === null || v === 0) estimate = null;
    else if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 60_000) errors.timeEstimateMinutes = "Estimate is 1 minute to 1000 hours";
    else estimate = v;
  }
  if (Object.keys(errors).length) invalid(errors);

  return (actorId: string) => {
    const changes: AuditChange[] = [];
    const fields = fieldsOf(db, t.projectId);
    const shown = (f: CustomFieldRec, v: CustomFieldValue | null | undefined) =>
      v === null || v === undefined ? null : f.type === "select" ? (f.options.find((o) => o.id === v)?.name ?? null) : v;
    const next = { ...(t.customFields ?? {}) };
    for (const [id, v] of Object.entries(sets)) {
      const f = fields.find((x) => x.id === id)!;
      const before = next[id];
      if (v === null) delete next[id];
      else next[id] = v;
      if (before !== v && !(before === undefined && v === null)) changes.push(change(f.name, shown(f, before), shown(f, v), f.type === "user" ? "person" : "value"));
    }
    t.customFields = next;
    if (estimate !== undefined && estimate !== (t.timeEstimateMinutes ?? null)) {
      changes.push(change("Time estimate", t.timeEstimateMinutes ?? null, estimate));
      t.timeEstimateMinutes = estimate;
    }
    if (changes.length) audit(db, t.projectId, actorId, "task.updated", t.title, { key: t.key, changes });
  };
}

/* ───────── routes ───────── */

export function registerExtensions() {
  /* F1–F5 custom fields */
  route("GET", "/projects/:id/custom-fields", (ctx) => {
    ensureExt39(ctx.db);
    const p = memberProject(ctx, ctx.params.id!);
    return fieldsOf(ctx.db, p.id).map((f) => toField(ctx.db, f));
  });

  route("POST", "/projects/:id/custom-fields", (ctx) => {
    ensureExt39(ctx.db);
    const p = memberProject(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "field.manage");
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const c = cleanField(ctx.db, p.id, body, null);
    const list = fieldsOf(ctx.db, p.id);
    if (list.length >= FIELD_LIMIT) fail(409, "field_limit", "A project can have up to 50 custom fields.");
    const f: CustomFieldRec = {
      id: uid("cf"),
      projectId: p.id,
      name: c.name!,
      type: c.type,
      required: c.required ?? false,
      position: list.length,
      options: c.type === "select" ? (c.options ?? []) : [],
      createdAt: nowISO(),
      createdById: ctx.userId,
    };
    ctx.db.customFields!.push(f);
    audit(ctx.db, p.id, ctx.userId!, "project.custom_field_created", f.name, { key: p.key, changes: [change("Type", null, f.type), change("Required", null, String(f.required))] });
    return toField(ctx.db, f);
  });

  route("PATCH", "/custom-fields/:fieldId", (ctx) => {
    ensureExt39(ctx.db);
    const f = fieldById(ctx, ctx.params.fieldId!);
    requireProject(ctx, f.projectId, "field.manage");
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const c = cleanField(ctx.db, f.projectId, body, f);
    const changes: AuditChange[] = [];
    if (c.name !== undefined && c.name !== f.name) {
      changes.push(change("Name", f.name, c.name));
      f.name = c.name;
    }
    if (c.required !== undefined && c.required !== f.required) {
      changes.push(change("Required", String(f.required), String(c.required)));
      f.required = c.required;
    }
    if (c.options) {
      const removed = f.options.filter((o) => !c.options!.some((x) => x.id === o.id)).map((o) => o.id);
      const names = (l: CustomFieldOption[]) => l.map((o) => o.name).join(", ");
      if (names(f.options) !== names(c.options)) changes.push(change("Options", names(f.options), names(c.options)));
      f.options = c.options;
      if (removed.length) {
        for (const t of ctx.db.tasks) {
          const v = t.customFields?.[f.id];
          if (v !== undefined && removed.includes(String(v))) {
            const next = { ...t.customFields };
            delete next[f.id];
            t.customFields = next;
          }
        }
      }
    }
    if (changes.length) audit(ctx.db, f.projectId, ctx.userId!, "project.custom_field_updated", f.name, { changes });
    return toField(ctx.db, f);
  });

  route("DELETE", "/custom-fields/:fieldId", (ctx) => {
    ensureExt39(ctx.db);
    const f = fieldById(ctx, ctx.params.fieldId!);
    requireProject(ctx, f.projectId, "field.manage");
    const valuesRemoved = toField(ctx.db, f).taskCount;
    for (const t of ctx.db.tasks) {
      if (t.customFields && f.id in t.customFields) {
        const next = { ...t.customFields };
        delete next[f.id];
        t.customFields = next;
      }
    }
    ctx.db.customFields = ctx.db.customFields!.filter((x) => x.id !== f.id);
    fieldsOf(ctx.db, f.projectId).forEach((x, i) => (x.position = i));
    audit(ctx.db, f.projectId, ctx.userId!, "project.custom_field_deleted", f.name, { data: { valuesRemoved } });
    return undefined;
  });

  route("PUT", "/projects/:id/custom-fields/order", (ctx) => {
    ensureExt39(ctx.db);
    const p = memberProject(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "field.manage");
    const ids = (ctx.body as { ids?: unknown })?.ids;
    const list = fieldsOf(ctx.db, p.id);
    if (!Array.isArray(ids) || ids.length !== list.length || new Set(ids).size !== ids.length || !list.every((f) => ids.includes(f.id))) {
      invalid({ ids: "Send every field once" });
    }
    const before = list.map((f) => f.name).join(", ");
    (ids as string[]).forEach((id, i) => (list.find((f) => f.id === id)!.position = i));
    const after = fieldsOf(ctx.db, p.id);
    audit(ctx.db, p.id, ctx.userId!, "project.custom_fields_reordered", p.name, { key: p.key, changes: [change("Order", before, after.map((f) => f.name).join(", "))] });
    return after.map((f) => toField(ctx.db, f));
  });

  /* D1–D3 dependencies */
  route("GET", "/tasks/:id/dependencies", (ctx) => {
    ensureExt39(ctx.db);
    const t = depTaskById(ctx, ctx.params.id!);
    return dependenciesOf(ctx.db, t.id);
  });

  route("POST", "/tasks/:id/dependencies", (ctx) => {
    ensureExt39(ctx.db);
    const db = ctx.db;
    const t = depTaskById(ctx, ctx.params.id!);
    const userId = ctx.userId!;
    if (!canEditTask(db, userId, t)) fail(403, "forbidden", "You can only edit tasks you reported or are assigned.", { permission: "task.edit_any" });
    const b = (ctx.body ?? {}) as { relation?: unknown; taskId?: unknown };
    if (b.relation !== "blocked_by" && b.relation !== "blocks") invalid({ relation: "Pick blocked by or blocks" });
    const other = db.tasks.find((x) => x.id === b.taskId);
    if (!other || other.projectId !== t.projectId || (other.deletedAt && other.id !== t.id)) invalid({ taskId: "Pick a task from this project" });
    if (other.id === t.id) invalid({ taskId: "A task can’t depend on itself" });
    if (other.parentId === t.id || t.parentId === other.id) invalid({ taskId: "A task and its sub-task can’t depend on each other" });
    if (t.deletedAt) fail(409, "task_deleted", "This task was deleted. Restore it to make changes.");
    const [blocker, blocked] = b.relation === "blocked_by" ? [other, t] : [t, other];
    if (db.dependencies!.some((d) => d.blockerId === blocker.id && d.blockedId === blocked.id)) fail(409, "dependency_exists", "These tasks are already linked.");
    const liveRows = db.dependencies!.filter((d) => liveTask(db, d.blockerId) && liveTask(db, d.blockedId));
    if (liveRows.filter((d) => d.blockerId === blocker.id).length >= DEP_LIMIT || liveRows.filter((d) => d.blockedId === blocked.id).length >= DEP_LIMIT) {
      fail(409, "dependency_limit", "A task can have up to 50 dependencies each way.");
    }
    const path = findCycle(db, blocker.id, blocked.id);
    if (path) fail(409, "dependency_cycle", `That would create a loop: ${path.join(" → ")}.`, { path });
    db.dependencies!.push({ id: uid("dep"), projectId: t.projectId, blockerId: blocker.id, blockedId: blocked.id, createdById: userId, createdAt: nowISO() });
    for (const [self, rel, o] of [
      [blocked, "blocked_by", blocker],
      [blocker, "blocks", blocked],
    ] as const) {
      audit(db, self.projectId, userId, "task.dependency_added", self.title, { key: self.key, data: { relation: rel, otherKey: o.key, otherTitle: o.title } });
      logActivity(db, userId, "dependency_added", self.projectId, self, { relation: rel, otherKey: o.key, otherTitle: o.title });
    }
    return dependenciesOf(db, t.id);
  });

  route("DELETE", "/tasks/:id/dependencies/:dependencyId", (ctx) => {
    ensureExt39(ctx.db);
    const db = ctx.db;
    const t = depTaskById(ctx, ctx.params.id!);
    const d = db.dependencies!.find((x) => x.id === ctx.params.dependencyId && (x.blockerId === t.id || x.blockedId === t.id));
    if (!d) fail(404, "not_found", "Dependency not found.");
    const blocker = db.tasks.find((x) => x.id === d.blockerId)!;
    const blocked = db.tasks.find((x) => x.id === d.blockedId)!;
    const userId = ctx.userId!;
    if (!canEditTask(db, userId, blocker) && !canEditTask(db, userId, blocked)) {
      fail(403, "forbidden", "You can only edit tasks you reported or are assigned.", { permission: "task.edit_any" });
    }
    db.dependencies = db.dependencies!.filter((x) => x.id !== d.id);
    for (const [self, rel, o] of [
      [blocked, "blocked_by", blocker],
      [blocker, "blocks", blocked],
    ] as const) {
      audit(db, self.projectId, userId, "task.dependency_removed", self.title, { key: self.key, data: { relation: rel, otherKey: o.key, otherTitle: o.title } });
      logActivity(db, userId, "dependency_removed", self.projectId, self, { relation: rel, otherKey: o.key, otherTitle: o.title });
    }
    return undefined;
  });

  /* E1–E3 time entries */
  route("GET", "/tasks/:id/time-entries", (ctx) => {
    ensureExt39(ctx.db);
    const t = depTaskById(ctx, ctx.params.id!);
    return ctx.db.timeEntries!.filter((e) => e.taskId === t.id).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  });

  route("POST", "/tasks/:id/time-entries", (ctx) => {
    ensureExt39(ctx.db);
    const t = depTaskById(ctx, ctx.params.id!);
    requireProject(ctx, t.projectId, "time.log");
    if (t.deletedAt) fail(409, "task_deleted", "This task was deleted. Restore it to make changes.");
    const b = (ctx.body ?? {}) as { minutes?: unknown; date?: unknown; note?: unknown };
    const m = b.minutes;
    if (typeof m !== "number" || !Number.isInteger(m)) invalid({ minutes: "Enter a duration" });
    if (m <= 0) invalid({ minutes: "Duration must be over 0" });
    if (m > 1440) invalid({ minutes: "Max 24h per entry" });
    const date = validateLogDate(b.date);
    return logEntry(ctx.db, ctx.userId!, t, m, date, typeof b.note === "string" ? b.note : "", "manual");
  });

  route("DELETE", "/time-entries/:entryId", (ctx) => {
    ensureExt39(ctx.db);
    const userId = requireUser(ctx);
    const e = ctx.db.timeEntries!.find((x) => x.id === ctx.params.entryId);
    if (!e || !projectPermissions(ctx.db, userId, e.projectId).includes("project.view")) fail(404, "not_found", "Time entry not found.");
    const perms = projectPermissions(ctx.db, userId, e.projectId);
    const own = e.userId === userId && perms.includes("time.log");
    if (!own && !perms.includes("time.delete_any")) fail(403, "forbidden", "You can’t delete this time entry.", { permission: "time.delete_any" });
    ctx.db.timeEntries = ctx.db.timeEntries!.filter((x) => x.id !== e.id);
    const t = ctx.db.tasks.find((x) => x.id === e.taskId);
    audit(ctx.db, e.projectId, userId, "task.time_entry_deleted", t?.title ?? "", {
      key: t?.key,
      data: { minutes: e.minutes, date: e.date, owner: ctx.db.users.find((u) => u.id === e.userId)?.name ?? "" },
    });
    return undefined;
  });

  /* R1–R3 timer */
  route("GET", "/me/timer", (ctx) => {
    ensureExt39(ctx.db);
    const userId = requireUser(ctx);
    const r = ctx.db.timers!.find((x) => x.userId === userId);
    if (!r) return { timer: null };
    const t = ctx.db.tasks.find((x) => x.id === r.taskId);
    if (!t || t.deletedAt || !projectPermissions(ctx.db, userId, t.projectId).includes("project.view")) {
      ctx.db.timers = ctx.db.timers!.filter((x) => x.userId !== userId);
      return { timer: null };
    }
    return { timer: toTimer(ctx.db, r) };
  });

  route("POST", "/tasks/:id/timer", (ctx) => {
    ensureExt39(ctx.db);
    const t = depTaskById(ctx, ctx.params.id!);
    requireProject(ctx, t.projectId, "time.log");
    if (t.deletedAt) fail(409, "task_deleted", "This task was deleted. Restore it to make changes.");
    const userId = ctx.userId!;
    const current = ctx.db.timers!.find((x) => x.userId === userId);
    if (current?.taskId === t.id) return { timer: toTimer(ctx.db, current), stopped: null };
    let stopped: TimeEntry | null = null;
    if (current) {
      const raw = (ctx.body as { date?: unknown } | undefined)?.date;
      const date = raw === undefined ? utcToday() : validateLogDate(raw);
      stopped = stopTimer(ctx.db, userId, date).entry;
    }
    const r = { userId, taskId: t.id, startedAt: nowISO() };
    ctx.db.timers!.push(r);
    return { timer: toTimer(ctx.db, r), stopped };
  });

  route("POST", "/me/timer/stop", (ctx) => {
    ensureExt39(ctx.db);
    const userId = requireUser(ctx);
    if (!ctx.db.timers!.some((x) => x.userId === userId)) fail(404, "not_found", "No timer is running.");
    const raw = (ctx.body as { date?: unknown } | undefined)?.date;
    const date = raw === undefined || raw === null ? utcToday() : validateLogDate(raw);
    const note = (ctx.body as { note?: unknown } | undefined)?.note;
    const res = stopTimer(ctx.db, userId, date);
    if (res.reason === "deleted") fail(409, "task_deleted", "This task was deleted. The timer was discarded.");
    if (res.reason === "forbidden") fail(403, "forbidden", "You can’t log time on this project any more. The timer was discarded.", { permission: "time.log" });
    if (res.entry && typeof note === "string" && note.trim()) res.entry.note = note.trim().slice(0, 140);
    return { entry: res.entry };
  });

  /* S1 timesheet */
  route("GET", "/workspaces/:slug/timesheet", (ctx) => {
    ensureExt39(ctx.db);
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const userId = ctx.userId!;
    const weekRaw = filterValues(ctx.query, "week")[0];
    if (weekRaw !== undefined && !validISO(weekRaw)) invalid({ "filter[week]": "Pick a date" });
    const weekStart = weekStartOf(weekRaw ?? utcToday());
    const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const projectFilter = filterValues(ctx.query, "project")[0];
    const visible = ctx.db.projects
      .filter((p) => p.workspaceId === ws.id && projectPermissions(ctx.db, userId, p.id).includes("project.view"))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (projectFilter) memberProject(ctx, projectFilter);
    const scope = projectFilter ? visible.filter((p) => p.id === projectFilter) : visible;
    const scopeIds = new Set(scope.map((p) => p.id));
    const entries = ctx.db.timeEntries!.filter((e) => {
      if (!scopeIds.has(e.projectId) || e.date < days[0]! || e.date > days[6]!) return false;
      const t = ctx.db.tasks.find((x) => x.id === e.taskId);
      return Boolean(t && !t.deletedAt);
    });
    const userIds = [...new Set(entries.map((e) => e.userId))];
    const rows = userIds
      .map((uid2) => {
        const u = ctx.db.users.find((x) => x.id === uid2)!;
        const mine = entries.filter((e) => e.userId === uid2);
        const cells = days.map((date) => {
          const list = mine.filter((e) => e.date === date);
          const slices = new Map<string, TimesheetSlice>();
          for (const e of list) {
            const p = ctx.db.projects.find((x) => x.id === e.projectId)!;
            const t = ctx.db.tasks.find((x) => x.id === e.taskId)!;
            const key = projectFilter ? t.id : p.id;
            const s = slices.get(key) ?? (projectFilter ? { projectId: p.id, taskId: t.id, key: t.key, name: t.title, hue: p.hue, minutes: 0 } : { projectId: p.id, taskId: null, key: p.key, name: p.name, hue: p.hue, minutes: 0 });
            s.minutes += e.minutes;
            slices.set(key, s);
          }
          return { date, minutes: list.reduce((a, e) => a + e.minutes, 0), breakdown: [...slices.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 5) };
        });
        return { user: { id: u.id, name: u.name, hue: u.hue, avatarUrl: u.avatarUrl }, cells, totalMinutes: cells.reduce((a, c) => a + c.minutes, 0) };
      })
      .sort((a, b) => a.user.name.localeCompare(b.user.name));
    const dayTotals = days.map((_, i) => rows.reduce((a, r) => a + r.cells[i]!.minutes, 0));
    const out: Timesheet = {
      weekStart,
      days,
      projects: visible.map((p) => ({ id: p.id, key: p.key, name: p.name, hue: p.hue, my_permissions: projectPermissions(ctx.db, userId, p.id) })),
      rows,
      dayTotals,
      totalMinutes: dayTotals.reduce((a, b) => a + b, 0),
    };
    return out;
  });
}

