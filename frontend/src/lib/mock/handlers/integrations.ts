import { suggestBranch, validateBranch } from "@/features/integrations/lib/branch-name";
import { aggregateChecks, PROVIDER_NAME } from "@/features/integrations/lib/dev-lib";
import type {
  ActivityEntry,
  AuditChange,
  AvailableRepository,
  CheckState,
  DevAuthor,
  DevAutomationRule,
  DevBranch,
  DevCheck,
  DevCommit,
  DevItem,
  DevPullRequest,
  DevTrigger,
  Integration,
  IntegrationErrorCode,
  Permission,
  Provider,
  ProviderInfo,
  RepoVisibility,
  Repository,
  TaskDevelopment,
} from "@/lib/api/types";
import { getDB, nowISO, persist, uid } from "../db";
import type { ConnectAttemptRec, DevLinkRec, DevRuleRec, IntegrationRec, MockDB, ProjectRec, RepositoryRec, TaskRec } from "../db-types";
import { activeReposFor, linkItem, orderPrs, repoApplies, visibleLinks } from "../dev-derive";
import { projectPermissions, statusesOf, wsMembership, wsPermissions } from "../derive";
import { mockBus, publishProject, publishTask } from "../realtime";
import { fail, invalid, requireProject, requireUser, requireWs, route, str, wsBySlug, type Ctx } from "../router";
import { notify } from "./common";
import { applyStatusSideEffects, lastPosition } from "./tasks";

/*
 * Board 37 mock backend (docs/v2/37-integrations-github-gitlab.md §5): G1–G13, D1–D4, A1–A2, with the
 * fake provider of §7.8 (the design's eight repositories), the same validation copy, status codes and
 * permission checks (`integration.manage` from the workspace role, `development.link` / `status.manage`
 * from the project role), the §7.10 automations made by a system actor, and the dev-pill simulators.
 *
 * The provider round-trip is in-page: `authorizeUrl` is `/<ws>/settings/integrations#mock-authorize=…`,
 * the screen shows the fake consent dialog and calls `fakeAuthorize()` (the backend's fake authorize
 * route + callback), which answers with the same `#connect=<attempt>.<token>` fragment as the real callback.
 */

/* ───────── fake provider ───────── */

export const GH_BASE = "https://github.com";
export const GL_BASE = "https://gitlab.com";

/** Mock-only server configuration (§2.3); tests flip these. */
export const mockProviderConfig = { github: true, gitlabOauth: true, githubBranchCreation: true };
/** The design's skeleton timing for available repositories (tests set 0). */
export const fakeTiming = { listMs: 700, syncMs: 1500, backfillMs: 2500 };

type FakeRepo = { id: string; owner: string; name: string; vis: RepoVisibility; updMin: number; prs: number };
const FAKE_REPOS: FakeRepo[] = [
  { id: "712004001", owner: "platform-team", name: "web", vis: "private", updMin: 2, prs: 12 },
  { id: "712004002", owner: "platform-team", name: "api", vis: "private", updMin: 9, prs: 7 },
  { id: "712004003", owner: "platform-team", name: "board-engine", vis: "private", updMin: 60, prs: 4 },
  { id: "712004004", owner: "platform-team", name: "mobile-app", vis: "private", updMin: 180, prs: 5 },
  { id: "712004188", owner: "platform-team", name: "infra-terraform", vis: "private", updMin: 1440, prs: 2 },
  { id: "712004190", owner: "platform-team", name: "design-tokens", vis: "public", updMin: 5760, prs: 1 },
  { id: "712009001", owner: "alexkim", name: "reflow-bench", vis: "public", updMin: 2880, prs: 0 },
  { id: "712009002", owner: "alexkim", name: "dotfiles", vis: "public", updMin: 30240, prs: 0 },
];
const fakeRepos = (provider: Provider) =>
  FAKE_REPOS.map((r) => ({ ...r, id: provider === "github" ? r.id : `44${r.id.slice(2)}` }));

/** GitHub accounts the fake install page offers, in order (the first one not yet connected is used). */
const GH_ACCOUNTS = [
  { login: "platform-team", kind: "organization" as const, ext: "51234567" },
  { login: "alexkim", kind: "user" as const, ext: "51239999" },
];

const ERROR_MESSAGE = (provider: Provider, code: IntegrationErrorCode) => {
  const name = PROVIDER_NAME[provider];
  switch (code) {
    case "token_expired":
      return `${name} access expired. Reconnect to resume syncing.`;
    case "token_revoked":
      return `${name} access was revoked. Reconnect to resume syncing.`;
    case "installation_suspended":
      return "The GitHub App was suspended on the organization.";
    case "installation_removed":
      return "The GitHub App was uninstalled from the organization.";
    case "insufficient_scope":
      return "Lightex is missing permissions. Reconnect to grant them.";
    case "unreachable":
      return "Lightex can’t reach this GitLab instance.";
    case "webhook_failing":
      return `${name} webhooks are failing.`;
  }
};

/* ───────── upgrade + seed ───────── */

const WS_GRANTS: Record<string, Permission[]> = { owner: ["integration.manage"], admin: ["integration.manage"] };
const PRJ_GRANTS: Record<string, Permission[]> = { project_admin: ["development.link"], manager: ["development.link"], project_member: ["development.link"] };

/**
 * Runs once per database (marker `ext37`): from createSeed(), when a cached database loads, and on
 * the first integrations route. Adds the two keys to cached **system** roles by key (custom roles
 * untouched), then seeds the platform workspace's GitHub connection and the design's PRs.
 */
export function ensureExt37(db: MockDB) {
  db.integrations ??= [];
  db.repositories ??= [];
  db.devLinks ??= [];
  db.devRules ??= [];
  db.connectAttempts ??= [];
  if (db.ext37) return;
  db.ext37 = true;
  for (const r of db.roles) {
    if (!r.isSystem || !r.key) continue;
    for (const p of WS_GRANTS[r.key] ?? []) {
      if (r.permissions.includes(p)) continue;
      const at = r.permissions.indexOf("audit.view");
      if (at >= 0) r.permissions.splice(at, 0, p);
      else r.permissions.push(p);
    }
    for (const p of PRJ_GRANTS[r.key] ?? []) {
      if (r.permissions.includes(p)) continue;
      const at = r.permissions.indexOf("project.import");
      const after = at >= 0 ? at : r.permissions.indexOf("task.move");
      if (after >= 0) r.permissions.splice(after + 1, 0, p);
      else r.permissions.push(p);
    }
  }
  if (db.workspaces.some((w) => w.id === "ws_platform") && db.projects.some((p) => p.id === "p_prj")) seedPlatform(db);
}

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const PEOPLE: Record<string, { login: string; name: string }> = {
  u_alex: { login: "akim", name: "Alex Kim" },
  u_jordan: { login: "jlee", name: "Jordan Lee" },
  u_sam: { login: "sam-p", name: "Sam Patel" },
  u_riley: { login: "rchen", name: "Riley Chen" },
  u_taylor: { login: "tng", name: "Taylor Ng" },
};
const author = (userId: string): DevAuthor => ({ login: PEOPLE[userId]?.login ?? userId, name: PEOPLE[userId]?.name ?? null, userId });
const fullSha = (short: string) => (short + "6e1b0c4d9a7f2e5b8c3d1a0f9e8d7c6b5a4f3e2d").slice(0, 40);
const ck = (name: string, state: CheckState, durationSec: number | null, url: string | null = null): DevCheck => ({ name, state, durationSec, url });
const checksOf = (items: DevCheck[]): DevPullRequest["checks"] => {
  const state = aggregateChecks(items.map((c) => c.state));
  return state ? { state, passed: items.filter((c) => c.state === "passing").length, total: items.length, items } : null;
};

/** Two design tasks that the v1 seed doesn't have (PRJ-41 in review, PRJ-29 done). */
function ensureDesignTasks(db: MockDB) {
  const proj = db.projects.find((p) => p.id === "p_prj")!;
  const add = (n: number, title: string, st: "review" | "done", asg: string, pri: 0 | 1 | 2 | 3 | 4, completedMin: number | null) => {
    if (db.tasks.some((t) => t.projectId === "p_prj" && t.number === n)) return;
    const statusId = `p_prj-st-${st}`;
    if (!db.statuses.some((s) => s.id === statusId)) return;
    const created = minsAgo(60 * 24 * 12);
    const task: TaskRec = {
      id: `p_prj-t${n}`,
      projectId: "p_prj",
      key: `PRJ-${n}`,
      number: n,
      title,
      type: "feature",
      priority: pri,
      statusId,
      assigneeId: asg,
      reporterId: "u_jordan",
      estimate: 2,
      dueDate: null,
      epicId: db.epics.some((e) => e.id === "ep_board") ? "ep_board" : null,
      milestoneId: null,
      sprintId: db.sprints.some((s) => s.id === "sp_14") ? "sp_14" : null,
      parentId: null,
      objectiveIds: [],
      labelIds: [],
      position: lastPosition(db, "p_prj", statusId),
      version: 1,
      createdAt: created,
      updatedAt: created,
      startedAt: minsAgo(60 * 24 * 6),
      completedAt: completedMin === null ? null : minsAgo(completedMin),
      deletedAt: null,
      description: null,
    };
    db.tasks.push(task);
    proj.taskSeq = Math.max(proj.taskSeq, n);
  };
  add(41, "Virtualize board column lists", "review", "u_riley", 3, null);
  add(29, "Board drag preview", "done", "u_taylor", 2, 60 * 24 * 3);
}

