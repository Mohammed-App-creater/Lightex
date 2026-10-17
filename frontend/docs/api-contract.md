# Lightex REST contract (frontend assumption)

> No backend API document was provided. This is the contract the frontend is written against. It is
> implemented by the in-browser mock (`src/lib/mock`) and the live HTTP transport (`src/api`).
> **Every endpoint below is a "requested API addition" until the backend confirms it.**
> Paths live in exactly one place: `src/api/endpoints.ts`.

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
  `/notifications*`, `/me/notification-channels*`, `/push/*`, `/comments/:id`, `/attachments/:id`). Every
  route served by the tracking module is prefixed with `/tracking`: projects, planning, tasks (including
  `/tracking/tasks/:id/comments` and `/attachments`), reports, dashboards, imports, integrations, time
  tracking, saved views, `/tracking/me/{tasks,recents,timer}` and
  `/tracking/workspaces/:slug/{projects,project-directory,tasks,activity,views,timesheet,integrations}`.
- **Permission codes:** `module.resource.action`: `core.workspace.*`, `core.roles.manage`,
  `core.audit.view`, `core.modules.manage`, `core.teams.manage` (the last two have no endpoints yet), and
  `tracking.*` for everything project-related (`tracking.task.create`, `tracking.project.view`, …).
- **Realtime event types and audit actions** carry a module prefix: `tracking.task.changed`,
  `tracking.project.changed`, `core.presence.updated`, `core.channels.changed`, `core.inbox.changed`,
  `core.access.changed`; audit `tracking.task.status_changed`, `core.member.invited`, and so on. The stream's
  control events (`hello`, `reset`, `reconnect`) are not prefixed.

## Auth
| Method | Path | Body → Response |
|---|---|---|
| POST | /auth/login | `{email,password}` → `{accessToken, user}` (sets refresh cookie) |
| POST | /auth/register | `{name,email,password}` → `{accessToken, user}` |
| POST | /auth/refresh | — → `{accessToken}` (reads cookie) |
| POST | /auth/logout | — → 204 (clears cookie) |
| POST | /auth/forgot-password | `{email}` → 204 (always 204, no account enumeration) |
| POST | /auth/reset-password | `{token,password}` → 204 (revokes other sessions) |
| GET | /auth/me | → `User` |
| PATCH | /auth/me | `{name?, avatarUploadId?, theme?}` → `User` |
| PUT | /auth/me/password | `{currentPassword,newPassword}` → 204 |
| GET | /invites/:token | → `Invite` (workspace, inviter, email, role) |
| POST | /invites/:token/accept | `{name,password}` → `{accessToken,user,workspaceSlug}` |

## Workspaces, members, roles
| Method | Path | Notes |
|---|---|---|
| GET | /workspaces | → `Workspace[]` with `my_permissions` |
| POST | /workspaces | `{name,slug}` (onboarding) |
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
| POST | /workspaces/:slug/roles | `{name, scope, permissions[]}` (`core.roles.manage`) |
| PATCH/DELETE | /roles/:id | system roles: 403 on PATCH/DELETE; DELETE in use → 409 `role_in_use` |
| GET | /permissions | → catalogue `{key, module, scope, group, label, description}[]` (`module`: `core` or `tracking`) |
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
| GET/POST | /tracking/tasks/:id/comments | `{body: TiptapDoc, mentions: userId[]}` (`tracking.comment.create`) |
| PATCH/DELETE | /comments/:id | own: `tracking.comment.edit_own`; anyone's delete: `tracking.comment.delete_any` |
| POST | /tracking/tasks/:id/attachments/upload-url | `{fileName,size,mimeType}` → `{uploadId,url,method,headers,expiresAt}` (server re-validates the 10 MB limit and type) |
| PUT | `<signed url>` | direct upload to object storage (not under /api) |
| POST | /tracking/tasks/:id/attachments | `{uploadId}` confirm → `Attachment` |
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
| POST | /notifications/read-all | `{before}` (so undo can re-mark) |
| GET/PUT | /notification-preferences | `{events: {event: {in_app, email, telegram, sms, push}}, emailDelivery: instant|hourly|daily, quietHours}`; event keys: `tracking.task.assigned`, `tracking.comment.mentioned`, `tracking.task.status_changed`, `tracking.comment.created`, `tracking.task.due_soon`, `tracking.sprint.started` |

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
