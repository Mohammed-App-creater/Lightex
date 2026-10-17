"""Settings shared by every environment. Secrets and hosts come from environment variables only."""

from datetime import timedelta
from pathlib import Path

import environ
from corsheaders.defaults import default_headers
from django.core.exceptions import ImproperlyConfigured

BASE_DIR = Path(__file__).resolve().parent.parent.parent

env = environ.Env()
environ.Env.read_env(BASE_DIR / ".env", overwrite=False)

SECRET_KEY = env("DJANGO_SECRET_KEY")
DEBUG = env.bool("DJANGO_DEBUG", default=False)
ALLOWED_HOSTS: list[str] = env.list("DJANGO_ALLOWED_HOSTS", default=["localhost", "127.0.0.1"])

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.postgres",
    "corsheaders",
    "rest_framework",
    "rest_framework_simplejwt.token_blacklist",
    "django_filters",
    "drf_spectacular",
    "core.common",
    "core.accounts",
    "core.access",
    "core.workspaces",
    "modules.tracking.projects",
    "modules.tracking.planning",
    "modules.tracking.tasks",
    "core.collab",
    "core.notifications",
    "modules.tracking.reports",
    "core.audit",
    "core.search",
    "modules.tracking.timetracking",
    "modules.tracking.imports",
    "modules.tracking.dashboards",
    "core.realtime",
    "modules.tracking.integrations",
    "core.channels",
]

MIDDLEWARE = [
    "core.common.middleware.RequestIdMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

DATABASES = {"default": env.db("DATABASE_URL", default="postgres://postgres:postgres@localhost:5432/lightex")}
DATABASES["default"]["ATOMIC_REQUESTS"] = False
DATABASES["default"]["CONN_MAX_AGE"] = env.int("DB_CONN_MAX_AGE", default=60)
# Behind a transaction-mode pooler (e.g. Neon's "-pooler" host / PgBouncer) server-side cursors break.
DATABASES["default"]["DISABLE_SERVER_SIDE_CURSORS"] = env.bool("DB_POOLED", default=False)
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

AUTH_USER_MODEL = "accounts.User"
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 8}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
    {"NAME": "core.accounts.validators.CharacterClassValidator"},
]
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2SHA1PasswordHasher",
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

# ───────────────────────── API ─────────────────────────

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["core.accounts.authentication.BearerJWTAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "EXCEPTION_HANDLER": "core.common.exceptions.api_exception_handler",
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.UserRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "anon": env("THROTTLE_ANON", default="120/min"),
        "user": env("THROTTLE_USER", default="1200/min"),
        "auth": env("THROTTLE_AUTH", default="10/min"),
        "password_reset": env("THROTTLE_PASSWORD_RESET", default="5/hour"),
        "invitations": env("THROTTLE_INVITATIONS", default="30/hour"),
        "invite_token": env("THROTTLE_INVITE_TOKEN", default="30/min"),
        "uploads": env("THROTTLE_UPLOADS", default="60/min"),
        "imports": env("THROTTLE_IMPORTS", default="20/hour"),
        "stream": env("THROTTLE_STREAM", default="30/min"),
        "presence": env("THROTTLE_PRESENCE", default="240/min"),
        "webhook": env("THROTTLE_WEBHOOK", default="1200/min"),
        "integration_connect": env("THROTTLE_INTEGRATION_CONNECT", default="10/hour"),
        "dev_branch": env("THROTTLE_DEV_BRANCH", default="30/hour"),
        "dev_link": env("THROTTLE_DEV_LINK", default="60/hour"),
    },
    "UNAUTHENTICATED_USER": "django.contrib.auth.models.AnonymousUser",
    "TEST_REQUEST_DEFAULT_FORMAT": "json",
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=env.int("JWT_ACCESS_MINUTES", default=15)),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=env.int("JWT_REFRESH_DAYS", default=14)),
    "ROTATE_REFRESH_TOKENS": False,
    "BLACKLIST_AFTER_ROTATION": False,
    "UPDATE_LAST_LOGIN": True,
    "ALGORITHM": "HS256",
    "SIGNING_KEY": env("JWT_SIGNING_KEY", default=SECRET_KEY),
    "AUTH_HEADER_TYPES": ("Bearer",),
    "USER_ID_FIELD": "id",
    "USER_ID_CLAIM": "user_id",
}

