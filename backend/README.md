# Lightex API

The v1 backend for Lightex, a project-management tool for software teams: workspaces, projects, boards,
backlog and sprints, objectives, milestones and epics, comments and attachments, notifications, search,
audit log, trash and reports. v2 adds custom fields, dependencies and time tracking (board 39), timeline dates
(board 32), the import wizard (board 40), and dashboards, presence and realtime updates over Server-Sent Events
(board 33).

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
7 sprints, objectives, milestones, epics), plus three teams with leads in Platform team. Tracking is on in both
workspaces and sales is on in Platform team. Every account's password is **`Lightex-demo-2026`**
(`DEMO_PASSWORD`); there is one account per default workspace role and per default project role (`DEMO_ACCOUNTS` in
`core/common/management/commands/seed_demo.py`):

| Account | Workspace role (Platform team) | Role on Platform Rebuild (PRJ) | Teams |
|---|---|---|---|
| `alex@team.dev` | Owner | Project Admin | Backend (lead) |
| `jordan@team.dev` | Admin | Manager | Frontend (lead) |
| `sam@team.dev` | Member | Member | Backend, Frontend |
| `taylor@team.dev` | Member | Viewer | Quality |
| `casey@team.dev` | Admin | not a member (gets the 403 + request-access screen) | Quality (lead) |

Riley and Morgan (`riley@team.dev`, `morgan@team.dev`, Members) and Drew (`drew@guild.dev`, Owner of Design guild) use
the same password. The command refuses to run when `DEBUG` is off. It is idempotent: when the demo workspaces exist
it does nothing; `--flush` deletes and recreates the demo data.

## Environment variables

