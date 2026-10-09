import type {
  AuditChange,
  Dashboard,
  DashboardSummary,
  DashboardWidget,
  Permission,
  WidgetConfigMap,
  WidgetType,
  WorkloadReport,
  WorkloadRow,
} from "@/lib/api/types";
import { DEFAULT_SIZE, MAX_H, MIN_H, SPRINT_HEALTH, WIDGET_NAME, WIDGET_NEEDS, WIDGET_TYPES, defaultConfig } from "@/lib/domain/dashboards";
import { nowISO, uid } from "../db";
import type { DashboardRec, MockDB, ProjectRec } from "../db-types";
import { liveTasks, statusesOf, toUser } from "../derive";
import { publishDashboard } from "../realtime";
import { fail, invalid, projectById, requireProject, requireUser, route, type Ctx } from "../router";

/*
 * Board 33 dashboards (spec §5.2) and the workload report (§5.4, W1). Same validation messages,
 * limits, `version` handling and §4.3 object rules as the contract. Personal dashboards of someone
 * else are 404, never 403. Archived projects: view only (the new permissions are not archive-safe).
 */

export const SHARED_LIMIT = 20;
export const PERSONAL_LIMIT = 10;

/* ───────── upgrade + seed ───────── */

const GRANTS: Record<string, Permission[]> = {
  project_admin: ["dashboard.create", "dashboard.manage"],
  manager: ["dashboard.create", "dashboard.manage"],
  project_member: ["dashboard.create"],
};

/**
 * Runs once per database (marker `ext33`): from createSeed(), when a cached database loads, and on
 * the first dashboards route. 1) adds the two keys to cached **system** roles by key, right before
 * report.view (custom roles untouched), 2) seeds PRJ's dashboards.
 */
export function ensureExt33(db: MockDB) {
  db.dashboards ??= [];
  if (db.ext33) return;
  db.ext33 = true;
  for (const r of db.roles) {
    if (!r.isSystem || !r.key) continue;
    for (const p of GRANTS[r.key] ?? []) {
      if (r.permissions.includes(p)) continue;
      const at = r.permissions.indexOf("report.view");
      if (at >= 0) r.permissions.splice(at, 0, p);
      else r.permissions.push(p);
    }
  }
  if (db.projects.some((p) => p.id === "p_prj")) seedPrj(db);
}

function seedPrj(db: MockDB) {
  const at = (iso: string) => new Date(iso).toISOString();
  const w = <T extends WidgetType>(id: string, type: T, size: { w: number; h: number }, config?: Partial<WidgetConfigMap[T]>) =>
    ({ id, type, ...size, config: { ...defaultConfig(type), ...config } }) as DashboardWidget;
  db.dashboards!.push(
    {
      id: "db_prj_health",
      projectId: "p_prj",
      name: "Sprint 14 health",
      visibility: "shared",
      ownerId: "u_alex",
      version: 1,
      widgets: [
        w("wg_prj_burn", "burndown", { w: 6, h: 2 }),
        w("wg_prj_mine", "my_tasks", { w: 3, h: 2 }),
        w("wg_prj_obj", "objectives", { w: 3, h: 2 }, { quarter: "Q4" }),
        w("wg_prj_load", "workload", { w: 6, h: 2 }),
        w("wg_prj_vel", "velocity", { w: 3, h: 2 }),
        w("wg_prj_act", "activity", { w: 3, h: 2 }),
      ],
      createdAt: at("2026-10-01T09:00:00Z"),
      updatedAt: at("2026-10-06T15:12:40Z"),
    },
    {
      id: "db_sam_focus",
      projectId: "p_prj",
      name: "My focus",
      visibility: "personal",
      ownerId: "u_sam",
      version: 1,
      widgets: [w("wg_sam_mine", "my_tasks", { w: 6, h: 2 }), w("wg_sam_act", "activity", { w: 6, h: 2 })],
      createdAt: at("2026-10-02T10:00:00Z"),
      updatedAt: at("2026-10-02T10:00:00Z"),
    },
  );
}

/* ───────── views ───────── */