# Refresh-token cookie (httpOnly; scoped to the auth endpoints).
REFRESH_COOKIE_NAME = env("REFRESH_COOKIE_NAME", default="lx_refresh")
REFRESH_COOKIE_PATH = "/api/v1/auth/"
REFRESH_COOKIE_SECURE = env.bool("REFRESH_COOKIE_SECURE", default=True)
REFRESH_COOKIE_SAMESITE = env("REFRESH_COOKIE_SAMESITE", default="Lax")
REFRESH_COOKIE_DOMAIN = env("REFRESH_COOKIE_DOMAIN", default=None)

SPECTACULAR_SETTINGS = {
    "TITLE": "Lightex API",
    "DESCRIPTION": "Lightex v1: project management for software teams. All paths are under /api/v1.",
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "COMPONENT_SPLIT_REQUEST": True,
    "SCHEMA_PATH_PREFIX": "/api/v1",
    "ENUM_GENERATE_CHOICE_DESCRIPTION": False,
    "DISABLE_ERRORS_AND_WARNINGS": True,
}

# ───────────────────────── CORS / CSRF ─────────────────────────

CORS_ALLOWED_ORIGINS: list[str] = env.list("CORS_ALLOWED_ORIGINS", default=["http://localhost:3000"])
CORS_ALLOW_CREDENTIALS = True
CORS_EXPOSE_HEADERS = ["X-Request-ID", "Retry-After"]
# Board 33: the realtime client sends Last-Event-ID on reconnect.
CORS_ALLOW_HEADERS = (*default_headers, "last-event-id")
CSRF_TRUSTED_ORIGINS = CORS_ALLOWED_ORIGINS

# ───────────────────────── Cache / Celery ─────────────────────────

REDIS_URL = env("REDIS_URL", default="")
if REDIS_URL:
    CACHES = {"default": {"BACKEND": "django.core.cache.backends.redis.RedisCache", "LOCATION": REDIS_URL}}
else:
    CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "lightex"}}

CELERY_BROKER_URL = env("CELERY_BROKER_URL", default=REDIS_URL or "memory://")
CELERY_RESULT_BACKEND = None
# No broker configured → run tasks inline so the app works on a host with no worker.
CELERY_TASK_ALWAYS_EAGER = env.bool("CELERY_TASK_ALWAYS_EAGER", default=not bool(REDIS_URL))
CELERY_TASK_EAGER_PROPAGATES = False
CELERY_TASK_IGNORE_RESULT = True
CELERY_TIMEZONE = "UTC"

# ───────────────────────── Email ─────────────────────────

EMAIL_BACKEND = env("EMAIL_BACKEND", default="django.core.mail.backends.console.EmailBackend")
EMAIL_HOST = env("EMAIL_HOST", default="localhost")
EMAIL_PORT = env.int("EMAIL_PORT", default=587)
EMAIL_HOST_USER = env("EMAIL_HOST_USER", default="")
EMAIL_HOST_PASSWORD = env("EMAIL_HOST_PASSWORD", default="")
EMAIL_USE_TLS = env.bool("EMAIL_USE_TLS", default=True)
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", default="Lightex <no-reply@lightex.local>")
COMPANY_ADDRESS = env("COMPANY_ADDRESS", default="Lightex")

# Public URL of the web client, used in email links.
FRONTEND_URL = env("FRONTEND_URL", default="http://localhost:3000").rstrip("/")

# Sign in with Google (OAuth "Web application" client). Authorised redirect URI:
# <API_PUBLIC_URL>/api/v1/auth/google/callback. Without both values, sign-in returns to the client's
# login page with ?error=google_unavailable.
GOOGLE_CLIENT_ID = env("GOOGLE_CLIENT_ID", default="")
GOOGLE_CLIENT_SECRET = env("GOOGLE_CLIENT_SECRET", default="")

# ───────────────────────── Files (Cloudflare R2) ─────────────────────────

