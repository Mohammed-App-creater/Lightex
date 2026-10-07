# Lightex backend plan (v1)

Status: written before any backend code, then kept current. The final report is
`docs/backend-final-report.md`.

## 0. Sources and precedence

| Source | Role |
|---|---|
| Build brief (backend) | Behaviour, permissions, data rules, security, testing bar |
| `frontend/docs/api-contract.md`, `frontend/docs/frontend-plan.md`, `frontend/docs/final-report.md` | The only `/docs` that exist. Contract assumptions written by the frontend team |
| `frontend/src/lib/api/{endpoints,types,transport,http-transport}.ts` | **Exact wire shapes.** Wins over every other source for paths, field names, list and error formats |
| `frontend/src/lib/mock/**` | Reference behaviour of every endpoint (validation copy, status codes, side effects) |
| `frontend/desing - orignal/*.html` | Designed transactional emails (invitation, password reset, task assigned, mentioned, due soon, sprint started/completed) |

There is no separate data-model or permission document. Where the brief and the frontend client
differ, the frontend shape is used and the difference is listed in §7 and in the final report.

## 1. Repository layout

```
backend/
  manage.py  pyproject.toml  requirements.txt  requirements-dev.txt
  Dockerfile  docker-compose.yml  Makefile  .env.example
  config/            settings/{base,dev,test,prod}.py, urls.py, wsgi.py, asgi.py, celery.py
  apps/
    common/          base models (UUID, timestamps, soft delete), errors, pagination, camelCase
                     helpers, rich-text sanitising, fractional index, throttles, health
    accounts/        User, auth (JWT + refresh cookie), password reset, profile
    access/          Permission catalogue, Role, RolePermission, can(), DRF permission classes,
                     default roles
    workspaces/      Workspace, WorkspaceMember, Invitation, WorkspaceAccessRequest
    projects/        Project, ProjectKeyAlias, ProjectMember, Status, Label, AccessRequest,
                     templates, recents, saved views
    planning/        Objective, Milestone, Epic, Sprint, SprintScopeChange
    tasks/           Task, TaskStatusHistory, ExternalLink (v2 reserve), board/backlog, bulk
    collaboration/   Comment, Attachment, storage backends (R2 + fake)
    notifications/   DomainEvent (outbox), Notification, NotificationPreference, email
    reports/         burndown, velocity, cycle time, throughput, progress, KPIs, summary
    audit/           AuditLog (also feeds the activity feeds), trash
    search/          PostgreSQL full-text search
docs/backend-plan.md  docs/openapi.yaml  docs/backend-final-report.md
.github/workflows/backend.yml
```

Layering in every app: `models.py` (fields + invariants only), `selectors.py` (read queries, always
membership-scoped), `services.py` (all writes and business rules, each mutating call writes an
audit row), `serializers.py` (validation + shaping), `views.py` (thin: permission declaration,
parse, call service/selector, serialize), `urls.py`.

## 2. Models

All models: `id UUID pk`, `created_at`, `updated_at` (UTC). Soft delete (`deleted_at`, default
manager hides deleted rows, `all_objects` sees them) on Project, Task, Comment, Attachment and
Workspace.