All configuration comes from the environment (or `backend/.env` in development). Nothing secret lives in
the repository. See [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `DJANGO_SETTINGS_MODULE` | `config.settings.dev` (manage.py), `config.settings.prod` (wsgi) | `dev`, `test` or `prod` |
| `DJANGO_SECRET_KEY` | required | Django signing key |
| `JWT_SIGNING_KEY` | `DJANGO_SECRET_KEY` | Signs access and refresh tokens |
| `JOBS_SECRET` | empty (endpoint off) | **Secret.** The `X-Jobs-Secret` value external cron sends to `POST /api/v1/internal/jobs/{name}` |
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
| `REALTIME_ENABLED` | `true` | Board 33 kill switch: `false` makes the stream answer 503 `realtime_unavailable` and every client poll |
| `REALTIME_BROKER` | `postgres` (`local` in tests) | `postgres` (LISTEN/NOTIFY), `redis` (needs `REDIS_URL`) or `local` (one process) |
| `REALTIME_LISTEN_DATABASE_URL` | the default database | A **direct** (unpooled) Postgres URL for LISTEN. On Neon: the host without `-pooler` |
| `REALTIME_EVENT_RETENTION_SECONDS` | `900` | How long stream events are kept for `Last-Event-ID` replay |
| `PRESENCE_TTL_SECONDS` | `45` | A presence row expires this long after its last heartbeat |
| `WEB_CONCURRENCY` / `GUNICORN_THREADS` | `2` / `24` | gunicorn processes and gthread threads per process (Docker image) |
| `SSE_MAX_STREAMS_PER_PROCESS` | `16` | Streams per process; must be lower than `GUNICORN_THREADS` (checked at startup) |
| `SSE_HEARTBEAT_SECONDS` / `SSE_MAX_LIFETIME_SECONDS` | `15` / `300` | Ping interval and stream lifetime (plus up to 30 s jitter) |
| `THROTTLE_STREAM` / `THROTTLE_PRESENCE` | `30/min` / `240/min` | Stream connects and presence heartbeats per user |
| `INTEGRATIONS_ENABLED` | `true` | Board 37 kill switch: receivers and connect endpoints answer 503 `integrations_unavailable` |
| `INTEGRATIONS_PROVIDER_BACKEND` | `real` (dev: `fake` unless `GITHUB_APP_ID`/`GITLAB_CLIENT_ID` is set; tests: `fake`) | `real` or `fake` (fixture repositories, `manage.py fake_webhook`) |
| `INTEGRATIONS_RUNNER` | `auto` (`inline` in tests) | Webhook/sync processing: Celery with a broker, else one daemon drain thread per process |
| `INTEGRATIONS_ENCRYPTION_KEYS` | dev/test: derived from `DJANGO_SECRET_KEY` | `kid:base64url(32 bytes)[,kid:…]`, first encrypts, all decrypt. **Required in prod** once a provider is configured. Generate with `manage.py generate_integration_key`; never regenerate, rotate with `rotate_integration_secrets` |
| `GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` | — | The GitHub App (all six `GITHUB_*` values make GitHub available) |
| `GITHUB_APP_PRIVATE_KEY` | — | The app's `.pem`; real newlines, `\n`-escaped or base64 |
| `GITHUB_WEBHOOK_SECRET` | — | HMAC key for `X-Hub-Signature-256`; comma-separated during a rotation |
| `GITHUB_BRANCH_CREATION` | `true` | `false` hides "Create branch" for GitHub (a read-only app) |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` / `GITLAB_BASE_URL` | — / — / `https://gitlab.com` | GitLab OAuth app (without it GitLab offers token mode only) |
| `GITLAB_ALLOWED_HOSTS` | empty (any public host) | Allow-list for self-managed hosts, e.g. `gitlab.example.com,*.corp.example` |
| `GITLAB_ALLOW_PRIVATE_NETWORKS` | `false` (dev: `true`) | Lets a self-managed URL resolve to private IPs. Leave `false` in prod (SSRF guard) |
| `INTEGRATION_BACKFILL_DAYS` / `INTEGRATION_BACKFILL_MAX_PRS` / `INTEGRATION_CATCHUP_MINUTES` | `30` / `200` / `30` | Backfill window and cap; catch-up after this much silence |
| `WEBHOOK_MAX_BODY_BYTES` / `WEBHOOK_RETENTION_DAYS` | `5242880` / `7` | Webhook body cap (413 above it) and delivery retention |
| `THROTTLE_WEBHOOK` / `THROTTLE_INTEGRATION_CONNECT` / `THROTTLE_DEV_BRANCH` / `THROTTLE_DEV_LINK` | `1200/min` (per IP) / `10/hour` / `30/hour` / `60/hour` | Board 37 throttles |

### Notification channels (board 38)

Telegram, SMS and Web Push (`docs/v2/38-telegram-sms-push.md` §2). Each channel has a real backend plus `console`
(dev: logs the message, and the OTP for SMS), `fake` (tests) and `disabled` (the API reports `available: false`).

| Variable | Default | Purpose |
|---|---|---|
| `TELEGRAM_BACKEND` | `bot` when `TELEGRAM_BOT_TOKEN` is set, else `disabled` (dev: `console`, tests: `fake`) | `bot` · `console` · `fake` · `disabled` |
| `TELEGRAM_BOT_TOKEN` | — | **Secret.** From @BotFather |
| `TELEGRAM_BOT_USERNAME` | — (dev: `lightex_dev_bot`) | Without `@`; shown in the dialog and deep links |
| `TELEGRAM_WEBHOOK_SECRET` | — | **Secret.** 32–256 chars `[A-Za-z0-9_-]`; checked against `X-Telegram-Bot-Api-Secret-Token` |
| `TELEGRAM_LINK_TTL_SECONDS` | `600` | Link code lifetime |
| `SMS_BACKEND` | `twilio` when `TWILIO_ACCOUNT_SID` is set, else `disabled` (dev: `console`, tests: `fake`) | `twilio` · `console` · `fake` · `disabled`. Prod refuses `console` |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | — | Twilio account; the token (**secret**) also verifies both Twilio webhooks |
| `TWILIO_MESSAGING_SERVICE_SID` / `TWILIO_FROM_NUMBER` | — | Sender: the Messaging Service (preferred, handles STOP) or a number |
| `SMS_COUNTRIES` | `US,GB,DE` | Allow-list from the server table (`IN` needs DLT registration first) |
| `SMS_USER_DAILY_CAP` / `SMS_GLOBAL_DAILY_CAP` / `SMS_OTP_GLOBAL_DAILY_CAP` | `10` / `300` / `100` | Per UTC day, counted in Postgres |
| `WEB_PUSH_BACKEND` | `webpush` when both VAPID keys are set, else `disabled` (dev: `console`, tests: `fake`) | `webpush` · `console` · `fake` · `disabled` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | — | `manage.py generate_vapid_keys`; the private key is **secret**; subject `mailto:` or `https:` |
| `WEB_PUSH_ALLOWED_HOSTS` | FCM, Mozilla, Apple, `*.notify.windows.com`, `*.push.apple.com` | Push endpoint allow-list (SSRF guard) |
| `CHANNELS_ENCRYPTION_KEY` | dev/test: derived from `DJANGO_SECRET_KEY` | **Secret.** Fernet key(s), newest first. `manage.py generate_channels_key`; rotate with `rotate_channels_key`. Required in prod with `SMS_BACKEND=twilio` |
| `CHANNEL_DISPATCH` | `auto` | `auto` (Celery with `REDIS_URL`, else a per-process thread pool + sweeper) · `thread` · `celery` · `inline` |
| `CHANNEL_SENDER_THREADS` / `CHANNEL_MAX_ATTEMPTS` / `CHANNEL_HTTP_TIMEOUT` | `4` / `5` / `10` | Pool size, attempts before `dead`, seconds per provider call |
| `THROTTLE_CHANNEL_CONNECT` / `THROTTLE_CHANNEL_TEST` | `20/hour` / `12/hour` | Telegram link + SMS start; test sends (per user) |
| `TELEGRAM_API_BASE` / `TWILIO_API_BASE` | the real APIs | Override only for local stubs |

Webhooks: Telegram `<API_PUBLIC_URL>/api/v1/webhooks/telegram` (set by `manage.py telegram_setup`, once per deploy),
Twilio inbound `<API_PUBLIC_URL>/api/v1/webhooks/twilio/sms`; the status callback is sent with each message.
`API_PUBLIC_URL` must be the exact public origin Twilio calls (signatures cover the full URL). Local development with a
real bot: `manage.py telegram_poll`; without one: `manage.py telegram_fake_start <code>`.

GitHub App setup (callback `<API_PUBLIC_URL>/api/v1/tracking/integrations/github/callback`, Setup URL
`<API_PUBLIC_URL>/api/v1/tracking/integrations/github/setup`, webhook `<API_PUBLIC_URL>/api/v1/tracking/webhooks/github`, permissions
and events) and the GitLab OAuth app (redirect `<API_PUBLIC_URL>/api/v1/tracking/integrations/gitlab/callback`, scope `api`)
are described in `docs/v2/37-integrations-github-gitlab.md` §2. Run `manage.py process_integrations` every 5 minutes
where cron exists (it drains work, queues catch-ups, checks token expiry with `--check-tokens` and purges).

## Tests and checks

```bash
make test        # pytest
make cov         # coverage gates: 85 % overall, 95 % on core/access
make lint        # ruff check + ruff format --check
make typecheck   # mypy (django-stubs)
make imports     # lint-imports (core never imports modules; modules are independent)
make schema      # regenerate ../docs/openapi.yaml
sh scripts/check.sh   # everything CI runs, in order, stopping at the first failure
```

Tests need PostgreSQL (full-text search, partial unique indexes and row locks are Postgres features). Point
`DATABASE_URL` (or `TEST_DATABASE_URL`) at a server where the user may create databases. The test settings
(also loaded by mypy) refuse any host other than `localhost`, `127.0.0.1`, `::1` or `db`, so a production
`DATABASE_URL` in `.env` can't be used by accident: set `TEST_DATABASE_URL` to a local server, for example
`postgres://postgres@localhost:5433/lightex`. `ALLOW_REMOTE_TEST_DATABASE=true` overrides the check.

Highlights of the suite:

- **Permission matrix** (`modules/tracking/tests/access/test_permission_matrix.py`): for every route and method, the
  roles that must pass and the roles that must be refused. The table is checked against the URL configuration, so a
  new endpoint without an entry fails the suite.
- **IDOR** (`modules/tracking/tests/access/test_idor.py`): every route called by a user from another workspace
  (always 404) and every project route called by workspace members who aren't on the project (403/404).
- **Tenant isolation** (`modules/tracking/tests/access/test_tenant_isolation.py`): walks the URL resolver for every
  `tracking/` and `sales/` route and every core workspace-scoped route, and calls each method as a user of another
  workspace (always 404); skipped routes are listed with their reason. It also checks that every module and platform
  table has a non-null `workspace` and the scoped manager (with the listed exceptions).
- **Concurrency** (`modules/tracking/tasks/tests/test_concurrency.py`): real threads; parallel creates get unique keys,
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
| `python manage.py process_outbox` | every few minutes (optional) | Retries domain events whose handlers failed |
| `python manage.py check_orphan_targets` | weekly (optional) | Reports comments, attachments, notifications and events whose target no longer exists |
| `python manage.py purge_imports` | daily | Board 40: cancels untouched import drafts (24 h) and deletes import jobs and their files 30 days after they finish (imported tasks stay) |
| `python manage.py resume_imports` | every minute (optional) | Board 40: re-dispatches imports whose runner stopped sending heartbeats (the import poll does this too) |
| `python manage.py send_channel_deliveries` | every 5 minutes (recommended) | Board 38: retries and quiet-hours summaries left by a sleeping or restarted process |
| `python manage.py channel_deliveries --dead [--since 7d]` / `--retry <id>` / `--retry-dead` | by hand | Board 38: list or re-queue dead-letter deliveries (no message text, no phone numbers) |
| `python manage.py sync_permissions` | after deploys (runs on `migrate` too) | Syncs the permission catalogue |

Board 33 needs no scheduled command: each web process sweeps expired presence rows and old stream events while it
has open streams.

## Realtime (board 33): the SSE stream

`GET /api/v1/workspaces/{slug}/stream` is one Server-Sent Events stream per browser per workspace. It carries
invalidation hints (ids, keys, versions, never record contents), presence rosters, and `hello` / `reset` /
`reconnect` control events; the event catalogue is in [`../docs/openapi.yaml`](../docs/openapi.yaml) and
[`../docs/v2/33-dashboards-presence.md`](../docs/v2/33-dashboards-presence.md) §2. Clients authenticate with the
normal `Authorization: Bearer` header (never a token in the URL), and reconnect with `Last-Event-ID` to replay what
they missed (15 minutes are kept). A stream pings every 15 s and ends itself with `reconnect` after 5 minutes, before
its access token expires, when the user's access changes, or on shutdown.

How it runs:

- Services publish after their transaction commits (most through the audit hook). Durable events are inserted under
  a Postgres advisory lock, so their ids follow commit order, and `NOTIFY`-ed in the same short transaction.
- Each web process opens **one** direct `LISTEN` connection while it has streams (closed 60 s after the last one)
  and fans events out to its streams through bounded queues. That process also deletes expired presence rows
  (every 15 s) and old events (every 60 s).
- The Docker image runs gunicorn with **gthread** workers: a stream holds one thread, never a process. Each process
  takes at most `SSE_MAX_STREAMS_PER_PROCESS` streams (503 `realtime_busy` beyond that, and the client polls).
- `REALTIME_ENABLED=false` switches realtime off without a client deploy; clients fall back to 30 s polling.

### Run and check streaming locally

`runserver` is threaded and serves streams as is. Point it at your **local** database:

```bash
cd backend
DATABASE_URL=postgres://postgres@localhost:5433/lightex python manage.py runserver 8000
```

Get an access token (here with the demo data) and open the stream with `curl -N` (no buffering):

```bash
TOKEN=$(curl -s -X POST localhost:8000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"alex@team.dev","password":"Lightex-demo-2026"}' \
  | python -c 'import json,sys; print(json.load(sys.stdin)["accessToken"])')
curl -N -H "Authorization: Bearer $TOKEN" -H "Accept: text/event-stream" \
  localhost:8000/api/v1/workspaces/platform/stream
```

It prints `retry: 3000` and `event: hello` at once, then `: ping …` every 15 s. Change something in another
terminal (edit a task in the web client, or `PATCH /api/v1/tracking/tasks/{id}`) and a `tracking.task.changed` event appears. Add
`-H "Last-Event-ID: <id>"` to replay what came after an id.

`bash scripts/sse_smoke.sh` runs the same checks against the real image (gunicorn gthread, LISTEN/NOTIFY, the stream
cap, `/health` while streams are open, replay) with its own throwaway Postgres container.

On a deployed API, check once that the platform doesn't buffer the stream:
`curl -N -H "Authorization: Bearer …" -H "Accept: text/event-stream" https://<api>/api/v1/workspaces/<slug>/stream`
must print `hello` immediately and a ping every 15 s.

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

The image (`Dockerfile`) runs migrations and then gunicorn on `$PORT` with gthread workers
(`--workers ${WEB_CONCURRENCY:-2} --worker-class gthread --threads ${GUNICORN_THREADS:-24} --timeout 30
--graceful-timeout 10 --keep-alive 5 --config gunicorn.conf.py`); static files are served by WhiteNoise.
`gunicorn.conf.py` ends open streams with `reconnect` when a worker shuts down (deploys).

- **Render**: [`../render.yaml`](../render.yaml) is a blueprint for a free web service plus Postgres (no worker
  needed). Fill in the values marked `sync: false`.
- **Any Docker host** (Fly.io, Railway, a VM): build `backend/`, set `DJANGO_SETTINGS_MODULE=config.settings.prod`
  and the variables above, and expose port 8000. Behind a TLS-terminating proxy, `X-Forwarded-Proto` is trusted.
- **Realtime (board 33)**: behind Neon's pooler (`DB_POOLED=true`), set `REALTIME_LISTEN_DATABASE_URL` to the
  same database's direct URL (the host without `-pooler`); LISTEN does not work through transaction pooling. Render
  Postgres URLs are already direct. `last-event-id` is already in `CORS_ALLOW_HEADERS`. Don't add a gzip
  middleware (it would buffer the stream).
- Production checklist: `DJANGO_SECRET_KEY` and `JWT_SIGNING_KEY` set, `DJANGO_ALLOWED_HOSTS` set,
  `CORS_ALLOWED_ORIGINS` = the client origin only, SMTP configured, R2 configured, the scheduled commands
  running, `ADMIN_ENABLED` off unless needed. Without Redis the cache is per process, so rate limits are counted
  per gunicorn worker; add Redis for exact limits.

## Platform services

Core never imports a module (`lint-imports` fails CI otherwise). Generic services refer to module records as
`(target_type, target_id)` (`<module>.<entity>` plus the record's UUID) and ask registries that each module fills
from its AppConfig `ready()`. Tracking does all of its registration in `modules/tracking/hooks/` (called from
`modules.tracking.projects.apps`); the test-only `core/tests/fake_module` shows the minimum a module needs.

| Registry | Register with | Used by |
|---|---|---|
| Targets (`core/common/targets.py`) | `register_target_type("tracking.task", TaskTarget())` | comments, attachments, notifications, audit hints, trash, `check_orphan_targets` |
| Access scopes (`core/access/scopes.py`) | `register_scope_provider(ProjectScope())` | `can()` for the `project` scope, inbox and stream visibility, role deletion |
| Event types and handlers (`core/events/registry.py`) | `register_event_type(key, label, default_channels, module)`, `register_handler(pattern, fn, module=...)` | the outbox dispatcher; the notification preference matrix (keys, labels, defaults) |
| Search (`core/search/services.py`) | `register_search_provider("tracking", TrackingSearch())` | `GET /search`, `GET /workspaces/{slug}/search` |
| Trash (`core/audit/trash.py`) | `register_trash_kind(TaskTrash())` | workspace trash list, restore, purge, `purge_trash` |
| Audit groups (`core/audit/registry.py`) | `register_audit_group("task", ["tracking.task"])` | the audit view's `filter[entity]` |
| Realtime (`core/realtime/`) | `register_realtime_types(...)`, `register_audit_publisher(fn)`, `register_access_hook(fn)`, `presence.register_location(kind, fn)` | the SSE stream and presence |
| Workspace hooks (`core/workspaces/hooks.py`) | `register_member_removed(fn)` | removing a workspace member |
| Scheduled jobs (`core/jobs/registry.py`) | `register_job("sales_followup_digest", fn, module="sales", schedule="daily 07:30")` | `manage.py run_job`, `POST /internal/jobs/{name}`, the Celery task `core.jobs.run_job` |
| Demo seeders (`core/common/seeding.py`) | `register_seeder(TrackingSeeder)` | `manage.py seed_demo` |

To plug a module in: subclass `TargetResolver` (`exists`, `can_view`, `can_comment`, `can_attach`, `describe`,
`workspace_of`, optionally `subscribers`, `mentionable`, `context`, `storage_prefix`) and register it; it then gets
`GET|POST /api/v1/targets/{targetType}/{targetId}/comments`, `GET …/attachments`, `POST …/attachments/upload-url`,
comment and mention notifications (`core.comment.created`, `core.comment.mentioned`), audit rows and realtime hints
(`core.comment.*`, `core.attachment.*`, payload `{targetType, targetId, commentId | attachmentId}`). Emit domain
events with `core.events.services.emit(type, workspace=…, target_type=…, target_id=…, actor=…, payload=…)` inside
the write's transaction; handlers run after commit (inline without a Celery worker), must be idempotent, and a
failure records `attempts` and `error` for `process_outbox` to retry.

## Module system

Each module declares a `ModuleDefinition` (`core/modules/registry.py`) and calls `register_module()` from its AppConfig
`ready()`: core in `core/modules/core_module.py`, tracking in `modules/tracking/module.py` (not toggleable yet), sales in
`modules/sales/module.py`. A definition lists the module's permissions, `default_role_grants` (system role key → codes),
`locked_role_grants`, notification event types (with their channel and email templates), target types, search provider,
`nav_items` and `depends_on`. The permission catalogue (`core/access/catalogue.py`, which holds only core's entries) is
assembled from the definitions and synced on migrate and by `manage.py sync_permissions`.

`WorkspaceModule` stores which toggleable modules are on per workspace (`core` has no row; non-toggleable modules are
always on). New workspaces get tracking plus `POST /workspaces` `modules`; `GET|PUT /workspaces/{slug}/modules[/{key}]`
lists and switches them (`core.modules.manage`, audit `core.module.enabled|disabled`, errors `module_not_toggleable`
and `module_dependency`). Enabling seeds the module's default grants. Workspace responses carry `enabledModules`.

Module routes are mounted with `module_urls(key, patterns)` (`config/api_urls.py`): after `ScopedPermission` resolves
the view's workspace or project (non-members get 404) it answers 403 `module_disabled` when the module is off.
While a module is off its codes are dropped from `can()`, `my_permissions` and role responses (the rows stay), and the
outbox, notifications, search and trash skip it. `core.modules.services.enabled_modules()` is cached per request.
Switching a module publishes the workspace-wide realtime event `core.module.changed` (`{module, enabled}`), and the
expired-trash purge leaves a disabled module's kinds alone (`TrashKind.purge_expired(..., skip_workspaces=...)`).

## Workspace scoping

Every module and platform table has a non-null `workspace` foreign key, even when a parent implies it (a child row
without one takes its parent's on save and `bulk_create`: `workspace_parent = "project"`). Models subclass
`core.common.models.WorkspaceScopedModel` (or `WorkspaceScopedSoftDeleteModel`), whose default manager answers only
when it knows the workspace (`core/common/scoping.py`):

- `Model.objects.for_workspace(ws)` names it;
- inside a request, `WorkspaceScopeMiddleware` starts strict and `ScopedView` scopes the rest of the request to the
  workspace of the scope it resolved (the generic comment and attachment views do the same with their target), so
  `Model.objects.filter(...)` is filtered to it: another workspace's id simply isn't found;
- `Model.objects.unscoped()` is the explicit escape hatch: scope resolution itself, views that span the user's
  workspaces (`cross_workspace = True`: auth, inbox, global search, my tasks/recents/timer, channels, webhooks),
  management commands (`manage.py` runs them unscoped), Celery tasks (a prerun signal), the background threads, the
  post-migrate permission sync, and tests (`WORKSPACE_SCOPE_DEFAULT = "unscoped"` in the test settings).

Anything else raises `UnscopedQueryError`. Writes (`create`, `bulk_create`) name or derive their workspace and skip
the check. Global tables (users, the permission catalogue, auth tokens, channel connections, notification preferences,
the webhook inbox) have no workspace; `ChannelDelivery` (nullable workspace), `RealtimeEvent` (a stream log read
outside requests) and `RunningTimer` (one per user across workspaces) have a workspace but a plain manager.

Core tables never reference module tables: audit rows, notifications, realtime events and presence sessions carry
generic `scope_id` / `subject_id` hints (tracking: the project and the task) instead of foreign keys, and a purge
deletes the generic rows of the purged targets (`core.collab.services.delete_target_records`). Notifications store
the registered event-type key in `type` and the display kind (`assigned`, `mention`, …) in `kind`.

## Teams and data scope

Teams (`core/teams`) are flat groups of workspace members (`Team`, `TeamMember` with `is_lead`); a user may be in
several. `GET|POST /workspaces/{slug}/teams`, `GET|PATCH|DELETE /teams/{id}`, `GET|POST /teams/{id}/members` and
`PATCH|DELETE /teams/{id}/members/{userId}`: reads are open to members, writes need `core.teams.manage` and are
audited (`core.team.*`). Removing someone from the workspace removes their team memberships.

A module makes a permission scopable in its definition, and may name the default scope per role (otherwise Owner and
Admin get `all` and Member gets `own`):

```python
PERMISSIONS = (workspace_permission("sales.lead.view", "Sales", "View leads", "See leads", scopable=True),)
DEFINITION = ModuleDefinition(
    ...,
    permissions=PERMISSIONS,
    default_role_grants={"owner": ["sales.lead.view"], "member": {"sales.lead.view": "team"}},
)
```

Each role then grants the code with a `RolePermission.data_scope` of `own`, `team` or `all` (role requests and
responses carry `dataScopes: {code: scope}`; workspace and project responses carry `myDataScopes`). The model names
its owner field, and every list selector for that data goes through `visible_to`, the only place the scope is applied:

```python
class Lead(SoftDeleteModel):
    data_scope_owner_field = "owner"  # and data_scope_workspace_field, default "workspace"


def leads_for(user, workspace):
    return visible_to(Lead.objects.all(), user, "sales.lead.view", workspace)
```

`own` keeps the user's records, `team` adds those owned by anyone sharing a live team with them, `all` is the whole
workspace; no grant, a non-member or a disabled module gives `none()`. It always filters by workspace. A non-scopable
code or a model without an owner field raises. Single-record checks still use `can()`.

Role writes can't hand out a wider data scope than the actor's own for that code: setting or changing a scope beyond
it answers 403 `data_scope_exceeds_own` (`details: {code, dataScope, yours}`). Owners are exempt.

## Workspace roles, time zone and jobs (sales S0)

The contract is `docs/sales/s0-contract.md`.

- **Several roles per member.** `WorkspaceMember.roles` goes through `WorkspaceMemberRole`. Workspace permissions are
  the union of the member's roles, and for a scopable code the widest scope wins (`all` > `team` > `own`). Members
  and invites carry `roleIds` (in precedence order: Owner, Admin, Member, then by name), and `roleId` is the first
  of them. `PATCH /members/{userId}` and `POST /invites` take `roleIds`, and the old `roleId` still works. The
  last-Owner rule covers every role change. A module adds its own default roles with
  `ModuleDefinition.default_roles=(DefaultRole(key, name, description, grants={code: scope | None}),)`. They are
  seeded when the module is on (on workspace creation and on enable), and an existing role is never changed.
- **Time zone.** `Workspace.timezone` (IANA, default `Africa/Addis_Ababa`, `PATCH /workspaces/{slug}`). Compute
  "today" and period boundaries with `core/workspaces/timezone.py`: `workspace_today`, `workspace_now`,
  `local_date`, `day_bounds` and `range_bounds`.
- **Scheduled jobs.** `register_job(name, func, module=..., schedule=..., description=...)` from `ready()`.
  `func(workspace, *, now)` runs once per live workspace, in its own transaction, with `now` in the workspace time
  zone. Workspaces where the module is off are skipped. Guard side effects with `core.jobs.services.claim(ws, job,
  key)`, so a second run does nothing. Trigger a job with `manage.py run_job <name> [--workspace ID]` (`--list` shows
  the jobs), with the Celery task `core.jobs.run_job`, or from an external cron with `POST
  /api/v1/internal/jobs/{name}` and the header `X-Jobs-Secret: $JOBS_SECRET`. The endpoint refuses every call while
  `JOBS_SECRET` is unset.
- **Owned records.** `core.common.models.OwnedModel` adds `owner` and `data_scope_owner_field = "owner"`.

## Layout

```
config/            settings (base, dev, test, prod), URLs, Celery app
core/              the platform core (docs/platform-architecture.md); never imports modules/
  common/          base models (UUID, timestamps, soft delete, WorkspaceScopedModel), workspace scoping, errors,
                   pagination, rich-text sanitising, fractional index, throttles, health, the target registry,
                   seed_demo (+ seeder registry)
  accounts/        users, auth (JWT + refresh cookie), password reset, profile
  access/          permission catalogue (assembled from the modules), roles, can(), visible_to(), DRF permission class
  teams/           teams and team members (data scope `team`)
  workspaces/      workspaces, members (several roles each), invitations, access requests, workspace time zone
  jobs/            scheduled job registry, runner, run_job, the internal jobs endpoint, JobMark idempotency
  collab/          generic comments and attachments on any registered target, storage backends
  events/          the DomainEvent outbox, event type and handler registries, process_outbox
  notifications/   notifications, preferences (built from the event type registry), email templates
  channels/        board 38: Telegram, SMS and Web Push delivery
  realtime/        board 33: the SSE stream, the per-process hub and brokers, events, presence
  audit/           audit log, trash (registered kinds)
  search/          search provider registry and fan-out
  tests/           fake_module: a test-only module proving the core is generic
modules/
  tracking/        the tracking module, served under /api/v1/tracking/
    projects/      projects, members, statuses, labels, access requests, recents, saved views
    planning/      objectives, milestones, epics, sprints
    tasks/         tasks, status history, board, backlog, bulk, activity feeds, send_due_soon
    hooks/         everything tracking registers with core (targets, scope provider, events, search, trash,
                   realtime, workspace hooks, demo seeder)
    reports/       burndown, velocity, cycle time, throughput, progress, KPIs, workload
    dashboards/    board 33: project dashboards (shared / personal) and their widget layouts
    imports/       board 40: CSV / Jira / Trello / Asana imports
    integrations/  board 37: GitHub and GitLab
    timetracking/  board 39: time entries, timers, timesheet
  sales/           skeleton (Stage 3): the module definition and a health route; how to add a module:
                   ../docs/platform/adding-a-module.md
```

Each app keeps its Django `AppConfig.label` (`projects`, `tasks`, …), so table names are unchanged. Stage 5 replaced
the migration history with one fresh `0001_initial` per app (`access` and `planning` also have a `0002_initial`, where
Django splits a real foreign-key cycle). There are no data migrations: the permission catalogue is synced after every
`migrate`, and default roles are seeded when a workspace is created or a module is enabled.
`lint-imports` (import-linter, configured in `pyproject.toml`) enforces that `core` never imports `modules` and that
modules never import each other; there are no exceptions for production code (see "Platform services").

Every app follows the same layering: `models.py` (fields and invariants), `selectors.py` (reads, always scoped
through membership), `services.py` (writes and business rules; every mutation writes an audit row),
`serializers.py` (validation and shaping), `views.py` (thin: permission declaration, call a service or selector).
`access.services.can()` is the only function that decides access.