STORAGE_BACKEND = env("STORAGE_BACKEND", default="fake")  # "r2" or "fake"
R2_ACCOUNT_ID = env("R2_ACCOUNT_ID", default="")
R2_ACCESS_KEY_ID = env("R2_ACCESS_KEY_ID", default="")
R2_SECRET_ACCESS_KEY = env("R2_SECRET_ACCESS_KEY", default="")
R2_BUCKET = env("R2_BUCKET", default="")
R2_ENDPOINT_URL = env("R2_ENDPOINT_URL", default="")
MEDIA_ROOT = Path(env("MEDIA_ROOT", default=str(BASE_DIR / "media")))
# Public base URL of this API (used for local-storage signed URLs in development).
API_PUBLIC_URL = env("API_PUBLIC_URL", default="http://localhost:8000").rstrip("/")
UPLOAD_URL_TTL_SECONDS = env.int("UPLOAD_URL_TTL_SECONDS", default=600)
DOWNLOAD_URL_TTL_SECONDS = env.int("DOWNLOAD_URL_TTL_SECONDS", default=300)
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
# Avatars are accepted as small data URLs until a signed avatar upload exists (see final report).
MAX_AVATAR_BYTES = 2 * 1024 * 1024

# ───────────────────────── Domain ─────────────────────────

INVITATION_TTL_DAYS = 7
PASSWORD_RESET_TTL_MINUTES = 60
TRASH_RETENTION_DAYS = 30

# Board 40 imports. IMPORT_RUNNER: "auto" (Celery with a broker, else a daemon thread in the web process),
# "thread", "celery" or "inline" (tests: runs synchronously inside the start request).
IMPORT_RUNNER = env("IMPORT_RUNNER", default="auto")
IMPORT_BATCH_SIZE = env.int("IMPORT_BATCH_SIZE", default=200)
IMPORT_LINK_BATCH = env.int("IMPORT_LINK_BATCH", default=500)
IMPORT_LEASE_SECONDS = env.int("IMPORT_LEASE_SECONDS", default=120)
IMPORT_MAX_ROWS = 5000
IMPORT_RETRIES = 2  # thread runner: a failed batch is retried twice, IMPORT_RETRY_DELAY_SECONDS apart
IMPORT_RETRY_DELAY_SECONDS = 2.0
IMPORT_REPORT_URL_TTL_SECONDS = 60

# ───────────────────────── Realtime (board 33) ─────────────────────────
# docs/v2/33-dashboards-presence.md §2.9. One SSE stream per browser per workspace; presence in Postgres.

# Kill switch: false → the stream answers 503 realtime_unavailable and every client polls; nothing is published.
REALTIME_ENABLED = env.bool("REALTIME_ENABLED", default=True)
REALTIME_BROKER = env("REALTIME_BROKER", default="postgres")  # postgres | redis | local
# Must be a direct (unpooled) connection: LISTEN doesn't survive PgBouncer transaction pooling (Neon "-pooler").
# Empty = the default database's own settings (DATABASE_URL).
REALTIME_LISTEN_DATABASE_URL = env("REALTIME_LISTEN_DATABASE_URL", default="")
REALTIME_EVENT_RETENTION_SECONDS = env.int("REALTIME_EVENT_RETENTION_SECONDS", default=900)
REALTIME_REPLAY_LIMIT = 500
REALTIME_LISTENER_IDLE_SECONDS = 60.0  # close the LISTEN connection this long after the last stream ends
REALTIME_LISTENER_BACKOFF_SECONDS = 1.0
REALTIME_LISTENER_BACKOFF_MAX_SECONDS = 30.0
REALTIME_LISTEN_POLL_SECONDS = 5.0
REALTIME_LISTEN_WAIT_SECONDS = 2.0  # a new stream waits this long for LISTEN before its replay query
REALTIME_SWEEP_SECONDS = 15.0  # expired presence rows
REALTIME_PURGE_SECONDS = 60.0  # events past retention
PRESENCE_TTL_SECONDS = env.int("PRESENCE_TTL_SECONDS", default=45)
# gunicorn gthread: threads per process serve every request; streams may take at most SSE_MAX_STREAMS_PER_PROCESS.
GUNICORN_THREADS = env.int("GUNICORN_THREADS", default=24)
SSE_MAX_STREAMS_PER_PROCESS = env.int("SSE_MAX_STREAMS_PER_PROCESS", default=16)
if SSE_MAX_STREAMS_PER_PROCESS >= GUNICORN_THREADS:
    raise ImproperlyConfigured("SSE_MAX_STREAMS_PER_PROCESS must be lower than GUNICORN_THREADS.")
