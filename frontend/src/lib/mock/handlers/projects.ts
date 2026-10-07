import type { ProjectAccessInfo, ProjectSummary, ProjectTemplate, Status } from "@/lib/api/types";
import { DAY, isDoneStatus } from "@/lib/domain/progress";
import { TEMPLATE_IDS, templateDef } from "@/lib/domain/project-templates";
import { nowISO, uid } from "../db";
import type { MockDB, ProjectRec } from "../db-types";
import {
  liveTasks,
  projectMembership,
  statusesOf,
  toProject,
  toSprint,
  toUser,
  wsMembership,
} from "../derive";
import { audit } from "./workspaces";
import { trashProject } from "./trash";
import { logActivity, notify } from "./common";
import {
  fail,
  invalid,
  paginate,
  projectById,
  requireProject,
  requireUser,
  requireWs,
  route,
  str,
  wsBySlug,
  type Ctx,
} from "../router";

const STATUS_DEFS: Pick<Status, "glyph" | "name" | "category">[] = [
  { glyph: "backlog", name: "Backlog", category: "todo" },
  { glyph: "todo", name: "Todo", category: "todo" },
  { glyph: "progress", name: "In progress", category: "in_progress" },
  { glyph: "review", name: "In review", category: "in_progress" },
  { glyph: "done", name: "Done", category: "done" },
  { glyph: "canceled", name: "Canceled", category: "done" },
];

export function accessInfo(db: MockDB, p: ProjectRec, userId: string): ProjectAccessInfo {
  const adminRoleIds = db.roles.filter((r) => r.scope === "project" && r.permissions.includes("project.manage_members")).map((r) => r.id);
  const admins = db.projectMembers
    .filter((m) => m.projectId === p.id && adminRoleIds.includes(m.roleId))
    .map((m) => db.users.find((u) => u.id === m.userId)!)
    .map((u) => ({ id: u.id, name: u.name, hue: u.hue }));
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    hue: p.hue,
    admins,
    myRequest: db.accessRequests.find((r) => r.projectId === p.id && r.userId === userId && r.status === "pending") ?? null,
  };
}

/** 409 when `userId` is the project's only member holding project.manage_members (board 28 "only admin"). */
function lastAdminGuard(db: MockDB, projectId: string, userId: string) {
  const adminRoles = new Set(db.roles.filter((r) => r.permissions.includes("project.manage_members")).map((r) => r.id));
  const admins = db.projectMembers.filter((m) => m.projectId === projectId && adminRoles.has(m.roleId));
  if (admins.length === 1 && admins[0]!.userId === userId) fail(409, "last_admin", "A project needs at least one admin.");
}

/** Member-only project lookup used by every project-scoped route. */
export function memberProject(ctx: Ctx, projectId: string) {
  requireProject(ctx, projectId, "project.view");
  return projectById(ctx, projectId);
}

