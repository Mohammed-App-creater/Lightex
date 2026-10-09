import type { PresenceLocation, PresencePerson, PresenceRoster, PresenceUpdate } from "@/lib/api/types";
import { getDB } from "../db";
import type { MockDB } from "../db-types";
import { projectPermissions, toUser } from "../derive";
import { mockBus } from "../realtime";
import { fail, filterValues, invalid, requireProject, requireUser, route, wsBySlug, type Ctx } from "../router";
import { ensureExt33 } from "./dashboards";

/*
 * Board 33 presence (spec §2.8, §5.3) against an in-memory session table: never persisted, so a
 * reload starts empty, like a server restart. Same TTL rules: 45 s per heartbeat, typing lives
 * 8 s, a 15 s sweeper (only while the tab is visible) expires rows and publishes
 * `presence.updated` for each affected location. A change of location, state, field or typing
 * publishes for the old and the new location; a pure refresh publishes nothing. Personal
 * dashboards are stored private: never listed, never broadcast.
 */

export const PRESENCE_TTL_MS = 45_000;
export const TYPING_MS = 8_000;
const SWEEP_MS = 15_000;
/** The contract's pattern, plus "_" because mock ids contain it (`cf.p_prj-cf-qaowner`); backend ids are UUIDs. */
const FIELD_RE = /^[a-zA-Z.]{1,10}[a-zA-Z0-9._-]{0,38}$/;

export type PresenceSessionRec = {
  userId: string;
  sessionId: string;
  workspaceId: string;
  projectId: string;
  location: PresenceLocation;
  private: boolean;
  state: "viewing" | "editing";
  field: string | null;
  typingUntil: number | null;
  since: string;
  expiresAt: number;
};

const sessions = new Map<string, PresenceSessionRec>();
const keyOf = (userId: string, sessionId: string) => `${userId}:${sessionId}`;
const sameLoc = (a: PresenceLocation, b: PresenceLocation) => a.kind === b.kind && a.id === b.id;

/** Roster of one location: live rows aggregated per user (editing > viewing; field/since from the earliest editing row; typing = any). */
export function peopleAt(db: MockDB, loc: PresenceLocation, now = Date.now()): PresencePerson[] {
  const byUser = new Map<string, PresenceSessionRec[]>();
  for (const s of sessions.values()) {
    if (s.private || s.expiresAt <= now || !sameLoc(s.location, loc)) continue;
    byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);
  }
  const out: PresencePerson[] = [];
  for (const [userId, rows] of byUser) {
    const u = db.users.find((x) => x.id === userId);
    if (!u) continue;
    const editing = rows.filter((r) => r.state === "editing").sort((a, b) => a.since.localeCompare(b.since));
    const first = editing[0] ?? [...rows].sort((a, b) => a.since.localeCompare(b.since))[0]!;
    const user = toUser(u);
    out.push({
      user: { id: user.id, name: user.name, hue: user.hue, avatarUrl: user.avatarUrl },
      state: editing.length ? "editing" : "viewing",
      field: editing.length ? first.field : null,
      typing: rows.some((r) => (r.typingUntil ?? 0) > now),
      since: first.since,
    });
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}

export function rosterFor(db: MockDB, projectId: string, now = Date.now()): PresenceRoster {
  const locs: PresenceLocation[] = [];
  for (const s of sessions.values()) {
    if (s.projectId !== projectId || s.private || s.expiresAt <= now) continue;
    if (!locs.some((l) => sameLoc(l, s.location))) locs.push(s.location);
  }
  return {
    projectId,
    at: new Date(now).toISOString(),
    locations: locs.map((location) => ({ location, people: peopleAt(db, location, now) })).filter((l) => l.people.length),
  };
}

function broadcast(db: MockDB, s: Pick<PresenceSessionRec, "workspaceId" | "projectId" | "location" | "private">, actorId: string | null, now = Date.now()) {
  if (s.private) return;
  mockBus.publish("presence.updated", {
    workspaceId: s.workspaceId,
    projectId: s.projectId,
    actorId,
    durable: false,
    data: { location: s.location, people: peopleAt(db, s.location, now), at: new Date(now).toISOString() },
  });
}

/** Resolves a location to its project (404 when the caller can't see it, §2.8). */
function resolveLocation(db: MockDB, userId: string, workspaceId: string, loc: PresenceLocation): { projectId: string; private: boolean } {
  const notFound = (): never => fail(404, "not_found", "That location doesn’t exist, or you can’t see it.");
  const visible = (projectId: string) => {
    const p = db.projects.find((x) => x.id === projectId);
    if (!p || p.workspaceId !== workspaceId) notFound();
    if (!projectPermissions(db, userId, projectId).includes("project.view")) {
      fail(403, "project_membership_required", "You’re not a member of this project.", { permission: "project.view" });
    }
  };
  if (loc.kind === "board") {
    visible(loc.id);
    return { projectId: loc.id, private: false };
  }
  if (loc.kind === "task") {
    const t = db.tasks.find((x) => x.id === loc.id && !x.deletedAt);
    if (!t) return notFound();
    visible(t.projectId);
    return { projectId: t.projectId, private: false };
  }
  ensureExt33(db);
  const d = db.dashboards!.find((x) => x.id === loc.id);
  if (!d || (d.visibility === "personal" && d.ownerId !== userId)) return notFound();
  visible(d.projectId);
  return { projectId: d.projectId, private: d.visibility === "personal" };
}

