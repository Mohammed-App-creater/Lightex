import { describe, expect, it, vi } from "vitest";
import type { Notification, WorkspacePermission } from "@/api/types";
import { MODULES, activeModules, isModuleEnabled, moduleNavItems, projectNavItems, routeAccess, shellOverlays, targetPreviewsFor } from "./index";

// next/dynamic doesn't resolve under jsdom; the registry only needs the overlay's shape.
vi.mock("@/lib/hooks/lazy-with-preload", () => ({ lazyWithPreload: () => ({ Component: () => null, preload: () => {} }), whenIdle: () => () => {} }));

/* Platform Stage 3: every registry slot is filtered by the workspace's enabledModules plus my_permissions. */

const ctx = (enabledModules: string[], my_permissions: WorkspacePermission[] = ["core.workspace.view"]) => ({ enabledModules, my_permissions });
const ids = (items: { id: string }[]) => items.map((i) => i.id);

describe("registry filtering", () => {
  it("lists tracking and sales, with core always on", () => {
    expect(MODULES.map((m) => m.key)).toEqual(["tracking", "sales"]);
    expect(isModuleEnabled(ctx([]), "core")).toBe(true);
    expect(activeModules(ctx(["core", "tracking"])).map((m) => m.key)).toEqual(["tracking"]);
  });

  it("hides a disabled module's nav items, project nav and overlays", () => {
    expect(ids(moduleNavItems(ctx(["core", "tracking"], ["core.workspace.view", "sales.dashboard.view"])))).toEqual(["my-tasks", "timesheet"]);
    expect(ids(moduleNavItems(ctx(["core"])))).toEqual([]);
    expect(projectNavItems(ctx(["core"]))).toEqual([]);
    expect(shellOverlays(ctx(["core"]))).toEqual([]);
    expect(shellOverlays(ctx(["core", "tracking"])).map((o) => o.id)).toEqual(["tracking.create-task"]);
  });

  it("shows an enabled module's items only with their permission", () => {
    const on = ["core", "tracking", "sales"];
    expect(ids(moduleNavItems(ctx(on, ["core.workspace.view"])))).toEqual(["my-tasks", "timesheet"]);
    expect(ids(moduleNavItems(ctx(on, ["core.workspace.view", "sales.dashboard.view"])))).toEqual(["my-tasks", "timesheet", "sales"]);
  });

  it("guards routes: disabled module, missing permission, or open", () => {
    const perms: WorkspacePermission[] = ["core.workspace.view", "sales.dashboard.view"];
    expect(routeAccess(ctx(["core", "tracking"], perms), "sales")).toMatchObject({ kind: "disabled", module: { key: "sales", name: "Sales" } });
    expect(routeAccess(ctx(["core", "tracking", "sales"], ["core.workspace.view"]), "sales")).toMatchObject({ kind: "forbidden", permission: "sales.dashboard.view" });
    expect(routeAccess(ctx(["core", "tracking", "sales"], perms), "sales")).toEqual({ kind: "ok" });
    expect(routeAccess(ctx(["core"]), "projects")).toMatchObject({ kind: "disabled", module: { key: "tracking" } });
    // Core routes are never guarded.
    expect(routeAccess(ctx(["core"]), "settings")).toEqual({ kind: "ok" });
    expect(routeAccess(ctx(["core"]), undefined)).toEqual({ kind: "ok" });
  });

  it("picks a notification's target preview from an enabled module (by targetType, or the taskKey fallback)", () => {
    const n = (over: Partial<Notification>) => ({ taskKey: null, targetType: null, ...over }) as Notification;
    const on = ctx(["core", "tracking"]);
    expect(targetPreviewsFor(on, n({ targetType: "tracking.task", taskKey: "PRJ-1" })).map((p) => p.targetType)).toEqual(["tracking.task"]);
    expect(targetPreviewsFor(on, n({ taskKey: "PRJ-1" }))).toHaveLength(1);
    expect(targetPreviewsFor(on, n({ targetType: "tracking.project" }))).toEqual([]);
    expect(targetPreviewsFor(ctx(["core"]), n({ targetType: "tracking.task", taskKey: "PRJ-1" }))).toEqual([]);
  });
});
