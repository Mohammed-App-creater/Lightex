import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/api/errors";
import type { HttpMethod } from "@/api/transport";
import type { Permission, PermissionInfo, Project, Role, Team, TeamDetail, TeamMember, Workspace } from "@/api/types";
import { PERMISSION_CATALOGUE } from "@/platform/roles/catalogue";
import { mockControls } from "./controls";
import { getDB, mockSession, resetDB } from "./db";
import { SCHEMA } from "./seed";
import { MockTransport } from "./transport";

/* Platform Stage 4 mock: teams (contract §1) and role data scopes (contract §2). */

const t = new MockTransport();
const as = (userId: string) => mockSession.set(userId);
const call = <T>(method: HttpMethod, path: string, body?: unknown) => t.request<T>({ method, path, body });

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected the request to fail");
}

beforeEach(() => {
  resetDB();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "polling" }));
  as("u_alex");
});

describe("seed", () => {
  it("bumps the schema and seeds teams in both workspaces", async () => {
    expect(SCHEMA).toBe(9); // sales S0 bumped it again
    const teams = await call<Team[]>("GET", "/workspaces/platform/teams");
    expect(teams.map((x) => x.name)).toEqual(["Backend", "Frontend", "Infrastructure"]);
    const frontend = teams.find((x) => x.name === "Frontend")!;
    expect(frontend).toMatchObject({ memberCount: 3, leadIds: ["u_alex"] });
    expect(getDB().teams.filter((x) => x.workspaceId === "ws_guild")).toHaveLength(1);
  });
});

