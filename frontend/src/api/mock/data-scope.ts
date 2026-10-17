import { DATA_SCOPES, type DataScope, type DataScopeMap } from "@/api/types";
import { PERMISSION_CATALOGUE, isScopable } from "@/platform/roles/catalogue";
import type { MockDB, RoleRec } from "./db-types";
import { wsMembership } from "./derive";
import { onlyEnabled } from "./modules";
import { fail, invalid } from "./router";

/*
 * Platform Stage 4 (docs/platform/stage4-contract.md §2): the mock side of `RolePermission.data_scope`.
 * Scopable codes come from the catalogue (`scopable: true`, workspace scope only). No real module has one yet;
 * tests push a fixture entry into PERMISSION_CATALOGUE.
 */

const scopable = (code: string) =>
  isScopable(PERMISSION_CATALOGUE, code) && PERMISSION_CATALOGUE.some((p) => p.key === code && p.scope === "workspace");

/**
 * The stored scope map after a role write. `granted` is the role's final permission list; `incoming` is the request's
 * `dataScopes` (undefined when the request leaves it out); `prev` is the stored map. Fails with 400
 * `data_scope_not_allowed` for a scope on a non-scopable code and 400 `data_scope_required` for a granted scopable
 * code with no scope. Scopes for scopable codes the role doesn't grant are dropped.
 */
export function resolveDataScopes(granted: readonly string[], incoming: unknown, prev: DataScopeMap = {}): DataScopeMap {
  if (incoming !== undefined && (incoming === null || typeof incoming !== "object" || Array.isArray(incoming))) {
    invalid({ dataScopes: "Send an object of permission code → scope" });
  }
  const given = (incoming ?? {}) as Record<string, unknown>;
  const notAllowed = Object.keys(given).filter((c) => !scopable(c));
  if (notAllowed.length) {
    fail(400, "data_scope_not_allowed", "Only scopable permissions take a data scope.", { codes: notAllowed });
  }
  const bad = Object.entries(given).filter(([, v]) => !(DATA_SCOPES as readonly unknown[]).includes(v));
  if (bad.length) invalid({ dataScopes: "Use own, team or all" });
  const out: DataScopeMap = {};
  const missing: string[] = [];
  for (const code of granted) {
    if (!scopable(code)) continue;
    const s = (given[code] as DataScope | undefined) ?? prev[code];
    if (s) out[code] = s;
    else missing.push(code);
  }
  if (missing.length) fail(400, "data_scope_required", "Choose Own, Team or All for each scoped permission.", { codes: missing });
  return out;
}

/** Role responses: the scope of each granted, enabled scopable code. */
export function roleDataScopes(db: MockDB, r: RoleRec): DataScopeMap {
  const out: DataScopeMap = {};
  for (const code of onlyEnabled(db, r.workspaceId, r.permissions as string[])) {
    const s = r.dataScopes?.[code];
    if (s && scopable(code)) out[code] = s;
  }
  return out;
}

/** `myDataScopes`: the scopable codes the user holds in the workspace (disabled modules excluded). */
export function myDataScopes(db: MockDB, userId: string, workspaceId: string): DataScopeMap {
  const m = wsMembership(db, userId, workspaceId);
  const role = m && db.roles.find((r) => r.id === m.roleId);
  return role ? roleDataScopes(db, role) : {};
}
