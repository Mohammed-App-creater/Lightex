import { describe, expect, it } from "vitest";
import type { Permission, Role } from "@/api/types";
import { PERMISSION_CATALOGUE } from "@/platform/roles/catalogue";
import {
  addChips,
  assignableRoles,
  canGrantRole,
  canRemoveMember,
  filterMembers,
  roleNamesOf,
  rolesLabel,
  roleToggleBlock,
  toggleRoleId,
  changeCount,
  changedKeys,
  classifyChips,
  consumeTyping,
  copyName,
  defaultRole,
  diffPermissions,
  EMAIL_RE,
  enabledCatalogue,
  groupCatalogue,
  groupCatalogueByModule,
  inviteHint,
  inviteMessage,
  isOwnerRole,
  lastActiveLabel,
  MAX_CHIPS,
  projectAdminRole,
  roleNameError,
  sendLabel,
  splitEmails,
  togglePermission,
} from "./lib";

const role = (id: string, scope: Role["scope"], isSystem: boolean, permissions: string[]): Role => ({
  id,
  workspaceId: "ws",
  name: id,
  description: "",
  scope,
  isSystem,
  permissions: permissions as Permission[],
  memberCount: 0,
  dataScopes: {},
});

describe("email chips", () => {
  it("validates with the design regex", () => {
    expect(EMAIL_RE.test("priya@team.dev")).toBe(true);
    expect(EMAIL_RE.test("jamie@team")).toBe(false);
    expect(EMAIL_RE.test("a b@team.dev")).toBe(false);
    expect(EMAIL_RE.test("x@y.c")).toBe(false);
  });
  it("splits on space, comma and semicolon, lowercased", () => {
    expect(splitEmails(" A@b.co, c@d.io;e@f.dev  ")).toEqual(["a@b.co", "c@d.io", "e@f.dev"]);
  });
  it("keeps the text after the last separator in the input", () => {
    expect(consumeTyping("a@b.co, c@d")).toEqual({ chips: ["a@b.co"], rest: "c@d" });
    expect(consumeTyping("a@b.co")).toEqual({ chips: [], rest: "a@b.co" });
  });
  it("dedupes and caps at 20", () => {
    expect(addChips(["a@b.co"], ["a@b.co", "c@d.io"])).toEqual(["a@b.co", "c@d.io"]);
    const many = Array.from({ length: 30 }, (_, i) => `u${i}@x.io`);
    expect(addChips([], many)).toHaveLength(MAX_CHIPS);
  });
  it("classifies chips and builds the design copy", () => {
    const chips = classifyChips(["priya@team.dev", "sam@team.dev", "jamie@team"], ["SAM@team.dev"]);
    expect(chips.map((c) => c.state)).toEqual(["ok", "dup", "bad"]);
    expect(inviteMessage(chips, "Platform team")).toEqual({ tone: "error", text: "“jamie@team” isn’t a valid email" });
    expect(inviteHint(chips)).toBe("Fix invalid emails to send");
    const noBad = chips.filter((c) => c.state !== "bad");
    expect(inviteMessage(noBad, "Platform team")?.text).toBe("sam@team.dev already in Platform team · skipped");
    expect(inviteHint([])).toBe("Enter or comma adds an email");
    expect(sendLabel(1)).toBe("Send invite");
    expect(sendLabel(3)).toBe("Send 3 invites");
  });
});

