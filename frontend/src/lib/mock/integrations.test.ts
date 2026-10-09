import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import type {
  AuditPage,
  AvailableRepository,
  DevAutomationRule,
  DevBranch,
  DevItem,
  Integration,
  IntegrationsOverview,
  Notification,
  Paginated,
  Project,
  Repository,
  Task,
  TaskDetail,
  TaskDevelopment,
  Workspace,
} from "@/lib/api/types";
import { mockControls } from "./controls";
import { getDB, mockSession, resetDB, setDB } from "./db";
import {
  fakeAuthorize,
  fakeTiming,
  mockProviderConfig,
  parseDevUrl,
  setIntegrationError,
  simulateExpireToken,
  simulateFailChecks,
  simulateMergePr,
  simulateOpenPr,
} from "./handlers/integrations";
import { MockRealtimeSource, mockBus, type BusEvent } from "./realtime";
import { createSeed } from "./seed";
import { MockTransport } from "./transport";

/* Board 37 mock backend (§12.2): G1–G13, D1–D4, A1–A2, the connect / confirm flow, automations, permissions. */

const t = new MockTransport();
const as = (u: string | null) => mockSession.set(u);
const req = <T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown, query?: Parameters<MockTransport["request"]>[0]["query"]) =>
  t.request<T>({ method, path, body, query });
async function rejects(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected rejection");
}

let events: BusEvent[] = [];
let unsub: () => void = () => undefined;

beforeEach(() => {
  resetDB();
  mockBus.resetForTests();
  fakeTiming.listMs = 0;
  mockProviderConfig.github = true;
  mockProviderConfig.gitlabOauth = true;
  mockProviderConfig.githubBranchCreation = true;
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "live" }));
  events = [];
  unsub = mockBus.subscribe((e) => events.push(e));
  as("u_alex");
  try {
    sessionStorage.clear();
  } catch {
    /* jsdom */
  }
});
afterEach(() => unsub());

const GH = "int_gh_platform";
const overview = () => req<IntegrationsOverview>("GET", "/workspaces/platform/integrations");
const dev = (key: string) => req<TaskDevelopment>("GET", `/tasks/${key}/development`);
const task = (key: string) => req<TaskDetail>("GET", `/workspaces/platform/tasks/${key}`);

/** Runs G2/G3 → the fake consent page → G6 like the screen does. */
async function connect(provider: "github" | "gitlab") {
  const { authorizeUrl } =
    provider === "github"
      ? await req<{ authorizeUrl: string }>("POST", "/workspaces/platform/integrations/github/connect", {})
      : await req<{ authorizeUrl: string }>("POST", "/workspaces/platform/integrations/gitlab/connect", { method: "oauth" });
  const attempt = authorizeUrl.split(`#mock-authorize=${provider}.`)[1]!;
  const frag = fakeAuthorize(attempt);
  const [a, token] = frag.replace("#connect=", "").split(".");
  return { authorizeUrl, attempt: a!, token: token!, frag };
}

describe("seed + upgrade (§9.8)", () => {
  it("seeds the GitHub connection, four repos and PRJ-41 / PRJ-29; GitLab stays connectable", async () => {
    const o = await overview();
    expect(o.providers.map((p) => [p.provider, p.available, p.methods])).toEqual([
      ["github", true, ["app"]],
      ["gitlab", true, ["oauth", "token"]],
    ]);
    expect(o.integrations).toHaveLength(1);
    const gh = o.integrations[0]!;
    expect(gh).toMatchObject({ id: GH, provider: "github", authKind: "github_app", status: "active", error: null, connectedBy: "u_alex", account: { login: "platform-team", kind: "organization" } });
    expect(gh.repositories.map((r) => r.fullPath)).toEqual(["platform-team/api", "platform-team/board-engine", "platform-team/mobile-app", "platform-team/web"]);
    expect(gh.repositories.find((r) => r.name === "web")).toMatchObject({ openPullRequests: 12, syncState: "idle", allProjects: true, canCreateBranch: true });
    expect(gh.manageUrl).toContain("/installations/");
    const keys = getDB().tasks.filter((x) => x.projectId === "p_prj").map((x) => x.key);
    expect(keys).toEqual(expect.arrayContaining(["PRJ-41", "PRJ-29"]));
  });

  it("ensureExt37 upgrades a cached database once (keys on system roles, seed) and leaves custom roles alone", () => {
    const old = createSeed();
    delete old.ext37;
    delete old.integrations;
    delete old.repositories;
    delete old.devLinks;
    delete old.devRules;
    delete old.connectAttempts;
    for (const r of old.roles) r.permissions = r.permissions.filter((p) => p !== "integration.manage" && p !== "development.link");
    old.tasks = old.tasks.filter((x) => x.key !== "PRJ-41" && x.key !== "PRJ-29");
    const custom = old.roles.find((r) => !r.isSystem)!;
    const customBefore = [...custom.permissions];
    localStorage.setItem("lightex-mock-db", JSON.stringify(old));
    setDB(null as never);
    const db = getDB();
    expect(db.ext37).toBe(true);
    const owner = db.roles.find((r) => r.key === "owner" && r.workspaceId === "ws_platform")!;
    expect(owner.permissions.slice(-2)).toEqual(["integration.manage", "audit.view"]);
    const member = db.roles.find((r) => r.key === "project_member" && r.workspaceId === "ws_platform")!;
    expect(member.permissions.indexOf("development.link")).toBe(member.permissions.indexOf("project.import") + 1);
    expect(db.roles.find((r) => r.key === "viewer" && r.workspaceId === "ws_platform")!.permissions).not.toContain("development.link");
    expect(db.roles.find((r) => r.key === "member" && r.workspaceId === "ws_platform")!.permissions).not.toContain("integration.manage");
    expect(db.roles.find((r) => r.id === custom.id)!.permissions).toEqual(customBefore);
    expect(db.integrations).toHaveLength(1);
    expect(db.tasks.filter((x) => x.key === "PRJ-41")).toHaveLength(1);
    // Twice is a no-op.
    const links = db.devLinks!.length;
    setDB(null as never);
    expect(getDB().devLinks!.length).toBe(links);
  });

  it("my_permissions follow §4.3 for Sam and the workspace order for Alex", async () => {
    as("u_sam");
    const p = await req<Project>("GET", "/workspaces/platform/projects/PRJ");
    expect(p.my_permissions).toEqual(["project.view", "task.create", "task.edit_own", "task.assign", "task.move", "project.import", "development.link", "time.log", "comment.create", "comment.edit_own", "attachment.upload", "dashboard.create", "report.view"]);
    expect(p.devEnabled).toBe(true);
    as("u_alex");
    const w = await req<Workspace>("GET", "/workspaces/platform");
    expect(w.my_permissions.slice(-2)).toEqual(["integration.manage", "audit.view"]);
  });
});

