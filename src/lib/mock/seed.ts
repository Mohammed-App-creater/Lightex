import type { Label, NotificationPreferences, RichDoc, Status, StatusGlyph, TaskType, Priority } from "@/lib/api/types";
import { DEFAULT_ROLES } from "@/lib/permissions/catalogue";
import { keysBetween } from "@/lib/utils/fractional-index";
import type {
  AttachmentRec,
  MockDB,
  NotificationRec,
  ProjectMemberRec,
  RoleRec,
  TaskRec,
  WsMemberRec,
} from "./db-types";

export const SCHEMA = 3;

/*
 * Seed data. Copy comes from the design boards (PRJ-42 "Fix flaky board reflow…", Sprint 14,
 * Beta launch, the people Alex Kim / Jordan Lee / …). Every date is written relative to the
 * design's "today" (2026-10-07) and shifted so the seed always looks current.
 */

const ANCHOR = new Date(2026, 9, 7);

function shiftDays() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - ANCHOR.getTime()) / 86_400_000);
}
const SHIFT = shiftDays();

const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Design date (YYYY-MM-DD, relative to 2026-10-07) → shifted ISO date. */
export function D(iso: string) {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d + SHIFT);
  return fmt(date);
}
/** Design date + hour → ISO timestamp. */
function T(iso: string, hour = 10) {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d + SHIFT, hour, 15).toISOString();
}
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/* ───────────── people ───────────── */

const people = [
  { id: "u_alex", name: "Alex Kim", email: "alex@team.dev", hue: 285 },
  { id: "u_jordan", name: "Jordan Lee", email: "jordan@team.dev", hue: 200 },
  { id: "u_sam", name: "Sam Patel", email: "sam@team.dev", hue: 20 },
  { id: "u_riley", name: "Riley Chen", email: "riley@team.dev", hue: 150 },
  { id: "u_morgan", name: "Morgan Diaz", email: "morgan@team.dev", hue: 60 },
  { id: "u_taylor", name: "Taylor Ng", email: "taylor@team.dev", hue: 330 },
  { id: "u_casey", name: "Casey Brooks", email: "casey@team.dev", hue: 100 },
  { id: "u_drew", name: "Drew Hart", email: "drew@guild.dev", hue: 240 },
];
const AK = "u_alex",
  JL = "u_jordan",
  SP = "u_sam",
  RC = "u_riley",
  MD = "u_morgan",
  TN = "u_taylor",
  CB = "u_casey",
  DH = "u_drew";

/** Password for every seeded account (mock mode only). */
export const MOCK_PASSWORD = "password";

/* ───────────── helpers ───────────── */

const STATUS_DEFS: { key: StatusGlyph; name: string; category: Status["category"] }[] = [
  { key: "backlog", name: "Backlog", category: "todo" },
  { key: "todo", name: "Todo", category: "todo" },
  { key: "progress", name: "In progress", category: "in_progress" },
  { key: "review", name: "In review", category: "in_progress" },
  { key: "done", name: "Done", category: "done" },
  { key: "canceled", name: "Canceled", category: "done" },
];

const sid = (projectId: string, key: StatusGlyph) => `${projectId}-st-${key}`;

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const doc = (...content: RichDoc["content"] & object): RichDoc => ({ type: "doc", content });

type TaskSeed = {
  n: number;
  title: string;
  st: StatusGlyph;
  pri: Priority;
  asg: string | null;
  epic?: string | null;
  sprint?: string | null;
  ms?: string | null;
  due?: string | null;
  labels?: string[];
  type?: TaskType;
  est?: number | null;
  parent?: number;
  rep?: string;
  created?: string;
  done?: string;
  desc?: RichDoc;
};

