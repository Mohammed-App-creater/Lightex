# Lightex REST contract (frontend assumption)

> No backend API document was provided. This is the contract the frontend is written against. It is
> implemented by the in-browser mock (`src/lib/mock`) and the live HTTP transport (`src/lib/api`).
> **Every endpoint below is a "requested API addition" until the backend confirms it.**
> Paths live in exactly one place: `src/lib/api/endpoints/*.ts`.

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
| PATCH | /workspaces/:slug | `{name?, slug?}` (`workspace.update`) |
| DELETE | /workspaces/:slug | soft delete, 30-day restore (`workspace.delete`) |
| GET | /workspaces/:slug/slug-availability?q= | → `{available}` |
| GET | /workspaces/:slug/members | paginated, `q`, `filter[role]` |
| PATCH | /workspaces/:slug/members/:userId | `{roleId}` (`workspace.manage_members`) |
| DELETE | /workspaces/:slug/members/:userId | |
| GET/POST | /workspaces/:slug/invites | `{emails[], roleId}` |
| DELETE | /workspaces/:slug/invites/:id | revoke |
| POST | /workspaces/:slug/invites/:id/resend | |
| GET | /workspaces/:slug/roles?filter[scope]=workspace\|project | → `Role[]` |
| POST | /workspaces/:slug/roles | `{name, scope, permissions[]}` (`workspace.manage_roles`) |
| PATCH/DELETE | /roles/:id | system roles: 403 on PATCH/DELETE; DELETE in use → 409 `role_in_use` |
| GET | /permissions | → catalogue `{key, scope, group, label, description}[]` |
| GET | /workspaces/:slug/audit | paginated (`audit.view`) |
| GET | /workspaces/:slug/activity | recent activity across visible projects |
| GET | /workspaces/:slug/tasks?filter[assignee]=me | my tasks across projects |
| GET | /workspaces/:slug/search?q=&filter[type]=task\|project\|user | → `SearchResult[]` |

## Projects
| Method | Path | Notes |
|---|---|---|
| GET | /workspaces/:slug/projects | projects visible to me (member of), + `my_permissions` each |
| GET | /workspaces/:slug/projects/:key | 403 `forbidden` with `details.canRequestAccess` if not a member |
| POST | /workspaces/:slug/projects | `{name,key,description?, template?}` (`project.create`) |
| PATCH | /projects/:id | (`project.update`) |
| POST | /projects/:id/archive · /projects/:id/unarchive | (`project.archive`) |
| DELETE | /projects/:id | (`project.delete`) |
| GET/POST | /projects/:id/members | (`project.manage_members`) |
| PATCH/DELETE | /projects/:id/members/:userId | `{roleId}` |
| POST | /projects/:id/access-requests | `{message?}` → `AccessRequest` |
| DELETE | /projects/:id/access-requests/mine | withdraw |
| GET | /projects/:id/statuses | ordered `Status[]` |
| POST/PATCH/DELETE | /projects/:id/statuses(/:statusId) | (`status.manage`) |
| GET/POST | /projects/:id/labels | |
| GET | /projects/:id/activity | paginated |
| GET | /projects/:id/summary | overview KPIs (open, done this sprint, cycle time) |

## Planning
`objectives`, `milestones`, `epics` and `sprints` each have `GET/POST /projects/:id/<kind>` and
`PATCH/DELETE /<kind>/:id`. Progress fields (`progress: {done,total,percent}`) are computed server-side from
tasks and are read-only.
| POST | /sprints/:id/start | `{startDate,endDate,goal?}` (`sprint.manage`) |
| POST | /sprints/:id/complete | `{moveOpenTasksTo: sprintId \| "backlog"}` |
| POST | /objectives/:id/tasks | `{taskIds[]}` link · `DELETE /objectives/:id/tasks/:taskId` unlink |

## Tasks, board, backlog
| Method | Path | Notes |
|---|---|---|
| GET | /projects/:id/tasks | `filter[status|assignee|sprint|epic|milestone|priority|label]`, `sort`, `q`, cursor |
| POST | /projects/:id/tasks | `task.create` |
| GET | /workspaces/:slug/tasks/:key | full task (description, sub-tasks, objective ids) |
| PATCH | /tasks/:id | partial + `version` (`task.edit_any` or `task.edit_own`; assignee change needs `task.assign`) |
| DELETE | /tasks/:id · POST /tasks/:id/restore | soft delete (`task.delete`) |
| POST | /projects/:id/tasks/bulk | `{ids[], patch}` or `{ids[], delete:true}` |
| GET | /projects/:id/board?filter[sprint]=active | → `{statuses, tasks}` ordered by `position` |
| POST | /tasks/:id/move | `{statusId?, sprintId?: string\|null, position, version}` (`task.move`) |
| GET | /projects/:id/backlog | → `{sprints:[{sprint,tasks}], backlog: Task[]}` |
| GET | /tasks/:id/activity | `ActivityEntry[]` |

## Comments and attachments
| Method | Path | Notes |
|---|---|---|
| GET/POST | /tasks/:id/comments | `{body: TiptapDoc, mentions: userId[]}` (`comment.create`) |
| PATCH/DELETE | /comments/:id | own: `comment.edit_own`; anyone's delete: `comment.delete_any` |
| POST | /tasks/:id/attachments/upload-url | `{fileName,size,mimeType}` → `{uploadId,url,method,headers,expiresAt}` (server re-validates the 10 MB limit and type) |
| PUT | `<signed url>` | direct upload to object storage (not under /api) |
| POST | /tasks/:id/attachments | `{uploadId}` confirm → `Attachment` |
| DELETE | /attachments/:id | own, or `attachment.delete_any` |

`Attachment.downloadUrl` is a short-lived signed URL with `Content-Disposition: attachment` for any
type that is not a raster image. HTML and SVG are always served as downloads.

## Reports (`report.view`)
`GET /projects/:id/reports/{burndown|velocity|cycle-time|throughput|progress}` with
`filter[sprint]`, `filter[from]`, `filter[to]`. Each returns series ready to chart.

## Notifications
| GET | /notifications | `filter[tab]=all|mentions|assigned`, `filter[unread]`, cursor |
| GET | /notifications/unread-count | `{count}` |
| POST | /notifications/:id/read | `{read: boolean}` |
| POST | /notifications/read-all | `{before}` (so undo can re-mark) |
| GET/PUT | /notification-preferences | `{events: {event: {in_app, email}}, emailDelivery: instant|hourly|daily}` |