describe("Task.dev and D1 (§5.6, §5.7)", () => {
  it("PRJ-42: 4 PRs ordered open/draft, merged, closed; 2 branches; 4 commits; the failing #214 headlines", async () => {
    const d = await dev("PRJ-42");
    expect(d).toMatchObject({ taskKey: "PRJ-42", enabled: true, suggestedBranch: "prj-42-fix-flaky-board-reflow", commitTotal: 4 });
    expect(d.pullRequests.map((p) => [p.ref, p.state, p.checks?.state ?? null])).toEqual([
      ["#214", "open", "failing"],
      ["#209", "draft", "running"],
      ["#198", "merged", "passing"],
      ["#190", "closed", null],
    ]);
    expect(d.pullRequests[0]!.checks).toMatchObject({ passed: 1, total: 3 });
    expect(d.pullRequests[0]!.checks!.items.map((c) => [c.name, c.state, c.durationSec])).toEqual([
      ["e2e / board-drag", "failing", 134],
      ["unit / reflow", "failing", 48],
      ["lint", "passing", 12],
    ]);
    expect(d.branches.map((b) => [b.name, b.aheadBy])).toEqual([
      ["prj-42-fix-reflow", 3],
      ["prj-42-reflow-tests", 1],
    ]);
    expect(d.commits.map((c) => c.shortSha)).toEqual(["a3f9c21", "7be04d8", "e51c7aa", "0c2d9f3"]);
    expect(d.commits[0]!.sha).toHaveLength(40);
    expect(d.repositories.map((r) => r.name)).toEqual(["api", "board-engine", "mobile-app", "web"]);
    const t42 = await task("PRJ-42");
    expect(t42.dev).toEqual({
      pr: { provider: "github", number: 214, ref: "#214", state: "open", checks: "failing", checksPassed: 1, checksTotal: 3, approvals: 0, baseBranch: "main", mergedAt: null },
      prCount: 4,
      branchCount: 2,
      commitCount: 4,
    });
  });

  it("PRJ-41 headlines an open passing PR with a review, PRJ-29 a recent merge, PRJ-58 nothing", async () => {
    expect((await task("PRJ-41")).dev!.pr).toMatchObject({ ref: "#221", state: "open", checks: "passing", approvals: 1 });
    expect((await task("PRJ-29")).dev!.pr).toMatchObject({ ref: "#187", state: "merged", baseBranch: "main" });
    expect((await task("PRJ-58")).dev).toBeNull();
    const empty = await dev("PRJ-58");
    expect(empty).toMatchObject({ pullRequests: [], branches: [], commits: [], suggestedBranch: "prj-58-invoice-pdf-redesign" });
  });

  it("the board payload carries Task.dev", async () => {
    const board = await req<{ columns: { tasks: Task[] }[] } | Paginated<Task>>("GET", "/projects/p_prj/tasks", undefined, { limit: 200 });
    const list = "data" in board ? board.data : board.columns.flatMap((c) => c.tasks);
    expect(list.find((x) => x.key === "PRJ-42")!.dev!.pr!.ref).toBe("#214");
    expect(list.every((x) => "dev" in x)).toBe(true);
  });

  it("closed PRs never headline; merges older than 14 days drop out", async () => {
    const db = getDB();
    const l = db.devLinks!.find((x) => x.taskId === "p_prj-t29")!;
    (l.item as { mergedAt: string }).mergedAt = new Date(Date.now() - 20 * 86_400_000).toISOString();
    expect((await task("PRJ-29")).dev).toMatchObject({ pr: null, prCount: 1 });
  });

  it("D1 permissions: Viewer reads; a non-member gets 403; another workspace's member 404", async () => {
    as("u_taylor");
    expect((await dev("PRJ-42")).pullRequests).toHaveLength(4);
    as("u_casey");
    expect((await rejects(dev("PRJ-42"))).status).toBe(403);
    as("u_drew");
    expect((await rejects(dev("PRJ-42"))).status).toBe(404);
  });
});