function seedPlatform(db: MockDB) {
  ensureDesignTasks(db);
  const integ: IntegrationRec = {
    id: "int_gh_platform",
    workspaceId: "ws_platform",
    provider: "github",
    authKind: "github_app",
    baseUrl: GH_BASE,
    account: { login: "platform-team", kind: "organization", url: `${GH_BASE}/platform-team` },
    accountExternalId: "51234567",
    status: "active",
    error: null,
    connectedBy: "u_alex",
    connectedAt: minsAgo(60 * 24 * 7),
    lastSyncedAt: minsAgo(2),
    tokenExpiresAt: null,
    manageUrl: `${GH_BASE}/organizations/platform-team/settings/installations/51234567`,
    syncRequestedAt: null,
    syncUntil: null,
  };
  db.integrations!.push(integ);
  const repos = FAKE_REPOS.slice(0, 4).map((f) => makeRepo(integ, f, minsAgo(2)));
  for (const r of repos) r.syncState = "idle";
  db.repositories!.push(...repos);
  const web = repos[0]!;
  const engine = repos[2]!;

  const pr = (taskId: string, repo: RepositoryRec, n: number, title: string, state: DevPullRequest["state"], head: string, who: string, checks: DevCheck[], updMin: number, extra: Partial<DevPullRequest> = {}) =>
    addLink(db, taskId, repo, {
      kind: "pull_request",
      provider: "github",
      number: n,
      ref: `#${n}`,
      title,
      url: `${repo.url}/pull/${n}`,
      state,
      headBranch: head,
      baseBranch: "main",
      author: author(who),
      checks: checksOf(checks),
      approvals: 0,
      linkSource: "auto",
      createdAt: minsAgo(updMin + 60 * 20),
      updatedAt: minsAgo(updMin),
      mergedAt: null,
      closedAt: null,
      ...extra,
    } as Omit<DevPullRequest, "id" | "repository" | "repoFullPath">);
  const t42 = "p_prj-t42";
  pr(t42, web, 214, "PRJ-42 Fix flaky board reflow", "open", "prj-42-fix-reflow", "u_alex", [ck("e2e / board-drag", "failing", 134), ck("unit / reflow", "failing", 48), ck("lint", "passing", 12)], 20);
  pr(t42, web, 209, "PRJ-42 Add reflow regression test", "draft", "prj-42-reflow-tests", "u_sam", [ck("e2e / board-drag", "running", 60), ck("unit / reflow", "passing", 41), ck("lint", "passing", 11)], 50);
  pr(t42, web, 198, "PRJ-42 Debounce sidebar toggle", "merged", "prj-42-debounce-sidebar", "u_jordan", [ck("e2e / board-drag", "passing", 122), ck("unit / reflow", "passing", 45), ck("lint", "passing", 10)], 60 * 30, { mergedAt: minsAgo(60 * 30), approvals: 2 });
  pr(t42, web, 190, "PRJ-42 Drop will-change hack", "closed", "prj-42-will-change", "u_alex", [], 60 * 24 * 5, { closedAt: minsAgo(60 * 24 * 5) });
  const br = (taskId: string, repo: RepositoryRec, name: string, ahead: number, updMin: number) =>
    addLink(db, taskId, repo, { kind: "branch", provider: "github", name, url: `${repo.url}/tree/${name}`, state: "active", aheadBy: ahead, linkSource: "auto", updatedAt: minsAgo(updMin) } as Omit<DevBranch, "id" | "repository" | "repoFullPath">);
  br(t42, web, "prj-42-fix-reflow", 3, 60);
  br(t42, web, "prj-42-reflow-tests", 1, 180);
  const cm = (taskId: string, repo: RepositoryRec, short: string, message: string, who: string, min: number) =>
    addLink(db, taskId, repo, {
      kind: "commit",
      provider: "github",
      sha: fullSha(short),
      shortSha: short,
      message,
      url: `${repo.url}/commit/${fullSha(short)}`,
      author: author(who),
      committedAt: minsAgo(min),
      linkSource: "auto",
    } as Omit<DevCommit, "id" | "repository" | "repoFullPath">);
  cm(t42, web, "a3f9c21", "fix(board): debounce reflow (PRJ-42)", "u_alex", 60);
  cm(t42, web, "7be04d8", "test(board): drag while resizing (PRJ-42)", "u_sam", 180);
  cm(t42, web, "e51c7aa", "refactor(board): extract measure() (PRJ-42)", "u_alex", 300);
  cm(t42, web, "0c2d9f3", "fix(board): guard null column (PRJ-42)", "u_jordan", 60 * 24);
  if (db.tasks.some((t) => t.id === "p_prj-t41")) {
    pr("p_prj-t41", web, 221, "PRJ-41 Virtualize board column lists", "open", "prj-41-virtualize-columns", "u_riley", [ck("e2e / board-drag", "passing", 118), ck("unit / virtual", "passing", 39), ck("lint", "passing", 11)], 90, { approvals: 1 });
  }
  if (db.tasks.some((t) => t.id === "p_prj-t29")) {
    pr("p_prj-t29", engine, 187, "PRJ-29 Board drag preview", "merged", "prj-29-drag-preview", "u_taylor", [ck("unit / drag", "passing", 52), ck("lint", "passing", 9)], 60 * 24 * 3, { mergedAt: minsAgo(60 * 24 * 3), approvals: 1 });
  }
  // §13 #4: every rule off by default; PRJ's demo turns pr_merged → Done on (§9.8).
  db.devRules!.push({ projectId: "p_prj", trigger: "pr_merged", enabled: true, statusId: "p_prj-st-done", updatedBy: "u_alex" });
}

function makeRepo(integ: IntegrationRec, f: FakeRepo, at: string | null): RepositoryRec {
  const fullPath = `${f.owner}/${f.name}`;
  return {
    id: integ.id === "int_gh_platform" ? `repo_gh_${f.name.replace(/-/g, "_")}` : uid("repo"),
    integrationId: integ.id,
    workspaceId: integ.workspaceId,
    baseUrl: integ.baseUrl,
    externalId: f.id,
    fullPath,
    owner: f.owner,
    name: f.name,
    visibility: f.vis,
    defaultBranch: "main",
    url: `${integ.baseUrl}/${fullPath}`,
    allProjects: true,
    projectIds: [],
    openPullRequests: f.prs,
    syncState: "queued",
    syncUntil: null,
    lastSyncedAt: at,
    archived: false,
  };
}

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A link's wire item before it has an id and repository. */
type NewItem = DistOmit<DevItem, "id" | "repository" | "repoFullPath">;

function externalIdOf(repo: { externalId: string }, item: { kind: DevItem["kind"]; number?: number; name?: string; sha?: string }) {
  if (item.kind === "pull_request") return `${repo.externalId}#${item.number}`;
  if (item.kind === "branch") return `${repo.externalId}:${item.name}`;
  return item.sha!;
}

function addLink(db: MockDB, taskId: string, repo: RepositoryRec, item: NewItem, linkedBy: string | null = null): DevLinkRec {
  const id = uid("lnk");
  const full = { ...item, id, repository: { id: repo.id, fullPath: repo.fullPath }, repoFullPath: repo.fullPath } as DevItem;
  const rec: DevLinkRec = {
    id,
    taskId,
    workspaceId: repo.workspaceId,
    baseUrl: repo.baseUrl,
    repoExternalId: repo.externalId,
    externalId: externalIdOf(repo, full),
    repositoryId: repo.id,
    suppressed: false,
    linkedBy,
    item: full,
  };
  db.devLinks!.push(rec);
  return rec;
}

/* ───────── views ───────── */

/** Lazy completion of sync / backfill runs (the runner's work, observed on read). */
function settle(db: MockDB, integ: IntegrationRec, now = Date.now()) {
  if (integ.syncUntil && now >= new Date(integ.syncUntil).getTime()) {
    integ.lastSyncedAt = integ.syncUntil;
    integ.syncUntil = null;
  }
  for (const r of db.repositories!) {
    if (r.integrationId !== integ.id || !r.syncUntil) continue;
    if (now >= new Date(r.syncUntil).getTime()) {
      r.lastSyncedAt = r.syncUntil;
      r.syncUntil = null;
      r.syncState = "idle";
    } else if (r.syncState === "queued" && now >= new Date(r.syncUntil).getTime() - fakeTiming.backfillMs / 2) {
      r.syncState = "syncing";
    }
  }
}

