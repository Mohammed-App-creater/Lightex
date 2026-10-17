# Stage 1 contract: split and namespace

Shared by the backend and frontend Stage 1 work. The parent document is `docs/platform-architecture.md`. The
backend core package is `backend/core/` (see section 0 there). Behavior does not change; only names, paths and
URLs change.

## 1. Permission codes

| Old | New |
|---|---|
| workspace.view / update / delete | core.workspace.view / update / delete |
| workspace.manage_members | core.workspace.manage_members |
| workspace.manage_roles | core.roles.manage |
| audit.view | core.audit.view |
| (new, granted to Owner + Admin) | core.modules.manage |
| (new, granted to Owner + Admin) | core.teams.manage |
| project.create | tracking.project.create |
| project.assign_admin | tracking.project.assign_admin |
| integration.manage | tracking.integration.manage |
| project.view / update / archive / delete / manage_members / import | tracking.project.view / update / archive / delete / manage_members / import |
| objective / milestone / epic / sprint / status / field `.manage` | tracking.objective.manage, … tracking.field.manage |
| task.create / edit_any / edit_own / delete / assign / move | tracking.task.* |
| time.log / time.delete_any | tracking.time.log / tracking.time.delete_any |
| development.link | tracking.development.link |
| comment.create / edit_own / delete_any | tracking.comment.* |
| attachment.upload / delete_any | tracking.attachment.* |
| dashboard.create / dashboard.manage | tracking.dashboard.create / tracking.dashboard.manage |
| report.view | tracking.report.view |

Scopes (workspace or project) are unchanged. Every permission gets a `module` attribute (`core` or `tracking`) in the
catalogue and in `GET /permissions`. The two new core codes have no endpoints yet (Stages 3 and 4); they exist only
in the catalogue and the default roles. `my_permissions` returns the new codes.

## 2. API routes

Base `/api/v1/`. **Core routes keep their current paths.** Every route served by a tracking app gets a `tracking/`
prefix, with the rest of the path unchanged:

- Core (unchanged): `auth/*`, `workspaces`, `workspaces/{slug}` (+ members, invites, transfer and similar),
  `invites/*`, `permissions`, `workspaces/{slug}/roles`, `roles/*`, `workspaces/{slug}/audit`,
  `workspaces/{slug}/trash*`, `trash/*`, `notifications*`, `notification-preferences`, `me/notification-channels*`,
  `push/*`, `me/push-subscriptions*`, `webhooks/telegram`, `webhooks/twilio/*`, `workspaces/{slug}/stream`,
  `workspaces/{slug}/presence*`, `search`, `workspaces/{slug}/search`, `comments/{id}`, `attachments/{id}*`,
  `storage/*`, `health`.
- Tracking (prefixed): everything from projects, planning, tasks, reports, dashboards, imports, integrations
  and timetracking. For example:
  - `workspaces/{slug}/projects` → `tracking/workspaces/{slug}/projects`
  - `projects/{id}/board` → `tracking/projects/{id}/board`
  - `tasks/{ref}` → `tracking/tasks/{ref}`
  - `me/tasks`, `me/recents`, `me/timer` → `tracking/me/tasks`, `tracking/me/recents`, `tracking/me/timer`
  - `workspaces/{slug}/tasks`, `/activity`, `/views`, `/timesheet`, `/integrations` → `tracking/workspaces/{slug}/…`
  - `webhooks/github`, `webhooks/gitlab/{id}`, `integrations/*/callback` → `tracking/webhooks/…`, `tracking/integrations/…`
  - task-scoped collaboration routes: `tasks/{ref}/comments`, `tasks/{ref}/attachments`,
    `tasks/{ref}/attachments/upload-url` → `tracking/tasks/{ref}/…`

## 3. Event types

Every domain event, realtime (SSE) event and audit action string gets a module prefix:

- Tracking entities (task, tasks, project, project_member, status, label, epic, milestone, objective, sprint,
  comment, attachment, dashboard, view, import, time entry, custom field, integration, repository) →
  `tracking.<old>`. For example, `task.created` → `tracking.task.created` and `sprint.started` → `tracking.sprint.started`.
- Workspace-level entities (workspace, member, invite, role, presence, channel) → `core.<old>`. For example,
  `member.invited` → `core.member.invited` and `presence.updated` → `core.presence.updated`.

Notification preference event keys become:

| Old | New |
|---|---|
| assigned | tracking.task.assigned |
| mentioned | tracking.comment.mentioned |
| status_change | tracking.task.status_changed |
| comment | tracking.comment.created |
| due_soon | tracking.task.due_soon |
| sprint_started | tracking.sprint.started |

`Notification.type` (the display kind: assigned, mention, status and so on) is unchanged in Stage 1.

## 4. Backend layout (Django)

`backend/apps/` is removed. Its apps move as follows, each staying its own Django app with **its current
`AppConfig.label`**, so existing migrations and table names stay valid:

- `core/`: accounts, workspaces, access, collab (from collaboration), notifications, channels (subpackage
  `core/notifications/channels` or a sibling `core/channels`, the backend's choice), realtime, audit, search, common.
- `modules/tracking/`: projects, planning, tasks, reports, dashboards, imports, integrations, timetracking.
- `modules/sales/`: empty package with a docstring only (built in Stage 3).

import-linter in CI: `core` must not import `modules`, and `modules.tracking` must not import `modules.sales` (and
the reverse). Core→tracking imports that exist today are listed as `ignore_imports` in the contract, each with a
comment saying Stage 2 removes it. The list may shrink but never grow.

## 5. Frontend

- The API client (`src/lib/api/endpoints.ts`, the mock router and handlers) uses the new routes, permission codes
  and event types.
- The permission catalogue (`src/lib/permissions/catalogue.ts`) mirrors section 1, including `module`.
- Folder layout moves toward section 11 of the architecture doc (`src/platform`, `src/modules/tracking`,
  `src/registry`, `src/api`, `src/ui`). **Page URLs do not change**; use route groups if pages move.
- Bump the mock `SCHEMA` so stored mock databases with old codes reseed.