describe("permission matrix", () => {
  it("diffs saved vs draft", () => {
    expect(diffPermissions(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
    expect([...changedKeys(["a"], ["b"])].sort()).toEqual(["a", "b"]);
  });
  it("counts toggles plus name and description changes", () => {
    const saved = { name: "QA lead", description: "x", permissions: ["tracking.task.create"] as Permission[] };
    expect(changeCount(saved, { ...saved })).toBe(0);
    expect(changeCount(saved, { ...saved, permissions: ["tracking.sprint.manage"] })).toBe(2);
    expect(changeCount(saved, { ...saved, name: "QA", description: "y" })).toBe(2);
    expect(changeCount(saved, { ...saved, name: " QA lead " })).toBe(0);
  });
  it("toggles idempotently", () => {
    expect(togglePermission(["tracking.task.create"], "tracking.task.create", true)).toEqual(["tracking.task.create"]);
    expect(togglePermission(["tracking.task.create"], "tracking.task.create", false)).toEqual([]);
  });
  it("groups the catalogue in design order", () => {
    const groups = groupCatalogue(PERMISSION_CATALOGUE, "project").map((g) => g.group);
    expect(groups).toEqual(["Tasks", "Planning", "Collaboration", "Reports", "Administration"]);
  });
  it("groups workspace permissions by module (core first) and hides disabled modules (platform Stage 3)", () => {
    const order = ["tracking", "sales"];
    const off = groupCatalogueByModule(PERMISSION_CATALOGUE, "workspace", ["core", "tracking"], order);
    expect(off.map((m) => m.module)).toEqual(["core", "tracking"]);
    const on = groupCatalogueByModule(PERMISSION_CATALOGUE, "workspace", ["core", "tracking", "sales"], order);
    expect(on.map((m) => m.module)).toEqual(["core", "tracking", "sales"]);
    const salesKeys = on.at(-1)!.groups.flatMap((g) => g.items.map((p) => p.key));
    expect(salesKeys).toHaveLength(46);
    expect(salesKeys[0]).toBe("sales.dashboard.view");
    expect(groupCatalogueByModule(PERMISSION_CATALOGUE, "project", ["core", "tracking"], order).map((m) => m.module)).toEqual(["tracking"]);
    expect(enabledCatalogue(PERMISSION_CATALOGUE, ["core", "tracking"]).some((p) => p.module === "sales")).toBe(false);
  });
});

describe("roles", () => {
  const owner = role("owner", "workspace", true, ["core.workspace.view", "core.workspace.delete"]);
  const admin = role("admin", "workspace", true, ["core.workspace.view", "core.workspace.update", "core.workspace.manage_members"]);
  const member = role("member", "workspace", true, ["core.workspace.view"]);
  const padmin = role("padmin", "project", true, ["tracking.project.view", "tracking.project.manage_members", "tracking.project.delete", "tracking.task.create"]);
  const pmember = role("pmember", "project", true, ["tracking.project.view", "tracking.task.create"]);
  const viewer = role("viewer", "project", true, ["tracking.project.view"]);
  const all = [owner, admin, member, padmin, pmember, viewer];

  it("never offers Owner", () => {
    expect(isOwnerRole(owner)).toBe(true);
    expect(assignableRoles(all, "workspace").map((r) => r.id)).toEqual(["admin", "member"]);
  });
  it("defaults to Member in both scopes", () => {
    expect(defaultRole(all, "workspace")?.id).toBe("member");
    expect(defaultRole(all, "project")?.id).toBe("pmember");
  });
  it("finds the Project Admin role", () => {
    expect(projectAdminRole(all)?.id).toBe("padmin");
  });
  it("names copies uniquely", () => {
    expect(copyName("QA lead", ["QA lead"])).toBe("Copy of QA lead");
    expect(copyName("QA lead", ["QA lead", "copy of qa lead"])).toBe("Copy of QA lead 2");
  });
  it("validates role names case-insensitively", () => {
    expect(roleNameError("  ", [])).toBe("Name is required");
    expect(roleNameError("admin", ["Admin"])).toBe("A role with this name exists");
    expect(roleNameError("QA", ["Admin"])).toBeNull();
  });
});

describe("lastActiveLabel", () => {
  const now = new Date("2026-10-07T12:00:00Z").getTime();
  const ago = (m: number) => new Date(now - m * 60_000).toISOString();
  it("formats like the design", () => {
    expect(lastActiveLabel(null, now)).toBe("—");
    expect(lastActiveLabel(ago(2), now)).toBe("Now");
    expect(lastActiveLabel(ago(12), now)).toBe("12m ago");
    expect(lastActiveLabel(ago(120), now)).toBe("2h ago");
    expect(lastActiveLabel(ago(60 * 26), now)).toBe("Yesterday");
    expect(lastActiveLabel(ago(60 * 72), now)).toBe("3d ago");
  });
});

describe("several roles per member (sales S0)", () => {
  const owner = role("owner", "workspace", true, ["core.workspace.view", "core.workspace.delete"]);
  const admin = role("admin", "workspace", true, ["core.workspace.view", "core.workspace.manage_members"]);
  const member = role("member", "workspace", true, ["core.workspace.view"]);
  const seller = role("seller", "workspace", true, ["core.workspace.view", "sales.dashboard.view"]);
  const roles = [owner, admin, member, seller];
  const adminPerms = ["core.workspace.view", "core.workspace.manage_members", "sales.dashboard.view"];

  it("can grant a role only when every permission is the viewer's", () => {
    expect(canGrantRole(seller, adminPerms)).toBe(true);
    expect(canGrantRole(owner, adminPerms)).toBe(false);
    // Sales S7: a self-service code (sales.dailyreport.submit) can be granted without holding it.
    expect(canGrantRole({ permissions: ["core.workspace.view", "sales.dailyreport.submit"] as Permission[] }, ["core.workspace.view"])).toBe(true);
  });

  it("explains why a checkbox is locked: Owner, the last role, then escalation", () => {
    expect(roleToggleBlock(owner, ["owner"], adminPerms)).toMatch(/Owner role/);
    expect(roleToggleBlock(member, ["member"], adminPerms)).toBe("Keep at least one role");
    expect(roleToggleBlock(member, ["member", "seller"], adminPerms)).toBeNull();
    expect(roleToggleBlock(seller, ["member"], ["core.workspace.view"])).toBe("It has permissions you don’t have");
    expect(roleToggleBlock(seller, ["member"], adminPerms)).toBeNull();
  });

  it("toggles ids in the roles' order", () => {
    expect(toggleRoleId(["seller"], "member", true, roles)).toEqual(["member", "seller"]);
    expect(toggleRoleId(["member", "seller"], "member", false, roles)).toEqual(["seller"]);
    expect(toggleRoleId(["member"], "member", true, roles)).toEqual(["member"]);
  });

  it("names, labels, filters and removal", () => {
    expect(roleNamesOf(["member", "gone", "seller"], roles)).toEqual(["member", "seller"]);
    expect(rolesLabel([])).toBe("Choose a role");
    expect(rolesLabel(["Member", "Salesperson"])).toBe("Member + Salesperson");
    expect(rolesLabel(["Admin", "Member", "Salesperson"])).toBe("Admin + 2 more");
    const people = [
      { userId: "a", roleId: "member", roleIds: ["member", "seller"], user: { name: "Ann", email: "ann@x.dev" } },
      { userId: "b", roleId: "member", roleIds: ["member"], user: { name: "Bob", email: "bob@x.dev" } },
    ] as unknown as Parameters<typeof filterMembers>[0];
    expect(filterMembers(people, "", "seller").map((m) => m.userId)).toEqual(["a"]);
    expect(filterMembers(people, "", "member").map((m) => m.userId)).toEqual(["a", "b"]);
    expect(canRemoveMember({ roleIds: ["owner", "member"] }, roles, adminPerms)).toBe(false);
    expect(canRemoveMember({ roleIds: ["member", "seller"] }, roles, adminPerms)).toBe(true);
  });
});