export function registerProjects() {
  route("GET", "/workspaces/:slug/projects", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const userId = ctx.userId!;
    const includeArchived = ctx.query.filter?.status === "archived" || ctx.query.filter?.status === "all";
    return ctx.db.projects
      .filter((p) => p.workspaceId === ws.id && projectMembership(ctx.db, userId, p.id))
      .filter((p) => includeArchived || p.status === "active")
      .map((p) => toProject(ctx.db, p, userId));
  });

  /** Lightweight directory: every project in the workspace (for "assign admin" and 403 context). */
  route("GET", "/workspaces/:slug/project-directory", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    return ctx.db.projects
      .filter((p) => p.workspaceId === ws.id)
      .map((p) => ({ ...accessInfo(ctx.db, p, ctx.userId!), isMember: Boolean(projectMembership(ctx.db, ctx.userId!, p.id)), status: p.status }));
  });

  route("GET", "/workspaces/:slug/projects/:key", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const p = ctx.db.projects.find((x) => x.workspaceId === ws.id && x.key.toLowerCase() === ctx.params.key!.toLowerCase());
    if (!p) fail(404, "not_found", "Project not found.");
    if (!projectMembership(ctx.db, ctx.userId!, p.id)) {
      fail(403, "forbidden", "You’re not a member of this project.", { canRequestAccess: true, project: accessInfo(ctx.db, p, ctx.userId!) });
    }
    return toProject(ctx.db, p, ctx.userId!);
  });

  route("POST", "/workspaces/:slug/projects", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "project.create");
    const name = (str(ctx.body, "name") ?? "").trim();
    const key = (str(ctx.body, "key") ?? "").trim().toUpperCase();
    const template = (str(ctx.body, "template") ?? "kanban") as ProjectTemplate;
    const fields: Record<string, string> = {};
    if (name.length < 2) fields.name = "Name the project (2+ characters)";
    if (!/^[A-Z]{2,5}$/.test(key)) fields.key = "Key: 2–5 letters";
    else if (ctx.db.projects.some((p) => p.workspaceId === ws.id && p.key === key)) fields.key = `${key} is already used in this workspace`;
    if (Object.keys(fields).length) invalid(fields);
    const p: ProjectRec = {
      id: uid("p"),
      workspaceId: ws.id,
      key,
      name: name.slice(0, 60),
      description: (str(ctx.body, "description") ?? "").slice(0, 500),
      hue: Math.floor(Math.random() * 360),
      leadId: ctx.userId,
      status: "active",
      template: TEMPLATE_IDS.includes(template) ? template : "kanban",
      createdAt: nowISO(),
      taskSeq: 0,
    };
    ctx.db.projects.push(p);
    // Board 24: each template creates its own workflow (names differ, glyphs stay canonical).
    const statusDefs = TEMPLATE_IDS.includes(template) ? templateDef(template).statuses : STATUS_DEFS;
    statusDefs.forEach((s, i) => ctx.db.statuses.push({ id: `${p.id}-st-${s.glyph}`, projectId: p.id, ...s, position: i }));
    [["frontend", "var(--low)"], ["backend", "var(--accent-t)"], ["bug", "var(--danger)"], ["design", "var(--warn)"]].forEach(([n, c]) =>
      ctx.db.labels.push({ id: `${p.id}-lb-${n}`, projectId: p.id, name: n!, color: c! }),
    );
    ctx.db.projectMembers.push({ projectId: p.id, userId: ctx.userId!, roleId: `${ws.id}-role-project_admin`, addedAt: nowISO() });
    audit(ctx.db, ws.id, ctx.userId!, "project.created", p.name);
    return toProject(ctx.db, p, ctx.userId!);
  });

  route("PATCH", "/projects/:id", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "project.update");
    const name = str(ctx.body, "name");
    const description = str(ctx.body, "description");
    const key = str(ctx.body, "key");
    const fields: Record<string, string> = {};
    if (name !== undefined && name.trim().length < 2) fields.name = "Name the project (2+ characters)";
    if (key !== undefined && !/^[A-Z]{2,5}$/.test(key.toUpperCase())) fields.key = "Key: 2–5 letters";
    if (Object.keys(fields).length) invalid(fields);
    if (name !== undefined) p.name = name.trim().slice(0, 60);
    if (description !== undefined) p.description = description.slice(0, 500);
    const hue = (ctx.body as { hue?: unknown })?.hue;
    if (typeof hue === "number" && Number.isFinite(hue)) p.hue = Math.round(((hue % 360) + 360) % 360);
    if (key !== undefined && key.toUpperCase() !== p.key) {
      const next = key.toUpperCase();
      if (ctx.db.projects.some((x) => x.workspaceId === p.workspaceId && x.key === next)) invalid({ key: `${next} is already used` });
      p.key = next;
      ctx.db.tasks.filter((t) => t.projectId === p.id).forEach((t) => (t.key = `${next}-${t.number}`));
    }
    return toProject(ctx.db, p, ctx.userId!);
  });

  route("POST", "/projects/:id/archive", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "project.archive");
    p.status = "archived";
    return toProject(ctx.db, p, ctx.userId!);
  });
  route("POST", "/projects/:id/unarchive", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "project.archive");
    p.status = "active";
    return toProject(ctx.db, p, ctx.userId!);
  });
  route("DELETE", "/projects/:id", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "project.delete");
    if (str(ctx.body, "confirm") !== p.key) invalid({ confirm: `Type ${p.key} to confirm` });
    trashProject(ctx.db, p, ctx.userId); // board 29: restorable from the Trash for 30 days
    ctx.db.projects = ctx.db.projects.filter((x) => x.id !== p.id);
    ctx.db.tasks = ctx.db.tasks.filter((t) => t.projectId !== p.id);
    ctx.db.projectMembers = ctx.db.projectMembers.filter((m) => m.projectId !== p.id);
    return undefined;
  });

  /* members */
  route("GET", "/projects/:id/members", (ctx) => {
    const p = memberProject(ctx, ctx.params.id!);
    return ctx.db.projectMembers
      .filter((m) => m.projectId === p.id)
      .map((m) => ({ ...m, user: toUser(ctx.db.users.find((u) => u.id === m.userId)!) }))
      .sort((a, b) => a.user.name.localeCompare(b.user.name));
  });

  route("POST", "/projects/:id/members", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    const userId = str(ctx.body, "userId")!;
    const roleId = str(ctx.body, "roleId")!;
    const role = ctx.db.roles.find((r) => r.id === roleId && r.scope === "project" && r.workspaceId === p.workspaceId);
    if (!role) invalid({ roleId: "Pick a project role" });
    // Workspace admins may assign a project admin without being project members themselves
    // (project.assign_admin). Everything else requires project.manage_members.
    const isAdminRole = role.permissions.includes("project.manage_members");
    if (isAdminRole && hasWs(ctx, p.workspaceId, "project.assign_admin")) {
      /* allowed */
    } else {
      requireProject(ctx, p.id, "project.manage_members");
    }
    if (!wsMembership(ctx.db, userId, p.workspaceId)) invalid({ userId: "Only workspace members can join projects" });
    const existing = projectMembership(ctx.db, userId, p.id);
    if (existing) existing.roleId = role.id;
    else ctx.db.projectMembers.push({ projectId: p.id, userId, roleId: role.id, addedAt: nowISO() });
    ctx.db.accessRequests.filter((r) => r.projectId === p.id && r.userId === userId && r.status === "pending").forEach((r) => (r.status = "approved"));
    logActivity(ctx.db, ctx.userId, "member_added", p.id, null, { member: ctx.db.users.find((u) => u.id === userId)?.name ?? "" });
    return { projectId: p.id, userId, roleId: role.id, addedAt: nowISO(), user: toUser(ctx.db.users.find((u) => u.id === userId)!) };
  });

  route("PATCH", "/projects/:id/members/:userId", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "project.manage_members");
    const m = projectMembership(ctx.db, ctx.params.userId!, p.id);
    if (!m) fail(404, "not_found", "Member not found.");
    const roleId = str(ctx.body, "roleId");
    const role = ctx.db.roles.find((r) => r.id === roleId && r.scope === "project" && r.workspaceId === p.workspaceId);
    if (!role) invalid({ roleId: "Pick a project role" });
    if (!role.permissions.includes("project.manage_members")) lastAdminGuard(ctx.db, p.id, m.userId);
    m.roleId = role.id;
    return { ...m, user: toUser(ctx.db.users.find((u) => u.id === m.userId)!) };
  });

  route("DELETE", "/projects/:id/members/:userId", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "project.manage_members");
    lastAdminGuard(ctx.db, p.id, ctx.params.userId!);
    ctx.db.projectMembers = ctx.db.projectMembers.filter((m) => !(m.projectId === p.id && m.userId === ctx.params.userId));
    return undefined;
  });

  /* access requests */
  route("POST", "/projects/:id/access-requests", (ctx) => {
    const userId = requireUser(ctx);
    const p = projectById(ctx, ctx.params.id!);
    if (!wsMembership(ctx.db, userId, p.workspaceId)) fail(404, "not_found", "Project not found.");
    if (projectMembership(ctx.db, userId, p.id)) fail(409, "already_member", "You’re already a member.");
    let req = ctx.db.accessRequests.find((r) => r.projectId === p.id && r.userId === userId && r.status === "pending");
    if (!req) {
      req = { id: uid("ar"), projectId: p.id, userId, message: (str(ctx.body, "message") ?? "").slice(0, 300), createdAt: nowISO(), status: "pending" };
      ctx.db.accessRequests.push(req);
      for (const admin of accessInfo(ctx.db, p, userId).admins) {
        notify(ctx.db, admin.id, "assigned", userId, null, p.id, { quote: `${ctx.db.users.find((u) => u.id === userId)?.name} requested access to ${p.name}` });
      }
    }
    return req;
  });
  route("DELETE", "/projects/:id/access-requests/mine", (ctx) => {
    const userId = requireUser(ctx);
    ctx.db.accessRequests
      .filter((r) => r.projectId === ctx.params.id && r.userId === userId && r.status === "pending")
      .forEach((r) => (r.status = "withdrawn"));
    return undefined;
  });
  route("GET", "/projects/:id/access-requests", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "project.manage_members");
    return ctx.db.accessRequests
      .filter((r) => r.projectId === p.id && r.status === "pending")
      .map((r) => ({ ...r, user: toUser(ctx.db.users.find((u) => u.id === r.userId)!) }));
  });

  /* statuses, labels */
  route("GET", "/projects/:id/statuses", (ctx) => {
    const p = memberProject(ctx, ctx.params.id!);
    const live = liveTasks(ctx.db, p.id);
    return statusesOf(ctx.db, p.id).map((s) => ({ ...s, taskCount: live.filter((t) => t.statusId === s.id).length }));
  });
  route("POST", "/projects/:id/statuses", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "status.manage");
    const name = (str(ctx.body, "name") ?? "").trim();
    if (!name) invalid({ name: "Name the status" });
    const category = (str(ctx.body, "category") ?? "in_progress") as Status["category"];
    const glyph = category === "todo" ? "todo" : category === "done" ? "done" : "progress";
    const list = statusesOf(ctx.db, p.id);
    if (list.some((x) => x.name.toLowerCase() === name.toLowerCase())) invalid({ name: `${name} already exists` });
    const s: Status = { id: uid("st"), projectId: p.id, name: name.slice(0, 30), category, glyph, position: list.length };
    // Board 28: a new status goes to the end of its category group.
    const order = ["todo", "in_progress", "done"];
    const at = list.filter((x) => order.indexOf(x.category) <= order.indexOf(category)).length;
    list.splice(at, 0, s);
    list.forEach((x, i) => (x.position = i));
    ctx.db.statuses.push(s);
    return s;
  });
  route("PATCH", "/projects/:id/statuses/:statusId", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "status.manage");
    const s = ctx.db.statuses.find((x) => x.id === ctx.params.statusId && x.projectId === p.id);
    if (!s) fail(404, "not_found", "Status not found.");
    const name = str(ctx.body, "name");
    if (name !== undefined) {
      if (!name.trim()) invalid({ name: "Name the status" });
      s.name = name.trim().slice(0, 30);
    }
    const color = (ctx.body as { color?: unknown })?.color;
    if (color === null || (typeof color === "string" && /^var\(--[a-z0-9-]+\)$/.test(color))) s.color = color;
    const position = (ctx.body as { position?: number })?.position;
    if (typeof position === "number") {
      const list = statusesOf(ctx.db, p.id).filter((x) => x.id !== s.id);
      list.splice(Math.max(0, Math.min(position, list.length)), 0, s);
      list.forEach((x, i) => (x.position = i));
    }
    return s;
  });
  route("DELETE", "/projects/:id/statuses/:statusId", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "status.manage");
    const s = ctx.db.statuses.find((x) => x.id === ctx.params.statusId && x.projectId === p.id);
    if (!s) fail(404, "not_found", "Status not found.");
    if (statusesOf(ctx.db, p.id).filter((x) => x.category === s.category).length < 2)
      fail(409, "last_in_category", "Each group needs at least one status.");
    // Board 28: tasks (including deleted ones, so restores land somewhere) move to `moveTo`.
    const moveTo = str(ctx.body, "moveTo");
    const target = moveTo ? ctx.db.statuses.find((x) => x.id === moveTo && x.projectId === p.id && x.id !== s.id) : undefined;
    const affected = ctx.db.tasks.filter((t) => t.statusId === s.id);
    if (affected.some((t) => !t.deletedAt) && !target) fail(409, "status_in_use", "Pick where this status’s tasks go.");
    if (target)
      affected.forEach((t) => {
        t.statusId = target.id;
        t.version += 1;
        t.completedAt = target.category === "done" ? (t.completedAt ?? nowISO()) : null;
      });
    ctx.db.statuses = ctx.db.statuses.filter((x) => x.id !== s.id);
    statusesOf(ctx.db, p.id).forEach((x, i) => (x.position = i));
    return undefined;
  });
  route("GET", "/projects/:id/labels", (ctx) => {
    const p = memberProject(ctx, ctx.params.id!);
    const live = liveTasks(ctx.db, p.id);
    return ctx.db.labels
      .filter((l) => l.projectId === p.id)
      .map((l) => ({ ...l, taskCount: live.filter((t) => t.labelIds.includes(l.id)).length }));
  });
  /* Board 28: label rename / recolor / delete (project.update). */
  route("PATCH", "/projects/:id/labels/:labelId", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "project.update");
    const l = ctx.db.labels.find((x) => x.id === ctx.params.labelId && x.projectId === p.id);
    if (!l) fail(404, "not_found", "Label not found.");
    const name = str(ctx.body, "name");
    if (name !== undefined) {
      const n = name.trim().toLowerCase().slice(0, 24);
      if (!n) invalid({ name: "Name the label" });
      if (ctx.db.labels.some((x) => x.projectId === p.id && x.id !== l.id && x.name === n)) invalid({ name: "Already exists" });
      l.name = n;
    }
    const color = str(ctx.body, "color");
    if (color !== undefined && /^var\(--[a-z0-9-]+\)$/.test(color)) l.color = color;
    return l;
  });
  route("DELETE", "/projects/:id/labels/:labelId", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "project.update");
    const id = ctx.params.labelId!;
    ctx.db.labels = ctx.db.labels.filter((x) => !(x.id === id && x.projectId === p.id));
    ctx.db.tasks
      .filter((t) => t.projectId === p.id && t.labelIds.includes(id))
      .forEach((t) => {
        t.labelIds = t.labelIds.filter((x) => x !== id);
        t.version += 1;
      });
    return undefined;
  });
  route("POST", "/projects/:id/labels", (ctx) => {
    const p = projectById(ctx, ctx.params.id!);
    requireProject(ctx, p.id, "task.create");
    const name = (str(ctx.body, "name") ?? "").trim().toLowerCase().slice(0, 24);
    if (!name) invalid({ name: "Name the label" });
    const existing = ctx.db.labels.find((l) => l.projectId === p.id && l.name === name);
    if (existing) return existing;
    const l = { id: uid("lb"), projectId: p.id, name, color: str(ctx.body, "color") ?? "var(--text-3)" };
    ctx.db.labels.push(l);
    return l;
  });

  /* activity + summary */
  route("GET", "/projects/:id/activity", (ctx) => {
    const p = memberProject(ctx, ctx.params.id!);
    return paginate(ctx.db.activity.filter((a) => a.projectId === p.id), ctx.query, 20);
  });

  route("GET", "/projects/:id/summary", (ctx): ProjectSummary => {
    const p = memberProject(ctx, ctx.params.id!);
    const statuses = statusesOf(ctx.db, p.id);
    const tasks = liveTasks(ctx.db, p.id);
    const sprint = ctx.db.sprints.find((s) => s.projectId === p.id && s.state === "active");
    const done = tasks.filter((t) => isDoneStatus(t.statusId, statuses));
    const cycles = done
      .filter((t) => t.startedAt && t.completedAt)
      .map((t) => (new Date(t.completedAt!).getTime() - new Date(t.startedAt!).getTime()) / DAY);
    const weekAhead = Date.now() + 7 * DAY;
    return {
      openTasks: tasks.filter((t) => statuses.find((s) => s.id === t.statusId)?.category !== "done").length,
      doneThisSprint: sprint ? done.filter((t) => t.sprintId === sprint.id).length : 0,
      cycleTimeDays: cycles.length ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 10) / 10 : 0,
      dueThisWeek: tasks.filter((t) => t.dueDate && new Date(t.dueDate).getTime() <= weekAhead && !isDoneStatus(t.statusId, statuses)).length,
    };
  });

  route("GET", "/projects/:id/active-sprint", (ctx) => {
    const p = memberProject(ctx, ctx.params.id!);
    const s = ctx.db.sprints.find((x) => x.projectId === p.id && x.state === "active");
    return s ? toSprint(ctx.db, s) : null;
  });
}

function hasWs(ctx: Ctx, workspaceId: string, perm: "project.assign_admin") {
  try {
    requireWs(ctx, workspaceId, perm);
    return true;
  } catch {
    return false;
  }
}