const canCreateBranchFor = (integ: IntegrationRec, r: RepositoryRec) => !r.archived && (integ.provider === "gitlab" || mockProviderConfig.githubBranchCreation);

function toRepository(integ: IntegrationRec, r: RepositoryRec): Repository {
  const { workspaceId: _w, baseUrl: _b, syncUntil: _s, archived: _a, syncState, ...rest } = r;
  return { ...rest, provider: integ.provider, syncState: integ.status === "error" ? "paused" : syncState, canCreateBranch: canCreateBranchFor(integ, r), projectIds: [...r.projectIds] };
}

function isManager(db: MockDB, userId: string, workspaceId: string) {
  return wsPermissions(db, userId, workspaceId).includes("integration.manage");
}

export function toIntegration(db: MockDB, integ: IntegrationRec, userId: string): Integration {
  settle(db, integ);
  const manager = isManager(db, userId, integ.workspaceId);
  const viewable = new Set(db.projects.filter((p) => p.workspaceId === integ.workspaceId && projectPermissions(db, userId, p.id).includes("project.view")).map((p) => p.id));
  const repos = db
    .repositories!.filter((r) => r.integrationId === integ.id)
    .filter((r) => manager || r.allProjects || r.projectIds.some((p) => viewable.has(p)))
    .sort((a, b) => a.fullPath.localeCompare(b.fullPath))
    .map((r) => toRepository(integ, r));
  const { workspaceId: _w, accountExternalId: _a, syncRequestedAt, syncUntil, status, manageUrl, ...rest } = integ;
  const next = syncRequestedAt ? new Date(new Date(syncRequestedAt).getTime() + SYNC_EVERY_MS) : null;
  return {
    ...rest,
    account: { ...integ.account },
    status: status === "error" ? "error" : "active",
    error: integ.error ? { ...integ.error } : null,
    syncing: Boolean(syncUntil) || repos.some((r) => r.syncState === "queued" || r.syncState === "syncing"),
    nextSyncAt: next && next.getTime() > Date.now() ? next.toISOString() : null,
    manageUrl: manager ? manageUrl : null,
    repositories: repos,
  };
}

const SYNC_EVERY_MS = 2 * 60_000;

function providersInfo(): ProviderInfo[] {
  return [
    { provider: "github", name: "GitHub", available: mockProviderConfig.github, methods: ["app"], oauthBaseUrl: null, canCreateBranch: mockProviderConfig.githubBranchCreation },
    {
      provider: "gitlab",
      name: "GitLab",
      available: true,
      methods: mockProviderConfig.gitlabOauth ? ["oauth", "token"] : ["token"],
      oauthBaseUrl: mockProviderConfig.gitlabOauth ? GL_BASE : null,
      canCreateBranch: true,
    },
  ];
}

const listed = (db: MockDB, workspaceId: string) =>
  db
    .integrations!.filter((i) => i.workspaceId === workspaceId && i.status !== "pending")
    .sort((a, b) => (a.provider === b.provider ? a.connectedAt.localeCompare(b.connectedAt) : a.provider === "github" ? -1 : 1));

/* ───────── shared helpers ───────── */

function loadIntegration(ctx: Ctx, id: string, manage: boolean) {
  const userId = requireUser(ctx);
  ensureExt37(ctx.db);
  const integ = ctx.db.integrations!.find((i) => i.id === id && i.status !== "pending");
  if (!integ || !wsMembership(ctx.db, userId, integ.workspaceId)) fail(404, "not_found", "Integration not found.");
  if (manage) requireWs(ctx, integ.workspaceId, "integration.manage");
  return integ;
}

function wsMember(db: MockDB, workspaceId: string, userId: string) {
  return Boolean(wsMembership(db, userId, workspaceId));
}

export function publishIntegration(db: MockDB, actorId: string | null, integ: Pick<IntegrationRec, "id" | "workspaceId">, op: "connected" | "updated" | "synced" | "error" | "disconnected") {
  mockBus.publish("integration.changed", { workspaceId: integ.workspaceId, projectId: null, actorId, data: { integrationId: integ.id, op } });
}

function publishDev(db: MockDB, actorId: string | null, t: TaskRec) {
  // The task's version doesn't move for link changes (§5.7): version null, always refetch.
  publishTask(db, actorId, { ...t, version: null as unknown as number }, "updated", ["development"]);
}

type AuditInput = {
  workspaceId: string;
  actorId: string;
  actorKind?: "user" | "integration";
  actorName?: string | null;
  action: string;
  target: string;
  entityKey?: string | null;
  source?: "web" | "webhook";
  changes?: AuditChange[];
};
function auditRow(db: MockDB, a: AuditInput) {
  db.audit.unshift({
    id: uid("au"),
    workspaceId: a.workspaceId,
    actorId: a.actorId,
    actorKind: a.actorKind ?? "user",
    actorName: a.actorName ?? null,
    action: a.action,
    target: a.target,
    createdAt: nowISO(),
    entityType: a.action.split(".")[0],
    entityKey: a.entityKey ?? null,
    source: a.source ?? "web",
    requestId: null,
    changes: a.changes,
  });
}
const change = (field: string, before: string | null, after: string | null): AuditChange => ({ field, kind: "text", before, after });
const integTarget = (i: IntegrationRec) => `${PROVIDER_NAME[i.provider]} · ${i.account.login}`;

function activity(db: MockDB, e: Omit<ActivityEntry, "id" | "createdAt">) {
  db.activity.unshift({ ...e, id: uid("act"), createdAt: nowISO() });
  if (db.activity.length > 500) db.activity.length = 500;
}

/* ───────── connect (G2, G3, G6, G12) ───────── */

const ATTEMPT_MS = 10 * 60_000;

function startAttempt(db: MockDB, slug: string, workspaceId: string, userId: string, provider: Provider, mode: "connect" | "reconnect", integrationId: string | null) {
  const a: ConnectAttemptRec = {
    id: uid("ca"),
    workspaceId,
    userId,
    provider,
    mode,
    integrationId,
    status: "started",
    confirmToken: null,
    expiresAt: new Date(Date.now() + ATTEMPT_MS).toISOString(),
  };
  db.connectAttempts!.push(a);
  return { authorizeUrl: `/${slug}/settings/integrations#mock-authorize=${provider}.${a.id}` };
}

/** The fake provider's consent page result (backend: fake authorize → G4/G5 callback → 302 with the fragment). */
export function fakeAuthorize(attemptId: string, opts: { deny?: boolean } = {}): string {
  const db = getDB();
  ensureExt37(db);
  const a = db.connectAttempts!.find((x) => x.id === attemptId);
  if (!a || a.status !== "started" || Date.now() > new Date(a.expiresAt).getTime()) return "#connect_error=state_invalid";
  if (opts.deny) {
    a.status = "failed";
    persist();
    return `#connect_error=${a.provider}_cancelled`;
  }
  let integ: IntegrationRec | undefined;
  if (a.mode === "reconnect") {
    integ = db.integrations!.find((i) => i.id === a.integrationId);
    if (!integ) {
      a.status = "failed";
      return "#connect_error=state_invalid";
    }
  } else if (a.provider === "github") {
    const mine = db.integrations!.filter((i) => i.workspaceId === a.workspaceId && i.provider === "github" && i.status !== "pending");
    const account = GH_ACCOUNTS.find((x) => !mine.some((i) => i.accountExternalId === x.ext)) ?? GH_ACCOUNTS[0]!;
    const elsewhere = db.integrations!.find((i) => i.provider === "github" && i.accountExternalId === account.ext && i.workspaceId !== a.workspaceId && i.status !== "pending");
    if (elsewhere) {
      a.status = "failed";
      persist();
      return "#connect_error=installation_in_use";
    }
    integ = mine.find((i) => i.accountExternalId === account.ext);
    integ ??= newIntegration(db, a, "github_app", GH_BASE, account.login, account.kind, account.ext);
  } else {
    const ext = "gl_user_1077";
    integ = db.integrations!.find((i) => i.workspaceId === a.workspaceId && i.provider === "gitlab" && i.baseUrl === GL_BASE && i.accountExternalId === ext);
    integ ??= newIntegration(db, a, "gitlab_oauth", GL_BASE, "akim", "user", ext);
  }
  a.integrationId = integ.id;
  a.status = "called_back";
  a.confirmToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  a.expiresAt = new Date(Date.now() + ATTEMPT_MS).toISOString();
  persist();
  return `#connect=${a.id}.${a.confirmToken}`;
}