export function createSeed(): MockDB {
  const db: MockDB = {
    schema: SCHEMA,
    users: people.map((u) => ({ ...u, avatarUrl: null, createdAt: T("2026-03-02"), password: MOCK_PASSWORD })),
    workspaces: [
      { id: "ws_platform", slug: "platform", name: "Platform team", hue: 255, createdAt: T("2026-03-02"), deletedAt: null },
      { id: "ws_guild", slug: "design-guild", name: "Design guild", hue: 300, createdAt: T("2026-05-11"), deletedAt: null },
    ],
    wsMembers: [],
    roles: [],
    invites: [],
    projects: [],
    projectMembers: [],
    accessRequests: [],
    statuses: [],
    labels: [],
    objectives: [],
    milestones: [],
    epics: [],
    sprints: [],
    tasks: [],
    comments: [],
    attachments: [],
    notifications: [],
    prefs: [],
    activity: [],
    audit: [],
    resetTokens: [],
    recents: [],
  };

  /* roles: the seven defaults per workspace, plus one custom role in Platform team */
  for (const ws of db.workspaces) {
    for (const r of DEFAULT_ROLES) {
      db.roles.push({
        id: `${ws.id}-role-${r.key}`,
        workspaceId: ws.id,
        key: r.key,
        name: r.name,
        description: r.description,
        scope: r.scope,
        isSystem: true,
        permissions: [...r.permissions],
      });
    }
  }
  const custom: RoleRec = {
    id: "ws_platform-role-release",
    workspaceId: "ws_platform",
    key: null,
    name: "Release captain",
    description: "Runs sprints and milestones for a release.",
    scope: "project",
    isSystem: false,
    permissions: [
      "project.view",
      "sprint.manage",
      "milestone.manage",
      "task.create",
      "task.edit_any",
      "task.edit_own",
      "task.move",
      "comment.create",
      "comment.edit_own",
      "report.view",
    ],
  };
  db.roles.push(custom);
  const role = (ws: string, key: string) => `${ws}-role-${key}`;

  /* workspace membership (the dev role switcher maps to these) */
  const wsm = (workspaceId: string, userId: string, key: string, lastMin: number | null): WsMemberRec => ({
    workspaceId,
    userId,
    roleId: role(workspaceId, key),
    status: "active",
    joinedAt: T("2026-03-02"),
    lastActiveAt: lastMin === null ? null : ago(lastMin),
  });
  db.wsMembers.push(
    wsm("ws_platform", AK, "owner", 2),
    wsm("ws_platform", JL, "admin", 12),
    wsm("ws_platform", SP, "member", 40),
    wsm("ws_platform", RC, "member", 180),
    wsm("ws_platform", MD, "member", 60 * 26),
    wsm("ws_platform", TN, "member", 60 * 50),
    wsm("ws_platform", CB, "admin", 60 * 5),
    wsm("ws_guild", DH, "owner", 30),
    wsm("ws_guild", AK, "member", 60 * 24 * 3),
    wsm("ws_guild", JL, "admin", 60 * 8),
  );
  db.invites.push(
    {
      id: "inv_1",
      token: "invite-quinn",
      workspaceId: "ws_platform",
      email: "quinn@team.dev",
      roleId: role("ws_platform", "member"),
      invitedById: AK,
      createdAt: ago(60 * 26),
      expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
      status: "pending",
    },
    {
      id: "inv_2",
      token: "invite-avery",
      workspaceId: "ws_platform",
      email: "avery@contractor.io",
      roleId: role("ws_platform", "member"),
      invitedById: JL,
      createdAt: ago(60 * 24 * 4),
      expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      status: "pending",
    },
  );

  /* projects */
  const addProject = (
    id: string,
    workspaceId: string,
    key: string,
    name: string,
    hue: number,
    leadId: string,
    description: string,
    template: "kanban" | "scrum" | "bugs",
    members: [string, string][],
    labels: [string, string][],
  ) => {
    db.projects.push({
      id,
      workspaceId,
      key,
      name,
      description,
      hue,
      leadId,
      status: "active",
      template,
      createdAt: T("2026-06-01"),
      taskSeq: 0,
    });
    STATUS_DEFS.forEach((s, i) =>
      db.statuses.push({ id: sid(id, s.key), projectId: id, name: s.name, category: s.category, glyph: s.key, position: i }),
    );
    for (const [userId, rk] of members) {
      const m: ProjectMemberRec = { projectId: id, userId, roleId: role(workspaceId, rk), addedAt: T("2026-06-01") };
      db.projectMembers.push(m);
    }
    for (const [lname, color] of labels) {
      const l: Label = { id: `${id}-lb-${lname}`, projectId: id, name: lname, color };
      db.labels.push(l);
    }
  };

  const LABELS: [string, string][] = [
    ["frontend", "var(--low)"],
    ["backend", "var(--accent-t)"],
    ["bug", "var(--danger)"],
    ["perf", "var(--info)"],
    ["infra", "var(--orange)"],
    ["design", "var(--warn)"],
  ];

  addProject(
    "p_prj",
    "ws_platform",
    "PRJ",
    "Platform Rebuild",
    255,
    AK,
    "Rebuild the core platform for speed: new board engine, auth overhaul and billing v2.",
    "scrum",
    [
      [AK, "project_admin"],
      [JL, "manager"],
      [SP, "project_member"],
      [MD, "project_member"],
      [TN, "viewer"],
      [RC, "project_member"],
    ],
    LABELS,
  );
  // Riley holds the custom "Release captain" role on PRJ.
  db.projectMembers.find((m) => m.projectId === "p_prj" && m.userId === RC)!.roleId = custom.id;

  addProject(
    "p_mob",
    "ws_platform",
    "MOB",
    "Mobile App",
    175,
    MD,
    "Native iOS and Android apps with offline-first task editing.",
    "kanban",
    [
      [MD, "project_admin"],
      [AK, "manager"],
      [JL, "project_member"],
      [SP, "project_member"],
      [TN, "viewer"],
    ],
    LABELS,
  );
  addProject(
    "p_inf",
    "ws_platform",
    "INF",
    "Infra",
    75,
    MD,
    "Clusters, edge cache, observability and the on-call rota.",
    "bugs",
    [
      [MD, "project_admin"],
      [RC, "manager"],
      [AK, "project_member"],
    ],
    LABELS,
  );
  addProject(
    "p_dsn",
    "ws_guild",
    "DSN",
    "Design System",
    300,
    DH,
    "Tokens, components and the docs site.",
    "kanban",
    [
      [DH, "project_admin"],
      [AK, "project_member"],
      [JL, "manager"],
    ],
    LABELS,
  );

  /* PRJ planning */
  db.epics.push(
    { id: "ep_auth", projectId: "p_prj", name: "Auth overhaul", description: "SSO, passkeys and session hardening.", hue: 255 },
    { id: "ep_board", projectId: "p_prj", name: "Board performance", description: "60fps boards at 1,000 cards.", hue: 200 },
    { id: "ep_sprint", projectId: "p_prj", name: "Sprint engine", description: "Rollover, carry-over and reports.", hue: 150 },
    { id: "ep_bill", projectId: "p_prj", name: "Billing v2", description: "Proration, invoices and tax.", hue: 60 },
    { id: "ep_mob_off", projectId: "p_mob", name: "Offline mode", description: "Queue edits while offline.", hue: 175 },
    { id: "ep_inf_edge", projectId: "p_inf", name: "Edge cache", description: "Serve reads from the edge.", hue: 75 },
  );
  db.milestones.push(
    { id: "ms_alpha", projectId: "p_prj", name: "Alpha", description: "Internal dogfood build.", ownerId: SP, startDate: D("2026-08-10"), dueDate: D("2026-09-12"), completedAt: T("2026-09-12", 16) },
    { id: "ms_beta", projectId: "p_prj", name: "Beta launch", description: "Invite-only beta for 50 teams.", ownerId: AK, startDate: D("2026-09-12"), dueDate: D("2026-10-21"), completedAt: null },
    { id: "ms_rc", projectId: "p_prj", name: "Release candidate", description: "Feature-complete, bug bash.", ownerId: JL, startDate: D("2026-09-28"), dueDate: D("2026-11-18"), completedAt: null },
    { id: "ms_ga", projectId: "p_prj", name: "General availability", description: "Public launch.", ownerId: AK, startDate: D("2026-10-21"), dueDate: D("2026-12-09"), completedAt: null },
    { id: "ms_mob_store", projectId: "p_mob", name: "App Store submission", description: "", ownerId: MD, startDate: D("2026-09-20"), dueDate: D("2026-11-02"), completedAt: null },
  );
  db.objectives.push(
    { id: "ob_latency", projectId: "p_prj", title: "Cut p95 latency to 200ms", description: "Board load and task open, measured at the edge.", ownerId: RC, quarter: "Q4", dueDate: D("2026-12-15"), status: "active", createdAt: T("2026-09-01") },
    { id: "ob_beta", projectId: "p_prj", title: "Ship beta on time", description: "Beta to 50 teams by Oct 21.", ownerId: AK, quarter: "Q4", dueDate: D("2026-10-21"), status: "active", createdAt: T("2026-09-01") },
    { id: "ob_p1", projectId: "p_prj", title: "Zero P1 incidents in Q4", description: "", ownerId: MD, quarter: "Q4", dueDate: D("2026-12-31"), status: "active", createdAt: T("2026-09-01") },
    { id: "ob_onboard", projectId: "p_prj", title: "Onboarding under 5 minutes", description: "From sign-up to first task moved.", ownerId: TN, quarter: "Q4", dueDate: D("2026-11-30"), status: "active", createdAt: T("2026-09-01") },
    { id: "ob_mob_offline", projectId: "p_mob", title: "Offline edits never lost", description: "", ownerId: MD, quarter: "Q4", dueDate: D("2026-11-30"), status: "active", createdAt: T("2026-09-05") },
  );
  db.sprints.push(
    { id: "sp_12", projectId: "p_prj", name: "Sprint 12", number: 12, goal: "Alpha out the door.", startDate: D("2026-09-03"), endDate: D("2026-09-16"), state: "completed", completedAt: T("2026-09-16", 17) },
    { id: "sp_13", projectId: "p_prj", name: "Sprint 13", number: 13, goal: "Board virtualization and tax IDs.", startDate: D("2026-09-17"), endDate: D("2026-09-30"), state: "completed", completedAt: T("2026-09-30", 17) },
    { id: "sp_14", projectId: "p_prj", name: "Sprint 14", number: 14, goal: "Beta blockers: SSO, reflow, carry-over.", startDate: D("2026-10-01"), endDate: D("2026-10-14"), state: "active", completedAt: null },
    { id: "sp_15", projectId: "p_prj", name: "Sprint 15", number: 15, goal: "", startDate: D("2026-10-15"), endDate: D("2026-10-28"), state: "planned", completedAt: null },
    { id: "sp_mob_7", projectId: "p_mob", name: "Sprint 7", number: 7, goal: "Offline queue.", startDate: D("2026-09-30"), endDate: D("2026-10-13"), state: "active", completedAt: null },
    { id: "sp_inf_3", projectId: "p_inf", name: "Sprint 3", number: 3, goal: "Edge cache rollout.", startDate: D("2026-10-01"), endDate: D("2026-10-14"), state: "active", completedAt: null },
    { id: "sp_dsn_2", projectId: "p_dsn", name: "Sprint 2", number: 2, goal: "", startDate: D("2026-10-01"), endDate: D("2026-10-14"), state: "active", completedAt: null },
  );

  /* tasks */
  const descReflow = doc(
    p("Columns jump when the sidebar collapses mid-drag. Reproduce by resizing the window while a card is held."),
    {
      type: "codeBlock",
      attrs: { language: "typescript" },
      content: [
        {
          type: "text",
          text: "// keep columns in sync\nconst ro = new ResizeObserver(() => {\n  requestAnimationFrame(() => reflow(columns));\n});",
        },
      ],
    },
  );

  const prjTasks: TaskSeed[] = [
    { n: 31, title: "Rotate refresh tokens on reuse", st: "done", pri: 3, asg: AK, epic: "ep_auth", sprint: "sp_13", ms: "ms_beta", due: "2026-09-30", labels: ["backend"], est: 3, done: "2026-09-29" },
    { n: 33, title: "SSO login with Okta", st: "progress", pri: 3, asg: JL, epic: "ep_auth", sprint: "sp_14", ms: "ms_beta", due: "2026-10-14", labels: ["backend", "frontend"], est: 5 },
    { n: 34, title: "Session timeout modal", st: "todo", pri: 2, asg: SP, epic: "ep_auth", sprint: "sp_14", ms: "ms_beta", due: "2026-10-10", labels: ["frontend", "design"], est: 2 },
    { n: 36, title: "Audit log for sign-ins", st: "backlog", pri: 1, asg: null, epic: "ep_auth", ms: "ms_rc", labels: ["backend"], est: 3 },
    { n: 38, title: "Passkey enrollment flow", st: "todo", pri: 2, asg: TN, epic: "ep_auth", sprint: "sp_14", ms: "ms_rc", due: "2026-10-16", labels: ["frontend"], est: 3 },
    { n: 40, title: "Virtualize board columns", st: "done", pri: 4, asg: AK, epic: "ep_board", sprint: "sp_13", ms: "ms_beta", due: "2026-10-02", labels: ["frontend", "perf"], est: 5, done: "2026-09-26" },
    { n: 42, title: "Fix flaky board reflow on column resize", st: "progress", pri: 3, asg: AK, rep: JL, epic: "ep_board", sprint: "sp_14", ms: "ms_beta", due: "2026-10-21", labels: ["frontend", "bug"], type: "bug", est: 3, created: "2026-10-02", desc: descReflow },
    { n: 43, title: "Add ResizeObserver to the board", st: "done", pri: 2, asg: AK, epic: "ep_board", sprint: "sp_14", parent: 42, est: 1, done: "2026-10-05" },
    { n: 44, title: "Debounce reflow on sidebar toggle", st: "progress", pri: 2, asg: JL, epic: "ep_board", sprint: "sp_14", ms: "ms_beta", due: "2026-10-08", labels: ["perf"], parent: 42, est: 1 },
    { n: 45, title: "Regression test: drag while resizing", st: "todo", pri: 2, asg: SP, epic: "ep_board", sprint: "sp_14", parent: 42, labels: ["perf"], est: 1 },
    { n: 46, title: "Beta invite emails", st: "progress", pri: 2, asg: TN, epic: "ep_auth", sprint: "sp_14", ms: "ms_beta", due: "2026-10-12", labels: ["frontend"], est: 2 },
    { n: 47, title: "Cache card thumbnails", st: "backlog", pri: 1, asg: null, epic: "ep_board", ms: "ms_ga", labels: ["perf"], est: 2 },
    { n: 48, title: "Token refresh race on cold start", st: "progress", pri: 3, asg: AK, epic: "ep_auth", sprint: "sp_14", ms: "ms_beta", due: "2026-10-09", labels: ["backend", "bug"], type: "bug", est: 2 },
    { n: 49, title: "Sprint rollover job", st: "done", pri: 3, asg: SP, epic: "ep_sprint", sprint: "sp_12", ms: "ms_alpha", due: "2026-09-10", labels: ["backend"], est: 3, done: "2026-09-09" },
    { n: 50, title: "Carry-over prompt at sprint close", st: "progress", pri: 4, asg: MD, epic: "ep_sprint", sprint: "sp_14", ms: "ms_beta", due: "2026-10-06", labels: ["frontend"], est: 3 },
    { n: 51, title: "Keyboard shortcut sheet", st: "review", pri: 2, asg: SP, epic: "ep_board", sprint: "sp_14", ms: "ms_beta", due: "2026-10-11", labels: ["frontend", "design"], est: 2 },
    { n: 52, title: "Velocity chart by assignee", st: "todo", pri: 1, asg: RC, epic: "ep_sprint", sprint: "sp_14", ms: "ms_rc", due: "2026-10-20", labels: ["frontend"], est: 2 },
    { n: 53, title: "Burndown off by one day", st: "done", pri: 3, asg: MD, epic: "ep_sprint", sprint: "sp_13", ms: "ms_beta", due: "2026-09-29", labels: ["bug"], type: "bug", est: 1, done: "2026-09-28" },
    { n: 54, title: "Rate-limit login attempts", st: "todo", pri: 2, asg: AK, epic: "ep_auth", sprint: "sp_14", ms: "ms_rc", due: "2026-10-14", labels: ["backend"], est: 2 },
    { n: 55, title: "Capacity planning per sprint", st: "backlog", pri: 2, asg: null, epic: "ep_sprint", ms: "ms_ga", labels: ["design"], est: 5 },
    { n: 56, title: "Persist saved filters per project", st: "review", pri: 2, asg: JL, epic: "ep_board", sprint: "sp_14", ms: "ms_beta", due: "2026-10-13", labels: ["frontend"], est: 2 },
    { n: 57, title: "Proration on plan change", st: "progress", pri: 3, asg: TN, epic: "ep_bill", sprint: "sp_14", ms: "ms_rc", due: "2026-10-15", labels: ["backend"], est: 5 },
    { n: 58, title: "Invoice PDF redesign", st: "todo", pri: 2, asg: SP, epic: "ep_bill", sprint: "sp_14", ms: "ms_rc", due: "2026-10-17", labels: ["design", "frontend"], est: 3 },
    { n: 60, title: "Stripe webhook retries", st: "done", pri: 4, asg: JL, epic: "ep_bill", sprint: "sp_12", ms: "ms_alpha", due: "2026-09-08", labels: ["backend", "infra"], est: 3, done: "2026-09-07" },
    { n: 61, title: "Tax IDs for EU customers", st: "done", pri: 2, asg: TN, epic: "ep_bill", sprint: "sp_13", ms: "ms_beta", due: "2026-10-01", labels: ["backend"], est: 3, done: "2026-09-30" },
    { n: 62, title: "Command palette v1", st: "done", pri: 3, asg: AK, epic: "ep_board", sprint: "sp_13", ms: "ms_beta", due: "2026-09-28", labels: ["frontend"], est: 5, done: "2026-09-25" },
    { n: 63, title: "Legacy coupon migration", st: "canceled", pri: 1, asg: MD, epic: "ep_bill", sprint: "sp_13", labels: ["infra"], est: 2 },
    { n: 64, title: "Public status page", st: "done", pri: 2, asg: MD, sprint: "sp_13", ms: "ms_rc", due: "2026-09-25", labels: ["infra"], est: 2, done: "2026-09-24" },
    { n: 65, title: "Migrate audit log", st: "done", pri: 2, asg: RC, sprint: "sp_14", ms: "ms_rc", due: "2026-10-05", labels: ["backend"], est: 3, done: "2026-10-05" },
    { n: 66, title: "On-call runbook", st: "progress", pri: 2, asg: MD, sprint: "sp_14", ms: "ms_rc", due: "2026-10-18", labels: ["infra"], type: "chore", est: 2 },
    { n: 67, title: "Alert on error budget", st: "todo", pri: 3, asg: MD, sprint: "sp_15", ms: "ms_ga", due: "2026-10-26", labels: ["infra"], est: 3 },
    { n: 68, title: "Load test 10k tasks", st: "backlog", pri: 2, asg: RC, epic: "ep_board", ms: "ms_ga", labels: ["perf"], type: "spike", est: 3 },
    { n: 69, title: "Empty state for new workspaces", st: "todo", pri: 1, asg: TN, sprint: "sp_15", ms: "ms_ga", due: "2026-10-24", labels: ["design"], est: 1 },
    { n: 70, title: "Write release notes for 2.4", st: "todo", pri: 0, asg: null, rep: JL, sprint: "sp_15", type: "chore" },
    { n: 71, title: "Guided first project", st: "progress", pri: 2, asg: TN, sprint: "sp_14", ms: "ms_ga", due: "2026-10-19", labels: ["frontend", "design"], est: 3 },
  ];
  const objectiveLinks: Record<string, number[]> = {
    ob_latency: [40, 42, 44, 47, 65, 68],
    ob_beta: [31, 34, 42, 46, 48, 61],
    ob_p1: [53, 64, 66, 67],
    ob_onboard: [38, 69, 70, 71],
  };

  const mobTasks: TaskSeed[] = [
    { n: 9, title: "Offline queue for task edits", st: "done", pri: 3, asg: MD, epic: "ep_mob_off", sprint: "sp_mob_7", ms: "ms_mob_store", labels: ["frontend"], est: 5, done: "2026-10-03" },
    { n: 12, title: "Queue task edits while offline", st: "progress", pri: 2, asg: MD, epic: "ep_mob_off", sprint: "sp_mob_7", ms: "ms_mob_store", due: "2026-10-11", labels: ["frontend"], est: 3 },
    { n: 13, title: "Conflict banner after reconnect", st: "review", pri: 3, asg: JL, epic: "ep_mob_off", sprint: "sp_mob_7", ms: "ms_mob_store", due: "2026-10-09", labels: ["design"], est: 2 },
    { n: 14, title: "Push notification opt-in screen", st: "todo", pri: 1, asg: SP, sprint: "sp_mob_7", due: "2026-10-13", labels: ["design"], est: 1 },
    { n: 15, title: "Crash on rotate in task detail", st: "progress", pri: 4, asg: AK, sprint: "sp_mob_7", due: "2026-10-08", labels: ["bug"], type: "bug", est: 2 },
    { n: 16, title: "Haptics on drag", st: "todo", pri: 1, asg: JL, sprint: "sp_mob_7", labels: ["frontend"], est: 1 },
    { n: 17, title: "Biometric unlock", st: "backlog", pri: 2, asg: null, ms: "ms_mob_store", labels: ["backend"], est: 3 },
    { n: 18, title: "Dark launch screen", st: "done", pri: 1, asg: SP, sprint: "sp_mob_7", labels: ["design"], est: 1, done: "2026-10-02" },
    { n: 19, title: "App Store screenshots", st: "backlog", pri: 2, asg: null, ms: "ms_mob_store", labels: ["design"] },
  ];
  const infTasks: TaskSeed[] = [
    { n: 7, title: "Cache board queries at the edge", st: "progress", pri: 3, asg: RC, epic: "ep_inf_edge", sprint: "sp_inf_3", due: "2026-10-12", labels: ["infra", "perf"], est: 5 },
    { n: 8, title: "Rotate TLS certificates", st: "done", pri: 4, asg: MD, sprint: "sp_inf_3", labels: ["infra"], est: 1, done: "2026-10-02" },
    { n: 9, title: "Postgres connection pooling", st: "review", pri: 3, asg: RC, sprint: "sp_inf_3", due: "2026-10-09", labels: ["backend", "infra"], est: 3 },
    { n: 10, title: "Error budget dashboard", st: "todo", pri: 2, asg: AK, sprint: "sp_inf_3", labels: ["infra"], est: 2 },
    { n: 11, title: "Paging rota for Q4", st: "todo", pri: 1, asg: MD, sprint: "sp_inf_3", type: "chore", est: 1 },
    { n: 12, title: "Upgrade Kubernetes to 1.34", st: "backlog", pri: 2, asg: null, labels: ["infra"], est: 5 },
    { n: 13, title: "Log retention policy", st: "backlog", pri: 1, asg: null, labels: ["infra"], type: "chore" },
  ];
  const dsnTasks: TaskSeed[] = [
    { n: 1, title: "Token export for iOS", st: "progress", pri: 2, asg: DH, sprint: "sp_dsn_2", labels: ["design"], est: 3 },
    { n: 2, title: "Focus ring audit", st: "todo", pri: 3, asg: AK, sprint: "sp_dsn_2", labels: ["design", "frontend"], est: 2 },
    { n: 3, title: "Docs site search", st: "backlog", pri: 1, asg: null, labels: ["frontend"] },
    { n: 4, title: "Button density variants", st: "done", pri: 2, asg: JL, sprint: "sp_dsn_2", labels: ["design"], est: 1, done: "2026-10-03" },
  ];

  const addTasks = (projectId: string, key: string, seeds: TaskSeed[], links: Record<string, number[]> = {}) => {
    // positions grouped per status so the board has a stable order
    const byStatus = new Map<StatusGlyph, TaskSeed[]>();
    seeds.forEach((s) => byStatus.set(s.st, [...(byStatus.get(s.st) ?? []), s]));
    const positions = new Map<number, string>();
    byStatus.forEach((list) => {
      const keys = keysBetween(null, null, list.length);
      list.forEach((s, i) => positions.set(s.n, keys[i]!));
    });
    const proj = db.projects.find((x) => x.id === projectId)!;
    for (const s of seeds) {
      const id = `${projectId}-t${s.n}`;
      const created = s.created ? T(s.created, 9) : T("2026-09-20", 9 + (s.n % 8));
      const objectiveIds = Object.entries(links)
        .filter(([, ns]) => ns.includes(s.n))
        .map(([oid]) => oid);
      const isDone = s.st === "done";
      const startedSt = s.st === "progress" || s.st === "review" || isDone;
      const task: TaskRec = {
        id,
        projectId,
        key: `${key}-${s.n}`,
        number: s.n,
        title: s.title,
        type: s.type ?? (s.labels?.includes("bug") ? "bug" : "feature"),
        priority: s.pri,
        statusId: sid(projectId, s.st),
        assigneeId: s.asg,
        reporterId: s.rep ?? (s.asg === AK ? JL : AK),
        estimate: s.est ?? null,
        dueDate: s.due ? D(s.due) : null,
        epicId: s.epic ?? null,
        milestoneId: s.ms ?? null,
        sprintId: s.sprint ?? null,
        parentId: s.parent ? `${projectId}-t${s.parent}` : null,
        objectiveIds,
        labelIds: (s.labels ?? []).map((l) => `${projectId}-lb-${l}`),
        position: positions.get(s.n)!,
        version: 1,
        createdAt: created,
        updatedAt: created,
        startedAt: startedSt ? T(s.done ? addDays(s.done, -3) : "2026-10-03", 11) : null,
        completedAt: isDone ? T(s.done ?? "2026-10-04", 15) : null,
        deletedAt: null,
        description: s.desc ?? null,
      };
      db.tasks.push(task);
      proj.taskSeq = Math.max(proj.taskSeq, s.n);
    }
  };
  addTasks("p_prj", "PRJ", prjTasks, objectiveLinks);
  addTasks("p_mob", "MOB", mobTasks, { ob_mob_offline: [9, 12, 13] });
  addTasks("p_inf", "INF", infTasks);
  addTasks("p_dsn", "DSN", dsnTasks);

  /* comments, attachments */
  db.comments.push(
    {
      id: "c1",
      taskId: "p_prj-t42",
      authorId: JL,
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Repro’d on Safari too. " },
              { type: "mention", attrs: { id: AK, label: "Alex Kim" } },
              { type: "text", text: " is " },
              { type: "text", text: "will-change", marks: [{ type: "code" }] },
              { type: "text", text: " the culprit?" },
            ],
          },
        ],
      },
      mentions: [AK],
      createdAt: ago(120),
      editedAt: null,
    },
    {
      id: "c2",
      taskId: "p_prj-t42",
      authorId: AK,
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Yes. Fix is behind the " },
              { type: "text", text: "board-reflow", marks: [{ type: "code" }] },
              { type: "text", text: " flag." },
            ],
          },
        ],
      },
      mentions: [],
      createdAt: ago(60),
      editedAt: null,
    },
    {
      id: "c3",
      taskId: "p_prj-t48",
      authorId: SP,
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "mention", attrs: { id: AK, label: "Alex Kim" } },
              { type: "text", text: " can you check the retry path before the beta cut?" },
            ],
          },
        ],
      },
      mentions: [AK],
      createdAt: ago(12),
      editedAt: null,
    },
  );
  const reflowTs = "export function reflow(\n  cols: Column[],\n) {\n  cols.forEach(m);\n}\n";
  const att: AttachmentRec[] = [
    {
      id: "at1",
      taskId: "p_prj-t42",
      uploaderId: JL,
      fileName: "drag-glitch.png",
      size: 1_258_291,
      mimeType: "image/png",
      kind: "image",
      downloadUrl: "",
      previewUrl: null,
      createdAt: ago(60 * 20),
    },
    {
      id: "at2",
      taskId: "p_prj-t42",
      uploaderId: AK,
      fileName: "reflow.ts",
      size: 4096,
      mimeType: "text/typescript",
      kind: "code",
      downloadUrl: "",
      previewUrl: null,
      createdAt: ago(60 * 3),
      content: reflowTs,
    },
  ];
  db.attachments.push(...att);

  /* notifications for Alex (inbox demo data, mapped onto real tasks) */
  const n = (
    id: string,
    type: NotificationRec["type"],
    actorId: string | null,
    taskN: number,
    minutes: number,
    read: boolean,
    payload: NotificationRec["payload"] = {},
    recipientId = AK,
  ): NotificationRec => {
    const t = db.tasks.find((x) => x.id === `p_prj-t${taskN}`)!;
    return {
      id,
      recipientId,
      type,
      actorId,
      projectId: "p_prj",
      projectName: "Platform Rebuild",
      taskId: t.id,
      taskKey: t.key,
      taskTitle: t.title,
      payload,
      createdAt: ago(minutes),
      readAt: read ? ago(minutes - 1) : null,
    };
  };
  db.notifications.push(
    n("n1", "mention", SP, 48, 12, false, { quote: "can you check the retry path before the beta cut?" }),
    n("n2", "assigned", JL, 54, 38, false),
    n("n3", "status", RC, 56, 60, false, { fromStatus: "In progress", toStatus: "In review" }),
    n("n4", "comment", MD, 50, 120, false, { quote: "Repro’d on Safari only. Timezone offset?" }),
    n("n5", "due", null, 44, 180, false, { dueDate: D("2026-10-08") }),
    n("n6", "status", TN, 62, 60 * 24, true, { fromStatus: "In review", toStatus: "Done" }),
    n("n7", "assigned", SP, 42, 60 * 26, false),
    n("n8", "mention", RC, 40, 60 * 48, true, { quote: "numbers after virtualization: 240ms p95." }),
    n("n9", "comment", JL, 31, 60 * 72, true, { quote: "Scope list looks right to me." }),
    n("n10", "sprint", JL, 33, 60 * 24 * 6, true, { sprintName: "Sprint 14" }),
    n("n11", "assigned", AK, 34, 45, false, {}, SP),
    n("n12", "mention", JL, 42, 90, false, { quote: "can you pair on the regression test?" }, SP),
    n("n13", "status", AK, 51, 200, true, { fromStatus: "In progress", toStatus: "In review" }, SP),
    n("n14", "assigned", AK, 44, 300, false, {}, JL),
  );

  /* activity feed */
  const act = (
    id: string,
    actorId: string | null,
    verb: MockDB["activity"][number]["verb"],
    taskN: number | null,
    minutes: number,
    data: Record<string, string | number | null> = {},
    projectId = "p_prj",
  ) => {
    const t = taskN === null ? null : db.tasks.find((x) => x.id === `${projectId}-t${taskN}`) ?? null;
    db.activity.push({
      id,
      actorId,
      verb,
      projectId,
      taskId: t?.id ?? null,
      taskKey: t?.key ?? null,
      taskTitle: t?.title ?? null,
      data,
      createdAt: ago(minutes),
    });
  };
  act("a1", AK, "status_changed", 42, 60, { to: "In progress" });
  act("a2", JL, "linked_objective", 42, 180, { objective: "Cut p95 latency to 200ms" });
  act("a3", JL, "created", 42, 60 * 24 * 5);
  act("a4", RC, "status_changed", 65, 60 * 30, { to: "Done" });
  act("a5", SP, "commented", 48, 12);
  act("a6", JL, "status_changed", 56, 60, { to: "In review" });
  act("a7", MD, "commented", 50, 120);
  act("a8", JL, "sprint_started", null, 60 * 24 * 6, { sprint: "Sprint 14" });
  act("a9", AK, "assigned", 54, 38, { assignee: "Alex Kim" });
  act("a10", MD, "status_changed", 12, 90, { to: "In progress" }, "p_mob");
  act("a11", RC, "status_changed", 9, 200, { to: "In review" }, "p_inf");

  db.audit.push(
    { id: "au1", workspaceId: "ws_platform", actorId: AK, action: "role.updated", target: "Release captain", createdAt: ago(60 * 30) },
    { id: "au2", workspaceId: "ws_platform", actorId: JL, action: "member.invited", target: "avery@contractor.io", createdAt: ago(60 * 24 * 4) },
    { id: "au3", workspaceId: "ws_platform", actorId: AK, action: "project.created", target: "Infra", createdAt: ago(60 * 24 * 20) },
  );

  db.recents.push(
    { userId: AK, kind: "task", id: "p_prj-t42", at: ago(5) },
    { userId: AK, kind: "project", id: "p_mob", at: ago(30) },
    { userId: AK, kind: "task", id: "p_prj-t51", at: ago(90) },
  );

  db.prefs = db.users.map((u) => ({ userId: u.id, prefs: defaultPrefs() }));
  return db;
}

