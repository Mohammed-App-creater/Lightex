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