SSE_HEARTBEAT_SECONDS = env.float("SSE_HEARTBEAT_SECONDS", default=15.0)
SSE_MAX_LIFETIME_SECONDS = env.float("SSE_MAX_LIFETIME_SECONDS", default=300.0)
SSE_LIFETIME_JITTER_SECONDS = 30.0
SSE_QUEUE_SIZE = 256
SSE_TEST_MAX_EVENTS: int | None = None  # tests: end the stream after this many events

# ───────────────────────── Integrations (board 37) ─────────────────────────
# docs/v2/37-integrations-github-gitlab.md §2.3. GitHub connects through a GitHub App; GitLab through an OAuth app
# (gitlab.com or GITLAB_BASE_URL) or a pasted group/project access token (any instance).

INTEGRATIONS_ENABLED = env.bool("INTEGRATIONS_ENABLED", default=True)  # false: receivers and connect answer 503
INTEGRATIONS_PROVIDER_BACKEND = env("INTEGRATIONS_PROVIDER_BACKEND", default="real")  # real | fake
# "auto" (Celery with a broker, else one daemon drain thread per process), "celery", "thread" or "inline" (tests).
INTEGRATIONS_RUNNER = env("INTEGRATIONS_RUNNER", default="auto")
# "kid:base64url(32 bytes)[,kid:…]": the first key encrypts, every key decrypts. Empty: a dev key derived from
# DJANGO_SECRET_KEY (prod refuses that when a provider is configured). `manage.py generate_integration_key`.
INTEGRATIONS_ENCRYPTION_KEYS = env("INTEGRATIONS_ENCRYPTION_KEYS", default="")
GITHUB_APP_ID = env("GITHUB_APP_ID", default="")
GITHUB_APP_SLUG = env("GITHUB_APP_SLUG", default="")
GITHUB_APP_CLIENT_ID = env("GITHUB_APP_CLIENT_ID", default="")
GITHUB_APP_CLIENT_SECRET = env("GITHUB_APP_CLIENT_SECRET", default="")
GITHUB_APP_PRIVATE_KEY = env("GITHUB_APP_PRIVATE_KEY", default="")
GITHUB_WEBHOOK_SECRET = env("GITHUB_WEBHOOK_SECRET", default="")  # comma-separated during a rotation
GITHUB_BRANCH_CREATION = env.bool("GITHUB_BRANCH_CREATION", default=True)
GITLAB_CLIENT_ID = env("GITLAB_CLIENT_ID", default="")
GITLAB_CLIENT_SECRET = env("GITLAB_CLIENT_SECRET", default="")
GITLAB_BASE_URL = env("GITLAB_BASE_URL", default="https://gitlab.com").rstrip("/")
GITLAB_ALLOWED_HOSTS: list[str] = env.list("GITLAB_ALLOWED_HOSTS", default=[])
GITLAB_ALLOW_PRIVATE_NETWORKS = env.bool("GITLAB_ALLOW_PRIVATE_NETWORKS", default=False)
INTEGRATION_BACKFILL_DAYS = env.int("INTEGRATION_BACKFILL_DAYS", default=30)
INTEGRATION_BACKFILL_MAX_PRS = env.int("INTEGRATION_BACKFILL_MAX_PRS", default=200)
INTEGRATION_CATCHUP_MINUTES = env.int("INTEGRATION_CATCHUP_MINUTES", default=30)
WEBHOOK_MAX_BODY_BYTES = env.int("WEBHOOK_MAX_BODY_BYTES", default=5 * 1024 * 1024)
WEBHOOK_RETENTION_DAYS = env.int("WEBHOOK_RETENTION_DAYS", default=7)

# ───────────────────────── Notification channels (board 38) ─────────────────────────
# docs/v2/38-telegram-sms-push.md §2. Each channel has a real backend plus console / fake / disabled.