function newIntegration(db: MockDB, a: Pick<ConnectAttemptRec, "workspaceId" | "userId">, authKind: IntegrationRec["authKind"], baseUrl: string, login: string, kind: IntegrationRec["account"]["kind"], ext: string, status: IntegrationRec["status"] = "pending"): IntegrationRec {
  const provider: Provider = authKind === "github_app" ? "github" : "gitlab";
  const rec: IntegrationRec = {
    id: uid(provider === "github" ? "int_gh" : "int_gl"),
    workspaceId: a.workspaceId,
    provider,
    authKind,
    baseUrl,
    account: { login, kind, url: `${baseUrl}/${login}` },
    accountExternalId: ext,
    status,
    error: null,
    connectedBy: a.userId,
    connectedAt: nowISO(),
    lastSyncedAt: null,
    tokenExpiresAt: authKind === "gitlab_token" ? new Date(Date.now() + 90 * 86_400_000).toISOString() : null,
    manageUrl:
      provider === "github"
        ? kind === "organization"
          ? `${GH_BASE}/organizations/${login}/settings/installations/${ext}`
          : `${GH_BASE}/settings/installations/${ext}`
        : authKind === "gitlab_oauth"
          ? `${baseUrl}/-/user_settings/applications`
          : null,
    syncRequestedAt: null,
    syncUntil: null,
  };
  db.integrations!.push(rec);
  return rec;
}

/** GitLab token checks (§5.3 G3): field errors with the contract's copy. */
function checkGitLabToken(rawBase: string | undefined, token: string | undefined, needBase = true): { baseUrl: string; ext: string } {
  let baseUrl = GL_BASE;
  if (needBase) {
    const raw = (rawBase ?? "").trim();
    let u: URL | null = null;
    try {
      u = new URL(raw);
    } catch {
      u = null;
    }
    if (!u || u.protocol !== "https:" || u.username || u.password) invalid({ baseUrl: "Use an https:// address." });
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host.endsWith(".internal") || host === "[::1]") {
      invalid({ baseUrl: "This address isn’t allowed." });
    }
    if (host.includes("unreachable")) invalid({ baseUrl: "Couldn’t reach GitLab at this address." });
    baseUrl = u.origin;
  }
  const t = (token ?? "").trim();
  if (t === "fake-noscope") invalid({ token: "The token needs the api scope." });
  if (t === "fake-expired") invalid({ token: "This token has expired." });
  if (t !== "fake-token" && t !== "fake-other") invalid({ token: "GitLab didn’t accept this token." });
  return { baseUrl, ext: `${t === "fake-other" ? "bot_other" : "bot_lightex"}@${new URL(baseUrl).host}` };
}

/* ───────── available repositories ───────── */

function availableFor(db: MockDB, integ: IntegrationRec, q: string): AvailableRepository[] {
  const mine = db.repositories!.filter((r) => r.integrationId === integ.id);
  const others = db.repositories!.filter((r) => r.workspaceId === integ.workspaceId && r.integrationId !== integ.id && r.baseUrl === integ.baseUrl);
  const needle = q.trim().toLowerCase();
  return fakeRepos(integ.provider)
    .map((f) => ({
      externalId: f.id,
      fullPath: `${f.owner}/${f.name}`,
      owner: f.owner,
      name: f.name,
      visibility: f.vis,
      updatedAt: minsAgo(f.updMin),
      tracked: mine.some((r) => r.externalId === f.id),
      trackedElsewhere: others.some((r) => r.externalId === f.id),
    }))
    .filter((r) => !needle || r.fullPath.toLowerCase().includes(needle))
    .sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name));
}

/* ───────── task development (D1–D4) ───────── */

function taskOf(ctx: Ctx, idOrKey: string) {
  const userId = requireUser(ctx);
  ensureExt37(ctx.db);
  const key = idOrKey.toUpperCase();
  const t = ctx.db.tasks.find((x) => (x.id === idOrKey || x.key === key) && !x.deletedAt && wsMember(ctx.db, ctx.db.projects.find((p) => p.id === x.projectId)?.workspaceId ?? "", userId));
  if (!t) fail(404, "not_found", "Task not found.");
  const project = ctx.db.projects.find((p) => p.id === t.projectId)!;
  if (!projectPermissions(ctx.db, userId, project.id).length) fail(403, "project_membership_required", "You’re not a member of this project.");
  requireProject(ctx, project.id, "project.view");
  return { t, project, userId };
}

function requireLink(ctx: Ctx, project: ProjectRec) {
  requireProject(ctx, project.id, "development.link");
  if (project.status === "archived") fail(403, "forbidden", "This project is archived. Development links are read-only.", { permission: "development.link" });
}

export function taskDevelopment(db: MockDB, t: TaskRec): TaskDevelopment {
  const links = visibleLinks(db, t.id).map((l) => linkItem(db, l));
  const repos = activeReposFor(db, t.projectId);
  const ws = db.projects.find((p) => p.id === t.projectId)!.workspaceId;
  const syncs = db.integrations!.filter((i) => i.workspaceId === ws && i.status === "active" && i.lastSyncedAt).map((i) => i.lastSyncedAt!);
  const prs = orderPrs(links.filter((i): i is DevPullRequest => i.kind === "pull_request")).slice(0, 50);
  const branches = links
    .filter((i): i is DevBranch => i.kind === "branch" && i.state === "active")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 50);
  const commits = links.filter((i): i is DevCommit => i.kind === "commit").sort((a, b) => b.committedAt.localeCompare(a.committedAt));
  return {
    taskId: t.id,
    taskKey: t.key,
    enabled: repos.length > 0,
    suggestedBranch: suggestBranch(t.key, t.title),
    repositories: repos.map((r) => {
      const integ = db.integrations!.find((i) => i.id === r.integrationId)!;
      return { id: r.id, provider: integ.provider, fullPath: r.fullPath, name: r.name, defaultBranch: r.defaultBranch, canCreateBranch: canCreateBranchFor(integ, r) };
    }),
    pullRequests: prs,
    branches,
    commits: commits.slice(0, 20),
    commitTotal: commits.length,
    syncedAt: syncs.sort().pop() ?? null,
  };
}

type ParsedUrl = { baseUrl: string; fullPath: string; kind: "pull_request" | "commit" | "branch"; ref: string };

