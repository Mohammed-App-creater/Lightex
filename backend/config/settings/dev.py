"""Local development: DEBUG on, console email, fake storage unless R2 is configured."""

from .base import *  # noqa: F403
from .base import env

DEBUG = env.bool("DJANGO_DEBUG", default=True)
REFRESH_COOKIE_SECURE = env.bool("REFRESH_COOKIE_SECURE", default=False)
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=["*"])
