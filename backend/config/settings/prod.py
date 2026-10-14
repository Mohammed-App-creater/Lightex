"""Production: HTTPS only, secure cookies, strict hosts. Everything sensitive comes from the environment."""

from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F403
from .base import env

DEBUG = False
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS")

SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = env.bool("SECURE_SSL_REDIRECT", default=True)
SECURE_HSTS_SECONDS = env.int("SECURE_HSTS_SECONDS", default=31536000)
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
X_FRAME_OPTIONS = "DENY"
SECURE_CROSS_ORIGIN_OPENER_POLICY = "same-origin"
CSRF_COOKIE_HTTPONLY = True
ADMIN_ENABLED = env.bool("ADMIN_ENABLED", default=False)
# Without Redis the cache is per process; throttles then count per gunicorn worker (see README).
REFRESH_COOKIE_SECURE = True
# Health checks from the platform must not be redirected.
SECURE_REDIRECT_EXEMPT = [r"^health$"]

# Board 37 §10.2: credentials at rest need real keys once any provider is configured.
if (env("GITHUB_APP_ID", default="") or env("GITLAB_CLIENT_ID", default="")) and not env(
    "INTEGRATIONS_ENCRYPTION_KEYS", default=""
):
    raise ImproperlyConfigured(
        "INTEGRATIONS_ENCRYPTION_KEYS is required when GitHub or GitLab is configured "
        "(python manage.py generate_integration_key)."
    )
