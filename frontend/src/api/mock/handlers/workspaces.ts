import { auditTargetFields } from "@/lib/audit";
import type { AuditChange, Paginated, PermissionInfo, SearchResult, WorkspaceMember } from "@/api/types";
import { PERMISSION_CATALOGUE, DEFAULT_ROLES, SELF_SERVICE_CODES } from "@/platform/roles/catalogue";
import { nowISO, uid } from "../db";
import type { MockDB, RoleRec } from "../db-types";
import {
  DEFAULT_TIMEZONE,
  codesOf,
  comparePrecedence,
  projectMembership,
  rolesOf,
  sortRoleIds,
  toActivity,
  toProject,
  toRole,
  toTask,
  toUser,
  toWorkspace,
  wsMembership,
} from "../derive";
import { isModuleOn, moduleOfCode, onlyEnabled, writeModule } from "../modules";
import { auditList } from "./audit";
import { creationModules } from "./modules";
import { assertWithinOwnScope, resolveDataScopes, roleDataScopes, widestScopes } from "../data-scope";
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
  const roleIds = sortRoleIds(db, m.roleIds);
  // Sales S0: `roleId` is the primary role, `roleIds[0]`.
  return { ...m, roleId: roleIds[0] ?? "", roleIds, user: toUser(u) };
}

/* ───────────── Sales S0 (s0-contract §1): several workspace roles per member ───────────── */

/** The backend's OWNER_PERMISSION: the workspace always keeps an active member holding it. */
const OWNER_PERMISSION = "core.workspace.delete";

/**
 * The roles a request names: `roleIds` (a non-empty list; wins when both are sent), else the old single `roleId`.
 * In precedence order, duplicates dropped. 422 `validation_failed` otherwise.
 */
export function workspaceRolesFrom(db: MockDB, workspaceId: string, body: unknown): RoleRec[] {
  const b = (body ?? {}) as { roleIds?: unknown; roleId?: unknown };
  const find = (id: unknown) => db.roles.find((r) => r.id === id && r.workspaceId === workspaceId && r.scope === "workspace");
  if ("roleIds" in b) {
    if (!Array.isArray(b.roleIds) || !b.roleIds.length) invalid({ roleIds: "Pick at least one role" });
    const roles = [...new Set(b.roleIds.map(String))].map(find);
    if (roles.some((r) => !r)) invalid({ roleIds: "Pick workspace roles" });
    return (roles as RoleRec[]).sort(comparePrecedence);
  }
  if (b.roleId === undefined || b.roleId === null || b.roleId === "") invalid({ roleIds: "Pick at least one role" });
  const role = find(b.roleId);
  if (!role) invalid({ roleId: "Pick a workspace role" });
  return [role];
}

/**
 * No privilege escalation: adding or removing roles needs every (enabled) permission they grant, self-service codes
 * excepted (403 `forbidden`), and (sales S7) no data scope wider than the actor's own (403 `data_scope_exceeds_own`;
 * owners exempt).
 */
function ensureCanGrant(db: MockDB, actorId: string, workspaceId: string, roles: readonly RoleRec[]) {
  const actor = wsMembership(db, actorId, workspaceId);
  // Every code the actor's roles grant (the union), so catalogue entries added at runtime count too.
  const mine = new Set(actor ? onlyEnabled(db, workspaceId, [...codesOf(rolesOf(db, actor.roleIds))]) : []);
  const missing = onlyEnabled(db, workspaceId, [...codesOf(roles)]).filter((c) => !mine.has(c) && !SELF_SERVICE_CODES.has(c)).sort();
  if (missing.length) fail(403, "forbidden", "You can’t assign a role with permissions you don’t have.", { permission: missing[0] });
  assertWithinOwnScope(db, actorId, workspaceId, widestScopes(roles.map((r) => roleDataScopes(db, r))));
}

type OwnerChange = { member?: { userId: string; roleIds: string[] }; role?: { id: string; permissions: string[] } };

