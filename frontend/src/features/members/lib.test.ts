import { describe, expect, it } from "vitest";
import type { Permission, Role } from "@/lib/api/types";
import { PERMISSION_CATALOGUE } from "@/lib/permissions/catalogue";
import {
  addChips,
  assignableRoles,
  changeCount,
  changedKeys,
  classifyChips,
  consumeTyping,
  copyName,
  defaultRole,
  diffPermissions,
  EMAIL_RE,
  groupCatalogue,
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
    const saved = { name: "QA lead", description: "x", permissions: ["task.create"] as Permission[] };
    expect(changeCount(saved, { ...saved })).toBe(0);
    expect(changeCount(saved, { ...saved, permissions: ["sprint.manage"] })).toBe(2);
    expect(changeCount(saved, { ...saved, name: "QA", description: "y" })).toBe(2);
    expect(changeCount(saved, { ...saved, name: " QA lead " })).toBe(0);
  });
  it("toggles idempotently", () => {
    expect(togglePermission(["task.create"], "task.create", true)).toEqual(["task.create"]);
    expect(togglePermission(["task.create"], "task.create", false)).toEqual([]);
  });
  it("groups the catalogue in design order", () => {
    const groups = groupCatalogue(PERMISSION_CATALOGUE, "project").map((g) => g.group);
    expect(groups).toEqual(["Tasks", "Planning", "Collaboration", "Reports", "Administration"]);
  });
});

describe("roles", () => {
  const owner = role("owner", "workspace", true, ["workspace.view", "workspace.delete"]);
  const admin = role("admin", "workspace", true, ["workspace.view", "workspace.update", "workspace.manage_members"]);
  const member = role("member", "workspace", true, ["workspace.view"]);
  const padmin = role("padmin", "project", true, ["project.view", "project.manage_members", "project.delete", "task.create"]);
  const pmember = role("pmember", "project", true, ["project.view", "task.create"]);
  const viewer = role("viewer", "project", true, ["project.view"]);
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
