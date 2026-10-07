"""Refresh-token cookie handling and the Origin check that protects cookie-authenticated endpoints."""

from urllib.parse import urlsplit

from django.conf import settings

from apps.common.exceptions import ApiError


def set_refresh_cookie(response, refresh: str) -> None:
    response.set_cookie(
        settings.REFRESH_COOKIE_NAME,
        refresh,
        max_age=int(settings.SIMPLE_JWT["REFRESH_TOKEN_LIFETIME"].total_seconds()),
        path=settings.REFRESH_COOKIE_PATH,
        domain=settings.REFRESH_COOKIE_DOMAIN,
        secure=settings.REFRESH_COOKIE_SECURE,
        httponly=True,
        samesite=settings.REFRESH_COOKIE_SAMESITE,
    )


def clear_refresh_cookie(response) -> None:
    response.delete_cookie(
        settings.REFRESH_COOKIE_NAME,
        path=settings.REFRESH_COOKIE_PATH,
        domain=settings.REFRESH_COOKIE_DOMAIN,
        samesite=settings.REFRESH_COOKIE_SAMESITE,
    )


def read_refresh_cookie(request) -> str | None:
    return request.COOKIES.get(settings.REFRESH_COOKIE_NAME)


def check_origin(request) -> None:
    """CSRF defence for endpoints that act on the refresh cookie.

    Browsers always send Origin on cross-site POSTs; it must be an allowed client origin or this
    API's own origin. Requests without Origin (non-browser clients) can't carry a victim's cookie
    cross-site, so they pass.
    """
    origin = request.headers.get("Origin")
    if not origin:
        return
    allowed = {o.rstrip("/") for o in settings.CORS_ALLOWED_ORIGINS}
    own = f"{request.scheme}://{request.get_host()}"
    if origin.rstrip("/") in allowed or origin.rstrip("/") == own:
        return
    parts = urlsplit(origin)
    raise ApiError(403, "csrf_failed", "This request came from an origin that isn’t allowed.", {"origin": parts.netloc})