| Model | Fields | Constraints / indexes |
|---|---|---|
| accounts.User | email (unique, lower-cased), name, hue, avatar_url, password, is_active, is_staff, last_login | email unique (case-insensitive) |
| accounts.PasswordResetToken | user, token_hash (sha256), expires_at, used_at | token_hash unique |
| access.Permission | code (pk-like unique), scope (workspace/project), group, label, description | synced from code catalogue by migration + `sync_permissions` |
| access.Role | workspace, name, description, scope, is_system, system_key | unique (workspace, scope, lower(name)); unique (workspace, system_key) |
| access.RolePermission | role, permission | unique (role, permission) |
| workspaces.Workspace | slug, name, hue, deleted_at | unique slug among live rows |
| workspaces.WorkspaceMember | workspace, user, role, status, joined_at, last_active_at | unique (workspace, user); role must be workspace scope + same workspace (service + check) |
| workspaces.Invitation | workspace, email, role, invited_by, token_hash, expires_at (7 days), status, accepted_by | token_hash unique; one pending per (workspace, email) |
| workspaces.WorkspaceAccessRequest | workspace, user | unique (workspace, user) |
| projects.Project | workspace, key, name, description, hue, lead, status (active/archived), template, task_seq, deleted_at, deleted_by | unique (workspace, key) among live rows |
| projects.ProjectKeyAlias | workspace, project, key | unique (workspace, key): retired keys stay reserved so task keys stay unique |
| projects.ProjectMember | project, user, role, added_at | unique (project, user) |
| projects.Status | project, name, category (todo/in_progress/done), glyph, color, position | index (project, position) |
| projects.Label | project, name, color | unique (project, lower(name)) |
| projects.AccessRequest | project, user, message, status | one pending per (project, user) |
| projects.SavedView / ViewPin | board 30 saved filters and per-user pins | |
| projects.Recent | user, kind, object_id, at | unique (user, object_id) |
| planning.Objective | project, title, description, owner, quarter, due_date, status | |
| planning.Milestone | project, name, description, owner, start_date, due_date, completed_at | check start ≤ due |
| planning.Epic | project, name, description, hue, owner, milestone, archived_at | unique (project, lower(name)) |
| planning.Sprint | project, name, number, goal, start_date, end_date, state, started_at, completed_at | unique (project, number); one active per project (partial unique index); check start ≤ end |
| planning.SprintScopeChange | sprint, task, kind (added/removed), estimate, actor, at | index (sprint, at) |
| tasks.Task | project, number, key, title, description (JSON), type, priority 0–4, status, assignee, reporter, estimate, due_date, epic, milestone, sprint, parent, objectives (M2M), labels (M2M), position (base-62 fractional string, `C` collation), version, started_at, completed_at, deleted_at, deleted_by, search_vector | unique (project, number); key unique; parent ≠ self; check priority 0–4; GIN(search_vector); indexes (project, status, position), (assignee), (sprint), (completed_at) |
| tasks.TaskStatusHistory | task, from_status, to_status, from_category, to_category, changed_by, at | index (task, at), (to_category, at) |
| tasks.ExternalLink | task, provider, url, type, external_id | v2 reserve, no endpoints |
| collaboration.Comment | task, author, body (JSON), body_text, mentions (M2M), edited_at, deleted_at, deleted_by, search_vector | GIN(search_vector) |
| collaboration.Attachment | task, uploader, file_name, size, mime_type, kind, storage_key, status (pending/ready), deleted_at | storage_key unique |
| notifications.DomainEvent | type, workspace, project, actor, payload, processed_at | outbox |
| notifications.Notification | recipient, type, actor, project, task, payload, read_at, emailed_at | index (recipient, read_at, created_at) |
| notifications.NotificationPreference | user, events (JSON), email_delivery | one per user |
| audit.AuditLog | workspace, project, task, actor, actor_name, action, entity_type, entity_id, entity_key, target, changes (JSON diff), data, source, request_id | index (workspace, created_at), (project, created_at), (task, created_at) |

Cross-project invariants (a task and its parent, epic, milestone, sprint, status, labels and
objectives belong to one project; subtasks cannot have subtasks) are enforced in
`tasks.services` and backed by DB check constraints where Postgres allows (parent ≠ self).

## 3. Access model

- `access.services.can(user, code, obj)` is the only decision point. `obj` is a Workspace or a
  Project. Workspace permissions come only from the WorkspaceMember role; project permissions only
  from the ProjectMember role. No override between scopes. Results are cached per request on the
  user object.
- Every view declares its permission (`permission_map = {"GET": "project.view", ...}`) and how to
  resolve its scope object. A single DRF permission class enforces it.
- Resolution errors: not a workspace member → 404 `not_found`; workspace member without project
  membership → 403 `project_membership_required` (with `details.project` access info so the
  frontend can show the request-access screen); missing permission → 403 `forbidden`
  (`details.permission`).
