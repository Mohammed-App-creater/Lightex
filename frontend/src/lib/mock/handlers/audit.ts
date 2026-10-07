import type { AuditChange, AuditEntry } from "@/lib/api/types";
import { auditActionKind, auditEntity } from "@/lib/audit";
import type { MockDB } from "../db-types";
import { filterValues, paginate, requireWs, wsBySlug, type Ctx } from "../router";

/*
 * Audit log (board 31). The list route lives in ./workspaces (GET /workspaces/:slug/audit) and
 * delegates here. Server-side filters: filter[actor] (ids, OR), filter[action] (action kind),
 * filter[entity] (entity type), filter[since] (ISO). Responds with { data, nextCursor, total }.
 */

type Row = AuditEntry & { workspaceId: string };

export function auditList(ctx: Ctx) {
  const ws = wsBySlug(ctx, ctx.params.slug!);
  requireWs(ctx, ws.id, "audit.view");
  ensureAuditFixtures(ctx.db);
  const actors = filterValues(ctx.query, "actor");
  const action = filterValues(ctx.query, "action")[0];
  const entity = filterValues(ctx.query, "entity")[0];
  const since = filterValues(ctx.query, "since")[0];
  const list = ctx.db.audit
    .filter((a) => a.workspaceId === ws.id)
    .filter((a) => !actors.length || actors.includes(a.actorId))
    .filter((a) => !action || auditActionKind(a) === action)
    .filter((a) => !entity || auditEntity(a) === entity)
    .filter((a) => !since || a.createdAt >= since)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ workspaceId: _ws, ...rest }) => rest);
  return { ...paginate(list, ctx.query, 25), total: list.length };
}

/* ───────── fixtures: ~320 events with field diffs for the Platform workspace ───────── */

const WS = "ws_platform";
const MARK = "au_fx_1";
const AK = "u_alex",
  JL = "u_jordan",
  SP = "u_sam",
  RC = "u_riley",
  MD = "u_morgan",
  TN = "u_taylor";
const BOT = "int_ci",
  AUTO = "int_automation";
const INTEGRATIONS: Record<string, string> = { [BOT]: "ci-bot", [AUTO]: "Automation" };

type Fx = {
  actor: string;
  action: string;
  key?: string | null;
  name: string;
  src?: "web" | "api";
  t: number;
  changes: AuditChange[];
};

const ch = (field: string, kind: AuditChange["kind"], before: AuditChange["before"], after: AuditChange["after"]): AuditChange => ({
  field,
  kind,
  before,
  after,
});

