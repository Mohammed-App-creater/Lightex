# Lightex Platform Architecture (Core + Modules)

Status: approved direction, ready for staged implementation.
Audience: Claude Code and the developer. This document is the source of truth for the restructure. If existing code conflicts with this document, this document wins, and the existing code is changed.

## 0. Decisions recorded at kickoff (2026-10-17)

These override the text below where they conflict.

- **The core package is `backend/core/`, not `backend/platform/`.** `platform` is a Python stdlib module, and celery, attrs and botocore all `import platform`. A first-party package with that name on the path would shadow it. Read every `platform.*` below as `core.*`. On the frontend, `src/platform/` is fine and stays.
- **Placement of the v2 apps** (which this document predates):
  - `channels` (Telegram, SMS, Web Push delivery) moves to `core/notifications` as delivery channels. Section 7's "future channels" are therefore already built.
  - `realtime` (SSE broker, presence) moves to `core/realtime`.
  - `dashboards`, `imports`, `integrations` (GitHub/GitLab) and `timetracking` move to `modules/tracking`.
- The work happens on branch `platform`, cut from `master`, which has v2 merged.

## 1. Context and goal

Lightex v1 (tracking app) is built, tested and has no real users. Because nothing depends on the current structure, we restructure it properly instead of retrofitting. The target is a **modular monolith**:

- One backend (Django), one database (PostgreSQL), one frontend (Next.js), one deployment.
- A **platform core** that every module builds on.
- **Modules** that a workspace can enable or disable: `tracking` (today's Lightex) and `sales` (next). More may follow.

Explicit non-goals: microservices, per-module databases, billing and licensing (only reserve a field), building features for imaginary modules. Design for exactly two modules, `tracking` and `sales`.

## 2. Principles

1. **Core never depends on modules. Modules never depend on each other.** Cross-module behavior goes through domain events or small public interfaces, and only appears when both modules are enabled.
2. **Everything is namespaced by module** (permission codes, API routes, event types, entity types).
3. **Every module table carries `workspace_id`.** Tenant isolation is enforced centrally, not remembered per query.
4. **Permissions decide what you can do; data scope decides whose records you can see.** Both are enforced in one place each.
5. **Disabling a module hides it; it never deletes data.**
6. **No backward compatibility burden.** Rename, move and regenerate migrations freely, but keep the test suite as the safety net and keep each stage shippable.

## 3. Naming and namespacing

- Module keys: `core` (platform, not toggleable), `tracking`, `sales`.
- Permission codes: `module.resource.action`, for example `core.workspace.manage_members`, `tracking.task.create`, `sales.lead.view`.
- API routes: platform at the root (`/api/v1/auth`, `/api/v1/workspaces`, `/api/v1/teams`, `/api/v1/notifications`, `/api/v1/search`, `/api/v1/audit`), modules prefixed (`/api/v1/tracking/...`, `/api/v1/sales/...`).
- Event types: `module.entity.event`, for example `tracking.task.assigned`, `sales.opportunity.won`.
- Entity (target) types: `module.entity`, for example `tracking.task`, `sales.opportunity`.
- Disabled module responses: HTTP 403 with code `module_disabled`.
- Error format unchanged: `{ code, message, details }`. Lists unchanged: `{ results, next_cursor }`.

### Permission code migration (existing to new)

| Existing | New | Scope |
|---|---|---|
| workspace.view / update / delete | core.workspace.view / update / delete | workspace |
| workspace.manage_members | core.workspace.manage_members | workspace |
| workspace.manage_roles | core.roles.manage | workspace |
| audit.view | core.audit.view | workspace |
| (new) | core.modules.manage | workspace |
| (new) | core.teams.manage | workspace |
| project.create | tracking.project.create | workspace |
| project.assign_admin | tracking.project.assign_admin | workspace |
| project.view / update / archive / delete / manage_members | tracking.project.* | project |
| objective.manage, milestone.manage, epic.manage, sprint.manage, status.manage | tracking.objective.manage, tracking.milestone.manage, tracking.epic.manage, tracking.sprint.manage, tracking.status.manage | project |
| task.create / edit_any / edit_own / delete / assign / move | tracking.task.* | project |
| comment.create / edit_own / delete_any | tracking.comment.* | project |
| attachment.upload / delete_any | tracking.attachment.* | project |
| report.view | tracking.report.view | project |

Codes added by v2 that are not in this table follow the same rule: a workspace-level platform capability gets `core.`, and anything project or tracking related gets `tracking.`.

A permission has a **module** (who owns it) and a **scope** (`workspace` or `project`). These are independent.

## 4. Backend layout

```
backend/
  core/                     # platform core (see section 0)
    accounts/               # users, auth, invitations, password reset
    workspaces/             # workspaces, members
    access/                 # permissions, roles, can(), visible_to(), teams
    modules/                # module registry, WorkspaceModule
    collab/                 # generic comments + attachments (+ storage)
    notifications/          # notifications, preferences, delivery (incl. v2 channels)
    realtime/               # SSE broker, presence (v2)
    events/                 # DomainEvent outbox, handler registry
    audit/                  # audit log
    search/                 # provider registry, /search fan-out
    common/                 # base models, scoped manager, errors, pagination
  modules/
    tracking/               # projects, statuses, tasks, planning, sprints, reports,
                            # dashboards, imports, integrations, timetracking
    sales/                  # skeleton now, built later
  config/                   # settings, urls, celery
```

Rules (enforced by import-linter, failing CI):
- `core.*` may not import `modules.*`.
- `modules.X` may import `core.*` but not `modules.Y`.
- Inside a module: views thin, rules in `services.py`, reads in `selectors.py`, serializers only validate and shape.

## 5. Module system

### ModuleDefinition (in code, one per module)
`key`, `name`, `description`, `is_core`, `depends_on: [keys]`, `permissions` (the module's catalog), `event_types` (with labels and default notification channels), `target_types` (see section 7), `search_provider`, `nav_items` (for the API to expose to the frontend), `settings_schema` (optional).

### WorkspaceModule (table)
`workspace`, `module_key`, `enabled`, `enabled_by`, `enabled_at`, `settings` (JSON), `plan` (nullable, reserved for future entitlements; unused now). Unique on (workspace, module_key).

### Behavior
- New workspaces enable `tracking` by default plus anything chosen during onboarding.
- `core` is always on. `tracking` is on for every workspace and cannot be disabled in this phase (the design must not prevent a sales-only workspace later).
- Enabling or disabling requires `core.modules.manage`, writes an audit entry, and validates dependencies (cannot disable a module another enabled module depends on).
- A disabled module: its API returns `module_disabled`, its navigation and permissions are hidden, its notifications and event handlers are skipped, its data is untouched. Re-enabling restores everything.
- Endpoints: `GET /workspaces/{id}/modules`, `PUT /workspaces/{id}/modules/{key}`. Workspace responses include `enabled_modules: string[]`.

## 6. Access control

### Two scopes plus data scope
1. **Workspace scope** permissions govern workspace-level actions and are checked against the user's workspace role.
2. **Project scope** permissions (tracking) govern everything inside a project and are checked against the user's project role. There is no override between workspace and project scope (a workspace Owner who is not a project member cannot read that project).
3. **Data scope** applies only to permissions flagged `scopable` in the catalog (for example `sales.lead.view`). A role grants such a permission with a data scope of `own`, `team` or `all`.

### Data scope semantics
- `own`: records whose `owner` is the user.
- `team`: records whose owner shares at least one team with the user (as member or lead).
- `all`: every record in the workspace.
- Tracking continues to use project membership for visibility; data scope does not apply to it.

### Teams (core)
`Team` (workspace, name), `TeamMember` (team, user, is_lead). Flat (no nesting) for now. A user may be in several teams. Managed with `core.teams.manage`. Endpoints under `/api/v1/teams`.

### Role and permission model
- `Permission` (code, module, scope, scopable, description). The catalog is assembled from the module definitions and synced to the database by a management command and on startup.
- `Role` (workspace, name, scope, is_system). A role belongs to one scope only.
- `RolePermission` (role, permission, `data_scope` nullable). `data_scope` is required when the permission is scopable and must be null otherwise.
- Default roles seeded per workspace: workspace Owner, Admin, Member; project Project Admin, Manager, Member, Viewer. Modules may contribute extra default roles (sales will add Sales Manager, Salesperson, and similar). Seeding is idempotent and runs when a module is enabled.
- Permissions of disabled modules are hidden in the role editor and ignored by checks.

### The two functions everyone uses
- `can(user, permission_code, scope_object) -> bool`: the only place a yes/no decision is made. Scope object is the workspace or project. Cached per request. No role names anywhere.
- `visible_to(queryset, user, permission_code) -> queryset`: applies data scope for scopable permissions using the model's declared `owner` field. Every list selector for scopable data must go through it.

### Invariants (carried over, still enforced)
Cannot remove or demote the last Owner. A project always keeps at least one Project Admin through the API. System roles cannot be deleted or lose core permissions. A role in use cannot be deleted until members are reassigned. `tracking.project.assign_admin` lets a user add a project admin without gaining read access. Non-members of a workspace get 404; workspace members who are not project members get 403 `project_membership_required`.

`my_permissions: string[]` stays on workspace and project responses, using the namespaced codes. Scopable permissions are returned as `code` plus the granted `data_scope` in a separate `my_data_scopes` map.

## 7. Generic platform services

### Targets (entity references)
Comments, attachments, notifications, audit and search refer to records as (`target_type`, `target_id`) instead of foreign keys, so any module can use them. Each module registers its target types with a resolver providing:
`exists(workspace, id)`, `can_view(user, id)`, `can_comment(user, id)`, `can_attach(user, id)`, `describe(id)` (title, link), and `workspace_of(id)`.
Core services validate through the resolver and never contain module-specific rules. Because there is no database foreign key, a management command checks for orphaned references, and soft deletes cascade through events.

### Comments and attachments (`core.collab`)
Generic comments (with mentions) and attachments attach to any registered target. The R2 flow is unchanged: request signed upload URL, direct upload, confirm with HEAD verification, 10 MB limit, allowlisted types, server-generated keys, download as attachment with `nosniff`. Permissions come from the target's resolver.

### Domain events (`core.events`)
`DomainEvent` (workspace, type, target_type, target_id, actor, payload JSON, created_at, processed_at). Written in the same transaction as the change, dispatched on commit to handlers that modules register (skipped when the module is disabled). Retries are safe (handlers are idempotent). Celery is optional; with no worker, dispatch runs inline.

### Notifications
Event types are declared by modules with labels and default channels. Channels: in-app and email, plus Telegram, SMS and Web Push (already built in v2, board 38). Preferences are keyed by event type.

### Audit
`AuditLog` (workspace, actor, module, action, target_type, target_id, changes JSON, created_at). Every mutating service call writes one. No secrets.

### Search
Each module registers a search provider (`search(user, query, limit)` returning permission-filtered results with target type and link). `/api/v1/search` fans out only across enabled modules.

### Soft delete and trash
Base mixin with `deleted_at`, default managers exclude deleted rows, restore endpoints, purge command after 30 days. Trash lists by module.

## 8. Multi-tenancy

- Every module and platform table (except global ones such as users and the permission catalog) has a non-null `workspace` foreign key, even when it could be derived through a parent.
- `common.WorkspaceScopedModel` with a manager that requires a workspace to be passed or set in request context. Unscoped access requires an explicit `.unscoped()` call used only in management commands and tests.
- Cross-tenant tests are mandatory (section 12). Row-level security in PostgreSQL is a possible later hardening step; the `workspace_id` column makes it easy.

## 9. Tracking module

Everything in the current Lightex backend moves under `modules/tracking` with namespaced routes and permissions: projects, project members, statuses, labels, tasks and subtasks, board and backlog, epics, milestones, objectives, sprints, reports, task status history, plus the v2 apps listed in section 0. Task comments and attachments move to the generic services, with `tracking.task` registered as a target type. Behavior, rules, concurrency (task `version`), fractional positions and computed progress are unchanged. Roughly: URLs and permission codes change, behavior does not.

## 10. Sales module (placeholder)

A skeleton only in this restructure: registered module `sales`, permission `sales.health.view`, `GET /api/v1/sales/health` protected by the module guard, one placeholder frontend page, and tests proving the pattern. The real sales specification is a separate document. Known needs that the platform must support: data scope on leads and opportunities, teams, targets and daily reports driven by a working calendar, scheduled jobs (follow-up reminders, daily report generation), generic comments and attachments on customers and opportunities, and a "won" event that other modules can react to.

## 11. Frontend architecture

```
src/
  platform/        # shell, auth, workspace, settings, roles, teams, notifications, search
  modules/
    tracking/      # existing screens moved here
    sales/         # placeholder
  registry/        # module registry: key, nav items, route group, required permission
  api/             # typed client generated from OpenAPI, one section per module
  ui/              # design system (unchanged)
```

- Sidebar, command palette and route guards are built from `enabled_modules` plus `my_permissions`. A disabled module's route shows a "module disabled" page.
- Permission checks use the namespaced codes (`useCan('tracking.task.create', scope)`).
- The API client is generated from the backend's OpenAPI schema; no handwritten endpoint types. The mock API is regenerated from the same schema or removed once the live API is the default.
- New screens: Settings, Modules (toggle cards, confirmation on disable stating that data is kept), Teams (list, members, leads), role editor grouped by module with a data-scope selector for scopable permissions, onboarding step "What do you need?" (Core tracking only, or Core tracking + Sales).

## 12. Testing requirements

- The existing test suite is migrated to the new codes and routes, keeping its structure (including the permission matrix generated from a table).
- Tenant isolation: for every module endpoint, a user from workspace A cannot read or write workspace B.
- Data scope: own / team / all behave correctly for a scopable test permission, including users in several teams.
- Module system: enable, disable, dependency refusal, `module_disabled`, hidden permissions, handlers skipped when disabled, data preserved across disable and enable.
- Import rules (import-linter) run in CI.
- Events: written transactionally, handlers idempotent, retried safely.
- Generic targets: a fake module registers a target type and gets comments, attachments, notifications, search and audit without core changes (this proves the platform is truly generic).
- Coverage: 85 percent overall, 95 percent on `core.access`.

## 13. Restructure stages

Each stage ends with lint, types and all tests green, a git commit, a regenerated OpenAPI file, and a working frontend. Do them in order.

**Stage 1: Split and namespace.** Create the `core` and `modules/tracking` layout, move code, namespace permission codes, API routes and event types, update the permission catalog and default roles, update the frontend routes, permission checks and client. Add import-linter. Done when the app behaves exactly as before under the new names.

**Stage 2: Generic services.** Target registry and resolvers, generic comments and attachments, domain events with handlers, generic notifications, audit and search provider fan-out. Move tracking onto them. Done when tracking has no private copies of these and the fake-module test passes.

**Stage 3: Module system.** ModuleDefinition registry, WorkspaceModule, endpoints, guard, `enabled_modules`, Settings, Modules page, onboarding step, role editor grouping, sales skeleton. Done when enabling and disabling the sales skeleton works end to end.

**Stage 4: Teams and data scope.** Teams, scopable permissions, `visible_to()`, role editor data-scope selector, `my_data_scopes`. Done when the data scope tests pass using the fake module.

**Stage 5: Cleanup.** Workspace-scoped base model and manager applied everywhere, fresh initial migrations per app, rebuilt seed data (including demo users per role and a few teams), generated API client adopted, docs updated (how to add a module in ten steps), final tenant isolation and matrix test run.

## 14. Open decisions

1. `team` data scope means "shares a team with the user". If it should mean only teams the user leads, change section 6 before Stage 4.
2. Whether tracking becomes toggleable (sales-only workspaces). The design allows it; the UI does not expose it yet.
3. Entitlements and billing per module: only the reserved `plan` field exists.
4. The definition of "actual sales" and the working calendar belong to the sales specification, not this document.
