import type { DataScope, ModuleNavItemInfo, Permission, WorkspaceModule } from "@/api/types";
import { OWNER_ADMIN_SALES_CODES, PERMISSION_CATALOGUE, isScopable } from "@/platform/roles/catalogue";
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
  /** Sales S0 (s0-contract §4): workspace system roles the module contributes, created on enable when missing. */
  defaultRoles?: MockDefaultRole[];
}

/** The backend's `DefaultRole(key, name, description, grants={code: scope | None})`. `key` is the role's system key. */
export interface MockDefaultRole {
  key: string;
  name: string;
  description: string;
  /** Code → data scope for scopable codes (null = `own`), null for the others. */
  grants: Record<string, DataScope | null>;
}

/**
 * The backend's sales GRANT_TABLE (`modules/sales/module.py`): code → granted to Sales Admin, CEO / GM,
 * Sales Manager, Salesperson (1 = granted).
 */
const SALES_GRANT_TABLE: [string, ...(0 | 1)[]][] = [
  ["sales.dashboard.view", 1, 1, 1, 1],
  ["sales.company.view", 1, 1, 1, 1],
  ["sales.company.create", 1, 0, 1, 1],
  ["sales.company.edit", 1, 0, 1, 1],
  ["sales.company.delete", 1, 0, 0, 0],
  ["sales.contact.view", 1, 1, 1, 1],
  ["sales.contact.create", 1, 0, 1, 1],
  ["sales.contact.edit", 1, 0, 1, 1],
  ["sales.contact.delete", 1, 0, 0, 0],
  ["sales.lead.view", 1, 1, 1, 1],
  ["sales.lead.create", 1, 0, 1, 1],
  ["sales.lead.edit", 1, 0, 1, 1],
  ["sales.lead.delete", 1, 0, 1, 0],
  ["sales.lead.assign", 1, 0, 1, 0],
  ["sales.lead.convert", 1, 0, 1, 1],
  ["sales.opportunity.view", 1, 1, 1, 1],
  ["sales.opportunity.create", 1, 0, 1, 1],
  ["sales.opportunity.edit", 1, 0, 1, 1],
  ["sales.opportunity.move", 1, 0, 1, 1],
  ["sales.opportunity.close", 1, 0, 1, 1],
  ["sales.opportunity.delete", 1, 0, 0, 0],
  ["sales.opportunity.assign", 1, 0, 1, 0],
  ["sales.opportunity.reopen", 1, 0, 0, 0],
  ["sales.quotation.view", 1, 1, 1, 1],
  ["sales.quotation.create", 1, 0, 1, 1],
  ["sales.quotation.edit", 1, 0, 1, 1],
  ["sales.quotation.delete", 1, 0, 1, 0],
  ["sales.activity.view", 1, 1, 1, 1],
  ["sales.activity.create", 1, 0, 1, 1],
  ["sales.activity.edit", 1, 0, 1, 1],
  ["sales.activity.delete", 1, 0, 1, 1],
  ["sales.followup.view", 1, 1, 1, 1],
  ["sales.followup.create", 1, 0, 1, 1],
  ["sales.followup.edit", 1, 0, 1, 1],
  ["sales.followup.complete", 1, 0, 1, 1],
  ["sales.followup.reassign", 1, 0, 1, 0],
  ["sales.followup.delete", 1, 0, 1, 1],
  ["sales.target.view", 1, 1, 1, 1],
  ["sales.target.manage", 1, 1, 1, 0],
  ["sales.dailyreport.submit", 1, 0, 1, 1],
  ["sales.dailyreport.view", 1, 1, 1, 1],
  ["sales.dailyreport.review", 1, 1, 1, 0],
  ["sales.performance.view", 1, 1, 1, 1],
  ["sales.report.view", 1, 1, 1, 0],
  ["sales.report.export", 1, 1, 1, 0],
  ["sales.settings.manage", 1, 0, 0, 0],
];

const SALES_ROLE_COLUMNS: [key: string, name: string, scope: DataScope, description: string][] = [
  ["sales_admin", "Sales Admin", "all", "Everything in Sales, including settings."],
  ["sales_ceo", "CEO / GM", "all", "Sees everything, reviews reports and sets targets; no day-to-day editing."],
  ["sales_manager", "Sales Manager", "team", "Runs the team's pipeline, targets and daily reports."],
  ["sales_salesperson", "Salesperson", "own", "Works their own customers, leads and deals."],
];

/** The four sales default roles; each also grants `core.workspace.view`. Scopable codes carry the role's scope. */
function salesDefaultRoles(): MockDefaultRole[] {
  return SALES_ROLE_COLUMNS.map(([key, name, scope, description], i) => {
    const grants: Record<string, DataScope | null> = { "core.workspace.view": null };
    for (const [code, ...row] of SALES_GRANT_TABLE) {
      if (row[i]) grants[code] = isScopable(PERMISSION_CATALOGUE, code) ? scope : null;
    }
    return { key, name, description, grants };
  });
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
      // As the backend's tracking module declares them (Stage 5: `permission` is never null).
      { key: "projects", label: "Projects", icon: "folder", path: "", permission: "core.workspace.view" },
      { key: "my-tasks", label: "My tasks", icon: "check-square", path: "my-tasks", permission: "core.workspace.view" },
      { key: "timesheet", label: "Timesheet", icon: "clock", path: "timesheet", permission: "core.workspace.view" },
    ],
    defaultRoleGrants: {},
  },
  {
    key: "sales",
    name: "Sales",
    description: "Customers, leads, pipeline, targets and daily reports for sales teams.",
    isCore: false,
    toggleable: true,
    dependsOn: [],
    navItems: [{ key: "sales", label: "Sales", icon: "briefcase", path: "sales", permission: "sales.dashboard.view" }],
    // Owner and Admin: every sales code with scope `all` (seedGrants' default for them) except daily-report submit.
    defaultRoleGrants: { owner: OWNER_ADMIN_SALES_CODES, admin: OWNER_ADMIN_SALES_CODES },
    defaultRoles: salesDefaultRoles(),
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
    seedDefaultRoles(db, workspaceId, key);
  }
  return row;
}

/**
 * Sales S0 (s0-contract §4): creates the module's missing default roles as system roles. A role found by its system
 * key is left as it is (admin edits survive). A taken name becomes "<name> (<module name>)"; if that's taken too,
 * the role is skipped.
 */
export function seedDefaultRoles(db: MockDB, workspaceId: string, key: string) {
  const def = moduleDef(key);
  for (const r of def?.defaultRoles ?? []) {
    const roles = db.roles.filter((x) => x.workspaceId === workspaceId && x.scope === "workspace");
    if (roles.some((x) => x.key === r.key)) continue;
    const taken = (n: string) => roles.some((x) => x.name.toLowerCase() === n.toLowerCase());
    const name = !taken(r.name) ? r.name : !taken(`${r.name} (${def!.name})`) ? `${r.name} (${def!.name})` : null;
    if (!name) continue;
    const permissions = Object.keys(r.grants) as Permission[];
    const dataScopes: Record<string, DataScope> = {};
    for (const [code, scope] of Object.entries(r.grants)) {
      if (isScopable(PERMISSION_CATALOGUE, code)) dataScopes[code] = scope ?? "own";
    }
    db.roles.push({
      id: `${workspaceId}-role-${r.key}`,
      workspaceId,
      key: r.key,
      name,
      description: r.description,
      scope: "workspace",
      isSystem: true,
      permissions,
      dataScopes,
    });
  }
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
