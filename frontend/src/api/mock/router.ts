import { ApiError } from "@/api/errors";
import type { ListQuery, HttpMethod } from "@/api/transport";
import type { Paginated, Permission, ProjectPermission, WorkspacePermission } from "@/api/types";
import { getDB } from "./db";
import type { MockDB } from "./db-types";
import { projectPermissions, wsMembership, wsPermissions } from "./derive";
import { isModuleOn, moduleDef } from "./modules";

export type Ctx = {
  params: Record<string, string>;
  query: ListQuery;
  body: unknown;
  userId: string | null;
  db: MockDB;
};
type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

type Route = { method: HttpMethod; pattern: string; re: RegExp; keys: string[]; handler: Handler; anonymous: boolean };
const routes: Route[] = [];

export function route(method: HttpMethod, pattern: string, handler: Handler, opts: { anonymous?: boolean } = {}) {
  // Stage 3 guard, applied once per module URL prefix (`/tracking/…`, `/sales/…`), not per handler.
  const mod = pattern.split("/")[1] ?? "";
  if (moduleDef(mod) && !moduleDef(mod)!.isCore) {
    const inner = handler;
    handler = (ctx) => {
      guardModule(ctx, mod, pattern);
      return inner(ctx);
    };
  }
  const keys: string[] = [];
  const re = new RegExp(
    "^" +
      pattern.replace(/\//g, "\\/").replace(/:(\w+)/g, (_, k: string) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "$",
  );
  routes.push({ method, pattern, re, keys, handler, anonymous: Boolean(opts.anonymous) });
}

export function match(method: HttpMethod, path: string) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (m) {
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      return { route: r, params };
    }
  }
  return null;
}

/* ───────── module guard (Stage 3 contract §3) ───────── */

type Row = { workspaceId?: string; projectId?: string; taskId?: string; integrationId?: string };

/** The workspace an object row belongs to, following project / task / integration links. */
function workspaceOfRow(db: MockDB, row: Row | undefined): string | null {
  if (!row) return null;
  if (row.workspaceId) return row.workspaceId;
  if (row.projectId) return db.projects.find((p) => p.id === row.projectId)?.workspaceId ?? null;
  if (row.taskId) return workspaceOfRow(db, db.tasks.find((t) => t.id === row.taskId));
  if (row.integrationId) return workspaceOfRow(db, db.integrations?.find((i) => i.id === row.integrationId));
  return null;
}

/**
 * Resolves the workspace from the path: `workspaces/:slug`, or the object after the module prefix
 * (`projects/:id`, `tasks/:id`, `custom-fields/:fieldId`…). User-level routes (`me/…`) resolve to none.
 */
function workspaceForRoute(ctx: Ctx, pattern: string): string | null {
  const { db, params } = ctx;
  if (params.slug) return db.workspaces.find((w) => w.slug === params.slug && !w.deletedAt)?.id ?? null;
  const [, , segment, param] = pattern.split("/");
  const key = param?.startsWith(":") ? param.slice(1) : null;
  if (!segment || !key || !params[key]) return null;
  const collection = segment.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  const rows = (db as unknown as Record<string, unknown>)[collection];
  if (!Array.isArray(rows)) return null;
  return workspaceOfRow(db, (rows as (Row & { id?: string })[]).find((r) => r.id === params[key]));
}

function guardModule(ctx: Ctx, mod: string, pattern: string) {
  if (!ctx.userId) return;
  const workspaceId = workspaceForRoute(ctx, pattern);
  // Non-members fall through to the handler's own 404.
  if (!workspaceId || !wsMembership(ctx.db, ctx.userId, workspaceId)) return;
  if (!isModuleOn(ctx.db, workspaceId, mod)) {
    fail(403, "module_disabled", `${moduleDef(mod)!.name} is turned off for this workspace.`, { module: mod });
  }
}

/* ───────── errors and guards ───────── */

export function fail(status: number, code: string, message: string, details?: Record<string, unknown>): never {
  throw new ApiError({ status, code, message, details });
}

export function invalid(fields: Record<string, string>, message = "Some fields need fixing."): never {
  fail(422, "validation_failed", message, { fields });
}

export function requireUser(ctx: Ctx): string {
  if (!ctx.userId) fail(401, "unauthorized", "Your session has expired.");
  return ctx.userId;
}

export function wsBySlug(ctx: Ctx, slug: string) {
  const userId = requireUser(ctx);
  const ws = ctx.db.workspaces.find((w) => w.slug === slug && !w.deletedAt);
  if (!ws || !wsMembership(ctx.db, userId, ws.id)) fail(404, "not_found", "Workspace not found.");
  return ws;
}

export function requireWs(ctx: Ctx, workspaceId: string, perm: WorkspacePermission) {
  const userId = requireUser(ctx);
  if (!wsPermissions(ctx.db, userId, workspaceId).includes(perm)) {
    fail(403, "forbidden", "You don’t have permission to do that.", { permission: perm });
  }
}

export function projectById(ctx: Ctx, id: string) {
  const p = ctx.db.projects.find((x) => x.id === id);
  if (!p) fail(404, "not_found", "Project not found.");
  return p;
}

/** 403 unless the user's *project* role grants the permission (no workspace override). */
export function requireProject(ctx: Ctx, projectId: string, perm: ProjectPermission) {
  const userId = requireUser(ctx);
  const perms = projectPermissions(ctx.db, userId, projectId);
  if (!perms.includes(perm)) {
    fail(403, "forbidden", perms.length ? "You don’t have permission to do that." : "You’re not a member of this project.", {
      permission: perm,
    });
  }
  return perms;
}

export function hasProject(ctx: Ctx, projectId: string, perm: Permission) {
  return ctx.userId ? (projectPermissions(ctx.db, ctx.userId, projectId) as Permission[]).includes(perm) : false;
}

/* ───────── list helpers ───────── */

export function paginate<T>(items: T[], query: ListQuery, defaultLimit = 50, maxLimit = 200): Paginated<T> {
  const limit = Math.min(Math.max(Number(query.limit) || defaultLimit, 1), maxLimit);
  const offset = query.cursor ? Number(query.cursor) || 0 : 0;
  const data = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? String(offset + limit) : null;
  return { data, nextCursor: next };
}

export function filterValues(query: ListQuery, key: string): string[] {
  const v = query.filter?.[key];
  if (v === undefined || v === null || v === "") return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

export function str(body: unknown, key: string): string | undefined {
  const v = (body as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : undefined;
}

export { getDB };