describe("G1 visibility for non-managers (§5.2)", () => {
  it("hides manageUrl and repositories scoped to projects the caller can't view", async () => {
    const r = getDB().repositories!.find((x) => x.name === "mobile-app")!;
    await req<Repository>("PATCH", `/repositories/${r.id}`, { projectIds: ["p_inf"] });
    as("u_taylor"); // PRJ / MOB viewer, not on INF
    const o = await overview();
    expect(o.integrations[0]!.manageUrl).toBeNull();
    expect(o.integrations[0]!.repositories.map((x) => x.name)).toEqual(["api", "board-engine", "web"]);
    as("u_alex");
    expect((await overview()).integrations[0]!.repositories).toHaveLength(4);
  });

  it("a non-member of the workspace gets 404", async () => {
    as("u_drew");
    expect((await rejects(overview())).status).toBe(404);
  });
});

describe("connect / confirm (§5.3, §9.6)", () => {
  it("G2 → fake consent → G6 creates a second GitHub connection; the pending one is never listed", async () => {
    const { authorizeUrl, attempt, token, frag } = await connect("github");
    expect(authorizeUrl).toBe(`/platform/settings/integrations#mock-authorize=github.${attempt}`);
    expect(frag).toMatch(/^#connect=ca_[^.]+\.[a-z0-9]+$/);
    expect((await overview()).integrations).toHaveLength(1);
    const i = await req<Integration>("POST", "/workspaces/platform/integrations/confirm", { attempt, token });
    expect(i).toMatchObject({ provider: "github", status: "active", account: { login: "alexkim", kind: "user" }, repositories: [] });
    expect((await overview()).integrations.map((x) => x.account.login)).toEqual(["platform-team", "alexkim"]);
    expect(events.some((e) => e.type === "integration.changed" && (e.data as { op: string }).op === "connected")).toBe(true);
    expect(getDB().audit[0]).toMatchObject({ action: "integration.connected", actorId: "u_alex", source: "web" });
    // Single use.
    expect((await rejects(req("POST", "/workspaces/platform/integrations/confirm", { attempt, token }))).status).toBe(404);
  });

  it("G6 answers 404 for a wrong token, another user, a lost permission or an expired attempt", async () => {
    const a = await connect("gitlab");
    expect((await rejects(req("POST", "/workspaces/platform/integrations/confirm", { attempt: a.attempt, token: "nope" }))).status).toBe(404);
    as("u_jordan"); // also a manager, but not the attempt's user
    expect((await rejects(req("POST", "/workspaces/platform/integrations/confirm", { attempt: a.attempt, token: a.token }))).status).toBe(404);
    as("u_alex");
    getDB().connectAttempts!.find((x) => x.id === a.attempt)!.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect((await rejects(req("POST", "/workspaces/platform/integrations/confirm", { attempt: a.attempt, token: a.token }))).status).toBe(404);
    const b = await connect("gitlab");
    const owner = getDB().roles.find((r) => r.key === "owner" && r.workspaceId === "ws_platform")!;
    owner.permissions = owner.permissions.filter((p) => p !== "integration.manage");
    expect((await rejects(req("POST", "/workspaces/platform/integrations/confirm", { attempt: b.attempt, token: b.token }))).status).toBe(404);
  });

  it("Cancel on the consent page answers #connect_error=<provider>_cancelled; a stale attempt state_invalid", async () => {
    const { authorizeUrl } = await req<{ authorizeUrl: string }>("POST", "/workspaces/platform/integrations/github/connect", {});
    const attempt = authorizeUrl.split(".").pop()!;
    expect(fakeAuthorize(attempt, { deny: true })).toBe("#connect_error=github_cancelled");
    expect(fakeAuthorize(attempt)).toBe("#connect_error=state_invalid");
  });

  it("GitLab OAuth connects akim on gitlab.com", async () => {
    const a = await connect("gitlab");
    const i = await req<Integration>("POST", "/workspaces/platform/integrations/confirm", { attempt: a.attempt, token: a.token });
    expect(i).toMatchObject({ provider: "gitlab", authKind: "gitlab_oauth", baseUrl: "https://gitlab.com", account: { login: "akim" } });
  });

  it("G3 token mode: field errors, success (201, no repositories) and 409 integration_exists", async () => {
    const tok = (baseUrl: string, token: string) => req<Integration>("POST", "/workspaces/platform/integrations/gitlab/connect", { method: "token", baseUrl, token });
    const field = async (p: Promise<unknown>) => ((await rejects(p)).details as { fields: Record<string, string> }).fields;
    expect(await field(tok("http://gitlab.example.com", "fake-token"))).toEqual({ baseUrl: "Use an https:// address." });
    expect(await field(tok("https://10.0.0.5", "fake-token"))).toEqual({ baseUrl: "This address isn’t allowed." });
    expect(await field(tok("https://localhost", "fake-token"))).toEqual({ baseUrl: "This address isn’t allowed." });
    expect(await field(tok("https://unreachable.example.com", "fake-token"))).toEqual({ baseUrl: "Couldn’t reach GitLab at this address." });
    expect(await field(tok("https://gitlab.example.com", "fake-noscope"))).toEqual({ token: "The token needs the api scope." });
    expect(await field(tok("https://gitlab.example.com", "fake-expired"))).toEqual({ token: "This token has expired." });
    expect(await field(tok("https://gitlab.example.com", "glpat-wrong"))).toEqual({ token: "GitLab didn’t accept this token." });
    const i = await tok("https://gitlab.example.com/some/path", "fake-token");
    expect(i).toMatchObject({ provider: "gitlab", authKind: "gitlab_token", baseUrl: "https://gitlab.example.com", account: { kind: "bot" }, repositories: [], manageUrl: null });
    expect(i.tokenExpiresAt).not.toBeNull();
    const dup = await rejects(tok("https://gitlab.example.com", "fake-token"));
    expect(dup).toMatchObject({ status: 409, code: "integration_exists", details: { integrationId: i.id } });
  });

  it("G2 / G3 need integration.manage (403 with details.permission); an unconfigured GitHub is 503", async () => {
    as("u_sam");
    expect(await rejects(req("POST", "/workspaces/platform/integrations/github/connect", {}))).toMatchObject({ status: 403, details: { permission: "integration.manage" } });
    expect((await rejects(req("POST", "/workspaces/platform/integrations/gitlab/connect", { method: "oauth" }))).status).toBe(403);
    as("u_casey"); // workspace Admin without project access still manages integrations
    expect((await req<{ authorizeUrl: string }>("POST", "/workspaces/platform/integrations/github/connect", {})).authorizeUrl).toContain("#mock-authorize=github.");
    mockProviderConfig.github = false;
    expect(await rejects(req("POST", "/workspaces/platform/integrations/github/connect", {}))).toMatchObject({ status: 503, code: "integrations_unavailable" });
    expect((await overview()).providers[0]!.available).toBe(false);
  });

  it("G12 reconnect: GitHub → authorize URL, confirm clears the error; GitLab token needs the same user", async () => {
    setIntegrationError(getDB(), GH, "installation_suspended");
    expect((await overview()).integrations[0]!.repositories.every((r) => r.syncState === "paused")).toBe(true);
    const { authorizeUrl } = await req<{ authorizeUrl: string }>("POST", `/integrations/${GH}/reconnect`, {});
    const frag = fakeAuthorize(authorizeUrl.split(".").pop()!);
    const [attempt, token] = frag.replace("#connect=", "").split(".");
    const i = await req<Integration>("POST", "/workspaces/platform/integrations/confirm", { attempt, token });
    expect(i).toMatchObject({ id: GH, status: "active", error: null });
    expect(getDB().audit[0]!.action).toBe("integration.reconnected");

    const gl = await req<Integration>("POST", "/workspaces/platform/integrations/gitlab/connect", { method: "token", baseUrl: "https://gitlab.example.com", token: "fake-token" });
    setIntegrationError(getDB(), gl.id, "token_expired");
    const other = await rejects(req("POST", `/integrations/${gl.id}/reconnect`, { token: "fake-other" }));
    expect((other.details as { fields: Record<string, string> }).fields).toEqual({ token: "This token belongs to a different GitLab user." });
    expect(await req<Integration>("POST", `/integrations/${gl.id}/reconnect`, { token: "fake-token" })).toMatchObject({ status: "active", error: null });
  });
});

describe("repositories, sync and disconnect (§5.4)", () => {
  it("G8 lists the eight fixtures by owner with tracked flags; 409 while in error; managers only", async () => {
    const list = await req<AvailableRepository[]>("GET", `/integrations/${GH}/available-repositories`);
    expect(list.map((r) => r.fullPath)).toEqual([
      "alexkim/dotfiles",
      "alexkim/reflow-bench",
      "platform-team/api",
      "platform-team/board-engine",
      "platform-team/design-tokens",
      "platform-team/infra-terraform",
      "platform-team/mobile-app",
      "platform-team/web",
    ]);
    expect(list.filter((r) => r.tracked).map((r) => r.name)).toEqual(["api", "board-engine", "mobile-app", "web"]);
    expect((await req<AvailableRepository[]>("GET", `/integrations/${GH}/available-repositories`, undefined, { q: "WEB" })).map((r) => r.name)).toEqual(["web"]);
    as("u_sam");
    expect((await rejects(req("GET", `/integrations/${GH}/available-repositories`))).status).toBe(403);
    as("u_alex");
    setIntegrationError(getDB(), GH, "token_expired");
    expect(await rejects(req("GET", `/integrations/${GH}/available-repositories`))).toMatchObject({ status: 409, code: "integration_error", details: { code: "token_expired" } });
  });

  it("a second GitHub account sees repositories tracked by the first as trackedElsewhere and can't take them", async () => {
    const a = await connect("github");
    const second = await req<Integration>("POST", "/workspaces/platform/integrations/confirm", { attempt: a.attempt, token: a.token });
    const list = await req<AvailableRepository[]>("GET", `/integrations/${second.id}/available-repositories`);
    expect(list.filter((r) => r.trackedElsewhere).map((r) => r.name)).toEqual(["api", "board-engine", "mobile-app", "web"]);
    const web = list.find((r) => r.name === "web")!;
    const err = await rejects(req("PUT", `/integrations/${second.id}/repositories`, { repositories: [{ externalId: web.externalId }] }));
    expect((err.details as { fields: Record<string, string> }).fields).toEqual({ "repositories.0.externalId": "Already connected through another account." });
  });

  it("G9: 1–200, unknown ids and unknown projects are 422; the set is complete; scopes are kept when sent", async () => {
    const put = (repositories: unknown) => req<Integration>("PUT", `/integrations/${GH}/repositories`, { repositories });
    const f = async (p: Promise<unknown>) => ((await rejects(p)).details as { fields: Record<string, string> }).fields;
    expect(await f(put([]))).toEqual({ repositories: "Choose at least one repository." });
    expect(await f(put(Array.from({ length: 201 }, () => ({ externalId: "712004001" }))))).toEqual({ repositories: "Up to 200 repositories." });
    expect(await f(put([{ externalId: "nope" }]))).toEqual({ "repositories.0.externalId": "This repository isn’t available to this connection." });
    expect(await f(put([{ externalId: "712004001", projectIds: ["p_dsn"] }]))).toEqual({ "repositories.0.projectIds": "Choose projects of this workspace." });

    const next = await put([{ externalId: "712004001" }, { externalId: "712004188", projectIds: ["p_inf"] }]);
    expect(next.repositories.map((r) => [r.name, r.allProjects, r.projectIds, r.syncState])).toEqual([
      ["infra-terraform", false, ["p_inf"], "queued"],
      ["web", true, [], "idle"],
    ]);
    expect(next.syncing).toBe(true);
    expect(getDB().audit[0]).toMatchObject({ action: "integration.repositories_updated" });
    // Removed repos: links stay, repository becomes null (PRJ-29's #187 lived in board-engine).
    const d29 = await dev("PRJ-29");
    expect(d29.pullRequests[0]).toMatchObject({ repository: null, repoFullPath: "platform-team/board-engine" });
    // Tracking it again re-attaches the orphaned link.
    await put([{ externalId: "712004001" }, { externalId: "712004003" }]);
    expect((await dev("PRJ-29")).pullRequests[0]!.repository).toMatchObject({ fullPath: "platform-team/board-engine" });
  });

  it("G10 scopes a repository; INF-only infra repos don't enable PRJ", async () => {
    const web = getDB().repositories!.find((r) => r.name === "web")!;
    const r = await req<Repository>("PATCH", `/repositories/${web.id}`, { projectIds: ["p_inf"] });
    expect(r).toMatchObject({ allProjects: false, projectIds: ["p_inf"] });
    expect(getDB().audit[0]!.action).toBe("integration.repository_scoped");
    expect(events.some((e) => e.type === "project.changed" && (e.data as { areas: string[] }).areas.includes("development"))).toBe(true);
    expect((await req<Repository>("PATCH", `/repositories/${web.id}`, { projectIds: [] })).allProjects).toBe(true);
    as("u_jordan");
    expect((await req<Repository>("PATCH", `/repositories/${web.id}`, { projectIds: ["p_prj"] })).projectIds).toEqual(["p_prj"]);
    as("u_sam");
    expect((await rejects(req("PATCH", `/repositories/${web.id}`, { projectIds: [] }))).status).toBe(403);
  });

  it("G11: 202 syncing, then 429 sync_throttled within 2 minutes; 409 while in error", async () => {
    const s = await req<Integration>("POST", `/integrations/${GH}/sync`, {});
    expect(s.syncing).toBe(true);
    expect(s.nextSyncAt).not.toBeNull();
    const again = await rejects(req("POST", `/integrations/${GH}/sync`, {}));
    expect(again).toMatchObject({ status: 429, code: "sync_throttled" });
    expect((again.details as { nextSyncAt: string }).nextSyncAt).toBe(s.nextSyncAt);
    getDB().integrations![0]!.syncRequestedAt = null;
    setIntegrationError(getDB(), GH, "token_expired");
    expect((await rejects(req("POST", `/integrations/${GH}/sync`, {}))).code).toBe("integration_error");
  });

  it("G13: 204, links stay with repository null, devEnabled goes false, the event reaches everyone", async () => {
    await req("DELETE", `/integrations/${GH}`);
    expect((await overview()).integrations).toEqual([]);
    const d = await dev("PRJ-42");
    expect(d.enabled).toBe(false);
    expect(d.pullRequests).toHaveLength(4);
    expect(d.pullRequests.every((p) => p.repository === null)).toBe(true);
    expect((await req<Project>("GET", "/workspaces/platform/projects/PRJ")).devEnabled).toBe(false);
    expect((await task("PRJ-42")).dev!.prCount).toBe(4);
    const ev = events.find((e) => e.type === "integration.changed");
    expect(ev).toMatchObject({ projectId: null, data: { integrationId: GH, op: "disconnected" } });
    as("u_taylor");
    expect((await rejects(req("DELETE", `/integrations/${GH}`))).status).toBe(404);
  });
});

describe("D2–D4 (§5.6)", () => {
  it("parses every URL form; untracked, out-of-scope and unknown objects are 422", async () => {
    expect(parseDevUrl("https://github.com/platform-team/web/pull/214/files", [])).toEqual({ baseUrl: "https://github.com", fullPath: "platform-team/web", kind: "pull_request", ref: "214" });
    expect(parseDevUrl("https://github.com/platform-team/web/commit/a3f9c21#diff", [])).toMatchObject({ kind: "commit", ref: "a3f9c21" });
    expect(parseDevUrl("https://github.com/platform-team/web/tree/feature/x/", [])).toMatchObject({ kind: "branch", ref: "feature/x" });
    expect(parseDevUrl("https://gitlab.com/group/sub/proj/-/merge_requests/12/diffs", ["https://gitlab.com"])).toMatchObject({ fullPath: "group/sub/proj", kind: "pull_request", ref: "12" });
    expect(parseDevUrl("https://example.com/x", [])).toBeNull();

    const link = (url: string, key = "PRJ-58") => req<DevItem>("POST", `/tasks/${key}/development/links`, { url });
    const f = async (p: Promise<unknown>) => ((await rejects(p)).details as { fields: Record<string, string> }).fields;
    expect(await f(link("https://github.com/platform-team/infra-terraform/pull/3"))).toEqual({ url: "Connect this repository first." });
    expect(await f(link("not a url"))).toEqual({ url: "Paste a link to a pull request, merge request, commit or branch." });
    expect(await f(link("https://github.com/platform-team/web/pull/12345"))).toEqual({ url: "GitHub can’t find this pull request." });
    const web = getDB().repositories!.find((r) => r.name === "web")!;
    web.allProjects = false;
    web.projectIds = ["p_inf"];
    expect(await f(link("https://github.com/platform-team/web/pull/214"))).toEqual({ url: "This repository isn’t used by PRJ." });
  });

  it("links a known PR manually, re-link is idempotent, unlink deletes manual links", async () => {
    const pr = await req<DevItem>("POST", "/tasks/PRJ-58/development/links", { url: "https://github.com/platform-team/web/pull/214" });
    expect(pr).toMatchObject({ kind: "pull_request", ref: "#214", linkSource: "manual", repository: { fullPath: "platform-team/web" } });
    const again = await req<DevItem>("POST", "/tasks/PRJ-58/development/links", { url: "https://github.com/platform-team/web/pull/214" });
    expect(again.id).toBe(pr.id);
    expect((await task("PRJ-58")).dev!.prCount).toBe(1);
    expect(getDB().audit[0]!.action).toBe("task.dev_linked");
    expect(getDB().activity[0]).toMatchObject({ verb: "dev_linked", actorId: "u_alex", data: { ref: "#214" } });
    expect(events.some((e) => e.type === "task.changed" && (e.data as { fields: string[]; version: number | null }).fields.includes("development") && (e.data as { version: unknown }).version === null)).toBe(true);
    await req("DELETE", `/tasks/PRJ-58/development/links/${pr.id}`);
    expect(getDB().devLinks!.some((l) => l.id === pr.id)).toBe(false);
    expect((await task("PRJ-58")).dev).toBeNull();
  });

  it("unlinking an auto link suppresses it; D2 re-link lifts the suppression", async () => {
    const d = await dev("PRJ-42");
    const p190 = d.pullRequests.find((p) => p.ref === "#190")!;
    await req("DELETE", `/tasks/PRJ-42/development/links/${p190.id}`);
    expect(getDB().devLinks!.find((l) => l.id === p190.id)!.suppressed).toBe(true);
    expect((await dev("PRJ-42")).pullRequests).toHaveLength(3);
    const back = await req<DevItem>("POST", "/tasks/PRJ-42/development/links", { url: p190.url });
    expect(back.id).toBe(p190.id);
    expect((await dev("PRJ-42")).pullRequests).toHaveLength(4);
    // A link id of another task is 404.
    const other = (await dev("PRJ-41")).pullRequests[0]!;
    expect((await rejects(req("DELETE", `/tasks/PRJ-42/development/links/${other.id}`))).status).toBe(404);
  });

  it("D4 creates a branch, validates names, 409 on an existing branch, respects canCreateBranch", async () => {
    const web = getDB().repositories!.find((r) => r.name === "web")!;
    const create = (name: string, repositoryId = web.id) => req<DevBranch>("POST", "/tasks/PRJ-58/development/branches", { repositoryId, name });
    const f = async (p: Promise<unknown>) => ((await rejects(p)).details as { fields: Record<string, string> }).fields;
    expect(await f(create("a..b"))).toEqual({ name: "Branch names can’t contain '..'." });
    expect(await f(create("a b"))).toEqual({ name: "Use letters, numbers, - _ . / only." });
    expect(await f(create("x".repeat(81)))).toEqual({ name: "Up to 80 characters." });
    expect(await f(create("prj-58-x", "repo_nope"))).toHaveProperty("repositoryId");
    const b = await create("prj-58-invoice-pdf-redesign");
    expect(b).toMatchObject({ kind: "branch", name: "prj-58-invoice-pdf-redesign", aheadBy: 0, linkSource: "created", state: "active" });
    expect(getDB().audit[0]!.action).toBe("task.dev_branch_created");
    expect(getDB().activity.find((a) => a.verb === "dev_branch_created")).toMatchObject({ data: { branch: "prj-58-invoice-pdf-redesign" } });
    expect(await rejects(create("prj-58-invoice-pdf-redesign"))).toMatchObject({ status: 409, code: "branch_exists", message: "That branch already exists in platform-team/web." });
    expect((await rejects(create("main"))).code).toBe("branch_exists");
    mockProviderConfig.githubBranchCreation = false;
    expect((await dev("PRJ-58")).repositories.every((r) => !r.canCreateBranch)).toBe(true);
    expect(await f(create("prj-58-y"))).toHaveProperty("repositoryId");
  });

  it("permissions per seeded user: Sam links, Taylor (Viewer) and Casey (not on PRJ) can't; archived projects are read-only", async () => {
    const url = "https://github.com/platform-team/web/pull/221";
    as("u_sam");
    expect((await req<DevItem>("POST", "/tasks/PRJ-58/development/links", { url })).kind).toBe("pull_request");
    as("u_taylor");
    expect(await rejects(req("POST", "/tasks/PRJ-58/development/links", { url }))).toMatchObject({ status: 403, details: { permission: "development.link" } });
    expect((await rejects(req("POST", "/tasks/PRJ-58/development/branches", { repositoryId: "x", name: "y" }))).status).toBe(403);
    as("u_casey");
    expect((await rejects(req("POST", "/tasks/PRJ-58/development/links", { url }))).status).toBe(403);
    as("u_jordan");
    expect((await req<DevBranch>("POST", "/tasks/PRJ-58/development/branches", { repositoryId: getDB().repositories!.find((r) => r.name === "api")!.id, name: "prj-58-jordan" })).name).toBe("prj-58-jordan");
    as("u_alex");
    getDB().projects.find((p) => p.id === "p_prj")!.status = "archived";
    expect((await rejects(req("POST", "/tasks/PRJ-58/development/links", { url }))).status).toBe(403);
  });
});

describe("automation rules A1 / A2 and §7.10", () => {
  const rules = (pid = "p_prj") => req<DevAutomationRule[]>("GET", `/projects/${pid}/dev-automation`);
  const put = (body: DevAutomationRule[], pid = "p_prj") => req<DevAutomationRule[]>("PUT", `/projects/${pid}/dev-automation`, body);

  it("A1 lists all three triggers in order; PRJ's seed turns pr_merged → Done on, MOB has all off", async () => {
    expect(await rules()).toEqual([
      { trigger: "branch_created", enabled: false, statusId: null },
      { trigger: "pr_opened", enabled: false, statusId: null },
      { trigger: "pr_merged", enabled: true, statusId: "p_prj-st-done" },
    ]);
    expect((await rules("p_mob")).every((r) => !r.enabled)).toBe(true);
  });

  it("A2 validates statuses (done-only for merges) and needs status.manage", async () => {
    const f = async (p: Promise<unknown>) => ((await rejects(p)).details as { fields: Record<string, string> }).fields;
    const base: DevAutomationRule[] = [
      { trigger: "branch_created", enabled: true, statusId: null },
      { trigger: "pr_opened", enabled: true, statusId: "p_mob-st-review" },
      { trigger: "pr_merged", enabled: true, statusId: "p_prj-st-review" },
    ];
    expect(await f(put(base))).toEqual({ "rules.0.statusId": "Choose a status.", "rules.1.statusId": "Choose a status.", "rules.2.statusId": "Pick a Done status." });
    expect(await f(put(base.slice(0, 2)))).toEqual({ rules: "Send all three triggers, in order." });
    const ok = await put([
      { trigger: "branch_created", enabled: true, statusId: "p_prj-st-progress" },
      { trigger: "pr_opened", enabled: true, statusId: "p_prj-st-review" },
      { trigger: "pr_merged", enabled: true, statusId: "p_prj-st-done" },
    ]);
    expect(ok.map((r) => r.enabled)).toEqual([true, true, true]);
    expect(getDB().audit[0]!.action).toBe("project.dev_automation_updated");
    expect(events.some((e) => e.type === "project.changed" && (e.data as { areas: string[] }).areas.includes("development"))).toBe(true);
    as("u_sam");
    expect(await rejects(put(ok))).toMatchObject({ status: 403, details: { permission: "status.manage" } });
    expect((await rules()).length).toBe(3);
  });

  it("Merge PR on PRJ-41 moves it to Done as GitHub: version bump, activity + audit as the integration, notifications with via", async () => {
    const before = getDB().tasks.find((x) => x.key === "PRJ-41")!;
    const v = before.version;
    expect(simulateMergePr("PRJ-41")).toBe("GitHub merged #221 (PRJ-41)");
    const after = getDB().tasks.find((x) => x.key === "PRJ-41")!;
    expect(after.statusId).toBe("p_prj-st-done");
    expect(after.version).toBe(v + 1);
    expect(after.completedAt).not.toBeNull();
    const acts = getDB().activity.filter((a) => a.taskId === after.id).slice(0, 2);
    expect(acts.map((a) => [a.verb, a.actorId, a.actorKind, a.actorName])).toEqual([
      ["status_changed", null, "integration", "GitHub"],
      ["dev_pr_merged", null, "integration", "GitHub"],
    ]);
    const audit = await req<AuditPage>("GET", "/workspaces/platform/audit", undefined, { limit: 50 });
    const row = audit.data.find((a) => a.action === "task.status_changed" && a.entityKey === "PRJ-41")!;
    expect(row).toMatchObject({ actorId: GH, actorKind: "integration", actorName: "GitHub", source: "webhook" });
    as("u_riley"); // assignee
    const inbox = await req<Paginated<Notification>>("GET", "/notifications", undefined, { filter: { tab: "all" } });
    const n = inbox.data.find((x) => x.taskKey === "PRJ-41" && x.type === "status")!;
    expect(n).toMatchObject({ actorId: null, payload: { via: "github", toStatus: "Done" } });
    expect(events.some((e) => e.type === "task.changed" && (e.data as { fields: string[] }).fields.includes("statusId") && e.actorId === null)).toBe(true);
    expect((await task("PRJ-41")).dev!.pr).toMatchObject({ state: "merged" });
  });

  it("forward-only guards: PRJ-42 keeps going while #209 is still a draft; nothing moves with the rule off", async () => {
    simulateMergePr("PRJ-42"); // merges #214, #209 (draft) is still open
    expect(getDB().tasks.find((x) => x.key === "PRJ-42")!.statusId).toBe("p_prj-st-progress");
    simulateMergePr("PRJ-42"); // the last open one
    expect(getDB().tasks.find((x) => x.key === "PRJ-42")!.statusId).toBe("p_prj-st-done");
    await put([
      { trigger: "branch_created", enabled: false, statusId: null },
      { trigger: "pr_opened", enabled: false, statusId: null },
      { trigger: "pr_merged", enabled: false, statusId: null },
    ]);
    const t48 = getDB().tasks.find((x) => x.key === "PRJ-48")!;
    simulateOpenPr("PRJ-48");
    simulateMergePr("PRJ-48");
    expect(t48.statusId).toBe("p_prj-st-progress");
  });

  it("pr_opened and branch_created only move to-do tasks; archived projects never move", async () => {
    await put([
      { trigger: "branch_created", enabled: true, statusId: "p_prj-st-progress" },
      { trigger: "pr_opened", enabled: true, statusId: "p_prj-st-review" },
      { trigger: "pr_merged", enabled: true, statusId: "p_prj-st-done" },
    ]);
    // PRJ-48 is in progress: a new PR doesn't move it back or forward.
    expect(simulateOpenPr("PRJ-48")).toMatch(/^GitHub opened #\d+ on PRJ-48$/);
    expect(getDB().tasks.find((x) => x.key === "PRJ-48")!.statusId).toBe("p_prj-st-progress");
    // PRJ-58 is to-do: creating a branch moves it to In progress (actor: the integration).
    const web = getDB().repositories!.find((r) => r.name === "web")!;
    await req<DevBranch>("POST", "/tasks/PRJ-58/development/branches", { repositoryId: web.id, name: "prj-58-go" });
    expect(getDB().tasks.find((x) => x.key === "PRJ-58")!.statusId).toBe("p_prj-st-progress");
    // Archived: no automation.
    getDB().projects.find((p) => p.id === "p_prj")!.status = "archived";
    const t52 = getDB().tasks.find((x) => x.key === "PRJ-52")!;
    simulateOpenPr("PRJ-52");
    expect(t52.statusId).toBe("p_prj-st-todo");
  });

  it("Fail checks flips the headline to failing; Expire token puts the connection in error", async () => {
    simulateFailChecks("PRJ-41");
    expect((await task("PRJ-41")).dev!.pr).toMatchObject({ checks: "failing", checksPassed: 2, checksTotal: 3 });
    expect(simulateExpireToken("platform")).toBe("GitHub token expired");
    const o = await overview();
    expect(o.integrations[0]).toMatchObject({ status: "error", error: { code: "token_expired" } });
    expect((await req<Project>("GET", "/workspaces/platform/projects/PRJ")).devEnabled).toBe(false);
    expect(simulateOpenPr(null)).toBe("Open a task first (?task=KEY).");
  });
});

describe("realtime (§8.4)", () => {
  it("integration.changed reaches every workspace member, even one on no project (Casey)", async () => {
    as("u_casey");
    const got: { type: string }[] = [];
    const ac = new AbortController();
    const done = new MockRealtimeSource().run({ slug: "platform", lastEventId: null, signal: ac.signal, onEvent: (e) => got.push(e), onActivity: () => undefined });
    await new Promise((r) => setTimeout(r, 5));
    as("u_alex");
    await req<Integration>("POST", `/integrations/${GH}/sync`, {});
    await new Promise((r) => setTimeout(r, 5));
    expect(got.map((e) => e.type)).toContain("integration.changed");
    expect(got.map((e) => e.type)).not.toContain("task.changed");
    ac.abort();
    await done;
  });
});
