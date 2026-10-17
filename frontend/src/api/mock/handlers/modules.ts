import { MODULE_DEFS, enabledModules, isModuleOn, moduleDef, toWorkspaceModule, writeModule } from "../modules";
import { fail, invalid, requireWs, route, wsBySlug } from "../router";
import { audit } from "./workspaces";
import { mockBus } from "../realtime";

/*
 * Platform Stage 3 (docs/platform/stage3-contract.md §3, §4): the workspace's modules, and the sales module's
 * placeholder endpoint. The module guard (403 `module_disabled`) lives in `../router.ts`.
 */

/**
 * Validates `modules` on `POST /workspaces`: known, toggleable keys whose dependencies are also requested
 * (core and tracking are accepted and ignored: they're always on). Returns the keys to enable.
 */
export function creationModules(body: unknown): string[] {
  const raw = (body as { modules?: unknown } | null)?.modules;
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((k) => typeof k !== "string")) invalid({ modules: "Must be a list of module keys" });
  const keys = [...new Set(raw as string[])];
  const unknown = keys.filter((k) => !moduleDef(k));
  if (unknown.length) invalid({ modules: `Unknown module: ${unknown.join(", ")}` });
  const extra = keys.filter((k) => moduleDef(k)!.toggleable);
  const missing = extra.flatMap((k) => moduleDef(k)!.dependsOn).filter((d) => moduleDef(d)!.toggleable && !extra.includes(d));
  if (missing.length) fail(400, "module_dependency", "Some modules need others turned on too.", { modules: [...new Set(missing)] });
  return extra;
}

export function registerModules() {
  route("GET", "/workspaces/:slug/modules", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    return MODULE_DEFS.map((d) => toWorkspaceModule(ctx.db, ws.id, d));
  });

  route("PUT", "/workspaces/:slug/modules/:key", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "core.modules.manage");
    const def = moduleDef(ctx.params.key!);
    if (!def) fail(404, "not_found", "Module not found.");
    const enabled = (ctx.body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") invalid({ enabled: "Must be true or false" });
    if (!def.toggleable) fail(400, "module_not_toggleable", `${def.name} is always on.`);
    const on = enabledModules(ctx.db, ws.id);
    if (enabled) {
      const off = def.dependsOn.filter((d) => !on.includes(d));
      if (off.length) fail(400, "module_dependency", `Turn on ${names(off)} first.`, { modules: off });
    } else {
      const dependents = MODULE_DEFS.filter((m) => m.dependsOn.includes(def.key) && on.includes(m.key)).map((m) => m.key);
      if (dependents.length) fail(400, "module_dependency", `${names(dependents)} needs ${def.name}. Turn it off first.`, { modules: dependents });
    }
    if (isModuleOn(ctx.db, ws.id, def.key) !== enabled) {
      writeModule(ctx.db, ws.id, def.key, enabled, ctx.userId);
      audit(ctx.db, ws.id, ctx.userId!, enabled ? "core.module.enabled" : "core.module.disabled", def.name);
      // Stage 5: every member's sidebar and route guards follow (sent on commit, like the backend's publish).
      mockBus.publish("core.module.changed", { workspaceId: ws.id, projectId: null, actorId: ctx.userId, data: { module: def.key, enabled } });
    }
    return toWorkspaceModule(ctx.db, ws.id, def);
  });

  /* Sales skeleton (§4): a workspace path segment so the guard resolves the workspace like tracking routes. */
  route("GET", "/sales/workspaces/:slug/health", (ctx) => {
    const ws = wsBySlug(ctx, ctx.params.slug!);
    requireWs(ctx, ws.id, "sales.health.view");
    return { status: "ok", module: "sales", workspace: ws.slug };
  });
}

const names = (keys: string[]) => keys.map((k) => moduleDef(k)?.name ?? k).join(", ");