/** D2 URL forms (§5.6); a trailing slash, /files, /commits, /diffs or #… is ignored. */
export function parseDevUrl(raw: string, gitlabBases: string[]): ParsedUrl | null {
  let s = raw.trim().replace(/#.*$/, "").replace(/\/+$/, "");
  s = s.replace(/\/(files|commits|diffs)$/, "");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const path = decodeURIComponent(u.pathname).replace(/^\/+/, "");
  if (u.origin === GH_BASE) {
    const m = /^([^/]+)\/([^/]+)\/(pull|commit|tree)\/(.+)$/.exec(path);
    if (!m) return null;
    const kind = m[3] === "pull" ? "pull_request" : m[3] === "commit" ? "commit" : "branch";
    if (kind === "pull_request" && !/^\d+$/.test(m[4]!)) return null;
    if (kind === "commit" && !/^[0-9a-f]{7,40}$/i.test(m[4]!)) return null;
    return { baseUrl: GH_BASE, fullPath: `${m[1]}/${m[2]}`, kind, ref: m[4]! };
  }
  if (gitlabBases.includes(u.origin)) {
    const m = /^(.+?)\/-\/(merge_requests|commit|tree)\/(.+)$/.exec(path);
    if (!m) return null;
    const kind = m[2] === "merge_requests" ? "pull_request" : m[2] === "commit" ? "commit" : "branch";
    if (kind === "pull_request" && !/^\d+$/.test(m[3]!)) return null;
    if (kind === "commit" && !/^[0-9a-f]{7,40}$/i.test(m[3]!)) return null;
    return { baseUrl: u.origin, fullPath: m[1]!, kind, ref: m[3]! };
  }
  return null;
}

/* ───────── automations (§7.10) ───────── */

export function rulesOf(db: MockDB, projectId: string): DevAutomationRule[] {
  return (["branch_created", "pr_opened", "pr_merged"] as DevTrigger[]).map((trigger) => {
    const r = db.devRules!.find((x) => x.projectId === projectId && x.trigger === trigger);
    return { trigger, enabled: r?.enabled ?? false, statusId: r?.statusId ?? null };
  });
}

const statusName = (db: MockDB, id: string) => db.statuses.find((s) => s.id === id)?.name ?? "";

/**
 * Applies a project's rule for `trigger` to one task, as the integration (system actor): forward-only
 * guards, the normal status side effects, a `version` bump, activity + audit with actorKind
 * "integration", the v1 status notification with `via`, and task.changed. Returns whether it moved.
 */
export function applyAutomation(db: MockDB, integ: Pick<IntegrationRec, "id" | "provider" | "workspaceId">, trigger: DevTrigger, t: TaskRec, ref: string | null = null): boolean {
  const project = db.projects.find((p) => p.id === t.projectId);
  if (!project || project.status === "archived" || t.deletedAt) return false;
  const rule = rulesOf(db, project.id).find((r) => r.trigger === trigger);
  if (!rule?.enabled || !rule.statusId) return false;
  const statuses = statusesOf(db, project.id);
  const cat = statuses.find((s) => s.id === t.statusId)?.category;
  if (trigger === "pr_merged") {
    if (cat === "done") return false;
    const openPrs = visibleLinks(db, t.id).filter((l) => l.item.kind === "pull_request" && (l.item.state === "open" || l.item.state === "draft"));
    if (openPrs.length) return false;
  } else if (cat !== "todo") return false;
  if (t.statusId === rule.statusId || !statuses.some((s) => s.id === rule.statusId)) return false;
  const name = PROVIDER_NAME[integ.provider];
  const from = t.statusId;
  applyStatusSideEffects(db, t, rule.statusId);
  t.statusId = rule.statusId;
  t.position = lastPosition(db, t.projectId, rule.statusId);
  t.version += 1;
  t.updatedAt = nowISO();
  activity(db, { actorId: null, actorName: name, actorKind: "integration", verb: "status_changed", projectId: t.projectId, taskId: t.id, taskKey: t.key, taskTitle: t.title, data: { from: statusName(db, from), to: statusName(db, t.statusId), rule: trigger, ref } });
  auditRow(db, {
    workspaceId: project.workspaceId,
    actorId: integ.id,
    actorKind: "integration",
    actorName: name,
    action: "task.status_changed",
    target: t.title,
    entityKey: t.key,
    source: "webhook",
    changes: [{ field: "Status", kind: "text", before: statusName(db, from), after: statusName(db, t.statusId) }],
  });
  const payload = { fromStatus: statusName(db, from), toStatus: statusName(db, t.statusId), via: integ.provider };
  for (const r of new Set([t.assigneeId, t.reporterId].filter((x): x is string => Boolean(x)))) notify(db, r, "status", null, t, t.projectId, payload);
  publishTask(db, null, t, "updated", ["statusId"]);
  return true;
}

/* ───────── routes ───────── */

export function registerIntegrations() {
  /* G1 */
  route("GET", "/workspaces/:slug/integrations", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    ensureExt37(ctx.db);
    return { providers: providersInfo(), integrations: listed(ctx.db, ws.id).map((i) => toIntegration(ctx.db, i, ctx.userId!)) };
  });

  /* G2 */
  route("POST", "/workspaces/:slug/integrations/github/connect", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    ensureExt37(ctx.db);
    requireWs(ctx, ws.id, "integration.manage");
    if (!mockProviderConfig.github) fail(503, "integrations_unavailable", "GitHub isn’t set up on this server.");
    return startAttempt(ctx.db, ws.slug, ws.id, ctx.userId!, "github", "connect", null);
  });

  /* G3 */
  route("POST", "/workspaces/:slug/integrations/gitlab/connect", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    ensureExt37(ctx.db);
    requireWs(ctx, ws.id, "integration.manage");
    const method = str(ctx.body, "method");
    if (method === "oauth") {
      if (!mockProviderConfig.gitlabOauth) fail(503, "integrations_unavailable", "GitLab.com sign-in isn’t set up on this server. Use an access token.");
      return startAttempt(ctx.db, ws.slug, ws.id, ctx.userId!, "gitlab", "connect", null);
    }
    if (method !== "token") invalid({ method: "Choose GitLab.com or an access token." });
    const { baseUrl, ext } = checkGitLabToken(str(ctx.body, "baseUrl"), str(ctx.body, "token"));
    const dup = ctx.db.integrations!.find((i) => i.workspaceId === ws.id && i.provider === "gitlab" && i.baseUrl === baseUrl && i.accountExternalId === ext && i.status !== "pending");
    if (dup) fail(409, "integration_exists", "This GitLab account is already connected. Reconnect it instead.", { integrationId: dup.id });
    const rec = newIntegration(ctx.db, { workspaceId: ws.id, userId: ctx.userId! }, "gitlab_token", baseUrl, ext.startsWith("bot_other") ? "other-bot" : "lightex-bot", "bot", ext, "active");
    auditRow(ctx.db, { workspaceId: ws.id, actorId: ctx.userId!, action: "integration.connected", target: integTarget(rec), changes: [change("Auth", null, "gitlab_token")] });
    publishIntegration(ctx.db, ctx.userId, rec, "connected");
    return toIntegration(ctx.db, rec, ctx.userId!);
  });

  /* G6 */
  route("POST", "/workspaces/:slug/integrations/confirm", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    ensureExt37(ctx.db);
    const userId = ctx.userId!;
    const a = ctx.db.connectAttempts!.find((x) => x.id === str(ctx.body, "attempt"));
    const ok =
      a &&
      a.workspaceId === ws.id &&
      a.userId === userId &&
      a.confirmToken !== null &&
      a.confirmToken === str(ctx.body, "token") &&
      a.status === "called_back" &&
      Date.now() <= new Date(a.expiresAt).getTime() &&
      isManager(ctx.db, userId, ws.id);
    const integ = ok ? ctx.db.integrations!.find((i) => i.id === a.integrationId) : undefined;
    if (!ok || !integ) fail(404, "not_found", "That connection link expired. Try again.");
    const reconnect = a.mode === "reconnect" || integ.status === "active";
    a.status = "confirmed";
    a.confirmToken = null;
    integ.status = "active";
    integ.error = null;
    if (reconnect) {
      // Catch-up after a reconnect (§7.6).
      integ.syncUntil = new Date(Date.now() + fakeTiming.syncMs).toISOString();
      scheduleSettle(integ);
    } else {
      integ.connectedAt = nowISO();
      integ.connectedBy = userId;
    }
    auditRow(ctx.db, { workspaceId: ws.id, actorId: userId, action: a.mode === "reconnect" ? "integration.reconnected" : "integration.connected", target: integTarget(integ), changes: [change("Auth", null, integ.authKind)] });
    publishIntegration(ctx.db, userId, integ, a.mode === "reconnect" ? "updated" : "connected");
    return toIntegration(ctx.db, integ, userId);
  });

  /* G7 */
  route("GET", "/integrations/:id", (ctx) => toIntegration(ctx.db, loadIntegration(ctx, ctx.params.id!, false), ctx.userId!));

  /* G8 */
  route("GET", "/integrations/:id/available-repositories", async (ctx) => {
    const integ = loadIntegration(ctx, ctx.params.id!, true);
    if (integ.status === "error") fail(409, "integration_error", "Reconnect this integration first.", { code: integ.error?.code });
    const list = availableFor(ctx.db, integ, typeof ctx.query.q === "string" ? ctx.query.q : "");
    if (fakeTiming.listMs) await new Promise((r) => setTimeout(r, fakeTiming.listMs));
    return list;
  });

  /* G9 */
  route("PUT", "/integrations/:id/repositories", (ctx) => {
    const db = ctx.db;
    const integ = loadIntegration(ctx, ctx.params.id!, true);
    if (integ.status === "error") fail(409, "integration_error", "Reconnect this integration first.", { code: integ.error?.code });
    const raw = (ctx.body as { repositories?: unknown } | null)?.repositories;
    if (!Array.isArray(raw)) invalid({ repositories: "Choose at least one repository." });
    if (raw.length === 0) invalid({ repositories: "Choose at least one repository." });
    if (raw.length > 200) invalid({ repositories: "Up to 200 repositories." });
    const visible = availableFor(db, integ, "");
    const wsProjects = new Set(db.projects.filter((p) => p.workspaceId === integ.workspaceId).map((p) => p.id));
    const wanted = raw.map((item, i) => {
      const ext = typeof (item as { externalId?: unknown })?.externalId === "string" ? (item as { externalId: string }).externalId : "";
      const av = visible.find((v) => v.externalId === ext);
      if (!av) invalid({ [`repositories.${i}.externalId`]: "This repository isn’t available to this connection." });
      if (av.trackedElsewhere) invalid({ [`repositories.${i}.externalId`]: "Already connected through another account." });
      const pids = (item as { projectIds?: unknown }).projectIds;
      if (pids !== undefined && (!Array.isArray(pids) || pids.some((p) => typeof p !== "string" || !wsProjects.has(p)))) {
        invalid({ [`repositories.${i}.projectIds`]: "Choose projects of this workspace." });
      }
      return { av, projectIds: [...new Set((pids as string[] | undefined) ?? [])] };
    });
    const current = db.repositories!.filter((r) => r.integrationId === integ.id);
    const added: string[] = [];
    const removed: string[] = [];
    const until = new Date(Date.now() + fakeTiming.backfillMs).toISOString();
    for (const w of wanted) {
      const existing = current.find((r) => r.externalId === w.av.externalId);
      if (existing) {
        if ((w.projectIds.length > 0) !== !existing.allProjects || w.projectIds.join() !== existing.projectIds.join()) {
          existing.allProjects = w.projectIds.length === 0;
          existing.projectIds = w.projectIds;
        }
        continue;
      }
      const f = fakeRepos(integ.provider).find((x) => x.id === w.av.externalId)!;
      const r = makeRepo(integ, f, null);
      r.allProjects = w.projectIds.length === 0;
      r.projectIds = w.projectIds;
      r.syncState = "queued";
      r.syncUntil = until;
      db.repositories!.push(r);
      added.push(r.fullPath);
      // Re-attach orphaned links of a repository tracked again (same base URL + external id).
      for (const l of db.devLinks!) if (!l.repositoryId && l.baseUrl === r.baseUrl && l.repoExternalId === r.externalId && l.workspaceId === r.workspaceId) l.repositoryId = r.id;
    }
    for (const r of current) {
      if (wanted.some((w) => w.av.externalId === r.externalId)) continue;
      for (const l of db.devLinks!) if (l.repositoryId === r.id) l.repositoryId = null;
      db.repositories = db.repositories!.filter((x) => x.id !== r.id);
      removed.push(r.fullPath);
    }
    if (added.length) scheduleSettle(integ, fakeTiming.backfillMs);
    auditRow(db, { workspaceId: integ.workspaceId, actorId: ctx.userId!, action: "integration.repositories_updated", target: integTarget(integ), changes: [change("Added", null, added.join(", ") || null), change("Removed", removed.join(", ") || null, null)] });
    publishIntegration(db, ctx.userId, integ, "updated");
    for (const p of db.projects.filter((x) => x.workspaceId === integ.workspaceId)) publishProject(db, ctx.userId, p.id, ["development"]);
    return toIntegration(db, integ, ctx.userId!);
  });

  /* G10 */
  route("PATCH", "/repositories/:id", (ctx) => {
    const userId = requireUser(ctx);
    ensureExt37(ctx.db);
    const r = ctx.db.repositories!.find((x) => x.id === ctx.params.id);
    if (!r || !wsMembership(ctx.db, userId, r.workspaceId)) fail(404, "not_found", "Repository not found.");
    const integ = loadIntegration(ctx, r.integrationId, true);
    const pids = (ctx.body as { projectIds?: unknown } | null)?.projectIds;
    const wsProjects = new Set(ctx.db.projects.filter((p) => p.workspaceId === r.workspaceId).map((p) => p.id));
    if (!Array.isArray(pids) || pids.some((p) => typeof p !== "string" || !wsProjects.has(p))) invalid({ projectIds: "Choose projects of this workspace." });
    const before = r.allProjects ? "All projects" : r.projectIds.map((id) => ctx.db.projects.find((p) => p.id === id)?.key).join(", ");
    r.projectIds = [...new Set(pids as string[])];
    r.allProjects = r.projectIds.length === 0;
    const after = r.allProjects ? "All projects" : r.projectIds.map((id) => ctx.db.projects.find((p) => p.id === id)?.key).join(", ");
    auditRow(ctx.db, { workspaceId: r.workspaceId, actorId: userId, action: "integration.repository_scoped", target: r.fullPath, changes: [change("Projects", before, after)] });
    publishIntegration(ctx.db, userId, integ, "updated");
    for (const p of ctx.db.projects.filter((x) => x.workspaceId === r.workspaceId)) publishProject(ctx.db, userId, p.id, ["development"]);
    return toRepository(integ, r);
  });

  /* G11 */
  route("POST", "/integrations/:id/sync", (ctx) => {
    const integ = loadIntegration(ctx, ctx.params.id!, true);
    if (integ.status === "error") fail(409, "integration_error", "Reconnect this integration first.", { code: integ.error?.code });
    const now = Date.now();
    if (integ.syncRequestedAt && now - new Date(integ.syncRequestedAt).getTime() < SYNC_EVERY_MS) {
      const next = new Date(new Date(integ.syncRequestedAt).getTime() + SYNC_EVERY_MS);
      fail(429, "sync_throttled", "You can sync again in a couple of minutes.", { nextSyncAt: next.toISOString(), retryAfter: Math.ceil((next.getTime() - now) / 1000) });
    }
    integ.syncRequestedAt = new Date(now).toISOString();
    integ.syncUntil = new Date(now + fakeTiming.syncMs).toISOString();
    for (const r of ctx.db.repositories!) if (r.integrationId === integ.id) {
      r.syncState = "syncing";
      r.syncUntil = integ.syncUntil;
    }
    scheduleSettle(integ);
    auditRow(ctx.db, { workspaceId: integ.workspaceId, actorId: ctx.userId!, action: "integration.sync_requested", target: integTarget(integ) });
    publishIntegration(ctx.db, ctx.userId, integ, "updated");
    return toIntegration(ctx.db, integ, ctx.userId!);
  });

  /* G12 */
  route("POST", "/integrations/:id/reconnect", (ctx) => {
    const integ = loadIntegration(ctx, ctx.params.id!, true);
    const ws = ctx.db.workspaces.find((w) => w.id === integ.workspaceId)!;
    if (integ.authKind === "gitlab_token") {
      const { ext } = checkGitLabToken(undefined, str(ctx.body, "token"), false);
      const same = ext.split("@")[0] === integ.accountExternalId.split("@")[0];
      if (!same) invalid({ token: "This token belongs to a different GitLab user." });
      integ.status = "active";
      integ.error = null;
      integ.tokenExpiresAt = new Date(Date.now() + 90 * 86_400_000).toISOString();
      integ.syncUntil = new Date(Date.now() + fakeTiming.syncMs).toISOString();
      scheduleSettle(integ);
      auditRow(ctx.db, { workspaceId: integ.workspaceId, actorId: ctx.userId!, action: "integration.reconnected", target: integTarget(integ) });
      publishIntegration(ctx.db, ctx.userId, integ, "updated");
      return toIntegration(ctx.db, integ, ctx.userId!);
    }
    return startAttempt(ctx.db, ws.slug, ws.id, ctx.userId!, integ.provider, "reconnect", integ.id);
  });

  /* G13 */
  route("DELETE", "/integrations/:id", (ctx) => {
    const db = ctx.db;
    const integ = loadIntegration(ctx, ctx.params.id!, true);
    const repos = db.repositories!.filter((r) => r.integrationId === integ.id);
    const ids = new Set(repos.map((r) => r.id));
    for (const l of db.devLinks!) if (l.repositoryId && ids.has(l.repositoryId)) l.repositoryId = null;
    db.repositories = db.repositories!.filter((r) => !ids.has(r.id));
    db.integrations = db.integrations!.filter((i) => i.id !== integ.id);
    db.connectAttempts = db.connectAttempts!.filter((a) => a.integrationId !== integ.id);
    auditRow(db, { workspaceId: integ.workspaceId, actorId: ctx.userId!, action: "integration.disconnected", target: integTarget(integ), changes: [change("Repositories", String(repos.length), null)] });
    publishIntegration(db, ctx.userId, integ, "disconnected");
    for (const p of db.projects.filter((x) => x.workspaceId === integ.workspaceId)) publishProject(db, ctx.userId, p.id, ["development"]);
    return undefined;
  });

  /* D1 */
  route("GET", "/tasks/:id/development", (ctx) => {
    const { t } = taskOf(ctx, ctx.params.id!);
    return taskDevelopment(ctx.db, t);
  });

  /* D2 */
  route("POST", "/tasks/:id/development/links", (ctx) => {
    const db = ctx.db;
    const { t, project, userId } = taskOf(ctx, ctx.params.id!);
    requireLink(ctx, project);
    const raw = str(ctx.body, "url") ?? "";
    const glBases = [...new Set(db.integrations!.filter((i) => i.workspaceId === project.workspaceId && i.provider === "gitlab").map((i) => i.baseUrl).concat(GL_BASE))];
    const parsed = parseDevUrl(raw, glBases);
    if (!parsed) invalid({ url: "Paste a link to a pull request, merge request, commit or branch." });
    const integs = db.integrations!.filter((i) => i.workspaceId === project.workspaceId && i.status !== "pending" && i.baseUrl === parsed.baseUrl);
    const repo = db.repositories!.find((r) => integs.some((i) => i.id === r.integrationId) && r.fullPath.toLowerCase() === parsed.fullPath.toLowerCase());
    if (!repo) invalid({ url: "Connect this repository first." });
    if (!repoApplies(repo, project.id)) invalid({ url: `This repository isn’t used by ${project.key}.` });
    const integ = integs.find((i) => i.id === repo.integrationId)!;
    const name = PROVIDER_NAME[integ.provider];
    let item: NewItem;
    if (parsed.kind === "pull_request") {
      const n = Number(parsed.ref);
      if (n >= 10_000) invalid({ url: `${name} can’t find this ${integ.provider === "gitlab" ? "merge request" : "pull request"}.` });
      const known = db.devLinks!.find((l) => l.repositoryId === repo.id && l.item.kind === "pull_request" && l.item.number === n)?.item as DevPullRequest | undefined;
      item = known
        ? { ...known, linkSource: "manual" }
        : ({
            kind: "pull_request",
            provider: integ.provider,
            number: n,
            ref: integ.provider === "gitlab" ? `!${n}` : `#${n}`,
            title: `${integ.provider === "gitlab" ? "Merge request" : "Pull request"} ${integ.provider === "gitlab" ? "!" : "#"}${n}`,
            url: integ.provider === "gitlab" ? `${repo.url}/-/merge_requests/${n}` : `${repo.url}/pull/${n}`,
            state: "open",
            headBranch: `branch-${n}`,
            baseBranch: repo.defaultBranch,
            author: { login: "octocat", name: null, userId: null },
            checks: null,
            approvals: 0,
            linkSource: "manual",
            createdAt: nowISO(),
            updatedAt: nowISO(),
            mergedAt: null,
            closedAt: null,
          } as Omit<DevPullRequest, "id" | "repository" | "repoFullPath">);
    } else if (parsed.kind === "commit") {
      const sha = parsed.ref.toLowerCase().padEnd(40, "0");
      item = {
        kind: "commit",
        provider: integ.provider,
        sha,
        shortSha: sha.slice(0, 7),
        message: `Commit ${sha.slice(0, 7)}`,
        url: integ.provider === "gitlab" ? `${repo.url}/-/commit/${sha}` : `${repo.url}/commit/${sha}`,
        author: { login: "octocat", name: null, userId: null },
        committedAt: nowISO(),
        linkSource: "manual",
      } as Omit<DevCommit, "id" | "repository" | "repoFullPath">;
    } else {
      item = {
        kind: "branch",
        provider: integ.provider,
        name: parsed.ref,
        url: integ.provider === "gitlab" ? `${repo.url}/-/tree/${parsed.ref}` : `${repo.url}/tree/${parsed.ref}`,
        state: "active",
        aheadBy: 0,
        linkSource: "manual",
        updatedAt: nowISO(),
      } as Omit<DevBranch, "id" | "repository" | "repoFullPath">;
    }
    const extId = externalIdOf(repo, item as DevItem);
    const existing = db.devLinks!.find((l) => l.taskId === t.id && l.repoExternalId === repo.externalId && l.baseUrl === repo.baseUrl && l.externalId === extId);
    if (existing) {
      // Re-link lifts a suppression; an already visible link is returned as it is.
      if (existing.suppressed) {
        existing.suppressed = false;
        existing.linkedBy = userId;
        publishDev(db, userId, t);
      }
      return linkItem(db, existing);
    }
    const rec = addLink(db, t.id, repo, item, userId);
    if (item.kind !== "commit") {
      const ref = item.kind === "pull_request" ? (item as DevPullRequest).ref : (item as DevBranch).name;
      auditRow(db, { workspaceId: project.workspaceId, actorId: userId, action: "task.dev_linked", target: t.title, entityKey: t.key, changes: [change(item.kind === "pull_request" ? "Pull request" : "Branch", null, `${ref} · ${repo.fullPath}`)] });
      if (item.kind === "pull_request") activity(db, { actorId: userId, actorKind: "user", verb: "dev_linked", projectId: t.projectId, taskId: t.id, taskKey: t.key, taskTitle: t.title, data: { ref, provider: integ.provider, repo: repo.fullPath } });
    }
    publishDev(db, userId, t);
    return linkItem(db, rec);
  });

  /* D3 */
  route("DELETE", "/tasks/:id/development/links/:linkId", (ctx) => {
    const db = ctx.db;
    const { t, project, userId } = taskOf(ctx, ctx.params.id!);
    requireLink(ctx, project);
    const l = db.devLinks!.find((x) => x.id === ctx.params.linkId && x.taskId === t.id);
    if (!l) fail(404, "not_found", "Link not found.");
    if (l.item.linkSource === "manual") db.devLinks = db.devLinks!.filter((x) => x.id !== l.id);
    else l.suppressed = true;
    const ref = l.item.kind === "pull_request" ? l.item.ref : l.item.kind === "branch" ? l.item.name : l.item.shortSha;
    auditRow(db, { workspaceId: project.workspaceId, actorId: userId, action: "task.dev_unlinked", target: t.title, entityKey: t.key, changes: [change(l.item.kind === "pull_request" ? "Pull request" : l.item.kind === "branch" ? "Branch" : "Commit", `${ref} · ${l.item.repoFullPath}`, null)] });
    publishDev(db, userId, t);
    return undefined;
  });

  /* D4 */
  route("POST", "/tasks/:id/development/branches", (ctx) => {
    const db = ctx.db;
    const { t, project, userId } = taskOf(ctx, ctx.params.id!);
    requireLink(ctx, project);
    const name = (str(ctx.body, "name") ?? "").trim();
    const err = validateBranch(name);
    if (err) invalid({ name: err });
    const repo = activeReposFor(db, project.id).find((r) => r.id === str(ctx.body, "repositoryId"));
    const integ = repo ? db.integrations!.find((i) => i.id === repo.integrationId)! : undefined;
    if (!repo || !integ || !canCreateBranchFor(integ, repo)) invalid({ repositoryId: "Choose a repository where Lightex can create branches." });
    const exists = name === repo.defaultBranch || db.devLinks!.some((l) => l.repoExternalId === repo.externalId && l.baseUrl === repo.baseUrl && l.item.kind === "branch" && l.item.name === name && l.item.state === "active");
    if (exists) fail(409, "branch_exists", `That branch already exists in ${repo.fullPath}.`, { fields: { name: `That branch already exists in ${repo.fullPath}.` } });
    const rec = addLink(
      db,
      t.id,
      repo,
      {
        kind: "branch",
        provider: integ.provider,
        name,
        url: integ.provider === "gitlab" ? `${repo.url}/-/tree/${name}` : `${repo.url}/tree/${name}`,
        state: "active",
        aheadBy: 0,
        linkSource: "created",
        updatedAt: nowISO(),
      } as Omit<DevBranch, "id" | "repository" | "repoFullPath">,
      userId,
    );
    auditRow(db, { workspaceId: project.workspaceId, actorId: userId, action: "task.dev_branch_created", target: t.title, entityKey: t.key, changes: [change("Branch", null, `${name} · ${repo.fullPath}`)] });
    activity(db, { actorId: userId, actorKind: "user", verb: "dev_branch_created", projectId: t.projectId, taskId: t.id, taskKey: t.key, taskTitle: t.title, data: { branch: name, repo: repo.fullPath } });
    applyAutomation(db, integ, "branch_created", t);
    publishDev(db, userId, t);
    return linkItem(db, rec) as DevBranch;
  });

  /* A1 */
  route("GET", "/projects/:id/dev-automation", (ctx) => {
    requireUser(ctx);
    ensureExt37(ctx.db);
    const p = ctx.db.projects.find((x) => x.id === ctx.params.id);
    if (!p) fail(404, "not_found", "Project not found.");
    requireProject(ctx, p.id, "project.view");
    return rulesOf(ctx.db, p.id);
  });

  /* A2 */
  route("PUT", "/projects/:id/dev-automation", (ctx) => {
    const userId = requireUser(ctx);
    ensureExt37(ctx.db);
    const db = ctx.db;
    const p = db.projects.find((x) => x.id === ctx.params.id);
    if (!p) fail(404, "not_found", "Project not found.");
    requireProject(ctx, p.id, "status.manage");
    if (p.status === "archived") fail(403, "forbidden", "This project is archived.", { permission: "status.manage" });
    const body = ctx.body as DevAutomationRule[] | null;
    const order: DevTrigger[] = ["branch_created", "pr_opened", "pr_merged"];
    if (!Array.isArray(body) || body.length !== 3 || order.some((tr, i) => body[i]?.trigger !== tr)) invalid({ rules: "Send all three triggers, in order." });
    const statuses = statusesOf(db, p.id);
    const fields: Record<string, string> = {};
    body.forEach((r, i) => {
      if (!r.enabled) return;
      const s = statuses.find((x) => x.id === r.statusId);
      if (!s) fields[`rules.${i}.statusId`] = "Choose a status.";
      else if (r.trigger === "pr_merged" && s.category !== "done") fields[`rules.${i}.statusId`] = "Pick a Done status.";
    });
    if (Object.keys(fields).length) invalid(fields);
    const before = rulesOf(db, p.id);
    const changes: AuditChange[] = [];
    body.forEach((r, i) => {
      const prev = before[i]!;
      const describe = (x: DevAutomationRule) => (x.enabled && x.statusId ? `→ ${statusName(db, x.statusId)}` : "Off");
      if (describe(prev) !== describe(r)) changes.push(change(r.trigger, describe(prev), describe(r)));
      const rec: DevRuleRec = { projectId: p.id, trigger: r.trigger, enabled: Boolean(r.enabled), statusId: r.statusId ?? null, updatedBy: userId };
      db.devRules = db.devRules!.filter((x) => !(x.projectId === p.id && x.trigger === r.trigger)).concat(rec);
    });
    auditRow(db, { workspaceId: p.workspaceId, actorId: userId, action: "project.dev_automation_updated", target: p.name, entityKey: p.key, changes });
    publishProject(db, userId, p.id, ["development"]);
    return rulesOf(db, p.id);
  });
}

