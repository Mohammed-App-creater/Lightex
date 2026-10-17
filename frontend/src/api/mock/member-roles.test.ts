import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/api/errors";
import type { HttpMethod } from "@/api/transport";
import type { AuditPage, Invite, Paginated, Role, Workspace, WorkspaceMember } from "@/api/types";
import { mockControls } from "./controls";
import { getDB, mockSession, resetDB } from "./db";
import { SCHEMA } from "./seed";
import { MockTransport } from "./transport";

/* Sales S0 mock (docs/sales/s0-contract.md §1, §2, §4): several workspace roles, the workspace time zone, module roles. */

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

const R = (key: string) => `ws_platform-role-${key}`;
const member = (userId: string) => call<WorkspaceMember>("PATCH", `/workspaces/platform/members/${userId}`, {});
const setRoles = (userId: string, roleIds: string[]) => call<WorkspaceMember>("PATCH", `/workspaces/platform/members/${userId}`, { roleIds });
const workspace = () => call<Workspace>("GET", "/workspaces/platform");
const enableSales = () => call("PUT", "/workspaces/platform/modules/sales", { enabled: true });

beforeEach(() => {
  resetDB();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false, realtime: "polling" }));
  as("u_alex");
});

describe("seed", () => {
  it("bumps the schema, gives every member a role list and every workspace the default time zone", async () => {
    expect(SCHEMA).toBe(8);
    expect(getDB().wsMembers.every((m) => m.roleIds.length === 1)).toBe(true);
    const ws = await workspace();
    expect(ws).toMatchObject({ timezone: "Africa/Addis_Ababa", myRoleId: R("owner"), myRoleIds: [R("owner")] });
    const invites = await call<Invite[]>("GET", "/workspaces/platform/invites");
    expect(invites[0]).toMatchObject({ roleId: R("member"), roleName: "Member", roleIds: [R("member")], roleNames: ["Member"] });
  });
});