/** Active members holding OWNER_PERMISSION, with one member's roles or one role's grants replaced. */
function ownerHolders(db: MockDB, workspaceId: string, what: OwnerChange = {}) {
  const perms = (r: RoleRec) => (what.role?.id === r.id ? what.role.permissions : (r.permissions as string[]));
  return db.wsMembers.filter((m) => {
    if (m.workspaceId !== workspaceId || m.status !== "active") return false;
    const ids = what.member?.userId === m.userId ? what.member.roleIds : m.roleIds;
    return rolesOf(db, ids).some((r) => perms(r).includes(OWNER_PERMISSION));
  }).length;
}

/** 409 `last_owner` when the change would leave the workspace with no active member holding OWNER_PERMISSION. */
function assertOwnerRemains(db: MockDB, workspaceId: string, what: OwnerChange) {
  if (ownerHolders(db, workspaceId) > 0 && ownerHolders(db, workspaceId, what) === 0) {
    fail(409, "last_owner", "A workspace needs at least one owner. Make someone else an owner first.");
  }
}

const roleNames = (roles: readonly RoleRec[]) => roles.map((r) => r.name).join(", ");

/** Sales S0: an IANA name the runtime knows. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function audit(db: MockDB, workspaceId: string, actorId: string, action: string, target: string) {
  db.audit.unshift({
    id: uid("au"),
    workspaceId,
    actorId,
    action,
    target,
    createdAt: nowISO(),
    ...auditTargetFields(action),
    targetId: null,
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
      ...(r.dataScopes ? { dataScopes: { ...r.dataScopes } } : {}),
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
    // Stage 3: tracking plus the optional `modules` passed at creation.
    const extra = creationModules(ctx.body);
    const ws = { id: uid("ws"), slug, name: name.slice(0, 40), hue: Math.floor(Math.random() * 360), createdAt: nowISO(), deletedAt: null, timezone: DEFAULT_TIMEZONE };
    ctx.db.workspaces.push(ws);
    seedRoles(ctx.db, ws.id);
    for (const key of ["tracking", ...extra]) writeModule(ctx.db, ws.id, key, true, userId);
    ctx.db.wsMembers.push({ workspaceId: ws.id, userId, roleIds: [`${ws.id}-role-owner`], status: "active", joinedAt: nowISO(), lastActiveAt: nowISO() });
    audit(ctx.db, ws.id, userId, "core.workspace.created", ws.name);
    return toWorkspace(ctx.db, ws, userId);
  });

  route("GET", "/workspaces/:slug", (ctx) => toWorkspace(ctx.db, wsBySlug(ctx, ctx.params.slug!), ctx.userId!));

  route("PATCH", "/workspaces/:slug", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "core.workspace.update");
    const name = str(ctx.body, "name");
    const slug = str(ctx.body, "slug");
    const policy = (ctx.body as { notificationPolicy?: { sms?: unknown } } | null)?.notificationPolicy;
    const hasTz = ctx.body !== null && typeof ctx.body === "object" && "timezone" in ctx.body;
    const tz = (ctx.body as { timezone?: unknown } | null)?.timezone;
    const fields: Record<string, string> = {};
    // Sales S0: an IANA name; audited as a "Time zone" change.
    if (hasTz && !isValidTimeZone(tz)) fields.timezone = "Pick a valid time zone";
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
    const tzBefore = ws.timezone ?? DEFAULT_TIMEZONE;
    if (hasTz) ws.timezone = tz as string;
    audit(ctx.db, ws.id, ctx.userId!, "core.workspace.updated", ws.name);
    const changes: AuditChange[] = [];
    if (sms !== undefined && sms !== before) changes.push({ field: "smsNotifications", kind: "value", before: String(before), after: String(sms) });
    if (hasTz && tz !== tzBefore) changes.push({ field: "Time zone", kind: "value", before: tzBefore, after: tz as string });
    if (changes.length) ctx.db.audit[0]!.changes = changes;
    return toWorkspace(ctx.db, ws, ctx.userId!);
  });

  route("DELETE", "/workspaces/:slug", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "core.workspace.delete");
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
  route("GET", "/workspaces/:slug/members", (ctx): Paginated<WorkspaceMember> => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const q = String(ctx.query.q ?? "").toLowerCase();
    const roles = filterValues(ctx.query, "role");
    const list = ctx.db.wsMembers
      .filter((m) => m.workspaceId === ws.id)
      .map((m) => toMember(ctx.db, m))
      .filter((m) => !q || m.user.name.toLowerCase().includes(q) || m.user.email.toLowerCase().includes(q))
      // Sales S0: members holding any of the given roles.
      .filter((m) => !roles.length || m.roleIds.some((id) => roles.includes(id)))
      .sort((a, b) => a.user.name.localeCompare(b.user.name));
    return paginate(list, ctx.query, 100);
  });

  route("PATCH", "/workspaces/:slug/members/:userId", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "core.workspace.manage_members");
    const m = ctx.db.wsMembers.find((x) => x.workspaceId === ws.id && x.userId === ctx.params.userId);
    if (!m) fail(404, "not_found", "Member not found.");
    // Sales S0: `roleIds` replaces the member's roles (the old `roleId` means `[roleId]`).
    const roles = workspaceRolesFrom(ctx.db, ws.id, ctx.body);
    const current = rolesOf(ctx.db, m.roleIds);
    const before = new Set(current.map((r) => r.id));
    const after = new Set(roles.map((r) => r.id));
    if (before.size === after.size && [...after].every((id) => before.has(id))) return toMember(ctx.db, m);
    // Only the roles added or removed are checked; the ones the member keeps aren't.
    ensureCanGrant(ctx.db, ctx.userId!, ws.id, [...roles.filter((r) => !before.has(r.id)), ...current.filter((r) => !after.has(r.id))]);
    assertOwnerRemains(ctx.db, ws.id, { member: { userId: m.userId, roleIds: [...after] } });
    m.roleIds = roles.map((r) => r.id);
    const name = ctx.db.users.find((u) => u.id === m.userId)?.name ?? m.userId;
    audit(ctx.db, ws.id, ctx.userId!, "core.member.role_changed", name);
    ctx.db.audit[0]!.changes = [{ field: "Roles", kind: "value", before: roleNames(current), after: roleNames(roles) }];
    return toMember(ctx.db, m);
  });

  route("DELETE", "/workspaces/:slug/members/:userId", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "core.workspace.manage_members");
    const m = ctx.db.wsMembers.find((x) => x.workspaceId === ws.id && x.userId === ctx.params.userId);
    if (!m) fail(404, "not_found", "Member not found.");
    if (m.userId === ctx.userId) fail(403, "forbidden", "You can’t remove yourself.");
    // Sales S0: removing someone needs every permission their roles grant, and leaves at least one owner.
    ensureCanGrant(ctx.db, ctx.userId!, ws.id, rolesOf(ctx.db, m.roleIds));
    assertOwnerRemains(ctx.db, ws.id, { member: { userId: m.userId, roleIds: [] } });
    ctx.db.wsMembers = ctx.db.wsMembers.filter((x) => x !== m);
    const projectIds = ctx.db.projects.filter((p) => p.workspaceId === ws.id).map((p) => p.id);
    ctx.db.projectMembers = ctx.db.projectMembers.filter((pm) => !(pm.userId === m.userId && projectIds.includes(pm.projectId)));
    // Stage 4: leaving the workspace removes the person's team memberships.
    ctx.db.teamMembers = ctx.db.teamMembers.filter((tm) => !(tm.workspaceId === ws.id && tm.userId === m.userId));
    audit(ctx.db, ws.id, ctx.userId!, "core.member.removed", m.userId);
    return undefined;
  });

  /* invites */
  route("GET", "/workspaces/:slug/invites", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "core.workspace.manage_members");
    return ctx.db.invites.filter((i) => i.workspaceId === ws.id && i.status === "pending").map((i) => toInvite(ctx.db, i));
  });

  route("POST", "/workspaces/:slug/invites", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "core.workspace.manage_members");
    const emails = ((ctx.body as { emails?: unknown })?.emails ?? []) as string[];
    if (!Array.isArray(emails) || !emails.length) invalid({ emails: "Add at least one email" });
    // Sales S0: one or more roles (`roleIds`, or the old `roleId`), each one the inviter could grant.
    const roles = workspaceRolesFrom(ctx.db, ws.id, ctx.body);
    const bad = emails.filter((e) => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e));
    if (!emails.length) invalid({ emails: "Add at least one email" });
    if (bad.length) invalid({ emails: bad.length === 1 ? `“${bad[0]}” isn’t an email` : `${bad.length} emails need fixing` });
    ensureCanGrant(ctx.db, ctx.userId!, ws.id, roles);
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
        roleIds: roles.map((r) => r.id),
        invitedById: ctx.userId!,
        createdAt: nowISO(),
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        status: "pending" as const,
      };
      ctx.db.invites.push(inv);
      created.push(toInvite(ctx.db, inv));
      audit(ctx.db, ws.id, ctx.userId!, "core.member.invited", email);
      ctx.db.audit[0]!.changes = [
        { field: "Email", kind: "value", before: null, after: email },
        { field: "Roles", kind: "value", before: null, after: roleNames(roles) },
      ];
    }
    return created;
  });

  route("DELETE", "/workspaces/:slug/invites/:id", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "core.workspace.manage_members");
    const inv = ctx.db.invites.find((i) => i.id === ctx.params.id && i.workspaceId === ws.id);
    if (!inv) fail(404, "not_found", "Invite not found.");
    inv.status = "revoked";
    return undefined;
  });

  route("POST", "/workspaces/:slug/invites/:id/resend", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "core.workspace.manage_members");
    const inv = ctx.db.invites.find((i) => i.id === ctx.params.id && i.workspaceId === ws.id);
    if (!inv) fail(404, "not_found", "Invite not found.");
    inv.expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    return toInvite(ctx.db, inv);
  });

  /* roles */
  route("GET", "/permissions", (): PermissionInfo[] => PERMISSION_CATALOGUE);

  route("GET", "/workspaces/:slug/roles", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const scopes = filterValues(ctx.query, "scope");
    return ctx.db.roles
      .filter((r) => r.workspaceId === ws.id && (!scopes.length || scopes.includes(r.scope)))
      .map((r) => toRole(ctx.db, r));
  });

  route("POST", "/workspaces/:slug/roles", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "core.roles.manage");
    const body = ctx.body as Partial<RoleRec>;
    const name = (body.name ?? "").trim();
    const scope = body.scope === "project" ? "project" : "workspace";
    if (!name) invalid({ name: "Name is required" });
    if (ctx.db.roles.some((r) => r.workspaceId === ws.id && r.scope === scope && r.name.toLowerCase() === name.toLowerCase()))
      invalid({ name: "A role with this name exists" });
    // Stage 3: a disabled module's permissions can't be granted while it's off.
    const allowed = onlyEnabled(ctx.db, ws.id, PERMISSION_CATALOGUE.filter((p) => p.scope === scope).map((p) => p.key));
    const permissions = (body.permissions ?? []).filter((p) => allowed.includes(p));
    const role: RoleRec = {
      id: uid("role"),
      workspaceId: ws.id,
      key: null,
      name: name.slice(0, 40),
      description: (body.description ?? "").slice(0, 80),
      scope,
      isSystem: false,
      permissions,
      // Stage 4: every granted scopable code needs a scope (400 data_scope_required / data_scope_not_allowed).
      dataScopes: resolveDataScopes(permissions, body.dataScopes),
    };
    // Stage 5: no wider than the actor's own scope (403 data_scope_exceeds_own; owners exempt).
    assertWithinOwnScope(ctx.db, ctx.userId!, ws.id, role.dataScopes ?? {});
    ctx.db.roles.push(role);
    audit(ctx.db, ws.id, ctx.userId!, "core.role.created", role.name);
    return toRole(ctx.db, role);
  });

  route("PATCH", "/roles/:id", (ctx) => {
    const role = roleForManage(ctx);
    const body = ctx.body as Partial<RoleRec>;
    // Sales sync: system roles' permissions are editable (as on the backend); the Owner role stays locked here, and
    // renaming or re-describing a system role is refused.
    if (role.isSystem) {
      if (role.scope === "workspace" && role.key === "owner") fail(403, "forbidden", "The Owner role is locked. Duplicate to customize.");
      const renamed = body.name !== undefined && body.name.trim() !== role.name;
      const redescribed = body.description !== undefined && body.description.slice(0, 80) !== role.description;
      if (renamed || redescribed) fail(403, "forbidden", "System roles can’t be renamed. Duplicate it to customise.");
    }
    // Everything is validated before anything is written.
    let name = role.name;
    if (body.name !== undefined) {
      name = body.name.trim();
      if (!name) invalid({ name: "Name is required" });
      if (ctx.db.roles.some((r) => r.id !== role.id && r.workspaceId === role.workspaceId && r.scope === role.scope && r.name.toLowerCase() === name.toLowerCase()))
        invalid({ name: "A role with this name exists" });
    }
    let permissions = role.permissions;
    if (body.permissions) {
      const allowed = onlyEnabled(ctx.db, role.workspaceId, PERMISSION_CATALOGUE.filter((p) => p.scope === role.scope).map((p) => p.key));
      // Stage 3: the client never sees a disabled module's grants, so they are kept as stored.
      const hidden = role.permissions.filter((p) => !isModuleOn(ctx.db, role.workspaceId, moduleOfCode(p)));
      permissions = [...body.permissions.filter((p) => allowed.includes(p)), ...hidden];
    }
    let dataScopes = role.dataScopes;
    // Stage 4: validated against the final grants; stored scopes stand in for codes the request leaves out.
    if (body.permissions || body.dataScopes !== undefined) {
      dataScopes = resolveDataScopes(permissions, body.dataScopes, role.dataScopes);
      // Stage 5: no wider than the actor's own scope (403 data_scope_exceeds_own; owners exempt).
      assertWithinOwnScope(ctx.db, ctx.userId!, role.workspaceId, dataScopes, role.dataScopes);
    }
    // Sales S0: taking OWNER_PERMISSION off a role can't leave the workspace without an owner.
    if (role.scope === "workspace") assertOwnerRemains(ctx.db, role.workspaceId, { role: { id: role.id, permissions } });
    role.name = name.slice(0, 40);
    if (body.description !== undefined) role.description = body.description.slice(0, 80);
    role.permissions = permissions;
    role.dataScopes = dataScopes;
    audit(ctx.db, role.workspaceId, ctx.userId!, "core.role.updated", role.name);
    return toRole(ctx.db, role);
  });

  route("DELETE", "/roles/:id", (ctx) => {
    const role = roleForManage(ctx);
    if (role.isSystem) fail(403, "forbidden", "System roles can’t be deleted.");
    const reassignTo = str(ctx.body, "reassignTo");
    const inUse =
      ctx.db.wsMembers.some((m) => m.roleIds.includes(role.id)) || ctx.db.projectMembers.some((m) => m.roleId === role.id);
    const target = reassignTo
      ? ctx.db.roles.find((r) => r.id === reassignTo && r.id !== role.id && r.scope === role.scope && r.workspaceId === role.workspaceId)
      : undefined;
    if (reassignTo && !target) invalid({ reassignTo: "Pick another role in the same scope" });
    if (inUse && !target) fail(409, "role_in_use", "Reassign members before deleting this role.", { memberCount: toRole(ctx.db, role).memberCount });
    // Sales S7: holders moved to the target can't receive more than the actor could grant.
    if (target && role.scope === "workspace") ensureCanGrant(ctx.db, ctx.userId!, role.workspaceId, [target]);
    if (target && role.scope === "workspace" && !target.permissions.includes(OWNER_PERMISSION as never)) {
      assertOwnerRemains(ctx.db, role.workspaceId, { role: { id: role.id, permissions: [] } });
    }
    // Sales S0: holders get the target (no duplicates); so do pending invites carrying the role.
    const swap = (ids: string[]) => sortRoleIds(ctx.db, ids.map((id) => (id === role.id ? target!.id : id)));
    if (target) {
      ctx.db.wsMembers.forEach((m) => m.roleIds.includes(role.id) && (m.roleIds = swap(m.roleIds)));
      ctx.db.projectMembers.forEach((m) => m.roleId === role.id && (m.roleId = target.id));
      ctx.db.invites.forEach((i) => i.status === "pending" && i.roleIds.includes(role.id) && (i.roleIds = swap(i.roleIds)));
    }
    // As before: an invite whose only role is the deleted one goes with it.
    ctx.db.invites = ctx.db.invites.filter((i) => !(i.roleIds.length === 1 && i.roleIds[0] === role.id));
    ctx.db.invites.forEach((i) => i.roleIds.includes(role.id) && (i.roleIds = i.roleIds.filter((id) => id !== role.id)));
    ctx.db.roles = ctx.db.roles.filter((r) => r.id !== role.id);
    audit(ctx.db, role.workspaceId, ctx.userId!, "core.role.deleted", role.name);
    return undefined;
  });

  /* audit, activity, my tasks, search */
  route("GET", "/workspaces/:slug/audit", (ctx) => auditList(ctx));

  route("GET", "/tracking/workspaces/:slug/activity", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const ids = visibleProjectIds(ctx.db, ctx.userId!, ws.id);
    const list = ctx.db.activity.filter((a) => ids.includes(a.projectId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toActivity);
    return paginate(list, ctx.query, 20);
  });

  route("GET", "/tracking/workspaces/:slug/tasks", (ctx) => {
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

  route("GET", "/workspaces/:slug/search", (ctx): SearchResult[] => searchHandler(ctx));
}

function roleForManage(ctx: Ctx) {
  requireUser(ctx);
  const role = ctx.db.roles.find((r) => r.id === ctx.params.id);
  if (!role) fail(404, "not_found", "Role not found.");
  requireWs(ctx, role.workspaceId, "core.roles.manage");
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
  // Stage 3: a disabled module's search providers are skipped (tracking owns tasks and projects).
  const tracking = isModuleOn(ctx.db, ws.id, "tracking");
  if (want("task") && tracking) {
    const tasks = ctx.db.tasks
      .filter((t) => !t.deletedAt && ids.includes(t.projectId))
      .filter((t) => !q || t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q))
      .slice(0, Math.min(Number(ctx.query.limit) || 50, 50)); // the backend caps at 50
    for (const t of tasks) {
      const p = ctx.db.projects.find((x) => x.id === t.projectId)!;
      const s = ctx.db.statuses.find((x) => x.id === t.statusId)!;
      out.push({
        type: "task",
        task: toTask(ctx.db, t),
        projectKey: p.key,
        projectName: p.name,
        status: { name: s.name, glyph: s.glyph },
        // Platform Stage 2: every result names its target (links are app-relative in the mock).
        targetType: "tracking.task",
        targetId: t.id,
        title: t.title,
        link: `/${ws.slug}/tasks/${t.key}`,
      });
    }
  }
  if (want("project") && tracking) {
    ctx.db.projects
      .filter((p) => ids.includes(p.id) && (!q || p.name.toLowerCase().includes(q) || p.key.toLowerCase().includes(q)))
      .forEach((p) =>
        out.push({ type: "project", project: toProject(ctx.db, p, userId), targetType: "tracking.project", targetId: p.id, title: p.name, link: `/${ws.slug}/projects/${p.key}/board` }),
      );
  }
  if (want("user")) {
    ctx.db.wsMembers
      .filter((m) => m.workspaceId === ws.id && m.status === "active")
      .forEach((m) => {
        const u = ctx.db.users.find((x) => x.id === m.userId)!;
        if (q && !u.name.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) return;
        out.push({ type: "user", user: toUser(u), roleName: rolesOf(ctx.db, m.roleIds)[0]?.name ?? "", targetType: "core.user", targetId: u.id, title: u.name, link: null });
      });
  }
  return out;
}