function addDays(iso: string, days: number) {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return fmt(new Date(y, m - 1, d + days));
}

export function defaultPrefs(): NotificationPreferences {
  return {
    events: {
      assigned: { in_app: true, email: true },
      mentioned: { in_app: true, email: true },
      status_change: { in_app: true, email: false },
      comment: { in_app: true, email: false },
      due_soon: { in_app: true, email: true },
      sprint_started: { in_app: true, email: false },
    },
    emailDelivery: "instant",
  };
}

/** Users offered by the dev role switcher, one per default role. */
export const ROLE_PRESETS = [
  { userId: "u_alex", role: "Owner", scope: "workspace", note: "Workspace owner · Project Admin on PRJ" },
  { userId: "u_jordan", role: "Admin", scope: "workspace", note: "Workspace admin · Manager on PRJ" },
  { userId: "u_sam", role: "Member", scope: "workspace", note: "Workspace member · Member on PRJ" },
  { userId: "u_alex", role: "Project Admin", scope: "project", note: "Platform Rebuild (PRJ)" },
  { userId: "u_jordan", role: "Manager", scope: "project", note: "Platform Rebuild (PRJ)" },
  { userId: "u_sam", role: "Member", scope: "project", note: "Platform Rebuild (PRJ)" },
  { userId: "u_taylor", role: "Viewer", scope: "project", note: "Platform Rebuild (PRJ) · read-only" },
  { userId: "u_casey", role: "Admin, no projects", scope: "workspace", note: "Workspace admin with no project membership (403 + request access)" },
] as const;
