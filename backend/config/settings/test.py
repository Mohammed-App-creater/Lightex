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