function toDashboard(db: MockDB, d: DashboardRec): Dashboard {
  const u = db.users.find((x) => x.id === d.ownerId);
  const owner = u ? toUser(u) : { id: d.ownerId, name: "Former member", hue: 0, avatarUrl: null };
  return { ...d, owner: { id: owner.id, name: owner.name, hue: owner.hue, avatarUrl: owner.avatarUrl }, widgets: d.widgets.map((x) => ({ ...x, config: { ...x.config } }) as DashboardWidget) };
}

function toSummary(d: DashboardRec): DashboardSummary {
  return { id: d.id, projectId: d.projectId, name: d.name, visibility: d.visibility, ownerId: d.ownerId, widgetCount: d.widgets.length, updatedAt: d.updatedAt };
}

/* ───────── rules (§4.3) ───────── */

export function canEdit(perms: readonly string[], d: Pick<DashboardRec, "ownerId" | "visibility">, userId: string) {
  return (d.ownerId === userId && perms.includes("dashboard.create")) || (d.visibility === "shared" && perms.includes("dashboard.manage"));
}

/**
 * Dashboard → visibility rules: unknown or someone else's personal → 404; a shared one in a project
 * the caller isn't on → the v1 403; otherwise the dashboard and the caller's project permissions.
 */
function loadDashboard(ctx: Ctx, id: string) {
  const userId = requireUser(ctx);
  ensureExt33(ctx.db);
  const d = ctx.db.dashboards!.find((x) => x.id === id);
  if (!d || (d.visibility === "personal" && d.ownerId !== userId)) fail(404, "not_found", "Dashboard not found.");
  const p = projectById(ctx, d.projectId);
  const perms = requireProject(ctx, p.id, "project.view");
  return { d, p, perms };
}

function requireEdit(perms: readonly string[], p: ProjectRec, d: DashboardRec, userId: string) {
  const code = d.visibility === "shared" && d.ownerId !== userId ? "dashboard.manage" : "dashboard.create";
  if (p.status === "archived") fail(403, "forbidden", "This project is archived. Dashboards are view only.", { permission: code });
  if (!canEdit(perms, d, userId)) fail(403, "forbidden", "You can’t edit this dashboard.", { permission: code });
}

function checkVersion(db: MockDB, d: DashboardRec, version: unknown) {
  if (typeof version !== "number") invalid({ version: "Send the version you edited" });
  if (version !== d.version) fail(409, "version_conflict", "Someone else changed this dashboard.", { current: toDashboard(db, d) });
}

function checkName(db: MockDB, raw: unknown, projectId: string, ownerId: string, selfId?: string): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) invalid({ name: "Name is required" });
  if (name.length > 60) invalid({ name: "Up to 60 characters" });
  const dup = db.dashboards!.some((x) => x.projectId === projectId && x.ownerId === ownerId && x.id !== selfId && x.name.toLowerCase() === name.toLowerCase());
  if (dup) invalid({ name: "You already have a dashboard with this name" });
  return name;
}

/* ───────── widgets (§3.3, §5.2 DB5) ───────── */

type Bad = Record<string, string>;

