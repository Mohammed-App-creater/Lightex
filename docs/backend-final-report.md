# Lightex backend — final report (v1)

**Status:** all phases (0–12) are built and committed on the `backend/v1` branch. Every gate passes.

| Check | Result |
|---|---|
| `ruff check` / `ruff format --check` | clean |
| `mypy apps config` (django-stubs) | clean |
| `pytest` | 1,089 tests passing (PostgreSQL 17) |
| Coverage | 96.8 % overall (gate 85 %); 99 % on `apps/access` (gate 95 %) |
| `makemigrations --check` | no pending migrations |
| OpenAPI | `docs/openapi.yaml` regenerated and validated: 101 paths, 143 operations |
| Live web client | the real frontend in `NEXT_PUBLIC_API_MODE=live` against this API: every v1 screen loads without an API error, and the scripted flows pass (see §6) |

`backend/scripts/check.sh` runs every gate in CI order and stops at the first failure.

---

## 1. What was built

**Foundations.** Django 5.2 + DRF under `backend/`, settings split (base / dev / test / prod) with all
configuration from the environment, Docker Compose (Postgres, optional Redis + worker), Makefile, GitHub Actions
workflow (lint, types, migrations check, tests with coverage gates, OpenAPI drift check), `/health`, request ids
(`X-Request-ID`), one error shape `{ code, message, details }`, keyset cursor pagination, OpenAPI at
`/api/schema/` with Swagger UI at `/api/docs/`.

**Data model.** UUID keys and UTC `created_at`/`updated_at` everywhere. Soft delete (`deleted_at`, default managers
hide deleted rows) on workspaces, projects, tasks, comments and attachments. Database constraints back the
invariants where Postgres can: unique live project keys, one active sprint per project (partial unique index),
task number unique per project, priority and estimate ranges, a task can't be its own parent, one pending invite
per email, ordered milestone and sprint dates.

**Auth.** Register, login, refresh, logout, forgot/reset password, change password, profile. 15-minute access
token in the body; 14-day refresh token in an httpOnly cookie scoped to `/api/v1/auth/` (Secure and SameSite
configurable). Logout blacklists the refresh token; password reset and change revoke every session. Reset and
invitation tokens are random, stored as SHA-256 hashes, compared in constant time and single-use.

**Access control.** The permission catalogue lives in code (`apps/access/catalogue.py`) and syncs on every
`migrate` (also `manage.py sync_permissions`). Seven system roles per workspace. `access.services.can()` is the only
decision point; results are cached per request. Every view declares the permission each method needs, and one DRF
permission class enforces it. Workspace and project scopes never override each other. Non-members of a workspace
get 404; workspace members who aren't on a project get 403 `project_membership_required` with the request-access
context. Invariants are expressed in permissions, never role names: the last holder of `workspace.delete` can't be
removed or demoted, a project always keeps one holder of `project.manage_members`, and nobody can grant workspace
permissions they don't hold.

**Workspaces.** CRUD by slug, slug availability, members (paged, filters), role changes, removal, invitations
(7-day expiry, resend rotates the link, revoke, works for new and existing accounts), workspace access requests,
project directory, activity feed.

**Roles.** Catalogue, list with member counts, custom roles in one scope, system roles locked to their core
permissions, delete with reassignment (`role_in_use` otherwise).

**Projects.** Four workflow templates (Simple, Scrum, Kanban, Bug tracking) with default labels; the creator
becomes Project Admin; list (member-of only), get by key or id, update, archive (read-only while archived),
soft delete and restore, members, access requests (create, withdraw, list, deny), statuses (CRUD, reorder,
delete with move-to), labels (CRUD with counts), recents, saved views with sidebar pins.

**Tasks.** Create with per-project keys allocated under `SELECT … FOR UPDATE`; read by id or key; update with a
required optimistic `version` (409 `version_conflict` with the current task); edit_any / edit_own / move-only /
assign rules; subtasks one level deep; labels and objectives; cursor-paginated lists with `filter[...]`, `q` and
`sort`; bulk update/delete/restore (all-or-nothing); my tasks; activity. Every status change writes
`TaskStatusHistory` and sets or clears `completed_at`.

**Board and backlog.** Board (active sprint, all, or a sprint), backlog grouped by open sprints, and `move` with
base-62 fractional positions: a normal move updates one row; a column is rebalanced when keys grow past 24
characters.

**Planning.** Objectives (task links), milestones (expected progress, at-risk), epics and sprints (start with a
commitment snapshot, complete with carry-over, scope-change tracking, sprint board). Progress is always computed
from tasks in the done category, never stored.

