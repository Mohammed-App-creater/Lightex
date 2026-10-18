import type { DataScope } from "@/api/types";
import type { MockDB, WorkspaceRec } from "../db-types";
import { wsMembership, wsPermissions } from "../derive";
import { myDataScopes } from "../data-scope";
import { isModuleOn } from "../modules";
import { fail, filterValues, invalid, requireUser, type Ctx } from "../router";
import { salesStore, type SalesStore } from "./store";

/*
 * The order of checks (docs/sales/api.md §1): 401 → not a member / unknown id 404 → module off 403 `module_disabled`
 * → permission 403 `forbidden` → record outside the view scope 404 → outside the action's scope 403.
 */

export type SalesCtx = {
  ctx: Ctx;
  db: MockDB;
  store: SalesStore;
  ws: WorkspaceRec;
  wsId: string;
  userId: string;
  scopes: Record<string, DataScope>;
  perms: Set<string>;
};

function build(ctx: Ctx, ws: WorkspaceRec): SalesCtx {
  const userId = requireUser(ctx);
  if (!wsMembership(ctx.db, userId, ws.id)) fail(404, "not_found", "Not found.");
  if (!isModuleOn(ctx.db, ws.id, "sales")) fail(403, "module_disabled", "Sales is turned off for this workspace.", { module: "sales" });
  return {
    ctx,
    db: ctx.db,
    store: salesStore(ctx.db),
    ws,
    wsId: ws.id,
    userId,
    scopes: myDataScopes(ctx.db, userId, ws.id),
    perms: new Set(wsPermissions(ctx.db, userId, ws.id)),
  };
}

/** A `/sales/workspaces/:slug/…` route: membership, module and (when given) the permission. */
export function wsCtx(ctx: Ctx, perm?: string): SalesCtx {
  requireUser(ctx);
  const ws = ctx.db.workspaces.find((w) => w.slug === ctx.params.slug && !w.deletedAt);
  if (!ws) fail(404, "not_found", "Workspace not found.");
  const sc = build(ctx, ws);
  if (perm) need(sc, perm);
  return sc;
}

/** A single-record route: the record's workspace, then membership, module and permission; 404 when missing. */
export function recCtx<T extends { workspaceId: string; deletedAt?: string | null }>(ctx: Ctx, rows: (s: SalesStore) => T[], perm: string, label = "Not found."): [SalesCtx, T] {
  requireUser(ctx);
  const id = Object.values(ctx.params)[0];
  const rec = rows(salesStore(ctx.db)).find((r) => (r as unknown as { id: string }).id === id && !r.deletedAt);
  const ws = rec && ctx.db.workspaces.find((w) => w.id === rec.workspaceId && !w.deletedAt);
  if (!rec || !ws) fail(404, "not_found", label);
  const sc = build(ctx, ws);
  need(sc, perm);
  return [sc, rec];
}

export const has = (sc: SalesCtx, code: string) => sc.perms.has(code);

export function need(sc: SalesCtx, code: string) {
  if (!sc.perms.has(code)) fail(403, "forbidden", "You don’t have permission to do that.", { permission: code });
}

/** The caller's scope for a code (null when not held). A held code without a stored scope counts as `all`. */
export function scopeOf(sc: SalesCtx, code: string): DataScope | null {
  if (!sc.perms.has(code)) return null;
  return sc.scopes[code] ?? "all";
}

/** Everyone sharing a live team with the user, the user included. */
export function teamMates(db: MockDB, workspaceId: string, userId: string): Set<string> {
  const live = new Set(db.teams.filter((t) => t.workspaceId === workspaceId && !t.deletedAt).map((t) => t.id));
  const mine = db.teamMembers.filter((m) => m.userId === userId && live.has(m.teamId)).map((m) => m.teamId);
  const out = new Set([userId]);
  for (const m of db.teamMembers) if (mine.includes(m.teamId)) out.add(m.userId);
  return out;
}