- Ownership-type rules are written in permissions, never role names: "owners" are members whose
  role holds `workspace.delete`; "project admins" are members whose role holds
  `project.manage_members`. You can only grant a workspace role whose permissions are a subset of
  your own.

## 4. Endpoint table (all under `/api/v1`)

Shapes: camelCase fields, `my_permissions` verbatim; lists `{ data, nextCursor }` where the
client expects `Paginated<T>`, plain arrays elsewhere (as the client types say); errors
`{ code, message, details }`, validation 422 `validation_failed` with `details.fields`.

| Area | Endpoints |
|---|---|
| Health/schema | `GET /health`, `GET /api/schema/`, `GET /api/docs/` |
| Auth | `POST auth/register, auth/login, auth/refresh, auth/logout, auth/forgot-password, auth/reset-password`; `GET/PATCH auth/me`; `PUT auth/me/password`; `GET invites/{token}`; `POST invites/{token}/accept` |
| Workspaces | `GET/POST workspaces`; `GET/PATCH/DELETE workspaces/{slug}`; `GET workspaces/{slug}/slug-availability`; members list/patch/delete; invites list/create/revoke/resend; `GET/POST/DELETE workspaces/{slug}/access-requests(/mine)`; `GET workspaces/{slug}/project-directory`; `GET workspaces/{slug}/activity`; `GET workspaces/{slug}/tasks`; `GET workspaces/{slug}/tasks/{key}`; `GET workspaces/{slug}/search`; `GET workspaces/{slug}/audit`; `GET workspaces/{slug}/trash`; `POST workspaces/{slug}/trash/restore`, `.../trash/purge`; saved views `GET/POST workspaces/{slug}/views`, `PUT workspaces/{slug}/views/order`, `PATCH/DELETE views/{id}` |
| Roles | `GET permissions`; `GET/POST workspaces/{slug}/roles`; `PATCH/DELETE roles/{id}`; `PUT roles/{id}/permissions` |
| Projects | `GET/POST workspaces/{slug}/projects`; `GET workspaces/{slug}/projects/{key}`; `GET/PATCH/DELETE projects/{id}`; `POST projects/{id}/archive, /unarchive`; members CRUD; statuses CRUD + `POST statuses/reorder`; labels CRUD; access requests (create, withdraw, list, approve/deny); `GET projects/{id}/activity, /summary, /active-sprint` |
| Planning | objectives, milestones, epics, sprints: `GET/POST projects/{id}/<kind>`, `GET/PATCH/DELETE <kind>/{id}`; `POST objectives/{id}/tasks`, `DELETE objectives/{id}/tasks/{taskId}`; `POST sprints/{id}/start, /complete`; `GET sprints/{id}/board` |
| Tasks | `GET/POST projects/{id}/tasks`; `GET/PATCH/DELETE tasks/{idOrKey}`; `POST tasks/{id}/restore, /move`; `POST projects/{id}/tasks/bulk`; `GET/POST tasks/{id}/subtasks`; `PUT tasks/{id}/objectives`; `PUT tasks/{id}/labels`; `GET tasks/{id}/activity`; `GET me/tasks`; `GET me/recents` |
| Board | `GET projects/{id}/board`, `GET projects/{id}/backlog` |
| Collaboration | `GET/POST tasks/{id}/comments`; `PATCH/DELETE comments/{id}`; `GET tasks/{id}/attachments`; `POST tasks/{id}/attachments/upload-url`; `POST tasks/{id}/attachments` (confirm) and `POST attachments/{id}/confirm`; `GET attachments/{id}/download-url`; `DELETE attachments/{id}` |
| Reports | `GET projects/{id}/reports/{kpis,burndown,velocity,cycle-time,throughput,progress}` |
| Notifications | `GET notifications`, `GET notifications/unread-count`, `POST notifications/{id}/read`, `POST notifications/read-all`, `GET/PUT notification-preferences` |
| Search | `GET search?q=&type=` (tasks + comments), `GET workspaces/{slug}/search` (frontend palette) |
| Trash | `POST trash/{type}/{id}/restore` (brief) in addition to the workspace trash endpoints |