describe("teams API", () => {
  it("lets any member read, with members carrying the user fields", async () => {
    as("u_taylor");
    const detail = await call<TeamDetail>("GET", "/teams/team_frontend");
    expect(detail.members.find((m) => m.userId === "u_alex")).toEqual({
      userId: "u_alex",
      name: "Alex Kim",
      email: "alex@team.dev",
      avatarUrl: null,
      isLead: true,
    });
    expect(await call<TeamMember[]>("GET", "/teams/team_frontend/members")).toHaveLength(3);
  });

  it("creates a team and audits it", async () => {
    const created = await call<TeamDetail>("POST", "/workspaces/platform/teams", { name: "  Support ", description: "Customer issues" });
    expect(created).toMatchObject({ name: "Support", description: "Customer issues", memberCount: 0, leadIds: [], members: [] });
    expect(getDB().audit[0]).toMatchObject({ action: "core.team.created", target: "Support", workspaceId: "ws_platform" });
    const list = await call<Team[]>("GET", "/workspaces/platform/teams");
    expect(list.map((x) => x.name)).toContain("Support");
  });

  it("rejects a duplicate name case-insensitively with 409 team_name_taken, on create and rename", async () => {
    let e = await failure(call("POST", "/workspaces/platform/teams", { name: "frontend" }));
    expect([e.status, e.code]).toEqual([409, "team_name_taken"]);
    e = await failure(call("PATCH", "/teams/team_backend", { name: "FRONTEND" }));
    expect([e.status, e.code]).toEqual([409, "team_name_taken"]);
    // Renaming a team to its own name (different case) is fine.
    expect((await call<TeamDetail>("PATCH", "/teams/team_backend", { name: "backend" })).name).toBe("backend");
    // A deleted team's name is free again.
    await call("DELETE", "/teams/team_infra");
    expect((await call<TeamDetail>("POST", "/workspaces/platform/teams", { name: "Infrastructure" })).name).toBe("Infrastructure");
  });

  it("validates the name", async () => {
    const e = await failure(call("POST", "/workspaces/platform/teams", { name: "  " }));
    expect([e.status, e.code, e.fieldErrors.name]).toEqual([422, "validation_failed", "Name is required"]);
  });

  it("adds a member; someone outside the workspace is 400 not_a_workspace_member, a repeat is 409 already_a_member", async () => {
    const added = await call<TeamMember>("POST", "/teams/team_frontend/members", { userId: "u_taylor" });
    expect(added).toMatchObject({ userId: "u_taylor", isLead: false });
    expect(getDB().audit[0]!.action).toBe("core.team.member_added");

    // Drew is only in Design guild.
    let e = await failure(call("POST", "/teams/team_frontend/members", { userId: "u_drew" }));
    expect([e.status, e.code]).toEqual([400, "not_a_workspace_member"]);

    e = await failure(call("POST", "/teams/team_frontend/members", { userId: "u_taylor" }));
    expect([e.status, e.code]).toEqual([409, "already_a_member"]);

    const lead = await call<TeamMember>("POST", "/teams/team_infra/members", { userId: "u_sam", isLead: true });
    expect(lead.isLead).toBe(true);
  });

  it("toggles a lead and removes a member", async () => {
    const m = await call<TeamMember>("PATCH", "/teams/team_frontend/members/u_sam", { isLead: true });
    expect(m.isLead).toBe(true);
    expect(getDB().audit[0]!.action).toBe("core.team.member_updated");
    let team = await call<TeamDetail>("GET", "/teams/team_frontend");
    expect(team.leadIds.sort()).toEqual(["u_alex", "u_sam"]);

    await call("PATCH", "/teams/team_frontend/members/u_alex", { isLead: false });
    team = await call<TeamDetail>("GET", "/teams/team_frontend");
    expect(team.leadIds).toEqual(["u_sam"]);

    await call("DELETE", "/teams/team_frontend/members/u_sam");
    expect(getDB().audit[0]!.action).toBe("core.team.member_removed");
    team = await call<TeamDetail>("GET", "/teams/team_frontend");
    expect(team).toMatchObject({ memberCount: 2, leadIds: [] });

    const e = await failure(call("PATCH", "/teams/team_frontend/members/u_sam", { isLead: true }));
    expect(e.status).toBe(404);
  });

  it("needs core.teams.manage for every write", async () => {
    as("u_sam");
    const writes: [HttpMethod, string, unknown][] = [
      ["POST", "/workspaces/platform/teams", { name: "Mine" }],
      ["PATCH", "/teams/team_frontend", { name: "Mine" }],
      ["DELETE", "/teams/team_frontend", undefined],
      ["POST", "/teams/team_frontend/members", { userId: "u_taylor" }],
      ["PATCH", "/teams/team_frontend/members/u_alex", { isLead: false }],
      ["DELETE", "/teams/team_frontend/members/u_alex", undefined],
    ];
    for (const [method, path, body] of writes) {
      const e = await failure(call(method, path, body));
      expect([e.status, e.code]).toEqual([403, "forbidden"]);
    }
  });

  it("answers 404 for a team in another workspace (tenant rule)", async () => {
    as("u_drew");
    for (const [method, path, body] of [
      ["GET", "/teams/team_frontend", undefined],
      ["GET", "/teams/team_frontend/members", undefined],
      ["PATCH", "/teams/team_frontend", { name: "Ours" }],
      ["DELETE", "/teams/team_frontend", undefined],
      ["POST", "/teams/team_frontend/members", { userId: "u_drew" }],
    ] as [HttpMethod, string, unknown][]) {
      const e = await failure(call(method, path, body));
      expect([e.status, e.code]).toEqual([404, "not_found"]);
    }
    // Drew's own workspace works, and lists only its team.
    expect((await call<Team[]>("GET", "/workspaces/design-guild/teams")).map((x) => x.name)).toEqual(["Brand"]);
  });

  it("deletes a team (gone from the list, its detail 404s)", async () => {
    await call("DELETE", "/teams/team_infra");
    expect(getDB().audit[0]!.action).toBe("core.team.deleted");
    expect((await call<Team[]>("GET", "/workspaces/platform/teams")).map((x) => x.id)).not.toContain("team_infra");
    expect((await failure(call("GET", "/teams/team_infra"))).status).toBe(404);
  });

  it("drops someone's team memberships when they leave the workspace", async () => {
    await call("DELETE", "/workspaces/platform/members/u_riley");
    const backend = await call<TeamDetail>("GET", "/teams/team_backend");
    expect(backend.members.map((m) => m.userId)).not.toContain("u_riley");
    expect(getDB().teamMembers.some((m) => m.userId === "u_riley" && m.workspaceId === "ws_platform")).toBe(false);
  });
});

