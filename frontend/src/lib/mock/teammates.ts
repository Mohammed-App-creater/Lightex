import { presenceClaims } from "@/lib/realtime/presence";
import { comparePosition, keyBetween } from "@/lib/utils/fractional-index";
import { getDB, mockSession, nowISO, persist } from "./db";
import type { MockDB } from "./db-types";
import { mockControls } from "./controls";
import { projectPermissions } from "./derive";
import { logActivity, notify } from "./handlers/common";
import { presenceSessions, removePresence, upsertPresence } from "./handlers/presence";
import { publishTask } from "./realtime";

/*
 * Simulated teammates: every ~45s (tab visible) someone else nudges a task forward.
 * This is what makes the 30s board/inbox polling observable in mock mode, and it bumps
 * task versions so an in-flight drag can hit a real `version_conflict`.
 */

let started = false;

export function startTeammates() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.setInterval(() => {
    if (document.visibilityState !== "visible" || !mockControls.get().teammates) return;
    simulateTeammateEdit();
  }, 45_000);
  // Board 33: the same teammates show presence, on the design's 7 s cadence.
  startPresenceSim();
}

const FLOW = ["todo", "progress", "review", "done"] as const;

/**
 * Moves one task (or `taskId`) one step along the flow as another project member. Returns its key.
 * Board 33: `projectId` limits it to one project and `actorId` picks the teammate (the dashboard's
 * simulated change is made by someone already shown as present).
 */
export function simulateTeammateEdit(taskId?: string, opts: { projectId?: string; actorId?: string } = {}): string | null {
  const db = getDB();
  const me = mockSession.get();
  if (!me) return null;
  const myProjects = db.projectMembers.filter((m) => m.userId === me).map((m) => m.projectId);
  const candidates = db.tasks.filter((t) => {
    if (t.deletedAt || !myProjects.includes(t.projectId) || t.parentId) return false;
    if (opts.projectId && t.projectId !== opts.projectId) return false;
    if (taskId) return t.id === taskId;
    const s = db.statuses.find((x) => x.id === t.statusId);
    const sprint = db.sprints.find((x) => x.id === t.sprintId);
    return sprint?.state === "active" && s && s.glyph !== "done" && s.glyph !== "canceled" && s.glyph !== "backlog";
  });
  const task = candidates[Math.floor(Math.random() * candidates.length)];
  if (!task) return null;
  // Board 33: only teammates who may move tasks make the change (a viewer never "moves" a card).
  const others = db.projectMembers
    .filter((m) => m.projectId === task.projectId && m.userId !== me && projectPermissions(db, m.userId, task.projectId).includes("task.move"))
    .map((m) => m.userId);
  const actor = (opts.actorId && others.includes(opts.actorId) ? opts.actorId : others[Math.floor(Math.random() * others.length)]) ?? null;
  const current = db.statuses.find((s) => s.id === task.statusId)!;
  const idx = FLOW.indexOf(current.glyph as (typeof FLOW)[number]);
  const nextGlyph = FLOW[Math.min(FLOW.length - 1, Math.max(0, idx) + 1)]!;
  const next = db.statuses.find((s) => s.projectId === task.projectId && s.glyph === nextGlyph)!;
  if (next.id !== task.statusId) {
    const col = db.tasks.filter((t) => t.projectId === task.projectId && t.statusId === next.id && !t.deletedAt).sort(comparePosition);
    task.statusId = next.id;
    task.position = keyBetween(null, col[0]?.position ?? null);
    if (next.glyph === "done") task.completedAt = nowISO();
    if (next.category === "in_progress") task.startedAt ??= nowISO();
    logActivity(db, actor, "status_changed", task.projectId, task, { from: current.name, to: next.name });
    if (task.assigneeId === me) {
      notify(db, me, "status", actor, task, task.projectId, { fromStatus: current.name, toStatus: next.name });
    }
  }
  task.version += 1;
  task.updatedAt = nowISO();
  persist();
  // Board 33: the change reaches open streams like any other write.
  const moved = next.id !== current.id;
  publishTask(db, actor, task, moved ? "moved" : "updated", moved ? ["statusId", "position"] : []);
  return task.key;
}

/* ───────── Board 33: simulated presence (spec §7.10) ───────── */

export const PRESENCE_TICK_MS = 7_000;
const ROTATE_EVERY = 4; // ≈ 30 s
const PROPERTY_FIELDS = ["dueDate", "priority", "assigneeId"] as const;

type SimState = {
  tick: number;
  rng: number;
  viewers: string[];
  editor: { userId: string; field: string; until: number } | null;
  desc: { userId: string; until: number } | null;
  typer: { userId: string; until: number } | null;
  locKey: string;
};

const sim: SimState = { tick: 0, rng: 33, viewers: [], editor: null, desc: null, typer: null, locKey: "" };
let simStarted = false;
let typingTimer: ReturnType<typeof setTimeout> | undefined;

/** Seeded pseudo-random in [0, 1): deterministic order, then a seeded pick. */
function rand() {
  sim.rng = (sim.rng * 1103515245 + 12345) % 2147483648;
  return sim.rng / 2147483648;
}

const simSession = (userId: string) => `sim-${userId}`;

export function startPresenceSim() {
  if (simStarted || typeof window === "undefined") return;
  simStarted = true;
  window.setInterval(() => presenceTick(), PRESENCE_TICK_MS);
}

/** Removes every simulated session (teammates off, signed out, nothing to watch). */
export function clearPresenceSim(db: MockDB = getDB()) {
  for (const s of presenceSessions.all()) if (s.sessionId.startsWith("sim-")) removePresence(db, s.userId, s.sessionId);
  sim.viewers = [];
  sim.editor = null;
  sim.desc = null;
  sim.typer = null;
  sim.locKey = "";
  clearTimeout(typingTimer);
}

