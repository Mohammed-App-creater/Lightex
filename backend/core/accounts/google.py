"""Sign in with Google (OAuth 2.0 authorization code flow).

The browser navigates to /auth/google/start, which redirects to Google with a random `state`. The
state and the client path to return to travel in a short-lived signed cookie, so no server session
is needed. Google sends the browser to /auth/google/callback; the API exchanges the code, finds or
creates the user by verified email, sets the usual refresh cookie and redirects to the web client,
which restores the session from that cookie like on any page load.
"""

from __future__ import annotations

import json
import secrets
import urllib.error
import urllib.parse
import urllib.request

from django.conf import settings
from django.core import signing
from django.db import transaction
from django.utils import timezone

from .models import User
from .services import normalize_email

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 (a URL, not a secret)
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
STATE_COOKIE = "lx_google_state"
STATE_COOKIE_PATH = "/api/v1/auth/google/"
STATE_MAX_AGE = 600
_SALT = "lightex.google-oauth"


class GoogleSignInError(Exception):
    """Ends the flow; the client shows a generic "couldn't sign in with Google" message."""


def configured() -> bool:
    return bool(settings.GOOGLE_CLIENT_ID and settings.GOOGLE_CLIENT_SECRET)


def redirect_uri() -> str:
    return f"{settings.API_PUBLIC_URL}/api/v1/auth/google/callback"


def safe_next(value: str | None) -> str:
    """Same rule as the client's safeNext: a same-origin path, never //host or /\\host."""
    if not value or not value.startswith("/") or value.startswith(("//", "/\\")):
        return "/"
    return value


def start(next_path: str | None) -> tuple[str, str]:
    """Returns (Google authorization URL, signed value for the state cookie)."""
    state = secrets.token_urlsafe(32)
    params = {
        "client_id": settings.GOOGLE_CLIENT_ID,
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
    }
    cookie = signing.dumps({"s": state, "n": safe_next(next_path)}, salt=_SALT)
    return f"{AUTH_URL}?{urllib.parse.urlencode(params)}", cookie


def read_state(cookie: str | None) -> dict | None:
    if not cookie:
        return None
    try:
        return signing.loads(cookie, salt=_SALT, max_age=STATE_MAX_AGE)
    except signing.BadSignature:
        return None


# Both helpers only ever open the fixed https Google URLs above (S310).
def _post_form(url: str, data: dict) -> dict:
    req = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(), method="POST")  # noqa: S310
    with urllib.request.urlopen(req, timeout=15) as res:  # noqa: S310
        return json.loads(res.read())


def _get_json(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})  # noqa: S310
    with urllib.request.urlopen(req, timeout=15) as res:  # noqa: S310
        return json.loads(res.read())


def fetch_profile(code: str) -> dict:
    """Exchanges the authorization code and returns Google's OpenID userinfo."""
    try:
        token = _post_form(
            TOKEN_URL,
            {
                "code": code,
                "client_id": settings.GOOGLE_CLIENT_ID,
                "client_secret": settings.GOOGLE_CLIENT_SECRET,
                "redirect_uri": redirect_uri(),
                "grant_type": "authorization_code",
            },
        )
        return _get_json(USERINFO_URL, token["access_token"])
    except (urllib.error.URLError, KeyError, ValueError, TimeoutError) as exc:
        raise GoogleSignInError("token exchange failed") from exc


@transaction.atomic
def user_for_profile(info: dict) -> User:
    """Finds the account with this verified email, or creates one without a usable password."""
    email = normalize_email(info.get("email"))
    if not email or info.get("email_verified") is not True:
        raise GoogleSignInError("no verified email")
    user = User.objects.filter(email__iexact=email).first()
    if user is None:
        name = (info.get("name") or "").strip() or email.split("@")[0]
        user = User.objects.create_user(email=email, password=None, name=name[:60])
    elif not user.is_active:
        raise GoogleSignInError("inactive account")
    user.last_login = timezone.now()
    user.save(update_fields=["last_login"])
    return user
