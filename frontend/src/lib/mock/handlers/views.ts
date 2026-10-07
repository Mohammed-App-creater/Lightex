import { completeRules, matchAll, parseRule, serializeRule } from "@/features/filters/filter-model";
import type { FilterRule, SavedView, ViewIcon } from "@/lib/api/types";
import { todayISO } from "@/lib/utils/dates";
import { nowISO, uid } from "../db";
import type { MockDB, SavedViewRec } from "../db-types";
import { projectPermissions } from "../derive";
import { fail, invalid, requireUser, route, wsBySlug, type Ctx } from "../router";

/*
 * Saved views + per-user sidebar pins (board 30). REQUESTED API ADDITION:
 *   GET    /workspaces/:slug/views          views I can see (mine + project-shared), with my pins and counts
 *   POST   /workspaces/:slug/views          create (project.view; "project" visibility needs task.create)
 *   PATCH  /views/:id                       owner edits name/icon/filters/visibility; anyone who sees it can (un)pin
 *   DELETE /views/:id                       owner only
 *   PUT    /workspaces/:slug/views/order    my pin order
 */

const ICONS: ViewIcon[] = ["filter", "star", "user", "calendar", "bolt", "flag"];
const MAX_NAME = 40;

function store(db: MockDB) {
  if (!db.views) {
    db.views = [];
    db.viewPins = [];
    seedViews(db);
  }
  db.viewPins ??= [];
  return { views: db.views, pins: db.viewPins };
}

/** Two personal pinned views per member (the sidebar's old fixed pins), in their first project. */
function seedViews(db: MockDB) {
  for (const m of db.wsMembers) {
    const project =
      db.projects.find((p) => p.workspaceId === m.workspaceId && p.status === "active" && p.key === "PRJ" && projectPermissions(db, m.userId, p.id).includes("project.view")) ??
      db.projects.find((p) => p.workspaceId === m.workspaceId && p.status === "active" && projectPermissions(db, m.userId, p.id).includes("project.view"));
    if (!project) continue;
    const doneIds = db.statuses.filter((s) => s.projectId === project.id && s.category === "done").map((s) => s.id);
    const bug = db.labels.find((l) => l.projectId === project.id && l.name.toLowerCase() === "bug");
    const notDone: FilterRule[] = doneIds.map((id) => ({ field: "status", op: "not", values: [id] }));
    const defs: { name: string; icon: ViewIcon; filters: FilterRule[] }[] = [
      { name: "My open bugs", icon: "user", filters: [{ field: "assignee", op: "is", values: ["me"] }, ...(bug ? [{ field: "label" as const, op: "is" as const, values: [bug.id] }] : []), ...notDone] },
      { name: "Due this week", icon: "calendar", filters: [{ field: "due", op: "before", values: ["week"] }, ...notDone] },
    ];
    defs.forEach((d, i) => {
      const id = uid("vw");
      db.views!.push({ id, workspaceId: m.workspaceId, projectId: project.id, ownerId: m.userId, name: d.name, icon: d.icon, visibility: "me", layout: "list", filters: d.filters, createdAt: nowISO() });
      db.viewPins!.push({ userId: m.userId, viewId: id, position: i });
    });
  }
}

function visibleTo(db: MockDB, userId: string, v: SavedViewRec) {
  if (!projectPermissions(db, userId, v.projectId).includes("project.view")) return false;
  return v.ownerId === userId || v.visibility === "project";
}

function countFor(db: MockDB, userId: string, v: SavedViewRec) {
  const sprintEnd = db.sprints.find((s) => s.projectId === v.projectId && s.state === "active")?.endDate ?? null;
  const ctx = { meId: userId, today: todayISO(), sprintEnd };
  const rules = completeRules(v.filters);
  return db.tasks.filter((t) => t.projectId === v.projectId && !t.deletedAt && matchAll(t, rules, ctx)).length;
}

function toView(db: MockDB, userId: string, v: SavedViewRec): SavedView {
  const pin = db.viewPins!.find((p) => p.userId === userId && p.viewId === v.id);
  return { ...v, filters: v.filters.map((f) => ({ ...f, values: [...f.values] })), pinned: Boolean(pin), position: pin?.position ?? 0, count: countFor(db, userId, v) };
}

function listFor(db: MockDB, userId: string, workspaceId: string) {
  const { views } = store(db);
  return views
    .filter((v) => v.workspaceId === workspaceId && visibleTo(db, userId, v))
    .map((v) => toView(db, userId, v))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.position - b.position || a.name.localeCompare(b.name));
}

function cleanFilters(raw: unknown): FilterRule[] {
  if (!Array.isArray(raw)) invalid({ filters: "Filters must be a list" });
  return (raw as FilterRule[])
    .slice(0, 12)
    .map((r) => parseRule(serializeRule({ field: r?.field, op: r?.op, values: Array.isArray(r?.values) ? r.values.map(String) : [] } as FilterRule)))
    .filter((r): r is FilterRule => Boolean(r));
}

function cleanName(raw: unknown) {
  const name = typeof raw === "string" ? raw.trim().slice(0, MAX_NAME) : "";
  if (!name) invalid({ name: "Name is required" });
  return name;
}

