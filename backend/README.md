# Lightex API

The v1 backend for Lightex, a project-management tool for software teams: workspaces, projects, boards,
backlog and sprints, objectives, milestones and epics, comments and attachments, notifications, search,
audit log, trash and reports.

It implements the contract the web client in [`../frontend`](../frontend) was built against, so the client
switches from its mock API to this one by changing environment variables only.

| | |
|---|---|
| Stack | Python 3.12, Django 5.2, Django REST Framework, PostgreSQL, SimpleJWT, drf-spectacular, Celery (optional Redis), boto3 (Cloudflare R2) |
| API docs | `GET /api/docs/` (Swagger UI), `GET /api/schema/` (OpenAPI), [`../docs/openapi.yaml`](../docs/openapi.yaml) |
| Design notes | [`../docs/backend-plan.md`](../docs/backend-plan.md), [`../docs/backend-final-report.md`](../docs/backend-final-report.md) |

## Quick start (Docker)

```bash
cd backend
docker compose up --build                      # API on http://localhost:8000, Postgres in a container
docker compose exec api python manage.py seed_demo
```

Redis and a Celery worker are optional: `docker compose --profile worker up`.

## Quick start (local Python)

Needs Python 3.12+ and PostgreSQL 14+.

```bash
cd backend
python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
cp .env.example .env                           # then set DATABASE_URL and DJANGO_SECRET_KEY
python manage.py migrate
python manage.py seed_demo                     # optional demo data (DEBUG only)
python manage.py runserver 0.0.0.0:8000
```

### Demo accounts

`seed_demo` loads the same data as the web client's mock mode (2 workspaces, 4 projects, 55 tasks,
7 sprints, objectives, milestones, epics). Every account's password is **`Lightex-demo-2026`**.

| Account | Workspace role (Platform team) | Role on Platform Rebuild (PRJ) |
|---|---|---|
| `alex@team.dev` | Owner | Project Admin |
| `jordan@team.dev` | Admin | Manager |
| `sam@team.dev` | Member | Member |
| `taylor@team.dev` | Member | Viewer |
| `casey@team.dev` | Admin | not a member (gets the 403 + request-access screen) |

The command refuses to run when `DEBUG` is off. `--flush` deletes and recreates the demo data.

## Environment variables

