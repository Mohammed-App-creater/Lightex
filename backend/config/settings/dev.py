"""Local development: DEBUG on, console email, fake storage unless R2 is configured."""

from .base import *  # noqa: F403
from .base import env

DEBUG = env.bool("DJANGO_DEBUG", default=True)
REFRESH_COOKIE_SECURE = env.bool("REFRESH_COOKIE_SECURE", default=False)
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=["*"])

# Board 37: the fake GitHub/GitLab provider unless real credentials are configured; private GitLab hosts allowed.
_REAL_PROVIDER = bool(env("GITHUB_APP_ID", default="") or env("GITLAB_CLIENT_ID", default=""))
INTEGRATIONS_PROVIDER_BACKEND = env("INTEGRATIONS_PROVIDER_BACKEND", default="real" if _REAL_PROVIDER else "fake")
GITLAB_ALLOW_PRIVATE_NETWORKS = env.bool("GITLAB_ALLOW_PRIVATE_NETWORKS", default=True)