/** Sync / backfill runs finish on a timer and publish integration.changed "synced" (the runner's job). */
function scheduleSettle(integ: Pick<IntegrationRec, "id" | "workspaceId">, ms = fakeTiming.syncMs) {
  setTimeout(() => {
    const db = getDB();
    const live = db.integrations?.find((i) => i.id === integ.id);
    if (!live) return;
    settle(db, live);
    publishIntegration(db, null, live, "synced");
    persist();
  }, ms + 20);
}

/* ───────── dev-pill simulators (§9.8): provider events applied as the processor would ───────── */

function focusTask(db: MockDB, taskKey: string | null) {
  ensureExt37(db);
  const t = taskKey ? db.tasks.find((x) => x.key === taskKey.toUpperCase() && !x.deletedAt) : undefined;
  if (!t) return { ok: false as const, error: "Open a task first (?task=KEY)." };
  const repo = activeReposFor(db, t.projectId)[0];
  const integ = repo ? db.integrations!.find((i) => i.id === repo.integrationId) : undefined;
  if (!repo || !integ) return { ok: false as const, error: `No connected repository applies to ${t.key.split("-")[0]}.` };
  return { ok: true as const, t, repo, integ };
}

function done(db: MockDB, t: TaskRec) {
  publishDev(db, null, t);
  persist();
}

