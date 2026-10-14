"""Test settings: fast hashing, inline Celery, fake storage, locmem email and cache."""

import os

os.environ.setdefault("DJANGO_SECRET_KEY", "test-secret-key-not-for-production-0123456789")

from .base import *  # noqa: F403
from .base import REST_FRAMEWORK, env

DEBUG = False
DATABASES = {
    "default": env.db(
        "TEST_DATABASE_URL", default=env("DATABASE_URL", default="postgres://postgres@localhost:5433/lightex")
    )
}
# Tests create, flush and drop databases. `.env` may hold the production DATABASE_URL, so refuse any
# host that isn't local (CI and docker-compose use localhost / db) unless explicitly allowed.
_TEST_DB_HOST = str(DATABASES["default"].get("HOST") or "localhost")
if _TEST_DB_HOST not in {"localhost", "127.0.0.1", "::1", "db"} and not env.bool(
    "ALLOW_REMOTE_TEST_DATABASE", default=False
):
    raise RuntimeError(
        f"Refusing to run tests against non-local database host {_TEST_DB_HOST!r}. "
        "Set TEST_DATABASE_URL to a local Postgres (e.g. postgres://postgres@localhost:5433/lightex)."
    )
DATABASES["default"]["CONN_MAX_AGE"] = 0
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "lightex-test"}}
CELERY_TASK_ALWAYS_EAGER = True
CELERY_BROKER_URL = "memory://"
STORAGE_BACKEND = "fake"
# Board 40: the import runner runs synchronously (deterministic tests), with no retry delay.
IMPORT_RUNNER = "inline"
IMPORT_RETRY_DELAY_SECONDS = 0.0
REFRESH_COOKIE_SECURE = True
CORS_ALLOWED_ORIGINS = ["http://localhost:3000"]
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}
# Throttles are exercised by dedicated tests that override these rates.
REST_FRAMEWORK = {
    **REST_FRAMEWORK,
    "DEFAULT_THROTTLE_RATES": {
        **REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"],  # type: ignore[dict-item]
        "anon": "100000/min",
        "user": "100000/min",
        "auth": "100000/min",
        "password_reset": "100000/min",
        "invitations": "100000/min",
        "invite_token": "100000/min",
        "uploads": "100000/min",
        "imports": "100000/min",
        "stream": "100000/min",
        "presence": "100000/min",
        "webhook": "100000/min",
        "integration_connect": "100000/min",
        "dev_branch": "100000/min",
        "dev_link": "100000/min",
    },
}
# Board 33: in-process realtime broker (rows are still stored for replay), fast heartbeats and short streams.
REALTIME_ENABLED = True
REALTIME_BROKER = "local"
REALTIME_LISTEN_DATABASE_URL = ""
SSE_HEARTBEAT_SECONDS = 0.05
SSE_MAX_LIFETIME_SECONDS = 0.5
SSE_LIFETIME_JITTER_SECONDS = 0.0
REALTIME_LISTENER_BACKOFF_SECONDS = 0.1
REALTIME_LISTEN_POLL_SECONDS = 0.2
# Board 37: the fake provider, synchronous processing, a known webhook secret and the derived dev encryption key.
INTEGRATIONS_ENABLED = True
INTEGRATIONS_PROVIDER_BACKEND = "fake"
INTEGRATIONS_RUNNER = "inline"
INTEGRATIONS_ENCRYPTION_KEYS = ""
GITHUB_APP_ID = ""
GITHUB_APP_SLUG = ""
GITHUB_APP_CLIENT_ID = ""
GITHUB_APP_CLIENT_SECRET = ""
GITHUB_APP_PRIVATE_KEY = ""
GITHUB_WEBHOOK_SECRET = "test-webhook-secret"
GITHUB_BRANCH_CREATION = True
GITLAB_CLIENT_ID = ""
GITLAB_CLIENT_SECRET = ""
GITLAB_BASE_URL = "https://gitlab.com"
GITLAB_ALLOWED_HOSTS = []
GITLAB_ALLOW_PRIVATE_NETWORKS = False
# Board 38: fake channel providers, synchronous dispatch and known secrets.
TELEGRAM_BACKEND = "fake"
SMS_BACKEND = "fake"
WEB_PUSH_BACKEND = "fake"
CHANNEL_DISPATCH = "inline"
TELEGRAM_BOT_TOKEN = ""
TELEGRAM_BOT_USERNAME = "lightex_bot"
TELEGRAM_WEBHOOK_SECRET = "test-telegram-secret"
TWILIO_ACCOUNT_SID = "ACtest"
TWILIO_AUTH_TOKEN = "test-twilio-token"
TWILIO_MESSAGING_SERVICE_SID = "MGtest"
TWILIO_FROM_NUMBER = ""
SMS_COUNTRIES = ["US", "GB", "DE"]
VAPID_PUBLIC_KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U"
VAPID_PRIVATE_KEY = ""
VAPID_SUBJECT = "mailto:ops@lightex.test"
CHANNELS_ENCRYPTION_KEY = ""
REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"].update(  # type: ignore[attr-defined]
    {"channel_connect": "100000/min", "channel_test": "100000/min"}
)