describe("several roles per member", () => {
  it("replaces the roles, orders them by precedence and unions the permissions", async () => {
    const auditor = await call<Role>("POST", "/workspaces/platform/roles", { name: "Auditor", scope: "workspace", permissions: ["core.workspace.view", "core.audit.view"] });
    // Sent out of order: the response follows Owner, Admin, Member, then by name.
    const m = await setRoles("u_sam", [auditor.id, R("member")]);
    expect(m.roleIds).toEqual([R("member"), auditor.id]);
    expect(m.roleId).toBe(R("member"));

    as("u_sam");
    const ws = await workspace();
    expect(ws.myRoleIds).toEqual([R("member"), auditor.id]);
    expect(ws.myRoleId).toBe(R("member"));
    expect(ws.my_permissions).toEqual(expect.arrayContaining(["core.workspace.view", "core.audit.view"]));

    // memberCount counts each holder under every role they hold.
    as("u_alex");
    const roles = await call<Role[]>("GET", "/workspaces/platform/roles");
    expect(roles.find((r) => r.id === auditor.id)!.memberCount).toBe(1);
    expect(roles.find((r) => r.id === R("member"))!.memberCount).toBe(4);
    // The role filter returns members holding any of the given roles.
    const page = await t.request<Paginated<WorkspaceMember>>({ method: "GET", path: "/workspaces/platform/members", query: { filter: { role: [auditor.id, "role_none"] } } });
    expect(page.data.map((x) => x.userId)).toEqual(["u_sam"]);
    // The search result names the primary role.
    const found = await t.request<{ type: string; roleName?: string }[]>({ method: "GET", path: "/workspaces/platform/search", query: { q: "sam", filter: { type: "user" } } });
    expect(found[0]!.roleName).toBe("Member");
  });

  it("audits the change on the Roles field and keeps the old roleId request working", async () => {
    await call("POST", "/workspaces/platform/roles", { name: "Auditor", scope: "workspace", permissions: ["core.workspace.view"] });
    const auditor = getDB().roles.find((r) => r.name === "Auditor")!;
    await setRoles("u_sam", [R("member"), auditor.id]);
    const page = await call<AuditPage>("GET", "/workspaces/platform/audit");
    expect(page.data[0]).toMatchObject({ action: "core.member.role_changed", target: "Sam Patel" });
    expect(page.data[0]!.changes).toEqual([{ field: "Roles", kind: "value", before: "Member", after: "Member, Auditor" }]);

    const old = await call<WorkspaceMember>("PATCH", "/workspaces/platform/members/u_sam", { roleId: R("admin") });
    expect(old.roleIds).toEqual([R("admin")]);
    // roleIds wins when both are sent.
    const both = await call<WorkspaceMember>("PATCH", "/workspaces/platform/members/u_sam", { roleId: R("admin"), roleIds: [R("member")] });
    expect(both.roleIds).toEqual([R("member")]);
  });

  it("answers the contract's 422 shapes", async () => {
    const fields = async (body: unknown) => (await failure(call("PATCH", "/workspaces/platform/members/u_sam", body))).fieldErrors;
    expect(await fields({ roleIds: [] })).toEqual({ roleIds: "Pick at least one role" });
    expect(await fields({ roleIds: "x" })).toEqual({ roleIds: "Pick at least one role" });
    expect(await fields({})).toEqual({ roleIds: "Pick at least one role" });
    expect(await fields({ roleIds: [R("member"), "nope"] })).toEqual({ roleIds: "Pick workspace roles" });
    expect(await fields({ roleIds: [R("project_member")] })).toEqual({ roleIds: "Pick workspace roles" });
    expect(await fields({ roleIds: ["ws_guild-role-member"] })).toEqual({ roleIds: "Pick workspace roles" });
    expect(await fields({ roleId: "nope" })).toEqual({ roleId: "Pick a workspace role" });
    // Duplicates are ignored.
    expect((await setRoles("u_sam", [R("member"), R("member")])).roleIds).toEqual([R("member")]);
    expect(await member("u_sam").catch((e: ApiError) => e.status)).toBe(422);
  });

  it("refuses privilege escalation, but not for roles the member keeps", async () => {
    as("u_jordan"); // Admin: no core.workspace.delete
    const e = await failure(setRoles("u_sam", [R("member"), R("owner")]));
    expect([e.status, e.code, e.details?.permission]).toEqual([403, "forbidden", "core.workspace.delete"]);
    // Alex keeps Owner; adding Member to Alex is fine for an Admin.
    expect((await setRoles("u_alex", [R("owner"), R("member")])).roleIds).toEqual([R("owner"), R("member")]);
    // Removing an owner needs the owner's permissions.
    expect((await failure(call("DELETE", "/workspaces/platform/members/u_alex"))).status).toBe(403);
  });

  it("keeps the last owner (409 last_owner) across member edits, removal and role edits", async () => {
    let e = await failure(setRoles("u_alex", [R("admin")]));
    expect([e.status, e.code]).toEqual([409, "last_owner"]);

    // A second owner makes it possible; the first can then step down.
    await setRoles("u_jordan", [R("owner"), R("admin")]);
    expect((await setRoles("u_alex", [R("admin"), R("member")])).roleIds).toEqual([R("admin"), R("member")]);
    as("u_jordan");
    await call("DELETE", "/workspaces/platform/members/u_alex");
    expect(getDB().wsMembers.some((m) => m.userId === "u_alex" && m.workspaceId === "ws_platform")).toBe(false);

    // A custom role carrying the owner permission: the last holder can't lose it through a role edit.
    resetDB();
    as("u_alex");
    const co = await call<Role>("POST", "/workspaces/platform/roles", { name: "Co-owner", scope: "workspace", permissions: ["core.workspace.view", "core.workspace.delete"] });
    await setRoles("u_jordan", [R("admin"), co.id]);
    await setRoles("u_alex", [R("admin")]);
    e = await failure(call("PATCH", `/roles/${co.id}`, { permissions: ["core.workspace.view"] }));
    expect([e.status, e.code]).toEqual([409, "last_owner"]);
    e = await failure(call("DELETE", `/roles/${co.id}`, { reassignTo: R("member") }));
    expect([e.status, e.code]).toEqual([409, "last_owner"]);
  });

  it("deleting a role with reassignTo moves holders and pending invites without duplicates", async () => {
    const extra = await call<Role>("POST", "/workspaces/platform/roles", { name: "Extra", scope: "workspace", permissions: ["core.workspace.view"] });
    await setRoles("u_sam", [R("member"), extra.id]);
    await setRoles("u_taylor", [extra.id]);
    await call("POST", "/workspaces/platform/invites", { emails: ["both@x.dev"], roleIds: [R("member"), extra.id] });
    await call("POST", "/workspaces/platform/invites", { emails: ["only@x.dev"], roleIds: [extra.id] });

    expect((await failure(call("DELETE", `/roles/${extra.id}`))).code).toBe("role_in_use");
    await call("DELETE", `/roles/${extra.id}`, { reassignTo: R("member") });
    const db = getDB();
    const roleIds = (u: string) => db.wsMembers.find((m) => m.userId === u && m.workspaceId === "ws_platform")!.roleIds;
    expect(roleIds("u_sam")).toEqual([R("member")]);
    expect(roleIds("u_taylor")).toEqual([R("member")]);
    expect(db.invites.find((i) => i.email === "both@x.dev")!.roleIds).toEqual([R("member")]);
    expect(db.invites.find((i) => i.email === "only@x.dev")!.roleIds).toEqual([R("member")]);
  });
});