function nameTaken(db: MockDB, userId: string, workspaceId: string, name: string, exceptId?: string) {
  return store(db).views.some((v) => v.workspaceId === workspaceId && v.ownerId === userId && v.id !== exceptId && v.name.toLowerCase() === name.toLowerCase());
}

function viewById(ctx: Ctx, id: string) {
  const userId = requireUser(ctx);
  const v = store(ctx.db).views.find((x) => x.id === id);
  if (!v || !visibleTo(ctx.db, userId, v)) fail(404, "not_found", "View not found.");
  return v;
}

function setPinned(db: MockDB, userId: string, viewId: string, pinned: boolean) {
  const { pins } = store(db);
  const has = pins.some((p) => p.userId === userId && p.viewId === viewId);
  if (pinned && !has) {
    const last = Math.max(-1, ...pins.filter((p) => p.userId === userId).map((p) => p.position));
    pins.push({ userId, viewId, position: last + 1 });
  } else if (!pinned && has) {
    db.viewPins = pins.filter((p) => !(p.userId === userId && p.viewId === viewId));
  }
}

export function registerViews() {
  route("GET", "/workspaces/:slug/views", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    return listFor(ctx.db, ctx.userId!, ws.id);
  });

  route("POST", "/workspaces/:slug/views", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const userId = ctx.userId!;
    const b = (ctx.body ?? {}) as Partial<SavedView>;
    const project = ctx.db.projects.find((p) => p.id === b.projectId && p.workspaceId === ws.id);
    if (!project) invalid({ projectId: "Unknown project" });
    const perms = projectPermissions(ctx.db, userId, project.id);
    if (!perms.includes("project.view")) fail(403, "forbidden", "You’re not a member of this project.", { permission: "project.view" });
    const visibility = b.visibility === "project" ? "project" : "me";
    if (visibility === "project" && !perms.includes("task.create")) fail(403, "forbidden", "Your role can’t share views with the project.", { permission: "task.create" });
    const name = cleanName(b.name);
    if (nameTaken(ctx.db, userId, ws.id, name)) invalid({ name: "A view with this name exists" });
    const filters = cleanFilters(b.filters);
    if (!completeRules(filters).length) invalid({ filters: "Add at least one filter" });
    const rec: SavedViewRec = {
      id: uid("vw"),
      workspaceId: ws.id,
      projectId: project.id,
      ownerId: userId,
      name,
      icon: ICONS.includes(b.icon as ViewIcon) ? (b.icon as ViewIcon) : "filter",
      visibility,
      layout: b.layout === "board" ? "board" : "list",
      filters: completeRules(filters),
      createdAt: nowISO(),
    };
    store(ctx.db).views.push(rec);
    if ((ctx.body as { pinned?: boolean })?.pinned) setPinned(ctx.db, userId, rec.id, true);
    return toView(ctx.db, userId, rec);
  });

  route("PATCH", "/views/:id", (ctx) => {
    const v = viewById(ctx, ctx.params.id!);
    const userId = ctx.userId!;
    const b = (ctx.body ?? {}) as Partial<SavedView>;
    const edits = ["name", "icon", "filters", "visibility"].some((k) => k in b);
    if (edits && v.ownerId !== userId) fail(403, "forbidden", "Only the person who saved this view can change it.");
    if ("name" in b) {
      const name = cleanName(b.name);
      if (nameTaken(ctx.db, userId, v.workspaceId, name, v.id)) invalid({ name: "A view with this name exists" });
      v.name = name;
    }
    if ("icon" in b && ICONS.includes(b.icon as ViewIcon)) v.icon = b.icon as ViewIcon;
    if ("filters" in b) {
      const f = completeRules(cleanFilters(b.filters));
      if (!f.length) invalid({ filters: "Add at least one filter" });
      v.filters = f;
    }
    if ("visibility" in b) {
      const vis = b.visibility === "project" ? "project" : "me";
      if (vis === "project" && !projectPermissions(ctx.db, userId, v.projectId).includes("task.create"))
        fail(403, "forbidden", "Your role can’t share views with the project.", { permission: "task.create" });
      v.visibility = vis;
    }
    if (typeof b.pinned === "boolean") setPinned(ctx.db, userId, v.id, b.pinned);
    return toView(ctx.db, userId, v);
  });

  route("DELETE", "/views/:id", (ctx) => {
    const v = viewById(ctx, ctx.params.id!);
    if (v.ownerId !== ctx.userId) fail(403, "forbidden", "Only the person who saved this view can delete it.");
    const s = store(ctx.db);
    ctx.db.views = s.views.filter((x) => x.id !== v.id);
    ctx.db.viewPins = s.pins.filter((p) => p.viewId !== v.id);
    return undefined;
  });

  route("PUT", "/workspaces/:slug/views/order", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const userId = ctx.userId!;
    const ids = (ctx.body as { ids?: unknown })?.ids;
    if (!Array.isArray(ids)) invalid({ ids: "ids must be a list" });
    const { pins } = store(ctx.db);
    const mine = pins.filter((p) => p.userId === userId);
    ids.map(String).forEach((id, i) => {
      const p = mine.find((x) => x.viewId === id);
      if (p) p.position = i;
    });
    return listFor(ctx.db, userId, ws.id);
  });
}
