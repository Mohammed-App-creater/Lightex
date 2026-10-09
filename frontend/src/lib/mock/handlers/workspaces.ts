import type { SearchResult, WorkspaceMember } from "@/lib/api/types";
import { PERMISSION_CATALOGUE, DEFAULT_ROLES } from "@/lib/permissions/catalogue";
import { nowISO, uid } from "../db";
import type { MockDB, RoleRec } from "../db-types";
import { projectMembership, toProject, toRole, toTask, toUser, toWorkspace, wsMembership } from "../derive";
import { auditList } from "./audit";
import { toInvite } from "./auth";
import { fail, filterValues, invalid, paginate, requireUser, requireWs, route, str, wsBySlug, type Ctx } from "../router";

const RESERVED = ["admin", "lightex", "api", "app", "login", "register", "onboarding", "dev", "invite"];
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

function toMember(db: MockDB, m: MockDB["wsMembers"][number]): WorkspaceMember {
  const u = db.users.find((x) => x.id === m.userId)!;
  return { ...m, user: toUser(u) };
}

export function audit(db: MockDB, workspaceId: string, actorId: string, action: string, target: string) {
  db.audit.unshift({
    id: uid("au"),
    workspaceId,
    actorId,
    action,
    target,
    createdAt: nowISO(),
    entityType: action.split(".")[0],
    source: "web",
    requestId: `req_${uid("").slice(-10)}`,
  });
}

function seedRoles(db: MockDB, workspaceId: string) {
  for (const r of DEFAULT_ROLES) {
    db.roles.push({
      id: `${workspaceId}-role-${r.key}`,
      workspaceId,
      key: r.key,
      name: r.name,
      description: r.description,
      scope: r.scope,
      isSystem: true,
      permissions: [...r.permissions],
    });
  }
}

/** Projects the user can see in a workspace: only those they're a member of. */
function visibleProjectIds(db: MockDB, userId: string, workspaceId: string) {
  return db.projects
    .filter((p) => p.workspaceId === workspaceId && projectMembership(db, userId, p.id))
    .map((p) => p.id);
}

