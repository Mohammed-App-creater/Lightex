import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiError } from "@/api/errors";
import type { Role, SearchResult, Workspace, WorkspaceModule } from "@/api/types";
import { mockControls } from "./controls";
import { getDB, mockSession, resetDB } from "./db";
import { MODULE_DEFS } from "./modules";
import { mockBus } from "./realtime";
import { MockTransport } from "./transport";

/* Platform Stage 3 (docs/platform/stage3-contract.md §3–§4): modules API, guard and hiding effects in the mock. */

const t = new MockTransport();
const as = (userId: string | null) => mockSession.set(userId);
const req = <T,>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) => t.request<T>({ method, path, body });

async function rejects(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected rejection");
}

const setSales = (enabled: boolean) => req<WorkspaceModule>("PUT", "/workspaces/platform/modules/sales", { enabled });

beforeEach(() => {
  resetDB();
  mockControls.set((c) => ({ ...c, errorRate: 0, latencyMin: 0, latencyMax: 0, offline: false, teammates: false }));
  as("u_alex");
});

describe("GET workspaces/{slug}/modules", () => {
  it("lists core, tracking and sales for any member; core and tracking on, sales off with no nav items", async () => {
    as("u_taylor");
    const list = await req<WorkspaceModule[]>("GET", "/workspaces/platform/modules");
    expect(list.map((m) => [m.key, m.enabled, m.toggleable])).toEqual([
      ["core", true, false],
      ["tracking", true, false],
      ["sales", false, true],
    ]);
    expect(list.find((m) => m.key === "core")).toMatchObject({ isCore: true, enabledAt: null, enabledBy: null });
    expect(list.find((m) => m.key === "sales")!.navItems).toEqual([]);
    const ws = await req<Workspace>("GET", "/workspaces/platform");
    expect(ws.enabledModules).toEqual(["core", "tracking"]);
  });
});

describe("core.module.changed (Stage 5)", () => {
  it("is published to the workspace on a real toggle, and not for a no-op", async () => {
    const seen: { type: string; ws?: string; projectId?: string | null; data: unknown }[] = [];
    const off = mockBus.subscribe((e) => seen.push(e));
    await setSales(true);
    await setSales(true);
    await setSales(false);
    off();
    const events = seen.filter((e) => e.type === "core.module.changed");
    expect(events.map((e) => e.data)).toEqual([
      { module: "sales", enabled: true },
      { module: "sales", enabled: false },
    ]);
    expect(events[0]).toMatchObject({ ws: "ws_platform", projectId: null });
  });
});

describe("the module guard", () => {
  it("returns 403 module_disabled for a disabled module's routes, and serves them once it's on", async () => {
    const e = await rejects(req("GET", "/sales/workspaces/platform/health"));
    expect(e.status).toBe(403);
    expect(e.code).toBe("module_disabled");
    expect(e.details).toEqual({ module: "sales" });

    const m = await setSales(true);
    expect(m).toMatchObject({ key: "sales", enabled: true, enabledBy: "u_alex" });
    expect(m.navItems).toEqual([{ key: "sales", label: "Sales", icon: "briefcase", path: "sales", permission: "sales.health.view" }]);
    expect(await req("GET", "/sales/workspaces/platform/health")).toEqual({ status: "ok", module: "sales", workspace: "platform" });
  });

  it("still 404s for workspaces the user isn't in, and requires the route's permission when on", async () => {
    await setSales(true);
    as("u_drew");
    expect((await rejects(req("GET", "/sales/workspaces/platform/health"))).status).toBe(404);
    // A custom workspace role without sales.health.view.
    as("u_alex");
    const role = await req<Role>("POST", "/workspaces/platform/roles", { name: "Limited", scope: "workspace", permissions: ["core.workspace.view"] });
    getDB().wsMembers.find((m) => m.userId === "u_sam" && m.workspaceId === "ws_platform")!.roleId = role.id;
    as("u_sam");
    expect((await rejects(req("GET", "/sales/workspaces/platform/health"))).code).toBe("forbidden");
  });

  it("resolves the workspace from objects in the path (projects, tasks) for tracking routes", async () => {
    // Tracking can't be turned off through the API; flip its row directly to exercise the guard.
    getDB().workspaceModules.find((r) => r.workspaceId === "ws_platform" && r.moduleKey === "tracking")!.enabled = false;
    expect((await rejects(req("GET", "/tracking/projects/p_prj/statuses"))).code).toBe("module_disabled");
    expect((await rejects(req("GET", "/tracking/tasks/p_prj-t42/activity"))).code).toBe("module_disabled");
    expect((await rejects(req("GET", "/tracking/workspaces/platform/projects"))).code).toBe("module_disabled");
    // Another workspace is unaffected.
    expect(Array.isArray(await req("GET", "/tracking/workspaces/design-guild/projects"))).toBe(true);
    // Search skips tracking's providers.
    const results = await req<SearchResult[]>("GET", "/workspaces/platform/search", undefined);
    expect(results.some((r) => r.type === "task" || r.type === "project")).toBe(false);
  });
});