/** "Open PR on…": a new open PR whose title carries the key (checks running), then pr_opened. */
export function simulateOpenPr(taskKey: string | null): string {
  const db = getDB();
  const f = focusTask(db, taskKey);
  if (!f.ok) return f.error;
  const { t, repo, integ } = f;
  const n = Math.max(230, ...db.devLinks!.filter((l) => l.item.kind === "pull_request" && l.repoExternalId === repo.externalId).map((l) => (l.item as DevPullRequest).number)) + 1;
  const ref = integ.provider === "gitlab" ? `!${n}` : `#${n}`;
  addLink(db, t.id, repo, {
    kind: "pull_request",
    provider: integ.provider,
    number: n,
    ref,
    title: `${t.key} ${t.title}`,
    url: integ.provider === "gitlab" ? `${repo.url}/-/merge_requests/${n}` : `${repo.url}/pull/${n}`,
    state: "open",
    headBranch: suggestBranch(t.key, t.title),
    baseBranch: repo.defaultBranch,
    author: author("u_sam"),
    checks: checksOf([ck("unit", "running", null), ck("lint", "passing", 9)]),
    approvals: 0,
    linkSource: "auto",
    createdAt: nowISO(),
    updatedAt: nowISO(),
    mergedAt: null,
    closedAt: null,
  } as Omit<DevPullRequest, "id" | "repository" | "repoFullPath">);
  repo.openPullRequests += 1;
  const name = PROVIDER_NAME[integ.provider];
  activity(db, { actorId: null, actorName: name, actorKind: "integration", verb: "dev_linked", projectId: t.projectId, taskId: t.id, taskKey: t.key, taskTitle: t.title, data: { ref, provider: integ.provider, repo: repo.fullPath } });
  auditRow(db, { workspaceId: integ.workspaceId, actorId: integ.id, actorKind: "integration", actorName: name, action: "task.dev_linked", target: t.title, entityKey: t.key, source: "webhook", changes: [change("Pull request", null, `${ref} · ${repo.fullPath}`)] });
  applyAutomation(db, integ, "pr_opened", t, ref);
  done(db, t);
  return `${name} opened ${ref} on ${t.key}`;
}