describe("invites with several roles", () => {
  it("creates the invite with every role and the new member gets them all", async () => {
    const auditor = await call<Role>("POST", "/workspaces/platform/roles", { name: "Auditor", scope: "workspace", permissions: ["core.workspace.view", "core.audit.view"] });
    const [inv] = await call<Invite[]>("POST", "/workspaces/platform/invites", { emails: ["new@x.dev"], roleIds: [auditor.id, R("member")] });
    expect(inv).toMatchObject({ roleId: R("member"), roleName: "Member", roleIds: [R("member"), auditor.id], roleNames: ["Member", "Auditor"] });
    const page = await call<AuditPage>("GET", "/workspaces/platform/audit");
    expect(page.data[0]!.changes).toContainEqual({ field: "Roles", kind: "value", before: null, after: "Member, Auditor" });

    const token = getDB().invites.find((i) => i.id === inv!.id)!.token;
    mockSession.set(null);
    await call("POST", `/invites/${token}/accept`, { name: "New Person", password: "Str0ng!pass" });
    const joined = getDB().users.find((u) => u.email === "new@x.dev")!;
    expect(getDB().wsMembers.find((m) => m.userId === joined.id)!.roleIds).toEqual([R("member"), auditor.id]);
  });

  it("accepts the old roleId, validates roleIds and refuses roles the inviter can't grant", async () => {
    expect((await call<Invite[]>("POST", "/workspaces/platform/invites", { emails: ["a@x.dev"], roleId: R("member") }))[0]!.roleIds).toEqual([R("member")]);
    expect((await failure(call("POST", "/workspaces/platform/invites", { emails: ["b@x.dev"], roleIds: [] }))).fieldErrors).toEqual({ roleIds: "Pick at least one role" });
    as("u_jordan");
    const e = await failure(call("POST", "/workspaces/platform/invites", { emails: ["c@x.dev"], roleIds: [R("owner")] }));
    expect([e.status, e.details?.permission]).toEqual([403, "core.workspace.delete"]);
  });
});