/** Hand-written head of the log (mirrors the board's fixture). */
const HEAD: Fx[] = [
  { actor: AK, action: "task.updated", key: "PRJ-42", name: "Fix flaky board reflow on column resize", t: 8, changes: [ch("Title", "text", "Fix flaky board reflow on resize", "Fix flaky board reflow on column resize"), ch("Priority", "priority", 2, 3)] },
  { actor: JL, action: "task.status_changed", key: "PRJ-44", name: "Debounce reflow on sidebar toggle", t: 35, changes: [ch("Status", "status", "progress", "review")] },
  { actor: BOT, action: "task.status_changed", key: "PRJ-59", name: "Stripe webhook retries", src: "api", t: 49, changes: [ch("Status", "status", "review", "done"), ch("Linked commit", "value", null, "a41c9e2")] },
  { actor: MD, action: "task.updated", key: "PRJ-50", name: "Carry-over prompt at sprint close", t: 142, changes: [ch("Description", "text", "Prompt owners to move unfinished tasks when a sprint closes.", "Prompt owners to carry over or return unfinished tasks when a sprint closes."), ch("Due date", "value", "Oct 4", "Oct 6")] },
  { actor: AK, action: "member.role_changed", name: "Riley Chen", t: 180, changes: [ch("Role", "value", "Member", "Admin")] },
  { actor: SP, action: "view.deleted", name: "Old triage", t: 268, changes: [ch("Name", "value", "Old triage", null), ch("Filters", "value", "Status is Backlog", null), ch("Visibility", "value", "Project", null)] },
  { actor: TN, action: "task.assigned", key: "PRJ-57", name: "Proration on plan change", t: 310, changes: [ch("Assignee", "person", null, TN)] },
  { actor: AK, action: "member.invited", name: "priya@team.dev", t: 338, changes: [ch("Email", "value", null, "priya@team.dev"), ch("Role", "value", null, "Member")] },
  { actor: RC, action: "sprint.created", name: "Sprint 15", t: 1196, changes: [ch("Name", "value", null, "Sprint 15"), ch("Dates", "value", null, "Oct 15 – Oct 28")] },
  { actor: JL, action: "comment.created", key: "PRJ-33", name: "SSO login with Okta", t: 1340, changes: [ch("Comment", "text", null, "Okta sandbox is ready, testing SAML today.")] },
  { actor: AK, action: "project.updated", key: "PRJ", name: "Platform Rebuild", t: 1417, changes: [ch("Target date", "value", "Dec 2", "Dec 9"), ch("Lead", "person", JL, AK)] },
  { actor: AUTO, action: "task.updated", key: "PRJ-53", name: "Burndown off by one day", src: "api", t: 1633, changes: [ch("Priority", "priority", 3, 4)] },
];

const COMMENTS = ["Repro on Safari only.", "Ready for review.", "Blocked on the Okta sandbox.", "Moved to next sprint.", "Added a test for this.", "Can we split this into two tasks?", "Mockups attached."];
const DUES = ["Oct 9", "Oct 10", "Oct 13", "Oct 14", "Oct 16", "Oct 21"];
const FLOW = ["backlog", "todo", "progress", "review", "done"];
const RENAMES: [string, string][] = [
  ["Session timeout modal", "Session timeout warning modal"],
  ["Passkey enrollment", "Passkey enrollment flow"],
  ["Cache thumbnails", "Cache card thumbnails"],
  ["Velocity chart", "Velocity chart by assignee"],
];

