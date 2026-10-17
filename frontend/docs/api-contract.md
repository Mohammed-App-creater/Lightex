# Lightex REST contract (frontend view)

> **Since platform Stage 5 the backend's `docs/openapi.yaml` (repo root) is the source of truth.** `npm run gen:api`
> turns it into `src/api/schema.d.ts`; every request and response type in `src/api/types.ts` is an alias into its
> `components["schemas"]` (narrowed where the schema is loose), and a unit test (`npm run check:api`) fails when
> `schema.d.ts` is stale. This page is the readable summary the client was first written against, kept for its notes
> on behaviour; where it and the schema disagree, the schema wins. The schema gaps the client still works around are
> listed in `docs/final-report.md` §6 ("Remaining known gaps"). Paths live in exactly one place:
> `src/api/endpoints.ts`; the in-browser mock (`src/api/mock`) answers with the same generated types.

## Conventions

- Base URL: `${NEXT_PUBLIC_API_URL}/api/v1`. JSON request and response bodies. Timestamps are ISO-8601 UTC.
  Dates without a time are `YYYY-MM-DD`.
- **Errors**: any non-2xx response returns `{ "code": string, "message": string, "details"?: object }`.
  Codes used by the UI: `unauthorized` (401), `forbidden` (403), `not_found` (404),
  `validation_failed` (422, `details.fields: Record<field, message>`), `version_conflict` (409),
  `rate_limited` (429), `server_error` (5xx), `network_error` (client-side only).
- **Lists**: `?cursor=&limit=` → `{ "data": T[], "nextCursor": string | null }`.
  Filters use `filter[field]=value` (repeat the parameter for OR). Sorting uses `sort=field` or `sort=-field`.
  Search uses `q=`.
- **Permissions**: `Workspace` and `Project` payloads include `my_permissions: string[]` for the current
  user in that scope only. The two scopes are independent: workspace permissions grant nothing inside a
  project.
- **Optimistic concurrency**: `Task` has an integer `version`. Mutations send it, and a stale version
  returns 409 `version_conflict`.
- **Auth**: `Authorization: Bearer <access>`. The refresh token is an httpOnly, Secure, SameSite=Lax cookie
  set by `/auth/*`. The client refreshes once on a 401 and retries the original request once.

## Module namespaces (platform Stage 1)

`docs/platform/stage1-contract.md` at the repo root is binding; in short:

- **Routes:** platform (core) routes keep their paths (`/auth/*`, `/workspaces`, `/workspaces/:slug` with
  members, invites, roles, audit, trash, presence, stream and search, `/roles/*`, `/permissions`,
  `/notifications*`, `/me/notification-channels*`, `/push/*`, `/targets/:targetType/:targetId/*`, `/comments/:id`,
  `/attachments/:id`). Every route served by the tracking module is prefixed with `/tracking`: projects, planning,
  tasks, reports, dashboards, imports, integrations, time
  tracking, saved views, `/tracking/me/{tasks,recents,timer}` and
  `/tracking/workspaces/:slug/{projects,project-directory,tasks,activity,views,timesheet,integrations}`.
- **Permission codes:** `module.resource.action`: `core.workspace.*`, `core.roles.manage`,
  `core.audit.view`, `core.modules.manage` (Stage 3), `core.teams.manage` (Stage 4), and
  `tracking.*` for everything project-related (`tracking.task.create`, `tracking.project.view`, …).
- **Realtime event types and audit actions** carry a module prefix: `tracking.task.changed`,
  `tracking.project.changed`, `core.presence.updated`, `core.channels.changed`, `core.inbox.changed`,
  `core.access.changed`; audit `tracking.task.status_changed`, `core.member.invited`, and so on. The stream's
  control events (`hello`, `reset`, `reconnect`) are not prefixed.

## Generic services (platform Stage 2)

`docs/platform/stage2-contract.md` at the repo root is binding; what the client relies on:

- **Targets:** comments and attachments hang off a target: `targetType` is `module.entity` (`tracking.task`) and
  `targetId` the record's id (for tasks `Task.id`, never the key). `Comment` and `Attachment` carry `targetType` and
  `targetId`; the client no longer reads `taskId`.
- **Realtime:** `core.comment.created|updated|deleted|restored|purged` and `core.attachment.created|changed|deleted`,
  payload `{targetType, targetId, commentId}` / `{targetType, targetId, attachmentId}` (created, deleted); the
  envelope's `projectId` is set when the target belongs to a project, otherwise the event goes to the whole workspace. The client invalidates the target's comment / attachment list, plus what the target's module
  registers (for tasks: the task detail, its activity and the project activity).
- **Notification preferences:** the comment keys are `core.comment.created` and `core.comment.mentioned`. An optional
  `labels: {event: string}` in the response overrides the client's row names.
- **Additive fields:** `Notification.targetType|targetId|title|link` (`projectId` / `projectName` may be null),
  `AuditEntry.module|targetType|targetId`, `TrashItem.module`, and `targetType|targetId|title|link` on every search
  result (global comment results carry `comment.targetType|targetId` instead of `taskId`).
- **Trash** kinds are always namespaced (`tracking.task`, `tracking.project`, `core.comment`), in lists and in the
  restore / purge echo; the client strips the module and sends bare kinds, which the server accepts.
- **Audit** `entityType` / `targetType` are `module.entity`. `filter[entity]` is a server-registered group, and the client
  mirrors the groups in `AUDIT_GROUPS` (`src/lib/audit.ts`; e.g. `core.attachment` → task, `tracking.epic` → project,
  ungrouped → workspace). Collab actions: `core.comment.created|updated|deleted|restored|purged`,
  `core.attachment.created|deleted`.

## Modules (platform Stage 3)

`docs/platform/stage3-contract.md` §3 is binding. `Workspace.enabledModules: string[]` (always contains `core`) and
`my_permissions` drive the sidebar, palette and route guards (`src/registry`). A disabled module's permissions are
missing from `my_permissions` and from role responses (`GET /permissions` still lists them, with `module`); its routes
return 403 `module_disabled`.

| Method | Path | Notes |
|---|---|---|
| GET | /workspaces/:slug/modules | → `[{key, name, description, isCore, toggleable, enabled, dependsOn, enabledAt, enabledBy, navItems}]`, core included, not paginated; any member |
| PUT | /workspaces/:slug/modules/:key | `{enabled}` → the module (`core.modules.manage`); 404 unknown; 400 `module_not_toggleable`; 400 `module_dependency` `details.modules` |
| GET | /sales/workspaces/:slug/health | → `{status: "ok", module: "sales", workspace}` (`sales.health.view`) |

## Teams and data scope (platform Stage 4)

`docs/platform/stage4-contract.md` §1–§2 is binding. Reads are open to any workspace member; writes need
`core.teams.manage` and are audited (`core.team.created|updated|deleted|member_added|member_removed|member_updated`).
A team from another workspace is a 404. Removing someone from the workspace removes their team memberships.

| Method | Path | Notes |
|---|---|---|
| GET | /workspaces/:slug/teams | → `[{id, name, description, memberCount, leadIds, createdAt}]`, by name, not paginated |
| POST | /workspaces/:slug/teams | `{name, description?}` → `TeamDetail`; 409 `team_name_taken` (case-insensitive); 422 empty name |
| GET | /teams/:id | → `TeamDetail` (the list item plus `members`) |
| PATCH | /teams/:id | `{name?, description?}` → `TeamDetail`; 409 `team_name_taken` |
| DELETE | /teams/:id | → 204 (soft delete) |
| GET | /teams/:id/members | → `[{userId, name, email, avatarUrl, isLead}]` |
| POST | /teams/:id/members | `{userId, isLead?}` → member; 400 `not_a_workspace_member`; 409 `already_a_member` |
| PATCH | /teams/:id/members/:userId | `{isLead}` → member |
| DELETE | /teams/:id/members/:userId | → 204 |