describe("widest data scope", () => {
  it("unions scopable grants across roles: all > team > own", async () => {
    await enableSales();
    as("u_sam"); // Member: sales.dashboard.view own
    expect((await workspace()).myDataScopes).toEqual({ "sales.dashboard.view": "own" });
    as("u_alex");
    await setRoles("u_sam", [R("member"), R("sales_manager")]);
    as("u_sam");
    expect((await workspace()).myDataScopes).toEqual({ "sales.dashboard.view": "team" });
    as("u_alex");
    await setRoles("u_sam", [R("sales_salesperson"), R("member"), R("sales_admin")]);
    as("u_sam");
    const ws = await workspace();
    expect(ws.myDataScopes).toEqual({ "sales.dashboard.view": "all" });
    expect(ws.myRoleIds).toEqual([R("member"), R("sales_admin"), R("sales_salesperson")]);
  });
});

describe("module default roles", () => {
  it("seeds the four sales roles as system roles on enable, once, keeping admin edits", async () => {
    await enableSales();
    const roles = () => getDB().roles.filter((r) => r.workspaceId === "ws_platform" && r.key?.startsWith("sales_"));
    expect(roles().map((r) => [r.name, r.isSystem, r.dataScopes?.["sales.dashboard.view"]])).toEqual([
      ["Sales Admin", true, "all"],
      ["CEO / GM", true, "all"],
      ["Sales Manager", true, "team"],
      ["Salesperson", true, "own"],
    ]);
    roles()[3]!.dataScopes = { "sales.dashboard.view": "team" };
    await call("PUT", "/workspaces/platform/modules/sales", { enabled: false });
    await enableSales();
    expect(roles()).toHaveLength(4);
    expect(roles()[3]!.dataScopes).toEqual({ "sales.dashboard.view": "team" });
  });

  it("renames on a name clash and skips when both names are taken", async () => {
    await call("POST", "/workspaces/platform/roles", { name: "Salesperson", scope: "workspace", permissions: ["core.workspace.view"] });
    await call("POST", "/workspaces/platform/roles", { name: "Sales Manager", scope: "workspace", permissions: ["core.workspace.view"] });
    await call("POST", "/workspaces/platform/roles", { name: "Sales Manager (Sales)", scope: "workspace", permissions: ["core.workspace.view"] });
    await enableSales();
    const sys = getDB().roles.filter((r) => r.workspaceId === "ws_platform" && r.key?.startsWith("sales_")).map((r) => r.name);
    expect(sys).toEqual(["Sales Admin", "CEO / GM", "Salesperson (Sales)"]);
  });

  it("gates the Sales placeholder on sales.dashboard.view", async () => {
    await enableSales();
    expect(await call("GET", "/sales/workspaces/platform/health")).toMatchObject({ status: "ok" });
    const ws = await workspace();
    expect(ws.my_permissions).toContain("sales.dashboard.view");
  });
});

describe("workspace time zone", () => {
  it("validates, stores and audits the IANA name", async () => {
    const e = await failure(call("PATCH", "/workspaces/platform", { timezone: "Mars/Olympus" }));
    expect(e.fieldErrors).toEqual({ timezone: "Pick a valid time zone" });
    expect((await failure(call("PATCH", "/workspaces/platform", { timezone: "" }))).fieldErrors.timezone).toBe("Pick a valid time zone");

    const ws = await call<Workspace>("PATCH", "/workspaces/platform", { timezone: "Asia/Tokyo" });
    expect(ws.timezone).toBe("Asia/Tokyo");
    expect((await workspace()).timezone).toBe("Asia/Tokyo");
    const page = await call<AuditPage>("GET", "/workspaces/platform/audit");
    expect(page.data[0]!.changes).toEqual([{ field: "Time zone", kind: "value", before: "Africa/Addis_Ababa", after: "Asia/Tokyo" }]);

    as("u_sam");
    expect((await failure(call("PATCH", "/workspaces/platform", { timezone: "UTC" }))).status).toBe(403);
  });

  it("gives new workspaces the default zone", async () => {
    const ws = await call<Workspace>("POST", "/workspaces", { name: "Revenue team", slug: "revenue-team" });
    expect(ws.timezone).toBe("Africa/Addis_Ababa");
  });
});