/** "Merge PR": the newest open / draft PR merges (checks passing), then pr_merged. */
export function simulateMergePr(taskKey: string | null): string {
  const db = getDB();
  const f = focusTask(db, taskKey);
  if (!f.ok) return f.error;
  const { t } = f;
  const l = visibleLinks(db, t.id)
    .filter((x) => x.item.kind === "pull_request" && (x.item.state === "open" || x.item.state === "draft"))
    .sort((a, b) => (b.item as DevPullRequest).updatedAt.localeCompare((a.item as DevPullRequest).updatedAt))[0];
  if (!l) return `${t.key} has no open pull request`;
  const integ = db.integrations!.find((i) => i.id === db.repositories!.find((r) => r.id === l.repositoryId)?.integrationId) ?? f.integ;
  const pr = l.item as DevPullRequest;
  const now = nowISO();
  const items = (pr.checks?.items ?? []).map((c) => ({ ...c, state: "passing" as const }));
  // Fan out: every task linked to this PR gets the same state (§3.3).
  const rows = db.devLinks!.filter((x) => x.workspaceId === l.workspaceId && x.repoExternalId === l.repoExternalId && x.externalId === l.externalId);
  for (const r of rows) Object.assign(r.item, { state: "merged", mergedAt: now, updatedAt: now, checks: checksOf(items) });
  const repo = db.repositories!.find((r) => r.id === l.repositoryId);
  if (repo) repo.openPullRequests = Math.max(0, repo.openPullRequests - 1);
  const name = PROVIDER_NAME[integ.provider];
  for (const r of rows) {
    const task = db.tasks.find((x) => x.id === r.taskId);
    if (!task) continue;
    activity(db, { actorId: null, actorName: name, actorKind: "integration", verb: "dev_pr_merged", projectId: task.projectId, taskId: task.id, taskKey: task.key, taskTitle: task.title, data: { ref: pr.ref, provider: integ.provider, repo: pr.repoFullPath } });
    auditRow(db, { workspaceId: integ.workspaceId, actorId: integ.id, actorKind: "integration", actorName: name, action: "task.dev_pr_state", target: task.title, entityKey: task.key, source: "webhook", changes: [change(`PR ${pr.ref}`, pr.state, "merged")] });
    if (!r.suppressed) applyAutomation(db, integ, "pr_merged", task, pr.ref);
    if (task.id !== t.id) publishDev(db, null, task);
  }
  done(db, t);
  return `${name} merged ${pr.ref} (${t.key})`;
}

/** "Fail checks": the newest open PR's first check fails. */
export function simulateFailChecks(taskKey: string | null): string {
  const db = getDB();
  const f = focusTask(db, taskKey);
  if (!f.ok) return f.error;
  const { t } = f;
  const l = visibleLinks(db, t.id).find((x) => x.item.kind === "pull_request" && (x.item.state === "open" || x.item.state === "draft"));
  if (!l) return `${t.key} has no open pull request`;
  const pr = l.item as DevPullRequest;
  const items = pr.checks?.items.length ? pr.checks.items.map((c, i) => (i === 0 ? { ...c, state: "failing" as const, durationSec: c.durationSec ?? 75 } : c)) : [ck("unit", "failing", 75)];
  for (const r of db.devLinks!.filter((x) => x.workspaceId === l.workspaceId && x.repoExternalId === l.repoExternalId && x.externalId === l.externalId)) {
    Object.assign(r.item, { checks: checksOf(items), updatedAt: nowISO() });
  }
  done(db, t);
  return `Checks failing on ${pr.ref}`;
}

/** "Expire GitHub token": the workspace's first active GitHub connection goes into token_expired. */
export function simulateExpireToken(workspaceSlug: string | null): string {
  const db = getDB();
  ensureExt37(db);
  const ws = db.workspaces.find((w) => w.slug === workspaceSlug);
  const integ = db.integrations!.find((i) => i.workspaceId === ws?.id && i.status === "active" && i.provider === "github") ?? db.integrations!.find((i) => i.workspaceId === ws?.id && i.status === "active");
  if (!integ) return "No active connection in this workspace";
  integ.status = "error";
  integ.error = { code: "token_expired", message: ERROR_MESSAGE(integ.provider, "token_expired"), since: nowISO() };
  auditRow(db, { workspaceId: integ.workspaceId, actorId: integ.id, actorKind: "integration", actorName: PROVIDER_NAME[integ.provider], action: "integration.error", target: integTarget(integ), source: "webhook", changes: [change("Error", null, "token_expired")] });
  publishIntegration(db, null, integ, "error");
  for (const p of db.projects.filter((x) => x.workspaceId === integ.workspaceId)) publishProject(db, null, p.id, ["development"]);
  persist();
  return `${PROVIDER_NAME[integ.provider]} token expired`;
}

/** Tests: put an integration into an error state directly. */
export function setIntegrationError(db: MockDB, id: string, code: IntegrationErrorCode | null) {
  const integ = db.integrations!.find((i) => i.id === id)!;
  integ.status = code ? "error" : "active";
  integ.error = code ? { code, message: ERROR_MESSAGE(integ.provider, code), since: nowISO() } : null;
}