TELEGRAM_BOT_TOKEN = env("TELEGRAM_BOT_TOKEN", default="")
TELEGRAM_BOT_USERNAME = env("TELEGRAM_BOT_USERNAME", default="").lstrip("@")
TELEGRAM_WEBHOOK_SECRET = env("TELEGRAM_WEBHOOK_SECRET", default="")
TELEGRAM_LINK_TTL_SECONDS = env.int("TELEGRAM_LINK_TTL_SECONDS", default=600)
TELEGRAM_API_BASE = env("TELEGRAM_API_BASE", default="https://api.telegram.org")
TWILIO_ACCOUNT_SID = env("TWILIO_ACCOUNT_SID", default="")
TWILIO_AUTH_TOKEN = env("TWILIO_AUTH_TOKEN", default="")
TWILIO_MESSAGING_SERVICE_SID = env("TWILIO_MESSAGING_SERVICE_SID", default="")
TWILIO_FROM_NUMBER = env("TWILIO_FROM_NUMBER", default="")
TWILIO_API_BASE = env("TWILIO_API_BASE", default="https://api.twilio.com")
SMS_COUNTRIES: list[str] = [c.strip().upper() for c in env.list("SMS_COUNTRIES", default=["US", "GB", "DE"])]
SMS_USER_DAILY_CAP = env.int("SMS_USER_DAILY_CAP", default=10)
SMS_GLOBAL_DAILY_CAP = env.int("SMS_GLOBAL_DAILY_CAP", default=300)
SMS_OTP_GLOBAL_DAILY_CAP = env.int("SMS_OTP_GLOBAL_DAILY_CAP", default=100)
VAPID_PUBLIC_KEY = env("VAPID_PUBLIC_KEY", default="")
VAPID_PRIVATE_KEY = env("VAPID_PRIVATE_KEY", default="")
VAPID_SUBJECT = env("VAPID_SUBJECT", default="")
# Fernet key(s), comma-separated, newest first. Empty: a dev key derived from DJANGO_SECRET_KEY.
CHANNELS_ENCRYPTION_KEY = env("CHANNELS_ENCRYPTION_KEY", default="")
_VAPID = bool(VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY)
TELEGRAM_BACKEND = env("TELEGRAM_BACKEND", default="bot" if TELEGRAM_BOT_TOKEN else "disabled")
SMS_BACKEND = env("SMS_BACKEND", default="twilio" if TWILIO_ACCOUNT_SID else "disabled")
WEB_PUSH_BACKEND = env("WEB_PUSH_BACKEND", default="webpush" if _VAPID else "disabled")
# "auto" (Celery with a broker, else a per-process sender pool), "thread", "celery" or "inline" (tests).
CHANNEL_DISPATCH = env("CHANNEL_DISPATCH", default="auto")
CHANNEL_SENDER_THREADS = env.int("CHANNEL_SENDER_THREADS", default=4)
CHANNEL_MAX_ATTEMPTS = env.int("CHANNEL_MAX_ATTEMPTS", default=5)
CHANNEL_HTTP_TIMEOUT = env.float("CHANNEL_HTTP_TIMEOUT", default=10.0)
WEB_PUSH_ALLOWED_HOSTS: list[str] = env.list(
    "WEB_PUSH_ALLOWED_HOSTS",
    default=[
        "fcm.googleapis.com",
        "updates.push.services.mozilla.com",
        "web.push.apple.com",
        "*.notify.windows.com",
        "*.push.apple.com",
    ],
)
REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"].update(  # type: ignore[attr-defined]
    {
        "channel_connect": env("THROTTLE_CHANNEL_CONNECT", default="20/hour"),
        "channel_test": env("THROTTLE_CHANNEL_TEST", default="12/hour"),
    }
)

# ───────────────────────── Logging ─────────────────────────

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"plain": {"format": "%(asctime)s %(levelname)s %(name)s %(message)s"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "plain"}},
    "root": {"handlers": ["console"], "level": env("LOG_LEVEL", default="INFO")},
    "loggers": {"django.db.backends": {"level": "WARNING"}},
}
APPEND_SLASH = False

# Django admin (operators only). Off in production unless explicitly enabled.
ADMIN_ENABLED = env.bool("ADMIN_ENABLED", default=True)
ADMIN_URL = env("ADMIN_URL", default="admin/")