**Collaboration.** Comments on sanitised Tiptap JSON with mentions (project members only). Attachments through a
storage interface: R2 via boto3, a local signed-URL backend for development, an in-memory fake for tests. Upload
URL → direct PUT → confirm, where confirm checks the real size, type and (for raster images) magic bytes, and
deletes and rejects mismatches.

**Notifications.** Outbox (`DomainEvent`) written inside the service transaction, processed after commit by Celery
(inline without a broker) exactly once, with retries via `process_outbox`. In-app notifications and the seven
designed emails, following each user's preferences (instant or hourly/daily queue). Due-soon reminders command.

**Search, audit, trash.** PostgreSQL full-text search (GIN-indexed vectors, prefix matching for type-ahead) over
tasks and comments, always within the caller's projects. Audit log with filters and totals. Trash list, restore
and purge; `purge_trash` removes items after 30 days.

**Reports.** KPIs, burndown (replayed from status history and scope changes), velocity, cycle time, throughput,
objective/milestone progress, project summary.

**Hardening.** Scoped throttles (login per IP and per account, password reset, invitations, invite tokens,
uploads), CORS limited to configured origins, Origin check on the cookie endpoints, production security settings,
admin off in production, rich-text allow-list sanitiser, secrets scrubbed from audit rows, IDOR suite.

**Seed and docs.** `seed_demo` loads the web client's own mock data; `backend/README.md` covers setup, variables,
tests, running without a worker, connecting the client and deployment; `render.yaml` is a free-tier blueprint.

---

## 2. Deviations

### 2.1 From the build brief (the frontend client's shapes win, as instructed)