function validConfig(db: MockDB, projectId: string, type: WidgetType, raw: unknown, path: string, bad: Bad): WidgetConfigMap[WidgetType] {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(c, k);
  const sprintOk = (v: unknown) => v === null || (typeof v === "string" && db.sprints.some((s) => s.id === v && s.projectId === projectId));
  switch (type) {
    case "burndown": {
      const sprintId = has("sprintId") ? c.sprintId : null;
      if (!sprintOk(sprintId)) bad[`${path}.sprintId`] = "Pick a sprint from this project";
      return { sprintId: (sprintId as string | null) ?? null };
    }
    case "my_tasks": {
      const showDone = has("showDone") ? c.showDone : true;
      if (typeof showDone !== "boolean") bad[`${path}.showDone`] = "Use true or false";
      return { showDone: showDone !== false };
    }
    case "objectives": {
      const quarter = has("quarter") ? c.quarter : null;
      if (quarter !== null && (typeof quarter !== "string" || quarter.length > 16)) bad[`${path}.quarter`] = "Up to 16 characters";
      return { quarter: typeof quarter === "string" ? quarter : null };
    }
    case "workload": {
      const unit = has("unit") ? c.unit : "points";
      const sprintId = has("sprintId") ? c.sprintId : null;
      const personField = has("personField") ? c.personField : null;
      if (unit !== "points" && unit !== "hours") bad[`${path}.unit`] = "Pick points or hours";
      if (!sprintOk(sprintId)) bad[`${path}.sprintId`] = "Pick a sprint from this project";
      if (personField !== null && !(typeof personField === "string" && (db.customFields ?? []).some((f) => f.id === personField && f.projectId === projectId && f.type === "user"))) {
        bad[`${path}.personField`] = "Pick a person field from this project";
      }
      return { unit: unit === "hours" ? "hours" : "points", sprintId: (sprintId as string | null) ?? null, personField: (personField as string | null) ?? null };
    }
    case "velocity": {
      const range = has("range") ? c.range : "last6";
      if (range !== "last2" && range !== "last6") bad[`${path}.range`] = "Pick last2 or last6";
      return { range: range === "last2" ? "last2" : "last6" };
    }
    case "activity":
      return {};
  }
}

/** Validates a complete DB5 list. Returns the next widget records (ids kept, new ones minted). */
function validateLayout(db: MockDB, d: DashboardRec, perms: readonly string[], raw: unknown, newId: () => string): DashboardWidget[] {
  if (!Array.isArray(raw)) invalid({ widgets: "Send a list of widgets" });
  if (raw.length > 6) invalid({ widgets: "Up to 6 widgets" });
  const bad: Bad = {};
  const seenTypes = new Set<string>();
  const seenIds = new Set<string>();
  const out: DashboardWidget[] = [];
  raw.forEach((item, i) => {
    const it = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const p = `widgets.${i}`;
    const type = it.type as WidgetType;
    const existing = typeof it.id === "string" ? d.widgets.find((x) => x.id === it.id) : undefined;
    if (it.id !== undefined && it.id !== null && (!existing || seenIds.has(existing.id))) bad[`${p}.id`] = "Unknown widget";
    if (!WIDGET_TYPES.includes(type)) {
      bad[`${p}.type`] = "Pick a widget type";
      return;
    }
    if (existing && existing.type !== type) bad[`${p}.type`] = "A widget’s type can’t be changed";
    // Adding a report widget needs report.view; keeping an existing one doesn't.
    if (!existing && WIDGET_NEEDS[type] === "report.view" && !perms.includes("report.view")) bad[`${p}.type`] = "You can’t view this report";
    if (seenTypes.has(type)) bad.widgets = "Each widget type can appear once";
    seenTypes.add(type);
    if (existing) seenIds.add(existing.id);
    const w = it.w;
    const h = it.h;
    if (typeof w !== "number" || !Number.isInteger(w) || w < 3 || w > 12) bad[`${p}.w`] = "Width is 3 to 12 columns";
    if (typeof h !== "number" || !Number.isInteger(h) || h < 1 || h > MAX_H) bad[`${p}.h`] = "Height is 1 to 4 rows";
    else if (h < MIN_H[type]) bad[`${p}.h`] = `${WIDGET_NAME[type]} needs at least ${MIN_H[type]} rows`;
    const config = validConfig(db, d.projectId, type, it.config, `${p}.config`, bad);
    out.push({ id: existing?.id ?? newId(), type, w: w as number, h: h as number, config } as DashboardWidget);
  });
  if (Object.keys(bad).length) invalid(bad);
  return out;
}

function templateWidgets(perms: readonly string[]): DashboardWidget[] {
  return SPRINT_HEALTH.filter((t) => perms.includes(WIDGET_NEEDS[t])).map((type) => ({ id: uid("wg"), type, ...DEFAULT_SIZE[type], config: defaultConfig(type) }) as DashboardWidget);
}

/* ───────── audit (board 31 shape, §6.1) ───────── */