function rng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(db: MockDB): Fx[] {
  const rnd = rng(20261007);
  const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
  const wpick = <T>(pairs: [T, number][]) => {
    let r = rnd() * pairs.reduce((s, p) => s + p[1], 0);
    for (const p of pairs) if ((r -= p[1]) <= 0) return p[0];
    return pairs[0]![0];
  };
  const projectIds = db.projects.filter((p) => p.workspaceId === WS).map((p) => p.id);
  const tasks = db.tasks.filter((t) => projectIds.includes(t.projectId)).map((t) => [t.key, t.title] as const);
  const pool = tasks.length ? tasks : ([["PRJ-42", "Fix flaky board reflow on column resize"]] as const);
  const people = [AK, JL, SP, RC, MD, TN];
  const nameOf = (id: string) => db.users.find((u) => u.id === id)?.name ?? id;
  const out: Fx[] = [];
  for (let i = 12; i < 320; i++) {
    const t = i < 250 ? 8 + i * 137 + Math.floor(rnd() * 60) : 43200 + (i - 250) * 980 + Math.floor(rnd() * 300);
    const actor = wpick<string>([[AK, 3], [JL, 3], [SP, 2], [RC, 2], [MD, 2], [TN, 2], [BOT, 1], [AUTO, 1]]);
    const kind = wpick<string>([["status", 5], ["updated", 4], ["assigned", 3], ["commented", 3], ["created", 3], ["deleted", 1], ["role", 0.3], ["invited", 0.3]]);
    const [key, title] = pick(pool);
    let fx: Omit<Fx, "actor" | "t" | "src">;
    if (kind === "status") {
      const s = Math.floor(rnd() * 4);
      fx = { action: "task.status_changed", key, name: title, changes: [ch("Status", "status", FLOW[s]!, FLOW[s + 1]!)] };
    } else if (kind === "assigned") {
      fx = { action: "task.assigned", key, name: title, changes: [ch("Assignee", "person", rnd() < 0.5 ? null : pick([AK, JL, SP]), pick(people))] };
    } else if (kind === "commented") {
      fx = { action: "comment.created", key, name: title, changes: [ch("Comment", "text", null, pick(COMMENTS))] };
    } else if (kind === "created") {
      if (rnd() < 0.8) fx = { action: "task.created", key, name: title, changes: [ch("Title", "text", null, title), ch("Status", "status", null, "todo")] };
      else {
        const n = pick(["Bugs this sprint", "My reviews", "Unassigned"]);
        fx = { action: "view.created", name: n, changes: [ch("Name", "value", null, n)] };
      }
    } else if (kind === "deleted") {
      fx =
        rnd() < 0.6
          ? { action: "task.deleted", key, name: title, changes: [ch("Title", "value", title, null)] }
          : { action: "comment.deleted", key, name: title, changes: [ch("Comment", "value", pick(COMMENTS), null)] };
    } else if (kind === "role") {
      fx = { action: "member.role_changed", name: nameOf(pick([SP, MD, TN])), changes: [ch("Role", "value", "Viewer", "Member")] };
    } else if (kind === "invited") {
      const email = `${pick(["dana", "lee.w", "omar", "kim.s"])}@team.dev`;
      fx = { action: "member.invited", name: email, changes: [ch("Email", "value", null, email), ch("Role", "value", null, "Member")] };
    } else {
      const r = rnd();
      if (r < 0.35) {
        const p = Math.floor(rnd() * 3) + 1;
        fx = { action: "task.updated", key, name: title, changes: [ch("Priority", "priority", p, p + 1)] };
      } else if (r < 0.65) {
        const a = Math.floor(rnd() * 5);
        fx = { action: "task.updated", key, name: title, changes: [ch("Due date", "value", DUES[a]!, DUES[a + 1]!)] };
      } else if (r < 0.85) {
        const [b, a] = pick(RENAMES);
        fx = { action: "task.updated", key, name: a, changes: [ch("Title", "text", b, a)] };
      } else {
        fx = {
          action: "project.updated",
          key: "PRJ",
          name: "Platform Rebuild",
          changes: [ch("Description", "text", "Rebuild the board and sprint engine.", "Rebuild the board, sprint engine and billing.")],
        };
      }
    }
    const src = actor === BOT || actor === AUTO || rnd() < 0.08 ? "api" : "web";
    out.push({ ...fx, actor, t, src });
  }
  return out;
}

function hex(rnd: () => number, n: number) {
  let s = "";
  for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(rnd() * 16)];
  return s;
}

/** Adds the fixture rows once (idempotent; marker row id). Not part of the seed, so no SCHEMA bump. */
export function ensureAuditFixtures(db: MockDB) {
  if (db.audit.some((a) => a.id === MARK)) return;
  if (!db.workspaces.some((w) => w.id === WS)) return;
  const now = Date.now();
  const rnd = rng(77);
  const rows: Row[] = [...HEAD, ...generate(db)].map((f, i) => ({
    id: `au_fx_${i + 1}`,
    workspaceId: WS,
    actorId: f.actor,
    actorName: INTEGRATIONS[f.actor] ?? db.users.find((u) => u.id === f.actor)?.name ?? null,
    actorKind: INTEGRATIONS[f.actor] ? "integration" : "user",
    action: f.action,
    target: f.name,
    entityType: f.action.split(".")[0],
    entityKey: f.key ?? null,
    source: f.src ?? "web",
    requestId: `req_${hex(rnd, 10)}`,
    changes: f.changes,
    createdAt: new Date(now - f.t * 60_000 - ((f.t * 7) % 53) * 1000).toISOString(),
  }));
  db.audit.push(...rows);
}