| Brief | Implemented (frontend client) |
|---|---|
| Lists `{ results, next_cursor }` | `{ data, nextCursor }` where the client expects `Paginated<T>`; plain arrays where the client expects arrays |
| snake_case fields | camelCase, except `my_permissions` |
| Validation errors (DRF 400) | 422 `validation_failed` with `details.fields: { field: message }` |
| `auth/password-reset`, `auth/password-reset/confirm`, `auth/change-password` | `auth/forgot-password`, `auth/reset-password`, `PUT auth/me/password` |
| Workspaces addressed by id | By slug |
| `workspaces/{id}/invitations`, `invitations/{token}` | `workspaces/{slug}/invites`, `invites/{token}` |
| Decimal board positions | Base-62 fractional-index strings (byte-for-byte the client's algorithm; `C` collation column) |
| `PUT roles/{id}/permissions`, `POST attachments/{id}/confirm`, `POST trash/{type}/{id}/restore`, `GET search?q=&type=`, `GET tasks/{id or key}`, `GET me/tasks`, `GET tasks/{id}/subtasks`, `GET sprints/{id}/board`, `PUT tasks/{id}/objectives`, `tasks/{id}/labels` | Implemented **as well as** the client's equivalents, over the same services |

### 2.2 From the brief's wording, by decision

- **Refresh-token rotation is off.** With rotation, two tabs refreshing at once log each other out. Logout
  blacklists the cookie's token and password changes revoke every session instead.
- **CSRF on the cookie endpoints** is an `Origin` allow-list check plus SameSite, not a CSRF token: the client
  sends no token header.
- **Invitation and password-reset emails bypass the outbox.** They carry single-use tokens, which must never be
  stored; everything else goes through `DomainEvent`.
- **Registration and enumeration.** Login and reset reveal nothing (identical responses, equalised timing).
  Registration returns a deliberately vague 422 for a taken email, because the client signs the user in straight
  after registering; full non-enumeration needs an email-verification step the contract doesn't have.
- **"Comment on your task" and "status change" emails** aren't sent (no designed template); they are in-app only.
  "Sprint completed" is email-only (the inbox has no row type for it).
- **Digest delivery** sends each queued email individually at digest time (no digest template).
- **Archived projects are read-only** (only view, report, archive/unarchive, delete and member management
  remain). Not specified; it falls out of `my_permissions` so the UI follows automatically.
- **Role deletion with members** is allowed when a reassignment target is given (the client's `reassignTo`);
  without one it returns 409 `role_in_use` as specified.

### 2.3 From the frontend mock's behaviour

| Mock | Backend | Client impact |
|---|---|---|
| Non-member project → 403 `forbidden` | 403 `project_membership_required`, same `details` | None (the client checks the status and `details.project`) |
| Task by key for a non-member → 404 | 403 `project_membership_required` (brief rule) | The task page shows the 403 state instead of 404 |
| Changing a project key re-keys all tasks | Task keys are immutable; the old prefix stays reserved; old URLs resolve | Existing tasks keep their old prefix |
| The Owner role can never be assigned | Owners (holders of every permission it grants) can assign it; last-owner protection applies | The role description still says "Can't be assigned" |
| System roles can't be edited at all | Name/description locked (403); permissions editable except each role's core set | None |
| Accepting an invite for an existing email signs in without a password | Requires that account's password, or a session as that user | Existing users type their own password on the accept screen |
| `version` optional on PATCH | Required (the client always sends it) | None |
| Velocity counts unestimated tasks as 1 point and pads history with design data | Unestimated = 0; real history only | Fewer bars until real sprints complete |
| Cycle-time median from bin midpoints | Exact median | Slightly different number |
| Mentions of anyone | Only project members are kept and notified | None |
| Labels: no edit/delete rules | Create needs `task.create`; edit/delete need `project.update` | None |
| Status delete always 409 with tasks | Accepts `moveTo`; a workflow keeps at least one To do and one Done status | None |
| Access requests notify admins as an "assigned" row with a quote | Same | Same |

---

## 3. Contract additions

Endpoints that are in neither the brief nor the client:

| Method | Path | Why |
|---|---|---|
| POST | `/projects/{id}/access-requests/{requestId}/deny` | The design has "Deny"; the client lists it as needed with no call yet |
| GET | `/objectives/{id}`, `/milestones/{id}`, `/epics/{id}`, `/sprints/{id}` | Single-item reads (the brief says CRUD) |
| POST | `/projects/{id}/statuses/reorder` `{ids}` | The brief's "reorder"; the client reorders through `PATCH … {position}`, which also works |
| PUT / GET | `/storage/upload/{token}`, `/storage/download/{token}` | Development storage (`STORAGE_BACKEND=local`) so uploads work without R2; 404 otherwise |
| GET | `/api/v1/health` | Same as `/health`, for proxies that only forward `/api` |

Endpoints from the client's own "requested API additions" (not in the brief), all implemented:
slug availability, project directory, workspace access requests (board 24), project and workspace activity,
project summary, active sprint, recents, report KPIs, notification unread count and counts/undo, task restore,
project unarchive, workspace tasks by assignee, trash list/restore/purge, saved views and pin order (board 30).

Response fields added on top of the client types: `Milestone.taskIds`; `ProgressRow.dueDate` (the client already
reads it); `GET attachments/{id}/download-url` also returns `previewUrl`.

---

## 4. Dependencies beyond the brief's stack

| Package | Why |
|---|---|
| `django-environ` | Parses `DATABASE_URL` and typed env vars for the settings split |
| `psycopg[binary]` 3 | PostgreSQL driver |
| `redis` (via `celery[redis]`) | Broker client when Redis is configured |
| `freezegun` (dev) | Deterministic time in report, expiry and due-soon tests |
| `django-stubs`, `djangorestframework-stubs` (dev) | mypy support for Django/DRF |

No frontend dependency was added. The seed export (`backend/scripts/frontend-seed/`) uses Node's built-in
TypeScript stripping.

---

## 5. Known gaps

- **Docker** was verified on 2026-10-08: `docker compose up --build` (db + api) migrates and serves the API,
  `seed_demo` runs in the container, and the full suite passes inside the api container (1,089 tests). The
  production image boots gunicorn with prod settings, serves static files, hides the admin and sets the secure
  refresh cookie. The optional `worker` profile (Redis + Celery worker) was not run.
- **R2 was not exercised against a real bucket.** The R2 backend uses standard boto3 presigning; the flow is
  covered end to end with the fake and local backends.
- **The web client's CSP blocks attachment previews in live mode.** `img-src` in `frontend/next.config.ts`
  allows `'self' blob: data:` only; it needs `${uploadOrigin}` like `connect-src`. Uploads, downloads and the
  attachment list work; only the inline `<img>` preview is blocked. One-line frontend change; not made here
  because the frontend tree has your uncommitted work.
- **`X-Content-Type-Options: nosniff` on R2 downloads** needs a Cloudflare Transform Rule (presigned URLs can't set
  it). The local backend sets it. Non-image downloads are forced to `application/octet-stream` + attachment either
  way.
- **"Today" is UTC** for due-soon, overdue, expected progress and sprint day index; the client uses local time,
  so values can differ by a day around midnight.
- **Rate limits without Redis are per process.** With several gunicorn workers each counts separately.
- **No unsubscribe tokens.** The email unsubscribe link opens the notification preferences page.
- **Not built (client lists them as "needed by design, no call yet"):** restore a deleted workspace, change a
  pending invite's role, "request a different role", report PNG/PDF export, Google OAuth, signed avatar upload
  (avatars arrive as validated data URLs up to 2 MB, PNG/JPEG/WebP only).
- **Audit `actorKind`** is always `user`; there are no integration actors in v1.
- **Python 3.12** is the target (Dockerfile, CI); local development ran on 3.13.

---

## 6. Verification against the real web client

The frontend (unchanged) ran with `NEXT_PUBLIC_API_MODE=live` against this API seeded with `seed_demo`:

- **Every v1 screen** (24 routes: home, inbox, my tasks, search, project overview, board, list, backlog, sprints,
  objectives, milestones, epics, reports, project settings, task page, trash, workspace settings ×6, other
  projects) loaded with no failed API call and no error state.
- **Session**: reloading the page restores the session through the refresh cookie.
- **Flows**: register → onboarding (create workspace, create project) → create a task → drag it to another column
  (`POST /tasks/{id}/move` 200, version bumped); post a comment; upload an image (upload URL → direct PUT →
  confirm); a workspace admin outside a project sees the 403 screen and requests access.

---

## 7. Deployment steps

1. Provision PostgreSQL (14+) and, optionally, Redis.
2. Build `backend/Dockerfile` (or use `render.yaml` on Render). The container runs `migrate` and then gunicorn on
   `$PORT`.
3. Set at least: `DJANGO_SETTINGS_MODULE=config.settings.prod`, `DJANGO_SECRET_KEY`, `JWT_SIGNING_KEY`,
   `DATABASE_URL`, `DJANGO_ALLOWED_HOSTS`, `CORS_ALLOWED_ORIGINS` (the client origin), `FRONTEND_URL`,
   `API_PUBLIC_URL`, SMTP settings, and `STORAGE_BACKEND=r2` with the `R2_*` values. If the client is on another
   site, `REFRESH_COOKIE_SAMESITE=None`.
4. Configure the R2 bucket CORS rule for browser PUTs and, on a custom domain, a nosniff Transform Rule.
5. Schedule `send_due_soon` (daily), `send_notification_emails --delivery hourly|daily`, `purge_trash` (daily)
   and optionally `process_outbox`.
6. Point the client at the API: `NEXT_PUBLIC_API_MODE=live`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_UPLOAD_ORIGIN`
   (and add the upload origin to the client's `img-src`).

---

## 8. v2 · Board 39: custom fields, dependencies, time tracking

Built from `docs/v2/39-fields-dependencies-time.md` (the contract), on branch `v2`.

| Check | Result |
|---|---|
| `ruff check` / `ruff format --check` / `mypy apps config` | clean |
| `makemigrations --check` | no pending migrations |
| `pytest` | 1,312 tests passing (PostgreSQL 17), 104 of them in the new board-39 test files plus new matrix, IDOR, seed and concurrency cases |
| Coverage | 97.0 % overall (gate 85 %); 99 % on `apps/access` (gate 95 %) |
| OpenAPI | `docs/openapi.yaml` regenerated and validated: 114 paths, 160 operations |

**Data model.** `projects.CustomField` / `CustomFieldOption` (migration `projects 0003_custom_fields`);
`tasks.TaskFieldValue`, `tasks.TaskDependency` and `Task.time_estimate_minutes` (`tasks 0002_fields_dependencies_time`);
new app `apps.timetracking` with `TimeEntry` and `RunningTimer` (`timetracking 0001_initial`). Every constraint of §2
is in the database (case-insensitive unique names, exactly one value column, number and estimate ranges, dependency
unique + not-self, entry minutes 1–1440, one timer per user). `access 0003_board39_permissions` is an idempotent data
migration that creates `field.manage`, `time.log`, `time.delete_any` if missing and grants them to existing system
roles by `system_key` (Project Admin and Manager: all three; project Member: `time.log`); custom roles are untouched.

**Endpoints.** F1–F5 (`projects/{id}/custom-fields`, `…/order`, `custom-fields/{id}`), T1 (`PATCH tasks/{id}` accepts
`customFields` as a merge and `timeEstimateMinutes`), D1–D3 (`tasks/{id}/dependencies[/{dependencyId}]`), E1–E3
(`tasks/{id}/time-entries`, `time-entries/{id}`), R1–R3 (`me/timer`, `tasks/{id}/timer`, `me/timer/stop`) and S1
(`workspaces/{slug}/timesheet`). Every `Task` payload gains `customFields`, `isBlocked`, `openBlockers`,
`timeEstimateMinutes`, `loggedMinutes`; `TaskDetail` gains `dependencies`. `GET projects/{id}/tasks` takes
`filter[blocked]`. Saved views understand `blocked` and `cf.<fieldId>` rules (rules for deleted fields match
everything), and their counts include them. The board keeps a constant query count (tested with 5 and 50 tasks
carrying values, entries and blockers). Dependency adds lock the project row before the cycle BFS (tested with two
real concurrent transactions). All writes are audited as listed in §5.2 of the contract; `task.dependency_added` and
`task.dependency_removed` feed the activity feeds (`dependency_added` / `dependency_removed`).

**Seed.** `seed_demo` adds the PRJ custom fields, values, dependencies, PRJ-42's estimate and entries (255 minutes
logged), weekday timesheet entries for PRJ, MOB and INF members over the current and previous week, and a pinned
"Blocked" view for every PRJ member. No timer is seeded.

### 8.1 Decisions where the contract was silent or ambiguous

| # | Topic | Decision |
|---|---|---|
| 1 | `seed_demo` source | The exported fixture (`demo_seed.json`) has no board-39 collections yet (the frontend mock is being built in parallel). `seed_demo` builds the §6.8 PRJ data itself, and loads the mock's `customFields` / `dependencies` / `timeEntries` collections (plus `TaskRec.customFields` / `timeEstimateMinutes`) instead once the fixture is regenerated. The timesheet fill is a port of the mock's `seedTimesheet` (same hash, same task, note and source choices, real dates), so the live timesheet matches mock mode; PRJ-42 is excluded, so its total stays 255 minutes. |
| 2 | Invisible ids | A custom field or time entry in a project the caller isn't on is 404 (`Custom field not found.` / `Time entry not found.`), as F3/E3 say, rather than v1's 403 `project_membership_required`. |
| 3 | Deleted tasks | The new task-scoped routes (dependencies, time entries, timer) resolve soft-deleted tasks, so reads work and writes return 409 `task_deleted`. `PATCH tasks/{id}` keeps v1's lookup, which hides deleted tasks (404); the service itself still refuses with 409. |
| 4 | Text values | A non-string value for a text field is 422 `Up to 120 characters` (the contract has no message for it; this matches the mock). |
| 5 | Create and bulk | `POST projects/{id}/tasks` ignores `customFields` / `timeEstimateMinutes` (v1 ignores unknown keys); bulk refuses them with the v1 message. |
| 6 | Option errors | `options.N.*` indices refer to the submitted array (before blank rows are dropped). An option `id` sent on create is `options.N.id: Unknown option`. Colour-only option edits are saved and audited with an empty diff. |
| 7 | Number values | Returned as JSON integers when whole (`1240`), otherwise as decimals (`12.35`). |
| 8 | Cycle path | The loop starts at the task that would become blocked: on PRJ-42, "blocked by PRJ-47" when PRJ-42 blocks PRJ-47 gives `["PRJ-42","PRJ-47","PRJ-42"]`. |
| 9 | Remove a link | When the other task is soft-deleted the link is hidden, so `DELETE …/dependencies/{id}` is 404 until it is restored. |
| 10 | Timer stop order | 404 (no timer) → 409 / 403 (timer discarded, and the discard commits) → 422 on a bad `date` (timer kept) → log. Durations round half up (30 s → 1 minute), as JavaScript's `Math.round` does. |
| 11 | Timesheet filter | `filter[project]` from another workspace is 404; a project where a custom role lacks `project.view` is 403 `forbidden`. |
| 12 | Routing | `apps.timetracking.urls` is included before `apps.tasks.urls`, and the dependency routes sit before `tasks/<str:task_ref>`. |
| 13 | OpenAPI drift | Regenerating also picked up an earlier, unregenerated change: `GET/PATCH auth/me` now reference the `Me` schema. |

### 8.2 Not in this release (per the contract)

No notifications for dependency, field or time events; no editing of time entries; no timer pause; no
cross-project dependencies; custom-field filtering is not added to `GET projects/{id}/tasks` (clients filter).

### 8.3 v2 · Board 32: timeline & calendar

Built from `docs/v2/32-timeline-calendar.md` (the contract), on branch `v2`, after board 39. No new endpoint, app or
permission.

| Check | Result |
|---|---|
| `ruff check` / `ruff format --check` / `mypy apps config` | clean |
| `makemigrations --check` | no pending migrations |
| `pytest` | 1,364 tests passing (PostgreSQL 17); 52 of them are new for board 32 (`tasks/tests/test_schedule.py`, `planning/tests/test_epic_dates.py`, one seed test) |
| Coverage | 97.1 % overall (gate 85 %); 99 % on `apps/access` (gate 95 %) |
| OpenAPI | `docs/openapi.yaml` regenerated and validated |

**Data model.** `Task.start_date` with `task_dates_ordered` and the `task_due` / `task_start` indexes
(`tasks 0003_task_start_date`); `Epic.start_date` / `Epic.due_date` with the both-or-neither `epic_dates_ordered`
check (`planning 0003_epic_dates`). No data migration: existing rows are `NULL`.

**Endpoints.** `GET projects/{id}/tasks` takes `filter[from]`, `filter[to]` (inclusive overlap with the effective span
`[start ?? due, due ?? start]`, at most 400 days) and `filter[scheduled]`, and sorts by `startDate` / `-startDate`
(empty dates last ascending, first descending, the `dueDate` sentinel). `PATCH tasks/{id}` and `POST
projects/{id}/tasks` accept `startDate`, with the order checked on the resulting pair and the field-specific messages;
the version is still checked first and bumped once. Bulk refuses `patch.startDate` and fails the whole request when
`patch.dueDate` falls before any selected task's start (first offending key by number). Epic create / patch accept
`startDate` / `dueDate` under `epic.manage`. Every `Task` payload carries `startDate`; every `Epic` payload carries
`startDate` and `dueDate`.

**Side effects.** `task.updated` audits `Start date` alongside `Due date` (so the activity feed shows the v1
"updated" entry); `epic.updated` audits `Start date` and `Target date`. No notifications.

**Seed.** `seed_demo` reads `startDate` (tasks) and `startDate` / `dueDate` (epics) from the fixture when present, then
runs a port of the mock's `ensureExt32`: the 22 PRJ start dates of §6.9 where the task has no start and its due date is
still the seeded one, the four design epic dates where the epic has none, and PRJ-50 blocks PRJ-52. That link makes
PRJ-52 blocked, so the seeded "Blocked" view now counts 5 (the board 39 seed test was updated to match).

**Shared vectors.** `apps/tasks/tests/data/span_vectors.json` is a verbatim copy of the frontend's
`frontend/src/features/schedule/span-vectors.json`, and every case runs against the real filter.

### 8.4 Board 32 decisions where the contract was silent or ambiguous

| # | Topic | Decision |
|---|---|---|
| 1 | Date format | `startDate`, `dueDate` (task and epic) and `filter[from]` / `filter[to]` must be exactly `YYYY-MM-DD` and a real date. v1's `dueDate` parser also accepted other ISO forms such as `20261009`; they are now `Pick a date`, which matches the mock. |
| 2 | Deleted task PATCH | As in board 39 (§8.1 #3): the `tasks/{id}` route hides soft-deleted tasks (404). The service still refuses with 409 `task_deleted`, which is tested at the service level. |
| 3 | Bulk check order | The date checks (`patch.startDate` refusal, bad `patch.dueDate` format, start after due) run before the permission and deleted-task checks, as in the mock. A bad bulk `dueDate` format is keyed `patch.dueDate`; v1 keyed it `dueDate`. |
| 4 | Repeated range params | Only the first non-empty `filter[from]` / `filter[to]` / `filter[scheduled]` is used, and empty values count as absent. When either date is malformed, both format errors are reported and the order and length checks are skipped. |
| 5 | Epic errors | The one-sided error is always on `startDate`, even when only `dueDate` was sent (as in the contract's table and the mock). Format errors skip the pair checks. Creating an epic with dates writes only `epic.created`, with no date changes. |
| 6 | Sort scope | `startDate` joins the shared sort table, so `me/tasks` and `workspaces/{slug}/tasks` accept it too. The range filters are only on `projects/{id}/tasks` (contract §9 #1). |
| 7 | Migration graph | `tasks 0003` depends on `planning 0003` (as Django generated it). |

### 8.5 v2 · Board 40: import wizard

Built from `docs/v2/40-import-wizard.md` (the contract) on branch `v2`, after boards 39 and 32.

| Check | Result |
|---|---|
| `ruff check` / `ruff format --check` / `mypy apps config` | clean |
| `makemigrations --check` | no pending migrations |
| `pytest` | 1,689 tests passing (PostgreSQL 17); 325 are new: 247 in `apps/imports/tests` (169 shared-vector cases), 5 in `access/tests/test_board40_permissions.py`, 46 permission-matrix and 27 IDOR cases for the nine routes |
| Coverage | 97.0 % overall (gate 85 %); 99 % on `apps/access` (gate 95 %); `apps/imports` 94–100 % per module |
| OpenAPI | `docs/openapi.yaml` regenerated and validated: 122 paths, 169 operations |

**Data model.** The new app `apps.imports` has `ImportJob` (status machine, lease token and heartbeat, cursor, phase,
setup, counters, retention) and `ImportRow` (unique per job and row). Its migration is `imports 0001_initial`, which
adds the one-active-per-project partial unique constraint, the 5,000-row check and the recovery/expiry indexes.
`access 0004_board40_import_permission` is an idempotent data migration: it creates `project.import` and grants it to
the Project Admin, Manager and project Member system roles. Custom roles are untouched.
`notifications 0003_notification_import_type` adds `import` to `Notification.type`'s choices. No changes to the
`tasks`, `projects` or `planning` tables. `Project.nextTaskNumber` is computed as `task_seq + 1`.

**Endpoints.**

- I1 `POST projects/{id}/imports`: a signed upload ticket from the existing storage backends, throttled by
  `UploadThrottle` plus `THROTTLE_IMPORTS` (20/hour).
- I2 `POST imports/{id}/analyze`.
- I3 `GET imports/{id}`: also re-dispatches a stale runner.
- I4 `PUT imports/{id}/mapping`.
- I5 `GET imports/{id}/rows`.
- I6 `POST imports/{id}/start`.
- I7 `POST imports/{id}/cancel`.
- I8 `GET imports/{id}/error-report`: a 60 s presigned GET, `text/csv; charset=utf-8`, served as an attachment.
- I9 `GET projects/{id}/imports`.

Every `Project` payload gains `nextTaskNumber`. `GET /permissions` lists `project.import` after `time.delete_any`, and
`my_permissions` follows the §3.3 order.

**Parsing.** The parser is a port of the web client's mock (`src/lib/mock/import/*`):

- `parsing.py` detects the encoding: a UTF-8 BOM, a UTF-16 LE/BE BOM, strict UTF-8, then a Windows-1252 fallback. It
  rejects ZIP/OLE signatures as `excel` and NULs after decoding as `binary`. It then sniffs the delimiter (§7.3) and
  reads quote-aware records, applying the §1.5 limits.
- `presets.py` holds the header synonyms, the Jira/Linear/Asana detection and the mapping suggestions.
- `mapping.py` matches statuses, types, people and priorities, and converts dates (with a per-column `dateOrder`),
  numbers and durations.
- `planner.py` produces the analysis, the value maps, the per-row plan, the validation with its blockers, and the
  normalised mapping.

`tests/data/import_vectors.json` and `jira-export.csv` are byte-for-byte copies of the mock's fixtures. `sample.csv` was
generated by running the mock's `sample.ts` with node, and a test checks the Python port of `sampleText()` against it.

**Execution.** `services.dispatch` runs the import on Celery when there is a broker, in a daemon thread when there
isn't, and synchronously when `IMPORT_RUNNER="inline"` (the test settings). The runner first takes a lease with one
conditional UPDATE. It then works through four phases. Each step is its own transaction and re-checks the lease, the
cancel flag, the project and the creator's `can_import`.

- **preparing** gets or creates labels, epics (with dates) and select options, stores their ids in `setup`, and
  reserves a contiguous block of task numbers under the project lock.
- **rows** commits every `IMPORT_BATCH_SIZE` (200) rows. Tasks, status history, labels, field values, scope changes,
  `ImportRow` rows and audit rows are each written with one bulk statement, and search vectors with one UPDATE. A test
  checks that 50 rows and 200 rows cost the same number of queries.
- **links** sets parents and adds dependencies with board 39's rules (not self, not parent and sub-task, at most 50,
  cycle BFS), in batches under the project lock.
- **finishing** writes the report and the final status, the audit summary and the `import_finished` event.

On a database error the thread runner retries the step twice; under Celery the runner releases the lease and Celery
retries. After the last retry the job fails with `import_failed`. Other failures are `project_unavailable`,
`permission_lost` and `file_missing`. A retry (`start` on a `failed` job) resumes at `phase`/`cursor`. Stale jobs are
re-dispatched by `resume_imports` and by the I3 poll.

**Side effects.**

- **Audit.** Rows carry `source="import"`, the start request's id and the creator as actor. The actions are
  `project.import_started`, `task.imported` (one per task, written through the new `audit.services.record_many`),
  `label.created`, `epic.created`, `project.custom_field_updated` and `project.import_completed`. The audit filter
  "created" includes `task.imported`.
- **Activity.** `task.imported` and `project.import_completed` map to the verb `imported`. The project and workspace
  feeds leave out `task.imported`; each task's own feed keeps it.
- **Notifications.** The creator gets one in-app `import` notification, with no actor, no task, no email and no
  preference row. Imports send no per-task notifications.

**Retention and helpers.** `purge_imports` (daily) expires untouched drafts after 24 h, and deletes the files and rows
of finished jobs after 30 days; the imported tasks stay. Purging a project from Trash deletes its import files
(`imports.services.delete_project_files`). `apps/common/csvsafe.py` holds the formula-safe CSV helper (`csv_safe`,
`csv_line`, `csv_document`), which the error report uses. The storage backends gain a server-side `put()`.
`common.fractional.keys_after` appends many short keys after a column's last card.

### 8.6 Board 40 decisions where the contract was silent or ambiguous

| # | Topic | Decision |
|---|---|---|
| 1 | CSV reader | The reader is hand-written (one regex per field), not Python's `csv`. The shared vectors need two behaviours that `csv` can't give in one mode: lenient text after a closing quote (`"ab"c` → `abc`), and the line where an unclosed quote opened. As in the mock, C0 control characters are stripped from every cell, CR included, so a CRLF inside quotes becomes LF. |
| 2 | Inferred types | The §4.3 rules apply as written. In the sample, Tags infers `text` (1 non-empty cell in 4 is a list, under the 30 % bar) and Assignee infers `text` (3 of 4 names are members, under 80 %). The contract's example shows `list`; the mock follows the rules. |
| 3 | Timesheet export | Board 39's timesheet CSV is built by the web client (`timesheet-lib.ts`). The backend has no timesheet or reports CSV writer to switch over. `csv_safe` is in place for the error report and any future backend export; the client's builder should adopt the mock's `csvSafe` twin. |
| 4 | Explicit choices | The user's explicit value choices are stored with the mapping under a private `_user` key that is never sent, and the `auto` flags are computed against it. The runner plans with the normalised maps, so a restart produces the same plan. |
| 5 | Counters | `ImportJob.epics_created` counts epic **rows** processed (wire `progress.epics` / `result.epics`). The objects actually created are counted in `setup.created` (`result.created`). |
| 6 | Run-time warnings | A status deleted after planning gives `Status “<file value>” was deleted · used <default>`. An assignee removed from the project gives `Assignee left the project · left unassigned` (the mock's copy). |
| 7 | Positions and search | New cards are appended to each column with `keys_after`, which spreads short keys after the last card. Repeated `key_between` would make keys one character longer every few rows. Search vectors are written with one UPDATE per batch (a `CASE` on the description text) instead of one per task, so the query count stays constant. |
| 8 | Inline runner | In tests (`IMPORT_RUNNER="inline"`) the whole import runs inside the start request, so I6's 202 body is already `completed`. In production it is `queued`. |
| 9 | Cancel | Canceling a `draft` or `ready` job deletes its files at once and keeps `expiresAt` (created + 24 h). Canceling a `queued` job writes no audit summary and sends no notification (as in the mock); it sets `finishedAt`, and `expiresAt` to 30 days later. |
| 10 | Errors | I1 and I2 422s use the error title as `message` (as in the mock). An unknown `filter[outcome]` on I5 is a 422. `start` on a `failed` job whose error is `file_missing` is 409 `import_state` "The uploaded file is gone. Start a new import.". A project deleted mid-run gives `project_unavailable` "The project was deleted during the import. …". |
| 11 | Throttle | `THROTTLE_IMPORTS` is a DRF scoped throttle on I1, so it counts every create request, including refused ones. |
| 12 | Celery | The task retries by hand (`self.retry`, 1/2/4 s, 3 times) instead of using `autoretry_for`, so that it can release the lease first. After the last failure the job is marked `import_failed`. |
| 13 | Stored files | `parsed.json.gz` also stores `rawHeader` and `delimiter` (`v: 1`). Created select options are cut to 32 characters (board 39's limit) and take palette colours by position. `ImportJob.expires_at` is nullable, because the wire value is `null` while a job is queued or running. |
| 14 | Deploy docs | `backend/README.md` now lists `purge_imports` (daily) and `resume_imports` (optional, every minute). `render.yaml` is outside `backend/`, so it was not edited; it defines no cron jobs today. |