/** Does the caller's scope for `code` reach a record owned by `ownerId`? */
export function reaches(sc: SalesCtx, code: string, ownerId: string | null): boolean {
  const s = scopeOf(sc, code);
  if (!s) return false;
  if (s === "all") return true;
  if (!ownerId) return false;
  if (s === "own") return ownerId === sc.userId;
  return teamMates(sc.db, sc.wsId, sc.userId).has(ownerId);
}

/** 404 outside the view scope. */
export function mustSee(sc: SalesCtx, viewCode: string, ownerId: string | null, label = "Not found.") {
  if (!reaches(sc, viewCode, ownerId)) fail(404, "not_found", label);
}

/** 403 outside the action's scope. */
export function mustReach(sc: SalesCtx, code: string, ownerId: string | null) {
  need(sc, code);
  if (!reaches(sc, code, ownerId)) fail(403, "forbidden", "You don’t have permission to do that.", { permission: code });
}

/** People (user ids) the caller's scope for a code reaches; null = everyone. */
export function scopePeople(sc: SalesCtx, code: string): Set<string> | null {
  const s = scopeOf(sc, code);
  if (s === "all") return null;
  if (s === "team") return teamMates(sc.db, sc.wsId, sc.userId);
  if (s === "own") return new Set([sc.userId]);
  return new Set();
}

export const activeMember = (db: MockDB, workspaceId: string, userId: string) =>
  db.wsMembers.some((m) => m.workspaceId === workspaceId && m.userId === userId && m.status === "active");

export function activeMembers(db: MockDB, workspaceId: string): string[] {
  return db.wsMembers.filter((m) => m.workspaceId === workspaceId && m.status === "active").map((m) => m.userId);
}

/**
 * §3 owner rule: `ownerId` someone else needs `code` with scope team / all (403), an active member (422) and, with
 * `team`, a team-mate (422).
 */
export function checkOwner(sc: SalesCtx, code: string, ownerId: unknown): string {
  if (ownerId === undefined || ownerId === null || ownerId === sc.userId) return sc.userId;
  if (typeof ownerId !== "string") invalid({ ownerId: "Pick a member of this workspace" });
  const s = scopeOf(sc, code);
  if (s !== "team" && s !== "all") fail(403, "forbidden", "You can’t give records to someone else.", { permission: code, scope: "team" });
  if (!activeMember(sc.db, sc.wsId, ownerId)) invalid({ ownerId: "Pick a member of this workspace" });
  if (s === "team" && !teamMates(sc.db, sc.wsId, sc.userId).has(ownerId)) invalid({ ownerId: "Pick someone in your team" });
  return ownerId;
}

export function userBrief(db: MockDB, id: string | null | undefined) {
  if (!id) return null;
  const u = db.users.find((x) => x.id === id);
  return u ? { id: u.id, name: u.name, hue: u.hue } : null;
}
export const userRef = (db: MockDB, id: string) => {
  const u = db.users.find((x) => x.id === id);
  return { id, name: u?.name ?? "" };
};

/* ───────── list helpers ───────── */

/** Offset cursors (opaque to the client); a broken cursor is 400 `invalid_cursor`. */
export function page<T>(items: T[], ctx: Ctx, defaultLimit = 50) {
  const raw = ctx.query.limit;
  let limit = defaultLimit;
  if (raw !== undefined && raw !== null && String(raw) !== "") {
    limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid({ limit: "Use 1–200" });
  }
  let offset = 0;
  if (ctx.query.cursor) {
    const m = /^o(\d+)$/.exec(String(ctx.query.cursor));
    if (!m) fail(400, "invalid_cursor", "That page link is broken. Start again.");
    offset = Number(m[1]);
  }
  const data = items.slice(offset, offset + limit);
  return { data, nextCursor: offset + limit < items.length ? `o${offset + limit}` : null };
}

type Getter<T> = (x: T) => string | number | null | undefined;