## 5. Cross-cutting decisions

| Topic | Decision |
|---|---|
| Auth | SimpleJWT. Access token (15 min) in the body as `accessToken`. Refresh token (14 days) in an httpOnly cookie scoped to `/api/v1/auth/`, Secure + SameSite configurable (Lax default). Logout and password changes blacklist refresh tokens. Cookie endpoints check `Origin` against the CORS allow-list (CSRF defence; the client sends no CSRF header). |
| Ordering | Base-62 fractional index strings (the client sends strings). A move updates one row; when a key grows past 24 characters the column is rebalanced in one transaction. |
| Concurrency | `Task.version` incremented on every write; PATCH/move compare it and return 409 `version_conflict` with `details.current`. Task keys come from `Project.task_seq` under `select_for_update`. |
| Progress | Computed from tasks in the done category (canceled excluded) in selectors; never stored. |
| Notifications | Services write `DomainEvent` rows; `transaction.on_commit` enqueues a Celery task (eager when no broker) that creates Notification rows and sends email according to preferences. `due_soon` and digest emails are management commands. |
| Files | `StorageBackend` interface: `R2Storage` (boto3, presigned PUT/GET, HEAD) and `FakeStorage` (tests/dev). Server-generated keys `ws/<id>/p/<id>/t/<id>/<uuid>`. |
| Search | `SearchVectorField` + GIN on tasks and comments, refreshed by services; `websearch_to_tsquery` plus prefix matching for the palette. |
| Rich text | Tiptap JSON is validated against an allow-list of node and mark types, attributes are filtered, and link hrefs are restricted to http(s)/mailto. Stored as JSON, never rendered as HTML by the API. |
| Throttling | DRF scoped throttles on auth, reset, invitations; default user/anon throttles. |

## 6. Build order

0. Foundations: skeleton, settings split, env, Docker Compose, Makefile, CI, health, error
   handler, OpenAPI.
1. Auth and workspaces (+ invitations).
2. Roles and permissions (`can()`, catalogue sync, default roles, permission classes).
3. Projects, members, statuses, templates, labels, access requests.
4. Tasks core, history, audit, bulk, my tasks.
5. Board, backlog, move.
6. Planning: objectives, milestones, epics.
7. Sprints.
8. Comments, attachments.
9. Notifications.
10. Search, audit log, trash.
11. Reports.
12. Hardening: throttling review, security pass, seed data, deployment, README.

After each phase: ruff, mypy, full test suite, regenerate `docs/openapi.yaml`, commit.

## 7. Known differences between the brief and the frontend client (frontend shape used)

| Brief | Frontend client (implemented) |
|---|---|
| Lists `{ results, next_cursor }` | `{ data, nextCursor }` (plain arrays where the client expects arrays) |
| snake_case fields | camelCase fields, except `my_permissions` |
| Validation errors (DRF 400) | 422 `validation_failed`, `details.fields: {field: message}` |
| `auth/password-reset`, `auth/password-reset/confirm`, `auth/change-password` | `auth/forgot-password`, `auth/reset-password`, `PUT auth/me/password` |
| Workspaces by id | Workspaces by slug |
| `workspaces/{id}/invitations`, `invitations/{token}` | `workspaces/{slug}/invites`, `invites/{token}` |
| `PUT roles/{id}/permissions` | `PATCH roles/{id}` (both implemented) |
| Decimal positions | Base-62 string positions |
| `POST attachments/{id}/confirm` | `POST tasks/{id}/attachments {uploadId}` (both implemented) |
| `POST trash/{type}/{id}/restore` | `POST workspaces/{slug}/trash/restore {items}` (both implemented) |
| `GET search?q=&type=` | `GET workspaces/{slug}/search` (both implemented) |
| Task keys immutable | Mock re-keys tasks when the project key changes; backend keeps keys immutable and reserves the old prefix |