function audit(db: MockDB, p: ProjectRec, actorId: string, action: string, target: string, changes?: AuditChange[]) {
  db.audit.unshift({
    id: uid("au"),
    workspaceId: p.workspaceId,
    actorId,
    actorName: db.users.find((u) => u.id === actorId)?.name ?? null,
    actorKind: "user",
    action,
    target,
    entityType: "dashboard",
    entityKey: p.key,
    source: "web",
    requestId: `req_${uid("").slice(-10)}`,
    changes,
    createdAt: nowISO(),
  });
}
const value = (field: string, before: string | number | null, after: string | number | null): AuditChange => ({ field, kind: "value", before, after });

/* ───────── workload (W1) ───────── */

const niceMax = (v: number, step: number) => (v <= 0 ? 0 : Math.max(step, Math.ceil(v / step) * step));

export function workloadReport(db: MockDB, p: ProjectRec, q: { sprint?: string; unit?: string; person?: string }): WorkloadReport {
  const unit = q.unit === undefined || q.unit === "" ? "points" : q.unit;
  if (unit !== "points" && unit !== "hours") invalid({ "filter[unit]": "Pick points or hours" });
  const personParam = q.person && q.person !== "assignee" ? q.person : null;
  const field = personParam ? (db.customFields ?? []).find((f) => f.id === personParam && f.projectId === p.id) : null;
  if (personParam && (!field || field.type !== "user")) invalid({ "filter[person]": "Pick a person field from this project" });
  const sprint = q.sprint ? db.sprints.find((s) => s.id === q.sprint && s.projectId === p.id) : db.sprints.find((s) => s.projectId === p.id && s.state === "active");
  if (q.sprint && !sprint) fail(404, "not_found", "Sprint not found.");
  const personField = field ? { id: field.id, name: field.name } : null;
  const empty = { inProgress: 0, todo: 0, unestimated: 0 };
  if (!sprint) return { sprint: null, unit, personField, scale: 0, rows: [], unassigned: { ...empty } };

  const statuses = statusesOf(db, p.id);
  const live = liveTasks(db, p.id);
  const personOf = (t: (typeof live)[number]) => (field ? ((t.customFields?.[field.id] as string | undefined) ?? null) : t.assigneeId);
  const logged = (taskId: string) => (db.timeEntries ?? []).reduce((a, e) => (e.taskId === taskId ? a + e.minutes : a), 0);

  const acc = new Map<string | null, { inProgress: number; todo: number; unestimated: number }>();
  for (const t of live) {
    if (t.sprintId !== sprint.id) continue;
    const cat = statuses.find((s) => s.id === t.statusId)?.category;
    if (cat !== "todo" && cat !== "in_progress") continue;
    let work = 0;
    let unest = false;
    if (unit === "points") {
      if (t.estimate == null) unest = true;
      else work = t.estimate;
    } else if (t.timeEstimateMinutes == null) unest = true;
    else work = Math.max(0, t.timeEstimateMinutes - logged(t.id));
    const who = personOf(t);
    const a = acc.get(who) ?? { ...empty };
    if (cat === "in_progress") a.inProgress += work;
    else a.todo += work;
    if (unest) a.unestimated += 1;
    acc.set(who, a);
  }

  // Capacity: the person's mean completed points (or logged minutes) over the last 3 completed sprints.
  const done = db.sprints
    .filter((s) => s.projectId === p.id && s.state === "completed")
    .sort((a, b) => b.endDate.localeCompare(a.endDate))
    .slice(0, 3);
  const capacity = (userId: string): number | null => {
    if (!done.length) return null;
    let total = 0;
    for (const s of done) {
      if (unit === "points") {
        total += live
          .filter((t) => t.sprintId === s.id && personOf(t) === userId)
          .filter((t) => {
            const st = statuses.find((x) => x.id === t.statusId);
            return st?.category === "done" && st.glyph !== "canceled";
          })
          .reduce((a, t) => a + (t.estimate ?? 0), 0);
      } else {
        total += (db.timeEntries ?? []).filter((e) => e.projectId === p.id && e.userId === userId && e.date >= s.startDate && e.date <= s.endDate).reduce((a, e) => a + e.minutes, 0);
      }
    }
    return Math.round(total / done.length);
  };

  const members = db.projectMembers.filter((m) => m.projectId === p.id).map((m) => m.userId);
  const people = new Set<string>([...[...acc.keys()].filter((k): k is string => !!k), ...(done.length ? members : [])]);
  const rows: WorkloadRow[] = [...people]
    .map((id) => {
      const u = db.users.find((x) => x.id === id);
      const a = acc.get(id) ?? { ...empty };
      return {
        user: { id, name: u?.name ?? "Former member", hue: u?.hue ?? 0, avatarUrl: u?.avatarUrl ?? null },
        inProgress: a.inProgress,
        todo: a.todo,
        capacity: capacity(id),
        unestimated: a.unestimated,
      };
    })
    .sort((a, b) => a.user.name.localeCompare(b.user.name));
  const max = rows.reduce((m, r) => Math.max(m, r.inProgress + r.todo, r.capacity ?? 0), 0);
  return { sprint: { id: sprint.id, name: sprint.name, number: sprint.number, startDate: sprint.startDate, endDate: sprint.endDate }, unit, personField, scale: niceMax(max, unit === "points" ? 2 : 120), rows, unassigned: acc.get(null) ?? { ...empty } };
}

