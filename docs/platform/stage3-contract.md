# Stage 3 contract: module system

The parent document is `docs/platform-architecture.md` (sections 5, 6, 10 and 11). Stages 1 and 2 are committed: core no
longer imports modules, and tracking plugs in through `modules/tracking/hooks/`.

## 1. Backend: registry and definitions (`core/modules`)

- `ModuleDefinition` (dataclass): `key`, `name`, `description`, `is_core`, `depends_on`, `permissions` (a list of
  PermissionDefs), `default_role_grants` (role name → codes), `event_types` (key, label, default channels, and
  notification templates where the module needs them), `target_types`, `search_provider`, `nav_items`
  (`[{key, label, icon, path, permission}]`, where the path is relative to the workspace), `settings_schema`
  (optional), `toggleable`.
- `register_module(defn)` is called from each module's AppConfig `ready()`. Definitions:
  - `core` (in core: the `core.*` permissions, comment and attachment event types, and the core default roles).
  - `tracking` (`modules/tracking/module.py`): every `tracking.*` permission, its default grants, event types,
    templates and nav items. `toggleable=False` in this phase.
  - `sales` (`modules/sales/module.py`).
  Existing Stage 2 registries (target types, search, trash, events, realtime hooks) may stay as they are, but
  `ModuleDefinition` lists what the module contributes.
- **The permission catalogue is assembled from the definitions.** `core/access/catalogue.py` keeps only core's
  entries, and the tracking entries move into tracking. Sync runs on migrate and through a `sync_permissions`
  command. Task-shaped notification and channel templates move out of core into tracking's event-type
  declarations wherever that's practical.

## 2. WorkspaceModule

- Fields: `workspace`, `module_key`, `enabled`, `enabled_by` (nullable), `enabled_at`, `settings` (JSON, default `{}`)
  and `plan` (nullable, unused). Unique on (workspace, module_key).
- A data migration enables `tracking` for every existing workspace. A new workspace enables `tracking` plus the
  `modules` passed at creation.
- `core` has no row; it is always enabled.
- `enabled_modules(workspace)` is cached per request.

## 3. API (base `/api/v1/`)

- `GET workspaces/{slug}/modules` → a list, not paginated:
  `[{key, name, description, isCore, toggleable, enabled, dependsOn, enabledAt, enabledBy, navItems}]`. It includes
  `core`. Any workspace member may read it.
- `PUT workspaces/{slug}/modules/{key}` with body `{enabled: boolean}` → the module object. It requires
  `core.modules.manage` and writes the audit action `core.module.enabled` or `core.module.disabled`. Errors:
  - unknown key → 404;
  - not toggleable (core, tracking) → 400 `module_not_toggleable`;
  - disabling a module that another enabled module depends on, or enabling a module whose dependency is
    disabled → 400 `module_dependency` with `details: {modules: [...]}`.
  Enabling seeds the module's default role grants idempotently.
- Workspace responses (list, detail and create) include `enabledModules: string[]`, which always contains `core`.
  `POST workspaces` accepts an optional `modules: string[]`.
- **Guard:** every route under `{moduleKey}/…` for a disabled module returns 403 `module_disabled`. The workspace
  is resolved from the slug, project, task or other object in the path. Implement this once, for example as a
  DRF permission or base view mixin per module URLconf, not per view.
- **Disabled-module effects:**
  - its permissions are excluded from `my_permissions` and ignored by `can()`;
  - its event handlers and notification event types are skipped;
  - its search providers and trash kinds are skipped;
  - its nav items are not returned;
  - role responses (`workspaces/{slug}/roles` and role permissions) omit its permissions;
  - its data and `RolePermission` rows are untouched.
  Re-enabling restores everything. `GET permissions` (the global catalogue) still lists everything, with `module`.

## 4. Sales skeleton

- `modules/sales` Django app: `module.py` with permission `sales.health.view` (workspace scope), granted to Owner,
  Admin and Member. Toggleable. `depends_on=[]`. One nav item: `{key: "sales", label: "Sales", icon: "briefcase",
  path: "sales", permission: "sales.health.view"}`.
- `GET sales/workspaces/{slug}/health` → `{status: "ok", module: "sales", workspace: slug}`. It requires
  `sales.health.view` and is behind the guard. (A workspace path segment is used instead of the doc's bare
  `sales/health`, so the guard can resolve the workspace the same way tracking routes do.)
- import-linter: `modules.sales` and `modules.tracking` stay independent.

## 5. Frontend

- Types: `Workspace.enabledModules`, plus `WorkspaceModule` as above. Client: `api.modules.list(slug)` and
  `api.modules.set(slug, key, enabled)`. The mock implements all of section 3, including the guard (403
  `module_disabled`), dependency and toggle errors, and the hiding effects.
- `src/registry`: tracking and sales entries. The sidebar, command palette and route guards are built from
  `enabledModules` plus `my_permissions`. A disabled module's route renders a "Module disabled" screen (owners see a
  link to the Modules page).
- New screens:
  - **Settings → Modules** (`/[workspace]/settings/modules`): toggle cards. Disabling asks for confirmation
    with a message that data is kept. Non-toggleable modules show as always on. Gated by `core.modules.manage`.
  - **Onboarding step "What do you need?"**: "Core tracking only" or "Core tracking + Sales". It sends `modules`
    on workspace creation.
  - **Sales placeholder** (`/[workspace]/sales`): calls the health endpoint and shows an empty-state page.
  - **Role editor:** permissions are grouped by module, and disabled modules are hidden.
- Notification preview slot: remove the last platform→tracking import (`platform/notifications/preview.tsx`) through
  a registry target-preview slot.
- Bump the mock `SCHEMA`.
