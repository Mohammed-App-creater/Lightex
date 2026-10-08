"""Accounts: registration, credentials, sessions (JWT + refresh cookie), password reset, profile."""

from __future__ import annotations

import base64
import binascii
import contextlib
import datetime as dt
import re
from typing import Any

from django.conf import settings
from django.contrib.auth import password_validation
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from django.utils import timezone
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken, OutstandingToken
from rest_framework_simplejwt.tokens import RefreshToken

from apps.common.exceptions import ApiError, invalid
from apps.common.tokens import hash_token as _hash
from apps.common.tokens import new_token, token_matches

from .models import PasswordResetToken, User

EMAIL_RE = re.compile(r"^[^\s@,]+@[^\s@,]+\.[^\s@,]+$")
_DUMMY = User(email="dummy@lightex.invalid")
_DUMMY.set_password("not-a-real-password-#1")


def normalize_email(email: Any) -> str:
    return str(email or "").strip().lower()


def password_problem(password: str, user: User | None = None) -> str | None:
    try:
        password_validation.validate_password(password, user=user)
    except DjangoValidationError as exc:
        return exc.messages[0]
    return None


# ───────────────────────── registration and login ─────────────────────────


@transaction.atomic
def register(*, name: str, email: str, password: str) -> User:
    name = (name or "").strip()
    email = normalize_email(email)
    fields: dict[str, str] = {}
    if len(name) < 2:
        fields["name"] = "Enter your name"
    if not EMAIL_RE.match(email) or len(email) > 254:
        fields["email"] = "Enter a valid email"
    candidate = User(email=email, name=name)
    problem = password_problem(password or "", candidate)
    if problem:
        fields["password"] = problem
    if not fields and User.objects.filter(email__iexact=email).exists():
        # Deliberately vague: the same message whether or not an account exists would be
        # ideal, but the client signs in straight after registering (see final report).
        fields["email"] = "We couldn’t create an account with this email. Try signing in or resetting your password."
    if fields:
        raise invalid(fields)
    return User.objects.create_user(email=email, password=password, name=name[:60])


def authenticate(email: str, password: str) -> User:
    email = normalize_email(email)
    user = User.objects.filter(email__iexact=email).first()
    if user is None:
        _DUMMY.check_password(password or "")  # equalise timing; no account enumeration
        raise ApiError(401, "invalid_credentials", "Email or password is incorrect.")
    if not user.check_password(password or "") or not user.is_active:
        raise ApiError(401, "invalid_credentials", "Email or password is incorrect.")
    user.last_login = timezone.now()
    user.save(update_fields=["last_login"])
    return user


def issue_tokens(user: User) -> tuple[str, str]:
    refresh = RefreshToken.for_user(user)
    return str(refresh.access_token), str(refresh)


def access_from_refresh(raw: str | None) -> tuple[str, User]:
    if not raw:
        raise ApiError(401, "unauthorized", "Not signed in.")
    try:
        refresh = RefreshToken(raw)  # type: ignore[arg-type]  # verifies signature, expiry and the blacklist
    except TokenError as exc:
        raise ApiError(401, "unauthorized", "Your session has expired. Sign in again.") from exc
    user = User.objects.filter(pk=refresh.get("user_id"), is_active=True).first()
    if user is None:
        raise ApiError(401, "unauthorized", "Your session has expired. Sign in again.")
    return str(refresh.access_token), user


def revoke_refresh(raw: str | None) -> None:
    if not raw:
        return
    with contextlib.suppress(TokenError):
        RefreshToken(raw).blacklist()  # type: ignore[arg-type]


def revoke_all_sessions(user: User) -> None:
    for token in OutstandingToken.objects.filter(user=user, expires_at__gt=timezone.now()):
        BlacklistedToken.objects.get_or_create(token=token)


# ───────────────────────── passwords ─────────────────────────


def request_password_reset(email: str) -> None:
    """Always succeeds from the caller's point of view (no account enumeration)."""
    from apps.notifications.emails import base_context, queue_email

    user = User.objects.filter(email__iexact=normalize_email(email), is_active=True).first()
    if user is None:
        _hash("equalise-timing")
        return
    with transaction.atomic():
        raw, digest = new_token()
        expires = timezone.now() + dt.timedelta(minutes=settings.PASSWORD_RESET_TTL_MINUTES)
        PasswordResetToken.objects.create(user=user, token_hash=digest, expires_at=expires)
        queue_email(
            user.email,
            "password_reset",
            {
                **base_context(),
                "cta_url": f"{settings.FRONTEND_URL}/reset-password?token={raw}",
                "expires_at": f"{settings.PASSWORD_RESET_TTL_MINUTES} minutes",
                "user_email": user.email,
            },
        )


@transaction.atomic
def reset_password(token: str, password: str) -> User:
    digest = _hash(token or "")
    row = PasswordResetToken.objects.select_for_update().select_related("user").filter(token_hash=digest).first()
    if (
        row is None
        or not token_matches(token or "", row.token_hash)
        or row.used_at is not None
        or row.expires_at <= timezone.now()
        or not row.user.is_active
    ):
        raise ApiError(400, "invalid_token", "This reset link has expired. Request a new one.")
    problem = password_problem(password or "", row.user)
    if problem:
        raise invalid({"password": problem})
    user = row.user
    user.set_password(password)
    user.save(update_fields=["password", "updated_at"])
    PasswordResetToken.objects.filter(user=user, used_at__isnull=True).update(used_at=timezone.now())
    revoke_all_sessions(user)
    return user


@transaction.atomic
def change_password(user: User, current: str, new: str) -> None:
    """Changes the password. An account without one (made with Google sign-in) sets it without a current one."""
    if user.has_usable_password() and not user.check_password(current or ""):
        raise invalid({"currentPassword": "Current password is incorrect"})
    problem = password_problem(new or "", user)
    if problem:
        raise invalid({"newPassword": problem})
    user.set_password(new)
    user.save(update_fields=["password", "updated_at"])
    revoke_all_sessions(user)


# ───────────────────────── profile ─────────────────────────

_DATA_URL = re.compile(r"^data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$")
_MAGIC = {"png": b"\x89PNG\r\n\x1a\n", "jpeg": b"\xff\xd8\xff", "webp": b"RIFF"}


def _check_avatar(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise invalid({"avatarUrl": "Upload a PNG, JPG or WebP image"})
    if value.startswith("https://") and len(value) <= 2000 and not re.search(r"[\s\"'<>]", value):
        return value
    match = _DATA_URL.match(value)
    if not match:
        raise invalid({"avatarUrl": "Upload a PNG, JPG or WebP image"})
    kind, payload = match.groups()
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise invalid({"avatarUrl": "Upload a PNG, JPG or WebP image"}) from exc
    if len(raw) > settings.MAX_AVATAR_BYTES:
        raise invalid({"avatarUrl": "Images up to 2 MB"})
    if not raw.startswith(_MAGIC[kind]) or (kind == "webp" and raw[8:12] != b"WEBP"):
        raise invalid({"avatarUrl": "Upload a PNG, JPG or WebP image"})
    return value


def update_profile(user: User, data: dict[str, Any]) -> User:
    fields = []
    if "name" in data:
        name = str(data.get("name") or "").strip()
        if len(name) < 2:
            raise invalid({"name": "Name must be at least 2 characters"})
        user.name = name[:60]
        fields.append("name")
    if "avatarUrl" in data:
        user.avatar_url = _check_avatar(data.get("avatarUrl"))
        fields.append("avatar_url")
    if fields:
        user.save(update_fields=[*fields, "updated_at"])
    return user