describe("PUT workspaces/{slug}/modules/{key}", () => {
  afterEach(() => {
    const i = MODULE_DEFS.findIndex((m) => m.key === "crm");
    if (i >= 0) MODULE_DEFS.splice(i, 1);
  });

  it("needs core.modules.manage, 404s an unknown key and refuses non-toggleable modules", async () => {
    as("u_sam");
    expect((await rejects(setSales(true))).status).toBe(403);
    as("u_alex");
    expect((await rejects(req("PUT", "/workspaces/platform/modules/nope", { enabled: true }))).status).toBe(404);
    for (const key of ["core", "tracking"]) {
      const e = await rejects(req("PUT", `/workspaces/platform/modules/${key}`, { enabled: false }));
      expect([e.status, e.code]).toEqual([400, "module_not_toggleable"]);
    }
    expect((await rejects(req("PUT", "/workspaces/platform/modules/sales", { enabled: "yes" }))).status).toBe(422);
  });

  it("returns 400 module_dependency with details.modules both ways", async () => {
    MODULE_DEFS.push({ key: "crm", name: "CRM", description: "", isCore: false, toggleable: true, dependsOn: ["sales"], navItems: [], defaultRoleGrants: {} });
    const enable = await rejects(req("PUT", "/workspaces/platform/modules/crm", { enabled: true }));
    expect([enable.status, enable.code, enable.details]).toEqual([400, "module_dependency", { modules: ["sales"] }]);
    await setSales(true);
    await req("PUT", "/workspaces/platform/modules/crm", { enabled: true });
    const disable = await rejects(setSales(false));
    expect([disable.status, disable.code, disable.details]).toEqual([400, "module_dependency", { modules: ["crm"] }]);
  });

  it("audits the change and is idempotent", async () => {
    await setSales(true);
    await setSales(true);
    await setSales(false);
    const actions = getDB().audit.filter((a) => a.action.startsWith("core.module.")).map((a) => a.action);
    expect(actions).toEqual(["core.module.disabled", "core.module.enabled"]);
  });
});

describe("hiding effects", () => {
  it("hides a disabled module's permissions from my_permissions and roles, keeps the stored grants, and restores them", async () => {
    const perms = async () => (await req<Workspace>("GET", "/workspaces/platform")).my_permissions;
    const ownerRole = async () => (await req<Role[]>("GET", "/workspaces/platform/roles")).find((r) => r.id === "ws_platform-role-owner")!;
    expect(await perms()).not.toContain("sales.health.view");
    expect((await ownerRole()).permissions).not.toContain("sales.health.view");

    await setSales(true);
    expect(await perms()).toContain("sales.health.view");
    expect((await ownerRole()).permissions).toContain("sales.health.view");

    // A custom role granted sales, saved while sales is off: the hidden grant survives.
    const custom = await req<Role>("POST", "/workspaces/platform/roles", { name: "Sales lead", scope: "workspace", permissions: ["core.workspace.view", "sales.health.view"] });
    await setSales(false);
    const saved = await req<Role>("PATCH", `/roles/${custom.id}`, { permissions: ["core.workspace.view", "core.audit.view"] });
    expect(saved.permissions).toEqual(["core.workspace.view", "core.audit.view"]);
    expect(getDB().roles.find((r) => r.id === custom.id)!.permissions).toContain("sales.health.view");
    // The global catalogue still lists everything, with module.
    const catalogue = await req<{ key: string; module: string }[]>("GET", "/permissions");
    expect(catalogue.find((p) => p.key === "sales.health.view")).toMatchObject({ module: "sales" });

    await setSales(true);
    expect((await req<Role[]>("GET", "/workspaces/platform/roles")).find((r) => r.id === custom.id)!.permissions).toContain("sales.health.view");
  });

  it("enabling re-seeds the default grants on system roles idempotently", async () => {
    const owner = getDB().roles.find((r) => r.id === "ws_platform-role-owner")!;
    owner.permissions = owner.permissions.filter((p) => p !== "sales.health.view");
    await setSales(true);
    await setSales(false);
    await setSales(true);
    expect(owner.permissions.filter((p) => p === "sales.health.view")).toHaveLength(1);
  });
});

describe("POST workspaces with modules", () => {
  it("enables tracking plus the requested modules", async () => {
    const ws = await req<Workspace>("POST", "/workspaces", { name: "Revenue team", slug: "revenue-team", modules: ["sales"] });
    expect(ws.enabledModules).toEqual(["core", "tracking", "sales"]);
    expect(ws.my_permissions).toContain("sales.health.view");
    const plain = await req<Workspace>("POST", "/workspaces", { name: "Plain team", slug: "plain-team" });
    expect(plain.enabledModules).toEqual(["core", "tracking"]);
    expect((await rejects(req("POST", "/workspaces", { name: "Odd team", slug: "odd-team", modules: ["nope"] }))).status).toBe(422);
  });
});