export function validateUpdate(body: unknown): PresenceUpdate {
  const b = (body ?? {}) as Partial<PresenceUpdate> & { location?: Partial<PresenceLocation> };
  const bad: Record<string, string> = {};
  const kind = b.location?.kind;
  if (kind !== "board" && kind !== "dashboard" && kind !== "task") bad["location.kind"] = "Pick board, dashboard or task";
  if (typeof b.location?.id !== "string" || !b.location.id) bad["location.id"] = "Pick a location";
  const state = b.state ?? "viewing";
  if (state !== "viewing" && state !== "editing") bad.state = "Pick viewing or editing";
  const field = b.field ?? null;
  if (state === "editing" && !field) bad.field = "Name the field being edited";
  else if (field !== null && (state !== "editing" || typeof field !== "string" || !FIELD_RE.test(field))) bad.field = "Unknown field";
  const typing = b.typing === true;
  if (typing && field !== "comment" && field !== "description") bad.typing = "Typing needs the comment or description field";
  if (Object.keys(bad).length) invalid(bad);
  return { location: { kind: kind!, id: b.location!.id! }, state, field, typing };
}

/** Upsert (P1 and the teammate simulator). Publishes only when location, state, field or typing changed. */
export function upsertPresence(db: MockDB, userId: string, sessionId: string, workspaceId: string, u: PresenceUpdate, now = Date.now()) {
  const where = resolveLocation(db, userId, workspaceId, u.location);
  const key = keyOf(userId, sessionId);
  const prev = sessions.get(key);
  const typingNow = (prev?.typingUntil ?? 0) > now;
  const moved = !prev || !sameLoc(prev.location, u.location);
  const changed = moved || prev.state !== u.state || prev.field !== u.field || typingNow !== u.typing || prev.expiresAt <= now;
  const rec: PresenceSessionRec = {
    userId,
    sessionId,
    workspaceId,
    projectId: where.projectId,
    location: u.location,
    private: where.private,
    state: u.state,
    field: u.state === "editing" ? u.field : null,
    typingUntil: u.typing ? now + TYPING_MS : null,
    since: !moved && prev && prev.state === u.state ? prev.since : new Date(now).toISOString(),
    expiresAt: now + PRESENCE_TTL_MS,
  };
  sessions.set(key, rec);
  if (changed) {
    if (prev && moved) broadcast(db, prev, userId, now);
    broadcast(db, rec, userId, now);
  }
  return rec;
}

export function removePresence(db: MockDB, userId: string, sessionId: string, now = Date.now()) {
  const key = keyOf(userId, sessionId);
  const prev = sessions.get(key);
  if (!prev) return;
  sessions.delete(key);
  broadcast(db, prev, userId, now);
}

/** Deletes expired rows and publishes once per affected location. */
export function sweepPresence(db: MockDB, now = Date.now()) {
  const affected: PresenceSessionRec[] = [];
  for (const [k, s] of sessions) {
    if (s.expiresAt > now) continue;
    sessions.delete(k);
    if (!affected.some((a) => sameLoc(a.location, s.location))) affected.push(s);
  }
  affected.forEach((s) => broadcast(db, s, null, now));
  return affected.length;
}

export const presenceSessions = {
  all: () => [...sessions.values()],
  forUser: (userId: string) => [...sessions.values()].filter((s) => s.userId === userId),
  clear: () => sessions.clear(),
};

let sweeper: ReturnType<typeof setInterval> | null = null;
function startSweeper() {
  if (sweeper || typeof window === "undefined") return;
  sweeper = setInterval(() => {
    if (document.visibilityState === "visible") sweepPresence(getDB());
  }, SWEEP_MS);
}

export function registerPresence() {
  startSweeper();

  // P1
  route("PUT", "/workspaces/:slug/presence/:sessionId", (ctx) => {
    const userId = requireUser(ctx);
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const u = validateUpdate(ctx.body);
    const rec = upsertPresence(ctx.db, userId, ctx.params.sessionId!, ws.id, u);
    return { expiresAt: new Date(rec.expiresAt).toISOString(), heartbeatSec: 20, roster: rosterFor(ctx.db, rec.projectId) };
  });

  // P2
  route("DELETE", "/workspaces/:slug/presence/:sessionId", (ctx) => {
    const userId = requireUser(ctx);
    wsBySlug(ctx, ctx.params.slug!);
    removePresence(ctx.db, userId, ctx.params.sessionId!);
    return undefined;
  });

  // P3
  route("GET", "/workspaces/:slug/presence", (ctx: Ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    const projectId = filterValues(ctx.query, "project")[0];
    if (!projectId) invalid({ "filter[project]": "Pick a project" });
    const p = ctx.db.projects.find((x) => x.id === projectId && x.workspaceId === ws.id);
    if (!p) fail(404, "not_found", "Project not found.");
    requireProject(ctx, p.id, "project.view");
    return rosterFor(ctx.db, p.id);
  });
}