**Data scope.** `GET /permissions` entries carry `scopable` (workspace scope only). Role create / update accept
`dataScopes: {code: "own" | "team" | "all"}` next to `permissions`: a granted scopable code without a scope is 400
`data_scope_required` (`details.codes`), a scope on a non-scopable code is 400 `data_scope_not_allowed`. Role
responses carry `dataScopes`; workspace and project responses carry `myDataScopes` (the same workspace-level map,
disabled modules excluded). The client reads it with `useDataScope(code)`; the server applies the scope itself.

## Stage 5 (platform cleanup)

`docs/platform/stage5-contract.md` §2 is binding. What changed for the client:

- **Notifications:** `Notification.eventType` (the registered event-type key, e.g. `tracking.task.assigned`); `type`
  is a plain string (the display kind: `assigned`, `mention`, …; unknown kinds render as a generic row);
  `projectName`, `taskKey` and `taskTitle` are snapshots taken when the notification was created.
- **Data scope widening:** a role create / update that sets or changes a data scope wider than the actor's own scope
  for that code is 403 `data_scope_exceeds_own`, `details {code, dataScope, yours}` (`yours` null when the actor
  doesn't hold the code). Owners (`core.workspace.delete`) are exempt. The role editor shows it as an error toast.
- **Realtime:** `core.module.changed` `{module, enabled}` (durable, whole workspace): the client refetches the
  workspace (`enabledModules`, `my_permissions`), the module list and the workspace list, so the sidebar and route
  guards follow.
- **Typed responses:** search, audit, trash, members, activity, saved views and reports now have schema types; the
  trash restore / purge body is `{items: [{kind, id}]}`.
- **Shapes the client now follows** (it used to assume otherwise): `POST /invites/:token/accept` returns
  `{accessToken, workspaceSlug}` (no user: the client loads `/auth/me`); `GET /auth/me` returns `Me` (with
  `hasPassword`), sign-in responses a plain `User`; `POST /me/notification-channels/:channel/test` takes `workspace`
  as a query parameter; module `navItems[].permission` is always a string.

## Auth
| Method | Path | Body → Response |
|---|---|---|
| POST | /auth/login | `{email,password}` → `{accessToken, user}` (sets refresh cookie) |
| POST | /auth/register | `{name,email,password}` → `{accessToken, user}` |
| POST | /auth/refresh | — → `{accessToken}` (reads cookie) |
| POST | /auth/logout | — → 204 (clears cookie) |
| POST | /auth/forgot-password | `{email}` → 204 (always 204, no account enumeration) |
| POST | /auth/reset-password | `{token,password}` → 204 (revokes other sessions) |
| GET | /auth/me | → `Me` (`User` + `hasPassword`) |
| PATCH | /auth/me | `{name?, avatarUrl?}` → `Me` |
| PUT | /auth/me/password | `{currentPassword,newPassword}` → 204 |
| GET | /invites/:token | → `Invite` (workspace, inviter, email, role) |
| POST | /invites/:token/accept | `{name,password}` → `{accessToken,workspaceSlug}` (the client then loads `/auth/me`) |

## Workspaces, members, roles
| Method | Path | Notes |
|---|---|---|
| GET | /workspaces | → `Workspace[]` with `my_permissions` |
| POST | /workspaces | `{name,slug,modules?}` (onboarding; `modules`: extra module keys, e.g. `["sales"]`) |
| GET | /workspaces/:slug | → `Workspace` |
| PATCH | /workspaces/:slug | `{name?, slug?}` (`core.workspace.update`) |
| DELETE | /workspaces/:slug | soft delete, 30-day restore (`core.workspace.delete`) |
| GET | /workspaces/:slug/slug-availability?q= | → `{available}` |
| GET | /workspaces/:slug/members | paginated, `q`, `filter[role]` |
| PATCH | /workspaces/:slug/members/:userId | `{roleId}` (`core.workspace.manage_members`) |
| DELETE | /workspaces/:slug/members/:userId | |
| GET/POST | /workspaces/:slug/invites | `{emails[], roleId}` |
| DELETE | /workspaces/:slug/invites/:id | revoke |
| POST | /workspaces/:slug/invites/:id/resend | |
| GET | /workspaces/:slug/roles?filter[scope]=workspace\|project | → `Role[]` |
| POST | /workspaces/:slug/roles | `{name, scope, permissions[], dataScopes?}` (`core.roles.manage`; 403 `data_scope_exceeds_own`) |
| PATCH/DELETE | /roles/:id | system roles: 403 on PATCH/DELETE; DELETE in use → 409 `role_in_use` |
| GET | /permissions | → catalogue `{key, module, scope, group, label, description, scopable}[]` (`module`: `core`, `tracking` or `sales`) |
| GET | /workspaces/:slug/audit | paginated (`core.audit.view`) |
| GET | /tracking/workspaces/:slug/activity | recent activity across visible projects |
| GET | /tracking/workspaces/:slug/tasks?filter[assignee]=me | my tasks across projects |
| GET | /workspaces/:slug/search?q=&filter[type]=task\|project\|user | → `SearchResult[]` |

## Projects
| Method | Path | Notes |
|---|---|---|
| GET | /tracking/workspaces/:slug/projects | projects visible to me (member of), + `my_permissions` each |
| GET | /tracking/workspaces/:slug/projects/:key | 403 `forbidden` with `details.canRequestAccess` if not a member |
| POST | /tracking/workspaces/:slug/projects | `{name,key,description?, template?}` (`tracking.project.create`) |
| PATCH | /tracking/projects/:id | (`tracking.project.update`) |
| POST | /tracking/projects/:id/archive · /tracking/projects/:id/unarchive | (`tracking.project.archive`) |
| DELETE | /tracking/projects/:id | (`tracking.project.delete`) |
| GET/POST | /tracking/projects/:id/members | (`tracking.project.manage_members`) |
| PATCH/DELETE | /tracking/projects/:id/members/:userId | `{roleId}` |
| POST | /tracking/projects/:id/access-requests | `{message?}` → `AccessRequest` |
| DELETE | /tracking/projects/:id/access-requests/mine | withdraw |
| GET | /tracking/projects/:id/statuses | ordered `Status[]` |
| POST/PATCH/DELETE | /tracking/projects/:id/statuses(/:statusId) | (`tracking.status.manage`) |
| GET/POST | /tracking/projects/:id/labels | |
| GET | /tracking/projects/:id/activity | paginated |
| GET | /tracking/projects/:id/summary | overview KPIs (open, done this sprint, cycle time) |

## Planning
`objectives`, `milestones`, `epics` and `sprints` each have `GET/POST /tracking/projects/:id/<kind>` and
`PATCH/DELETE /tracking/<kind>/:id`. Progress fields (`progress: {done,total,percent}`) are computed server-side from
tasks and are read-only.
| POST | /tracking/sprints/:id/start | `{startDate,endDate,goal?}` (`tracking.sprint.manage`) |
| POST | /tracking/sprints/:id/complete | `{moveOpenTasksTo: sprintId \| "backlog"}` |
| POST | /tracking/objectives/:id/tasks | `{taskIds[]}` link · `DELETE /tracking/objectives/:id/tasks/:taskId` unlink |

## Tasks, board, backlog
| Method | Path | Notes |
|---|---|---|
| GET | /tracking/projects/:id/tasks | `filter[status|assignee|sprint|epic|milestone|priority|label]`, `sort`, `q`, cursor |
| POST | /tracking/projects/:id/tasks | `tracking.task.create` |
| GET | /tracking/workspaces/:slug/tasks/:key | full task (description, sub-tasks, objective ids) |
| PATCH | /tracking/tasks/:id | partial + `version` (`tracking.task.edit_any` or `tracking.task.edit_own`; assignee change needs `tracking.task.assign`) |
| DELETE | /tracking/tasks/:id · POST /tracking/tasks/:id/restore | soft delete (`tracking.task.delete`) |
| POST | /tracking/projects/:id/tasks/bulk | `{ids[], patch}` or `{ids[], delete:true}` |
| GET | /tracking/projects/:id/board?filter[sprint]=active | → `{statuses, tasks}` ordered by `position` |
| POST | /tracking/tasks/:id/move | `{statusId?, sprintId?: string\|null, position, version}` (`tracking.task.move`) |
| GET | /tracking/projects/:id/backlog | → `{sprints:[{sprint,tasks}], backlog: Task[]}` |
| GET | /tracking/tasks/:id/activity | `ActivityEntry[]` |

## Comments and attachments
| Method | Path | Notes |
|---|---|---|
| GET/POST | /targets/:targetType/:targetId/comments | `{body: TiptapDoc, mentions: userId[]}` (for `tracking.task`: `tracking.comment.create`) |
| PATCH/DELETE | /comments/:id | own: `tracking.comment.edit_own`; anyone's delete: `tracking.comment.delete_any` |
| GET | /targets/:targetType/:targetId/attachments | `Attachment[]` |
| POST | /targets/:targetType/:targetId/attachments/upload-url | `{fileName,size,mimeType}` → `{uploadId,url,method,headers,expiresAt}` (server re-validates the 10 MB limit and type) |
| PUT | `<signed url>` | direct upload to object storage (not under /api) |
| POST | /attachments/:uploadId/confirm | no body; the ticket's `uploadId` is the pending attachment's id → `Attachment` |
| DELETE | /attachments/:id | own, or `tracking.attachment.delete_any` |

`Attachment.downloadUrl` is a short-lived signed URL with `Content-Disposition: attachment` for any
type that is not a raster image. HTML and SVG are always served as downloads.

## Reports (`tracking.report.view`)
`GET /tracking/projects/:id/reports/{burndown|velocity|cycle-time|throughput|progress}` with
`filter[sprint]`, `filter[from]`, `filter[to]`. Each returns series ready to chart.

## Notifications
| GET | /notifications | `filter[tab]=all|mentions|assigned`, `filter[unread]`, cursor |
| GET | /notifications/unread-count | `{count}` |
| POST | /notifications/:id/read | `{read: boolean}` |
| POST | /notifications/read-all | `{ids?}` → `{ids}` changed; `{ids, unread: true}` undoes |
| GET/PUT | /notification-preferences | `{events: {event: {in_app, email, telegram, sms, push}}, emailDelivery: instant|hourly|daily, quietHours}`; event keys: `tracking.task.assigned`, `core.comment.mentioned`, `tracking.task.status_changed`, `core.comment.created`, `tracking.task.due_soon`, `tracking.sprint.started`; optional `labels` (Stage 2) |

## Additions found while building the client

These were needed by the designed screens and are implemented in the mock:

| Method | Path | Why |
|---|---|---|
| GET | /tracking/workspaces/:slug/project-directory | every project in the workspace with admins + `isMember` (403 screen context, "assign project admin" for `tracking.project.assign_admin`) |
| GET | /tracking/projects/:id/access-requests | pending requests for project admins (`tracking.project.manage_members`) |
| GET | /tracking/projects/:id/active-sprint | sidebar sprint card (name, progress, days left) |
| GET | /tracking/tasks/:id/attachments | attachment list with fresh signed URLs |
| GET | /tracking/me/recents | command palette "Recent" section (tasks + projects) |
| GET | /tracking/projects/:id/reports/kpis | Reports KPI tiles (completed vs planned, cycle time avg/p85, overdue, scope change) |
| GET | /notifications?filter[workspace]= | inbox scoped to the current workspace |

`GET /notifications` also returns `counts: { all, mentions, assigned, unread }` for the tab counters.
`POST /notifications/read-all` returns the ids it changed and accepts `{ ids, unread: true }` to undo.
