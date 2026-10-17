import type { DataScope, ModuleNavItemInfo, Permission, WorkspaceModule } from "@/api/types";
import { PERMISSION_CATALOGUE, isScopable } from "@/platform/roles/catalogue";
import type { MockDB, WorkspaceModuleRec } from "./db-types";

/*
 * Platform Stage 3 (docs/platform/stage3-contract.md §1–§3): the mock side of the backend's module registry
 * (`core/modules`). Each definition mirrors a `ModuleDefinition`; `WorkspaceModuleRec` rows in the DB say which
 * modules a workspace has turned on. `core` has no row and is always on.
 */

export interface MockModuleDef {
  key: string;
  name: string;
  description: string;
  isCore: boolean;
  toggleable: boolean;
  dependsOn: string[];
  navItems: ModuleNavItemInfo[];
  /** Default role grants by system role key, seeded idempotently when the module is turned on. */
  defaultRoleGrants: Record<string, Permission[]>;
  /** Stage 4: scopes for scopable codes in `defaultRoleGrants`, by role key. Default: Owner / Admin `all`, others `own`. */
  defaultRoleScopes?: Record<string, Record<string, DataScope>>;
}

/** Registration order. Exported mutable so tests can register a module that depends on another. */
export const MODULE_DEFS: MockModuleDef[] = [
  {
    key: "core",
    name: "Core",
    description: "Workspace, members, roles, notifications, search and audit.",
    isCore: true,
    toggleable: false,
    dependsOn: [],
    navItems: [],
    defaultRoleGrants: {},
  },
  {
    key: "tracking",
    name: "Tracking",
    description: "Projects, boards, sprints, goals, reports and time tracking.",
    isCore: false,
    // Stage 3: tracking can't be turned off in this phase.
    toggleable: false,
    dependsOn: [],
    navItems: [
      { key: "my-tasks", label: "My tasks", icon: "circle-check", path: "my-tasks", permission: null },
      { key: "timesheet", label: "Timesheet", icon: "clock", path: "timesheet", permission: null },
    ],
    defaultRoleGrants: {},
  },
  {
    key: "sales",
    name: "Sales",
    description: "Leads, opportunities and pipeline health. A placeholder for now.",
    isCore: false,
    toggleable: true,
    dependsOn: [],
    navItems: [{ key: "sales", label: "Sales", icon: "briefcase", path: "sales", permission: "sales.health.view" }],
    defaultRoleGrants: { owner: ["sales.health.view"], admin: ["sales.health.view"], member: ["sales.health.view"] },
  },
];

export const moduleDef = (key: string) => MODULE_DEFS.find((m) => m.key === key);

/** The module that owns a permission code, event type or route: its first segment. */
export const moduleOfCode = (code: string) => code.slice(0, Math.max(0, code.indexOf("."))) || code;

/** `enabled_modules(workspace)`: "core" plus every module with an enabled row, in registration order. */
export function enabledModules(db: MockDB, workspaceId: string): string[] {
  const on = new Set(db.workspaceModules.filter((r) => r.workspaceId === workspaceId && r.enabled).map((r) => r.moduleKey));
  return MODULE_DEFS.filter((m) => m.isCore || on.has(m.key)).map((m) => m.key);
}

export const isModuleOn = (db: MockDB, workspaceId: string, key: string) => enabledModules(db, workspaceId).includes(key);

/** Keeps only codes whose module is on (my_permissions, role responses). Unknown prefixes pass through. */
export function onlyEnabled<T extends string>(db: MockDB, workspaceId: string, codes: readonly T[]): T[] {
  const on = enabledModules(db, workspaceId);
  return codes.filter((c) => {
    const m = moduleOfCode(c);
    return !moduleDef(m) || on.includes(m);
  });
}

export function moduleRow(db: MockDB, workspaceId: string, key: string): WorkspaceModuleRec | undefined {
  return db.workspaceModules.find((r) => r.workspaceId === workspaceId && r.moduleKey === key);
}

export function toWorkspaceModule(db: MockDB, workspaceId: string, def: MockModuleDef): WorkspaceModule {
  const row = moduleRow(db, workspaceId, def.key);
  const enabled = def.isCore || Boolean(row?.enabled);
  return {
    key: def.key,
    name: def.name,
    description: def.description,
    isCore: def.isCore,
    toggleable: def.toggleable,
    enabled,
    dependsOn: [...def.dependsOn],
    enabledAt: row?.enabledAt ?? null,
    enabledBy: row?.enabledBy ?? null,
    // A disabled module's nav items are not returned.
    navItems: enabled ? def.navItems.map((n) => ({ ...n })) : [],
  };
}

/** Turns a module on or off (creating its row), seeding default grants on enable. No checks: callers validate. */
export function writeModule(db: MockDB, workspaceId: string, key: string, enabled: boolean, actorId: string | null) {
  let row = moduleRow(db, workspaceId, key);
  if (!row) {
    row = { workspaceId, moduleKey: key, enabled: false, enabledBy: null, enabledAt: null, settings: {}, plan: null };
    db.workspaceModules.push(row);
  }
  row.enabled = enabled;
  if (enabled) {
    row.enabledBy = actorId;
    row.enabledAt = new Date().toISOString();
    seedGrants(db, workspaceId, key);
  }
  return row;
}

/** Enabling seeds the module's default role grants on the workspace's system roles, idempotently. */
function seedGrants(db: MockDB, workspaceId: string, key: string) {
  const def = moduleDef(key);
  const grants = def?.defaultRoleGrants ?? {};
  for (const role of db.roles) {
    if (role.workspaceId !== workspaceId || !role.isSystem || !role.key) continue;
    for (const code of grants[role.key] ?? []) {
      if (!role.permissions.includes(code)) role.permissions.push(code);
      // Stage 4: a scopable grant always carries a scope.
      if (isScopable(PERMISSION_CATALOGUE, code) && !role.dataScopes?.[code]) {
        const scope = def?.defaultRoleScopes?.[role.key]?.[code] ?? (role.key === "owner" || role.key === "admin" ? "all" : "own");
        role.dataScopes = { ...role.dataScopes, [code]: scope };
      }
    }
  }
}