/** `sort=<key>` / `sort=-<key>` over allowed keys (422 `sort` otherwise), tie-broken by id. Nulls sort last. */
export function sortRows<T extends { id: string }>(ctx: Ctx, rows: T[], keys: Record<string, Getter<T>>, def: string): T[] {
  const raw = typeof ctx.query.sort === "string" && ctx.query.sort ? ctx.query.sort : def;
  const desc = raw.startsWith("-");
  const key = desc ? raw.slice(1) : raw;
  const get = keys[key];
  if (!get) invalid({ sort: `Sort by ${Object.keys(keys).join(", ")}` });
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    let c = 0;
    if (x == null && y != null) return 1;
    if (y == null && x != null) return -1;
    if (x != null && y != null) c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    if (desc) c = -c;
    return c || a.id.localeCompare(b.id);
  });
}

/** Repeatable `filter[key]` restricted to allowed values (422 otherwise). */
export function enumFilter(ctx: Ctx, key: string, allowed: readonly string[]): string[] {
  const vals = filterValues(ctx.query, key);
  if (vals.some((v) => !allowed.includes(v))) invalid({ [`filter[${key}]`]: `Use ${allowed.join(", ")}` });
  return vals;
}

/** `filter[owner]` (ids or `me`) and `filter[team]` → a set of owner ids, or null when neither is given. */
export function ownerFilter(sc: SalesCtx): Set<string> | null {
  const owners = filterValues(sc.ctx.query, "owner").map((v) => (v === "me" ? sc.userId : v));
  const teams = filterValues(sc.ctx.query, "team");
  if (!owners.length && !teams.length) return null;
  const out = new Set(owners);
  for (const t of teams) {
    const team = sc.db.teams.find((x) => x.id === t && x.workspaceId === sc.wsId && !x.deletedAt);
    if (!team) invalid({ "filter[team]": "Unknown team" });
    for (const m of sc.db.teamMembers) if (m.teamId === t) out.add(m.userId);
  }
  return out;
}

export function dateFilter(ctx: Ctx, key: string): string | null {
  const v = filterValues(ctx.query, key)[0];
  if (v === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) invalid({ [`filter[${key}]`]: "Use YYYY-MM-DD" });
  return v;
}

export const q = (ctx: Ctx) => (typeof ctx.query.q === "string" ? ctx.query.q.trim().toLowerCase() : "");
export const contains = (needle: string, ...hay: (string | null | undefined)[]) => !needle || hay.some((h) => h?.toLowerCase().includes(needle));

/* ───────── body helpers ───────── */

export type Body = Record<string, unknown>;
export const bodyOf = (ctx: Ctx): Body => (ctx.body && typeof ctx.body === "object" ? (ctx.body as Body) : {});

/** Trimmed text field (undefined when absent); 422 when not a string or too long. */
export function text(b: Body, key: string, max: number, fields: Record<string, string>): string | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null) return "";
  if (typeof v !== "string") {
    fields[key] = "Must be text";
    return undefined;
  }
  const t = v.trim();
  if (t.length > max) fields[key] = `At most ${max} characters`;
  return t;
}

/** A non-negative money string (two places) or number. */
export function moneyIn(b: Body, key: string, fields: Record<string, string>, nullable = false): string | null | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null || v === "") {
    if (nullable) return null;
    fields[key] = "Enter an amount";
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !/^\d+(\.\d{1,2})?$/.test(String(v))) {
    fields[key] = "Enter an amount of 0 or more with at most two decimals";
    return undefined;
  }
  return n.toFixed(2);
}

export const flush = (fields: Record<string, string>) => {
  if (Object.keys(fields).length) invalid(fields);
};

/** An owned record's route: `action`'s permission (403), then the view scope (404), then the action's scope (403). */
export function owned<T extends { workspaceId: string; deletedAt?: string | null; ownerId: string | null }>(
  ctx: Ctx,
  rows: (s: SalesStore) => T[],
  view: string,
  action: string,
  label = "Not found.",
): [SalesCtx, T] {
  const [sc, rec] = recCtx(ctx, rows, action, label);
  mustSee(sc, view, rec.ownerId, label);
  if (action !== view) mustReach(sc, action, rec.ownerId);
  return [sc, rec];
}