export function registerWorkspaces() {
  route("GET", "/workspaces", (ctx) => {
    const userId = requireUser(ctx);
    return ctx.db.workspaces
      .filter((w) => !w.deletedAt && wsMembership(ctx.db, userId, w.id))
      .map((w) => toWorkspace(ctx.db, w, userId));
  });

  route("POST", "/workspaces", (ctx) => {
    const userId = requireUser(ctx);
    const name = (str(ctx.body, "name") ?? "").trim();
    const slug = slugify(str(ctx.body, "slug") ?? name);
    if (name.length < 2) invalid({ name: "Use at least 2 characters" });
    if (RESERVED.includes(slug) || ctx.db.workspaces.some((w) => w.slug === slug)) invalid({ slug: `lightex.app/${slug} is taken` });
    const ws = { id: uid("ws"), slug, name: name.slice(0, 40), hue: Math.floor(Math.random() * 360), createdAt: nowISO(), deletedAt: null };
    ctx.db.workspaces.push(ws);
    seedRoles(ctx.db, ws.id);
    ctx.db.wsMembers.push({ workspaceId: ws.id, userId, roleId: `${ws.id}-role-owner`, status: "active", joinedAt: nowISO(), lastActiveAt: nowISO() });
    audit(ctx.db, ws.id, userId, "workspace.created", ws.name);
    return toWorkspace(ctx.db, ws, userId);
  });

  route("GET", "/workspaces/:slug", (ctx) => toWorkspace(ctx.db, wsBySlug(ctx, ctx.params.slug!), ctx.userId!));

  route("PATCH", "/workspaces/:slug", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "workspace.update");
    const name = str(ctx.body, "name");
    const slug = str(ctx.body, "slug");
    const policy = (ctx.body as { notificationPolicy?: { sms?: unknown } } | null)?.notificationPolicy;
    const fields: Record<string, string> = {};
    if (policy !== undefined && typeof policy?.sms !== "boolean") fields["notificationPolicy.sms"] = "Must be true or false";
    if (name !== undefined && name.trim().length < 2) fields.name = "Use at least 2 characters";
    if (slug !== undefined) {
      const s = slugify(slug);
      if (s.length < 2) fields.slug = "Use at least 2 characters";
      else if (RESERVED.includes(s) || ctx.db.workspaces.some((w) => w.slug === s && w.id !== ws.id)) fields.slug = `lightex.app/${s} is taken`;
    }
    if (Object.keys(fields).length) invalid(fields);
    if (name !== undefined) ws.name = name.trim().slice(0, 40);
    if (slug !== undefined) ws.slug = slugify(slug);
    // Board 38 (§4.2): the workspace SMS policy, audited as `changes.smsNotifications`.
    const sms = policy?.sms as boolean | undefined;
    const before = ws.smsEnabled !== false;
    if (sms !== undefined) ws.smsEnabled = sms;
    audit(ctx.db, ws.id, ctx.userId!, "workspace.updated", ws.name);
    if (sms !== undefined && sms !== before) {
      ctx.db.audit[0]!.changes = [{ field: "smsNotifications", kind: "value", before: String(before), after: String(sms) }];
    }
    return toWorkspace(ctx.db, ws, ctx.userId!);
  });

  route("DELETE", "/workspaces/:slug", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "workspace.delete");
    if (str(ctx.body, "confirm") !== ws.slug) invalid({ confirm: `Type ${ws.slug} to confirm` });
    ws.deletedAt = nowISO();
    return undefined;
  });

  route("GET", "/workspaces/:slug/slug-availability", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const q = slugify(String(ctx.query.q ?? ""));
    const available = q.length >= 2 && !RESERVED.includes(q) && !ctx.db.workspaces.some((w) => w.slug === q && w.id !== ws.id);
    return { slug: q, available };
  });

  /* members */
  route("GET", "/workspaces/:slug/members", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const q = String(ctx.query.q ?? "").toLowerCase();
    const roles = filterValues(ctx.query, "role");
    const list = ctx.db.wsMembers
      .filter((m) => m.workspaceId === ws.id)
      .map((m) => toMember(ctx.db, m))
      .filter((m) => !q || m.user.name.toLowerCase().includes(q) || m.user.email.toLowerCase().includes(q))
      .filter((m) => !roles.length || roles.includes(m.roleId))
      .sort((a, b) => a.user.name.localeCompare(b.user.name));
    return paginate(list, ctx.query, 100);
  });

  route("PATCH", "/workspaces/:slug/members/:userId", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "workspace.manage_members");
    const m = ctx.db.wsMembers.find((x) => x.workspaceId === ws.id && x.userId === ctx.params.userId);
    if (!m) fail(404, "not_found", "Member not found.");
    const roleId = str(ctx.body, "roleId");
    const role = ctx.db.roles.find((r) => r.id === roleId && r.workspaceId === ws.id && r.scope === "workspace");
    const current = ctx.db.roles.find((r) => r.id === m.roleId);
    if (!role) invalid({ roleId: "Pick a workspace role" });
    if (role.key === "owner" || current?.key === "owner") fail(403, "forbidden", "The owner role can’t be assigned or changed.");
    m.roleId = role.id;
    audit(ctx.db, ws.id, ctx.userId!, "member.role_changed", `${m.userId} → ${role.name}`);
    return toMember(ctx.db, m);
  });

  route("DELETE", "/workspaces/:slug/members/:userId", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "workspace.manage_members");
    const m = ctx.db.wsMembers.find((x) => x.workspaceId === ws.id && x.userId === ctx.params.userId);
    if (!m) fail(404, "not_found", "Member not found.");
    if (ctx.db.roles.find((r) => r.id === m.roleId)?.key === "owner") fail(403, "forbidden", "The owner can’t be removed.");
    if (m.userId === ctx.userId) fail(403, "forbidden", "You can’t remove yourself.");
    ctx.db.wsMembers = ctx.db.wsMembers.filter((x) => x !== m);
    const projectIds = ctx.db.projects.filter((p) => p.workspaceId === ws.id).map((p) => p.id);
    ctx.db.projectMembers = ctx.db.projectMembers.filter((pm) => !(pm.userId === m.userId && projectIds.includes(pm.projectId)));
    audit(ctx.db, ws.id, ctx.userId!, "member.removed", m.userId);
    return undefined;
  });

  /* invites */
  route("GET", "/workspaces/:slug/invites", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "workspace.manage_members");
    return ctx.db.invites.filter((i) => i.workspaceId === ws.id && i.status === "pending").map((i) => toInvite(ctx.db, i));
  });

  route("POST", "/workspaces/:slug/invites", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "workspace.manage_members");
    const emails = ((ctx.body as { emails?: unknown })?.emails ?? []) as string[];
    const roleId = str(ctx.body, "roleId");
    const role = ctx.db.roles.find((r) => r.id === roleId && r.workspaceId === ws.id && r.scope === "workspace");
    if (!role || role.key === "owner") invalid({ roleId: "Pick a role" });
    const bad = emails.filter((e) => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e));
    if (!emails.length) invalid({ emails: "Add at least one email" });
    if (bad.length) invalid({ emails: bad.length === 1 ? `“${bad[0]}” isn’t an email` : `${bad.length} emails need fixing` });
    const created = [];
    for (const raw of emails.slice(0, 20)) {
      const email = raw.trim().toLowerCase();
      const member = ctx.db.users.find((u) => u.email === email && wsMembership(ctx.db, u.id, ws.id));
      if (member || ctx.db.invites.some((i) => i.workspaceId === ws.id && i.email === email && i.status === "pending")) continue;
      const inv = {
        id: uid("inv"),
        token: uid("tok"),
        workspaceId: ws.id,
        email,
        roleId: role.id,
        invitedById: ctx.userId!,
        createdAt: nowISO(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        status: "pending" as const,
      };
      ctx.db.invites.push(inv);
      created.push(toInvite(ctx.db, inv));
    }
    audit(ctx.db, ws.id, ctx.userId!, "member.invited", emails.join(", "));
    return created;
  });

  route("DELETE", "/workspaces/:slug/invites/:id", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "workspace.manage_members");
    const inv = ctx.db.invites.find((i) => i.id === ctx.params.id && i.workspaceId === ws.id);
    if (!inv) fail(404, "not_found", "Invite not found.");
    inv.status = "revoked";
    return undefined;
  });

  route("POST", "/workspaces/:slug/invites/:id/resend", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "workspace.manage_members");
    const inv = ctx.db.invites.find((i) => i.id === ctx.params.id && i.workspaceId === ws.id);
    if (!inv) fail(404, "not_found", "Invite not found.");
    inv.expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    return toInvite(ctx.db, inv);
  });

  /* roles */
  route("GET", "/permissions", () => PERMISSION_CATALOGUE);

  route("GET", "/workspaces/:slug/roles", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const scopes = filterValues(ctx.query, "scope");
    return ctx.db.roles
      .filter((r) => r.workspaceId === ws.id && (!scopes.length || scopes.includes(r.scope)))
      .map((r) => toRole(ctx.db, r));
  });

  route("POST", "/workspaces/:slug/roles", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "workspace.manage_roles");
    const body = ctx.body as Partial<RoleRec>;
    const name = (body.name ?? "").trim();
    const scope = body.scope === "project" ? "project" : "workspace";
    if (!name) invalid({ name: "Name is required" });
    if (ctx.db.roles.some((r) => r.workspaceId === ws.id && r.scope === scope && r.name.toLowerCase() === name.toLowerCase()))
      invalid({ name: "A role with this name exists" });
    const allowed = PERMISSION_CATALOGUE.filter((p) => p.scope === scope).map((p) => p.key);
    const role: RoleRec = {
      id: uid("role"),
      workspaceId: ws.id,
      key: null,
      name: name.slice(0, 40),
      description: (body.description ?? "").slice(0, 80),
      scope,
      isSystem: false,
      permissions: (body.permissions ?? []).filter((p) => allowed.includes(p)),
    };
    ctx.db.roles.push(role);
    audit(ctx.db, ws.id, ctx.userId!, "role.created", role.name);
    return toRole(ctx.db, role);
  });

  route("PATCH", "/roles/:id", (ctx) => {
    const role = roleForManage(ctx);
    if (role.isSystem) fail(403, "forbidden", "System roles are locked. Duplicate to customize.");
    const body = ctx.body as Partial<RoleRec>;
    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) invalid({ name: "Name is required" });
      if (ctx.db.roles.some((r) => r.id !== role.id && r.workspaceId === role.workspaceId && r.scope === role.scope && r.name.toLowerCase() === name.toLowerCase()))
        invalid({ name: "A role with this name exists" });
      role.name = name.slice(0, 40);
    }
    if (body.description !== undefined) role.description = body.description.slice(0, 80);
    if (body.permissions) {
      const allowed = PERMISSION_CATALOGUE.filter((p) => p.scope === role.scope).map((p) => p.key);
      role.permissions = body.permissions.filter((p) => allowed.includes(p));
    }
    audit(ctx.db, role.workspaceId, ctx.userId!, "role.updated", role.name);
    return toRole(ctx.db, role);
  });

  route("DELETE", "/roles/:id", (ctx) => {
    const role = roleForManage(ctx);
    if (role.isSystem) fail(403, "forbidden", "System roles can’t be deleted.");
    const reassignTo = str(ctx.body, "reassignTo");
    const inUse =
      ctx.db.wsMembers.some((m) => m.roleId === role.id) || ctx.db.projectMembers.some((m) => m.roleId === role.id);
    if (inUse) {
      const target = ctx.db.roles.find((r) => r.id === reassignTo && r.scope === role.scope && r.workspaceId === role.workspaceId);
      if (!target) fail(409, "role_in_use", "Reassign members before deleting this role.", { memberCount: toRole(ctx.db, role).memberCount });
      ctx.db.wsMembers.forEach((m) => m.roleId === role.id && (m.roleId = target.id));
      ctx.db.projectMembers.forEach((m) => m.roleId === role.id && (m.roleId = target.id));
    }
    ctx.db.roles = ctx.db.roles.filter((r) => r.id !== role.id);
    audit(ctx.db, role.workspaceId, ctx.userId!, "role.deleted", role.name);
    return undefined;
  });

  /* audit, activity, my tasks, search */
  route("GET", "/workspaces/:slug/audit", (ctx) => auditList(ctx));

  route("GET", "/workspaces/:slug/activity", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const ids = visibleProjectIds(ctx.db, ctx.userId!, ws.id);
    const list = ctx.db.activity.filter((a) => ids.includes(a.projectId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return paginate(list, ctx.query, 20);
  });

  route("GET", "/workspaces/:slug/tasks", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const ids = visibleProjectIds(ctx.db, ctx.userId!, ws.id);
    const assignee = filterValues(ctx.query, "assignee").map((a) => (a === "me" ? ctx.userId! : a));
    const list = ctx.db.tasks
      .filter((t) => !t.deletedAt && ids.includes(t.projectId))
      .filter((t) => !assignee.length || (t.assigneeId && assignee.includes(t.assigneeId)))
      .map((t) => toTask(ctx.db, t))
      .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || b.priority - a.priority);
    return paginate(list, ctx.query, 200);
  });

  route("GET", "/workspaces/:slug/search", (ctx) => searchHandler(ctx));
}