type Claim = NonNullable<ReturnType<typeof presenceClaims.active>>;

function writeTeammate(db: MockDB, userId: string, workspaceId: string, claim: Claim, now: number) {
  let state: "viewing" | "editing" = "viewing";
  let field: string | null = null;
  let typing = false;
  if (sim.typer?.userId === userId && sim.typer.until > now) {
    state = "editing";
    field = "comment";
    typing = true;
  } else if (sim.editor?.userId === userId) {
    state = "editing";
    field = sim.editor.field;
  } else if (sim.desc?.userId === userId) {
    state = "editing";
    field = "description";
  }
  try {
    upsertPresence(db, userId, simSession(userId), workspaceId, { location: claim.location, state, field, typing }, now);
  } catch {
    /* the teammate can't see this location: skip */
  }
}

/**
 * One 7 s tick (only while the tab is visible and teammates are on):
 * - keeps up to 2 teammates viewing whatever the user is on, rotating one every ~30 s;
 * - on a task: one teammate edits a property (dueDate, priority, assigneeId) for 10–20 s, another
 *   sometimes edits the description;
 * - with the comment composer on screen: a teammate types for 3–5 s;
 * - every 3rd tick on a dashboard: a real change through the mock DB (task.changed).
 */
export function presenceTick(now = Date.now(), opts: { visible?: boolean } = {}) {
  const db = getDB();
  const me = mockSession.get();
  if (!mockControls.get().teammates || !me) return clearPresenceSim(db);
  const visible = opts.visible ?? (typeof document === "undefined" || document.visibilityState === "visible");
  if (!visible) return;
  const claim = presenceClaims.active();
  const project = claim && db.projects.find((p) => p.id === claim.projectId);
  if (!claim || !project) return clearPresenceSim(db);
  const personal = claim.location.kind === "dashboard" && db.dashboards?.find((d) => d.id === claim.location.id)?.visibility === "personal";
  if (personal) return clearPresenceSim(db);

  sim.tick += 1;
  const candidates = db.projectMembers
    .filter((m) => m.projectId === project.id && m.userId !== me)
    .map((m) => m.userId)
    .sort();
  if (!candidates.length) return clearPresenceSim(db);

  // Viewers: up to 2, one rotated every ~30 s.
  sim.viewers = sim.viewers.filter((v) => candidates.includes(v));
  if (sim.viewers.length && sim.tick % ROTATE_EVERY === 0 && candidates.length > sim.viewers.length) {
    const out = sim.viewers.shift()!;
    if (sim.editor?.userId === out) sim.editor = null;
    if (sim.desc?.userId === out) sim.desc = null;
    removePresence(db, out, simSession(out), now);
  }
  while (sim.viewers.length < Math.min(2, candidates.length)) {
    const pool = candidates.filter((c) => !sim.viewers.includes(c));
    sim.viewers.push(pool[Math.floor(rand() * pool.length)]!);
  }

  const locKey = `${claim.location.kind}:${claim.location.id}`;
  if (locKey !== sim.locKey) {
    sim.locKey = locKey;
    sim.editor = null;
    sim.desc = null;
    sim.typer = null;
  }
  if (sim.editor && sim.editor.until <= now) sim.editor = null;
  if (sim.desc && sim.desc.until <= now) sim.desc = null;

  if (claim.location.kind === "task") {
    // Only people who could really do it: editors can edit this task, typists can comment.
    const task = db.tasks.find((x) => x.id === claim.location.id);
    const perms = (u: string) => projectPermissions(db, u, project.id);
    const canEdit = (u: string) => perms(u).includes("task.edit_any") || (perms(u).includes("task.edit_own") && !!task && (task.assigneeId === u || task.reporterId === u));
    const editorsPool = sim.viewers.filter(canEdit);
    const [a, b] = editorsPool;
    if (!sim.editor && a && rand() < 0.6) {
      sim.editor = { userId: a, field: PROPERTY_FIELDS[Math.floor(rand() * PROPERTY_FIELDS.length)]!, until: now + 10_000 + Math.floor(rand() * 10_000) };
    }
    if (!sim.desc && b && rand() < 0.35) sim.desc = { userId: b, until: now + 10_000 + Math.floor(rand() * 10_000) };
    const typists = sim.viewers.filter((v) => perms(v).includes("comment.create"));
    if (claim.composer && !sim.typer && typists.length && rand() < 0.6) {
      const typer = typists.find((v) => v !== sim.editor?.userId) ?? typists[0]!;
      const dur = 3000 + Math.floor(rand() * 2000);
      sim.typer = { userId: typer, until: now + dur };
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => {
        const t = sim.typer;
        sim.typer = null;
        const c = presenceClaims.active();
        if (t && c && mockControls.get().teammates) writeTeammate(getDB(), t.userId, project.workspaceId, c, Date.now());
      }, dur);
    }
  } else {
    sim.editor = null;
    sim.desc = null;
  }

  for (const v of sim.viewers) writeTeammate(db, v, project.workspaceId, claim, now);

  if (claim.location.kind === "dashboard" && sim.tick % 3 === 0) {
    // The change is made by a teammate on screen who may move tasks (never a viewer).
    const actor = sim.viewers.find((v) => projectPermissions(db, v, project.id).includes("task.move"));
    simulateTeammateEdit(undefined, { projectId: project.id, actorId: actor });
  }
}

/** Tests. */
export function resetPresenceSim() {
  clearPresenceSim();
  sim.tick = 0;
  sim.rng = 33;
}