/* ───────── routes ───────── */

export function registerDashboards() {
  // DB1
  route("GET", "/projects/:id/dashboards", (ctx) => {
    const userId = requireUser(ctx);
    ensureExt33(ctx.db);
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "project.view");
    const mine = ctx.db.dashboards!.filter((d) => d.projectId === p.id);
    const byName = (a: DashboardRec, b: DashboardRec) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    return [...mine.filter((d) => d.visibility === "shared").sort(byName), ...mine.filter((d) => d.visibility === "personal" && d.ownerId === userId).sort(byName)].map(toSummary);
  });

  // DB2
  route("POST", "/projects/:id/dashboards", (ctx) => {
    const userId = requireUser(ctx);
    ensureExt33(ctx.db);
    const p = projectById(ctx, ctx.params.id!);
    const perms = requireProject(ctx, p.id, "dashboard.create");
    if (p.status === "archived") fail(403, "forbidden", "This project is archived. Dashboards are view only.", { permission: "dashboard.create" });
    const b = (ctx.body ?? {}) as { name?: unknown; visibility?: unknown; template?: unknown };
    const visibility = b.visibility ?? "shared";
    const template = b.template ?? "blank";
    const fields: Bad = {};
    if (visibility !== "shared" && visibility !== "personal") fields.visibility = "Pick shared or personal";
    if (template !== "blank" && template !== "sprint_health") fields.template = "Pick blank or sprint_health";
    if (Object.keys(fields).length) invalid(fields);
    const name = checkName(ctx.db, b.name, p.id, userId);
    const list = ctx.db.dashboards!.filter((d) => d.projectId === p.id);
    if (visibility === "shared" && list.filter((d) => d.visibility === "shared").length >= SHARED_LIMIT) {
      fail(409, "dashboard_limit", "A project can have up to 20 shared dashboards.");
    }
    if (visibility === "personal" && list.filter((d) => d.visibility === "personal" && d.ownerId === userId).length >= PERSONAL_LIMIT) {
      fail(409, "dashboard_limit", "You can have up to 10 personal dashboards in a project.");
    }
    const now = nowISO();
    const d: DashboardRec = {
      id: uid("db"),
      projectId: p.id,
      name,
      visibility: visibility as DashboardRec["visibility"],
      ownerId: userId,
      version: 1,
      widgets: template === "sprint_health" ? templateWidgets(perms) : [],
      createdAt: now,
      updatedAt: now,
    };
    ctx.db.dashboards!.push(d);
    audit(ctx.db, p, userId, "dashboard.created", name, [value("visibility", null, d.visibility), value("template", null, String(template))]);
    publishDashboard(ctx.db, userId, d, "created");
    return toDashboard(ctx.db, d);
  });

  // DB3
  route("GET", "/dashboards/:id", (ctx) => toDashboard(ctx.db, loadDashboard(ctx, ctx.params.id!).d));

  // DB4
  route("PATCH", "/dashboards/:id", (ctx) => {
    const userId = requireUser(ctx);
    const { d, p, perms } = loadDashboard(ctx, ctx.params.id!);
    requireEdit(perms, p, d, userId);
    const b = (ctx.body ?? {}) as { name?: unknown; visibility?: unknown; version?: unknown };
    checkVersion(ctx.db, d, b.version);
    const changes: AuditChange[] = [];
    if (b.visibility !== undefined) {
      if (b.visibility !== "shared" && b.visibility !== "personal") invalid({ visibility: "Pick shared or personal" });
      if (b.visibility !== d.visibility) {
        if (!(d.ownerId === userId && perms.includes("dashboard.create"))) {
          fail(403, "forbidden", "Only the owner can change who sees this dashboard.", { permission: "dashboard.create" });
        }
        const limit = b.visibility === "shared" ? SHARED_LIMIT : PERSONAL_LIMIT;
        const count = ctx.db.dashboards!.filter((x) => x.projectId === p.id && x.visibility === b.visibility && (b.visibility === "shared" || x.ownerId === userId)).length;
        if (count >= limit) fail(409, "dashboard_limit", b.visibility === "shared" ? "A project can have up to 20 shared dashboards." : "You can have up to 10 personal dashboards in a project.");
      }
    }
    if (b.name !== undefined) {
      const name = checkName(ctx.db, b.name, p.id, d.ownerId, d.id);
      if (name !== d.name) changes.push(value("Name", d.name, name));
      d.name = name;
    }
    if (b.visibility !== undefined && b.visibility !== d.visibility) {
      changes.push(value("Visibility", d.visibility, b.visibility as string));
      const was = { ...d };
      d.visibility = b.visibility as DashboardRec["visibility"];
      // Whoever could see it before hears about the change.
      if (was.visibility === "shared") publishDashboard(ctx.db, userId, { ...was, version: d.version + 1 }, "updated");
    }
    d.version += 1;
    d.updatedAt = nowISO();
    audit(ctx.db, p, userId, "dashboard.updated", d.name, changes);
    publishDashboard(ctx.db, userId, d, "updated");
    return toDashboard(ctx.db, d);
  });

  // DB5
  route("PUT", "/dashboards/:id/layout", (ctx) => {
    const userId = requireUser(ctx);
    const { d, p, perms } = loadDashboard(ctx, ctx.params.id!);
    requireEdit(perms, p, d, userId);
    const b = (ctx.body ?? {}) as { version?: unknown; widgets?: unknown };
    checkVersion(ctx.db, d, b.version);
    d.widgets = validateLayout(ctx.db, d, perms, b.widgets, () => uid("wg"));
    d.version += 1;
    d.updatedAt = nowISO();
    audit(ctx.db, p, userId, "dashboard.layout_updated", d.name, [value("widgets", null, d.widgets.map((x) => `${x.type}:${x.w}x${x.h}`).join(", "))]);
    publishDashboard(ctx.db, userId, d, "layout");
    return toDashboard(ctx.db, d);
  });

  // DB6
  route("DELETE", "/dashboards/:id", (ctx) => {
    const userId = requireUser(ctx);
    const { d, p, perms } = loadDashboard(ctx, ctx.params.id!);
    requireEdit(perms, p, d, userId);
    ctx.db.dashboards = ctx.db.dashboards!.filter((x) => x.id !== d.id);
    audit(ctx.db, p, userId, "dashboard.deleted", d.name, [value("visibility", null, d.visibility), value("widgets", null, d.widgets.length)]);
    publishDashboard(ctx.db, userId, d, "deleted");
    return undefined;
  });

  // W1
  route("GET", "/projects/:id/reports/workload", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "report.view");
    const f = ctx.query.filter ?? {};
    const one = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? "") : v === undefined || v === null ? undefined : String(v));
    return workloadReport(ctx.db, p, { sprint: one(f.sprint), unit: one(f.unit), person: one(f.person) });
  });
}