describe("data scope", () => {
  const CODE = "core.widget.view" as Permission;
  const fixture: PermissionInfo = {
    key: CODE,
    module: "core",
    scope: "workspace",
    group: "Reports",
    label: "View widgets",
    description: "Fixture scopable permission",
    scopable: true,
  };
  beforeEach(() => {
    PERMISSION_CATALOGUE.push(fixture);
  });
  afterEach(() => {
    PERMISSION_CATALOGUE.splice(PERMISSION_CATALOGUE.indexOf(fixture), 1);
  });

  const createRole = (body: Record<string, unknown>) =>
    call<Role>("POST", "/workspaces/platform/roles", { name: "Widgeteer", description: "", scope: "workspace", ...body });

  it("returns scopable on catalogue entries", async () => {
    const cat = await call<PermissionInfo[]>("GET", "/permissions");
    expect(cat.find((p) => p.key === CODE)?.scopable).toBe(true);
    expect(cat.find((p) => p.key === "core.roles.manage")?.scopable).toBe(false);
  });

  it("needs a scope for a granted scopable code: 400 data_scope_required with the codes", async () => {
    const e = await failure(createRole({ permissions: ["core.workspace.view", CODE] }));
    expect([e.status, e.code, e.details?.codes]).toEqual([400, "data_scope_required", [CODE]]);
  });

  it("refuses a scope on a non-scopable code: 400 data_scope_not_allowed", async () => {
    const e = await failure(createRole({ permissions: ["core.workspace.view"], dataScopes: { "core.workspace.view": "all" } }));
    expect([e.status, e.code]).toEqual([400, "data_scope_not_allowed"]);
  });

  it("stores the scope, returns it on roles and as myDataScopes on workspace and project", async () => {
    const role = await createRole({ permissions: ["core.workspace.view", CODE], dataScopes: { [CODE]: "team" } });
    expect(role.dataScopes).toEqual({ [CODE]: "team" });

    // Re-scoping alone works; the stored scope covers a PATCH that only changes permissions.
    expect((await call<Role>("PATCH", `/roles/${role.id}`, { dataScopes: { [CODE]: "all" } })).dataScopes).toEqual({ [CODE]: "all" });
    expect((await call<Role>("PATCH", `/roles/${role.id}`, { permissions: [CODE] })).dataScopes).toEqual({ [CODE]: "all" });
    // Revoking the code drops its scope.
    expect((await call<Role>("PATCH", `/roles/${role.id}`, { permissions: ["core.workspace.view"] })).dataScopes).toEqual({});
    await call("PATCH", `/roles/${role.id}`, { permissions: ["core.workspace.view", CODE], dataScopes: { [CODE]: "own" } });

    // Sales S0: no privilege escalation, so the owner holds the fixture code before assigning a role with it.
    const owner = getDB().roles.find((r) => r.id === "ws_platform-role-owner")!;
    owner.permissions = [...owner.permissions, CODE as Permission];
    owner.dataScopes = { ...owner.dataScopes, [CODE]: "all" };
    await call("PATCH", "/workspaces/platform/members/u_sam", { roleId: role.id });
    as("u_sam");
    expect((await call<Workspace>("GET", "/workspaces/platform")).myDataScopes).toEqual({ [CODE]: "own" });
    expect((await call<Project>("GET", "/tracking/workspaces/platform/projects/PRJ")).myDataScopes).toEqual({ [CODE]: "own" });
    as("u_taylor");
    expect((await call<Workspace>("GET", "/workspaces/platform")).myDataScopes).toEqual({});
  });

  it("Stage 5: a non-owner can't grant a wider scope than their own (403 data_scope_exceeds_own); owners can", async () => {
    // u_jordan (Admin) holds the code with Team.
    const admin = getDB().roles.find((r) => r.id === getDB().wsMembers.find((m) => m.userId === "u_jordan" && m.workspaceId === "ws_platform")!.roleIds[0])!;
    admin.permissions = [...admin.permissions, CODE];
    admin.dataScopes = { ...admin.dataScopes, [CODE]: "team" };
    as("u_jordan");
    const role = await createRole({ permissions: [CODE], dataScopes: { [CODE]: "team" } });
    let e = await failure(call("PATCH", `/roles/${role.id}`, { dataScopes: { [CODE]: "all" } }));
    expect([e.status, e.code, e.details]).toEqual([403, "data_scope_exceeds_own", { code: CODE, dataScope: "all", yours: "team" }]);
    // Nothing was written; narrowing is fine.
    expect(getDB().roles.find((r) => r.id === role.id)!.dataScopes).toEqual({ [CODE]: "team" });
    expect((await call<Role>("PATCH", `/roles/${role.id}`, { dataScopes: { [CODE]: "own" } })).dataScopes).toEqual({ [CODE]: "own" });
    e = await failure(createRole({ name: "Wide", permissions: [CODE], dataScopes: { [CODE]: "all" } }));
    expect(e.code).toBe("data_scope_exceeds_own");
    // Without the code yourself, any scope is wider than yours.
    admin.permissions = admin.permissions.filter((c) => c !== CODE);
    e = await failure(createRole({ name: "Mine", permissions: [CODE], dataScopes: { [CODE]: "own" } }));
    expect([e.status, e.details?.yours]).toEqual([403, null]);
    // The owner is exempt.
    as("u_alex");
    expect((await call<Role>("PATCH", `/roles/${role.id}`, { dataScopes: { [CODE]: "all" } })).dataScopes).toEqual({ [CODE]: "all" });
  });
});