All configuration comes from the environment (or `backend/.env` in development). Nothing secret lives in
the repository. See [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `DJANGO_SETTINGS_MODULE` | `config.settings.dev` (manage.py), `config.settings.prod` (wsgi) | `dev`, `test` or `prod` |
| `DJANGO_SECRET_KEY` | required | Django signing key |
| `JWT_SIGNING_KEY` | `DJANGO_SECRET_KEY` | Signs access and refresh tokens |
| `DJANGO_DEBUG` | `true` in dev, `false` in prod | |
| `DJANGO_ALLOWED_HOSTS` | `localhost,127.0.0.1` (required in prod) | |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/lightex` | PostgreSQL connection |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:3000` | Web client origin(s). Also used for the refresh-cookie Origin check |
| `FRONTEND_URL` | `http://localhost:3000` | Links in emails |
| `API_PUBLIC_URL` | `http://localhost:8000` | This API's public URL (signed URLs of the `local` storage backend) |
| `REFRESH_COOKIE_SECURE` | `true` (`false` in dev) | Secure flag on the refresh cookie |
| `REFRESH_COOKIE_SAMESITE` | `Lax` | Use `None` when the client and the API are on different sites |
| `REFRESH_COOKIE_DOMAIN` | unset | |
| `JWT_ACCESS_MINUTES` / `JWT_REFRESH_DAYS` | `15` / `14` | Token lifetimes |
| `REDIS_URL` | unset | Enables the Redis cache and the Celery broker |
| `CELERY_TASK_ALWAYS_EAGER` | `true` when `REDIS_URL` is unset | Run background tasks inline |
| `EMAIL_BACKEND`, `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD`, `EMAIL_USE_TLS`, `DEFAULT_FROM_EMAIL` | console backend | Outgoing mail |
| `COMPANY_ADDRESS` | `Lightex` | Email footer |
| `STORAGE_BACKEND` | `fake` | `r2` (production), `local` (files on disk, development), `fake` (memory, tests) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT_URL` | | Cloudflare R2 |
| `UPLOAD_URL_TTL_SECONDS` / `DOWNLOAD_URL_TTL_SECONDS` | `600` / `300` | Signed URL lifetimes |
| `MEDIA_ROOT` | `backend/media` | Where the `local` storage backend keeps files |
| `THROTTLE_*` | see `config/settings/base.py` | Rate limits (`THROTTLE_AUTH`, `THROTTLE_PASSWORD_RESET`, `THROTTLE_INVITATIONS`, …) |
| `ADMIN_ENABLED` / `ADMIN_URL` | on in dev, off in prod / `admin/` | Django admin |
| `LOG_LEVEL` | `INFO` | |

## Tests and checks

```bash
make test        # pytest
make cov         # coverage gates: 85 % overall, 95 % on apps/access
make lint        # ruff check + ruff format --check
make typecheck   # mypy (django-stubs)
make schema      # regenerate ../docs/openapi.yaml
sh scripts/check.sh   # everything CI runs, in order, stopping at the first failure
```

Tests need PostgreSQL (full-text search, partial unique indexes and row locks are Postgres features). Point
`DATABASE_URL` (or `TEST_DATABASE_URL`) at a server where the user may create databases.

Highlights of the suite:

- **Permission matrix** (`apps/access/tests/test_permission_matrix.py`): for every route and method, the roles
  that must pass and the roles that must be refused. The table is checked against the URL configuration, so a
  new endpoint without an entry fails the suite.
- **IDOR** (`apps/access/tests/test_idor.py`): every route called by a user from another workspace (always 404)
  and every project route called by workspace members who aren't on the project (403/404).
- **Concurrency** (`apps/tasks/tests/test_concurrency.py`): real threads; parallel creates get unique keys,
  simultaneous edits at the same version yield exactly one success.

## Running without a Celery worker

With no `REDIS_URL`, `CELERY_TASK_ALWAYS_EAGER` is on and notification processing and email sending run inline
after each transaction commits. Nothing else changes, so a free host with one web process is enough.

With Redis: set `REDIS_URL`, then run `celery -A config worker -l info` next to the web process.

Imports (board 40) run in a daemon thread in the web process when there is no broker, and as a Celery task when
there is one (`IMPORT_RUNNER=auto`; `thread` or `celery` force one). Each batch of `IMPORT_BATCH_SIZE` (200) rows
commits on its own, and a restarted process resumes the job from its last committed batch.

### Scheduled commands

Run these from cron, a platform scheduler, or a CI schedule:

| Command | When | What |
|---|---|---|
| `python manage.py send_due_soon` | daily | Reminders for open tasks due tomorrow (idempotent) |
| `python manage.py send_notification_emails --delivery hourly` | hourly | Queued emails for people on hourly delivery |
| `python manage.py send_notification_emails --delivery daily` | daily | Queued emails for people on daily delivery |
| `python manage.py purge_trash` | daily | Deletes trash items older than 30 days, abandoned uploads and old outbox rows |
| `python manage.py process_outbox` | every few minutes (optional) | Retries notification events that failed |
| `python manage.py purge_imports` | daily | Board 40: cancels untouched import drafts (24 h) and deletes import jobs and their files 30 days after they finish (imported tasks stay) |
| `python manage.py resume_imports` | every minute (optional) | Board 40: re-dispatches imports whose runner stopped sending heartbeats (the import poll does this too) |
| `python manage.py sync_permissions` | after deploys (runs on `migrate` too) | Syncs the permission catalogue |

## Connecting the web client

In `frontend/.env.local`:

```bash
NEXT_PUBLIC_API_MODE=live
NEXT_PUBLIC_API_URL=http://localhost:8000          # the client appends /api/v1
NEXT_PUBLIC_UPLOAD_ORIGIN=http://localhost:8000    # local storage; your R2 endpoint in production
NEXT_PUBLIC_DEV_TOOLS=false
```

On the API side, list the client's origin in `CORS_ALLOWED_ORIGINS`. If the client and the API are on different
sites (not just different ports), set `REFRESH_COOKIE_SAMESITE=None` and serve both over HTTPS.

The client's CSP currently allows the upload origin in `connect-src` only. Image previews of attachments load
from that origin, so `img-src` in `frontend/next.config.ts` needs it too (see the final report).

## Files (Cloudflare R2)

1. Create a bucket and an API token with object read/write on it; set `STORAGE_BACKEND=r2` and the `R2_*`
   variables.
2. Add a CORS rule on the bucket so browsers can upload directly:

   ```json
   [{"AllowedOrigins": ["https://app.example.com"], "AllowedMethods": ["PUT", "GET", "HEAD"],
     "AllowedHeaders": ["Content-Type"], "MaxAgeSeconds": 600}]
   ```

3. Downloads are short-lived presigned URLs with a forced `Content-Disposition` and `Content-Type`
   (`application/octet-stream` for anything but raster images). If you serve the bucket through a custom domain,
   add a Cloudflare Transform Rule that sets `X-Content-Type-Options: nosniff` on responses.

## Deployment

The image (`Dockerfile`) runs migrations and then gunicorn on `$PORT`; static files are served by WhiteNoise.

- **Render**: [`../render.yaml`](../render.yaml) is a blueprint for a free web service plus Postgres (no worker
  needed). Fill in the values marked `sync: false`.
- **Any Docker host** (Fly.io, Railway, a VM): build `backend/`, set `DJANGO_SETTINGS_MODULE=config.settings.prod`
  and the variables above, and expose port 8000. Behind a TLS-terminating proxy, `X-Forwarded-Proto` is trusted.
- Production checklist: `DJANGO_SECRET_KEY` and `JWT_SIGNING_KEY` set, `DJANGO_ALLOWED_HOSTS` set,
  `CORS_ALLOWED_ORIGINS` = the client origin only, SMTP configured, R2 configured, the scheduled commands
  running, `ADMIN_ENABLED` off unless needed. Without Redis the cache is per process, so rate limits are counted
  per gunicorn worker; add Redis for exact limits.

## Layout

```
config/            settings (base, dev, test, prod), URLs, Celery app
apps/
  common/          base models (UUID, timestamps, soft delete), errors, pagination, rich-text sanitising,
                   fractional index, throttles, health, seed_demo
  accounts/        users, auth (JWT + refresh cookie), password reset, profile
  access/          permission catalogue, roles, can(), DRF permission class
  workspaces/      workspaces, members, invitations, access requests
  projects/        projects, members, statuses, labels, access requests, recents, saved views
  planning/        objectives, milestones, epics, sprints
  tasks/           tasks, status history, board, backlog, bulk, activity
  collaboration/   comments, attachments, storage backends
  notifications/   outbox events, notifications, preferences, email templates
  reports/         burndown, velocity, cycle time, throughput, progress, KPIs
  audit/           audit log, activity feeds, trash
  search/          PostgreSQL full-text search
```

Every app follows the same layering: `models.py` (fields and invariants), `selectors.py` (reads, always scoped
through membership), `services.py` (writes and business rules; every mutation writes an audit row),
`serializers.py` (validation and shaping), `views.py` (thin: permission declaration, call a service or selector).
`access.services.can()` is the only function that decides access.