function roleForManage(ctx: Ctx) {
  requireUser(ctx);
  const role = ctx.db.roles.find((r) => r.id === ctx.params.id);
  if (!role) fail(404, "not_found", "Role not found.");
  requireWs(ctx, role.workspaceId, "workspace.manage_roles");
  return role;
}

function searchHandler(ctx: Ctx) {
  const ws = wsBySlug(ctx, ctx.params.slug!);
  const userId = ctx.userId!;
  const q = String(ctx.query.q ?? "").trim().toLowerCase();
  const types = filterValues(ctx.query, "type");
  const want = (t: string) => !types.length || types.includes(t);
  const ids = visibleProjectIds(ctx.db, userId, ws.id);
  const out: SearchResult[] = [];
  if (want("task")) {
    const tasks = ctx.db.tasks
      .filter((t) => !t.deletedAt && ids.includes(t.projectId))
      .filter((t) => !q || t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q))
      .slice(0, Math.min(Number(ctx.query.limit) || 50, 50)); // the backend caps at 50
    for (const t of tasks) {
      const p = ctx.db.projects.find((x) => x.id === t.projectId)!;
      const s = ctx.db.statuses.find((x) => x.id === t.statusId)!;
      out.push({ type: "task", task: toTask(ctx.db, t), projectKey: p.key, projectName: p.name, status: { name: s.name, glyph: s.glyph } });
    }
  }
  if (want("project")) {
    ctx.db.projects
      .filter((p) => ids.includes(p.id) && (!q || p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q)))
      .forEach((p) => out.push({ type: "project", project: toProject(ctx.db, p, userId) }));
  }
  if (want("user")) {
    ctx.db.wsMembers
      .filter((m) => m.workspaceId === ws.id && m.status === "active")
      .forEach((m) => {
        const u = ctx.db.users.find((x) => x.id === m.userId)!;
        if (q && !u.name.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) return;
        out.push({ type: "user", user: toUser(u), roleName: ctx.db.roles.find((r) => r.id === m.roleId)?.name ?? "" });
      });
  }
  return out;
}
