"""Board 38 personal channel endpoints (docs/v2/38-telegram-sms-push.md §5): Telegram linking, SMS verification,
push subscriptions and test sends. Every function only touches the caller's own rows."""

from __future__ import annotations

import base64
import binascii
import datetime as dt
import fnmatch
import hmac
import logging
import re
import secrets
import urllib.parse
import uuid
import zoneinfo
from typing import Any

from cryptography.hazmat.primitives.asymmetric import ec
from django.conf import settings
from django.db import transaction
from django.utils import timezone

from core.common.exceptions import ApiError, conflict, invalid, not_found
from core.common.utils import iso

from . import crypto, dispatch, phones, render, runner
from .models import (
    ChannelDelivery,
    OtpSend,
    PushSubscription,
    SmsConnection,
    SmsVerification,
    TelegramConnection,
    TelegramLinkRequest,
)
from .providers import available, get_sms, get_telegram

logger = logging.getLogger("lightex.channels")

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
OTP_TTL = dt.timedelta(seconds=600)
RESEND_AFTER = dt.timedelta(seconds=30)
MAX_PUSH_DEVICES = 10
EXPIRED_DEVICE_DAYS = 7


# ───────────────────────── errors ─────────────────────────


def unavailable(channel: str) -> ApiError:
    return ApiError(503, "channel_unavailable", "This channel isn’t available on this server.", {"channel": channel})


def send_failed(channel: str, reason: str) -> ApiError:
    return ApiError(
        502, "channel_send_failed", "The provider didn’t accept the message.", {"channel": channel, "reason": reason}
    )


def throttled(message: str, retry_at: dt.datetime, reason: str) -> ApiError:
    wait = max(1, int((retry_at - timezone.now()).total_seconds()))
    return ApiError(
        429, "throttled", message, {"retryAt": iso(retry_at), "reason": reason}, headers={"Retry-After": str(wait)}
    )


# ───────────────────────── shapes ─────────────────────────


def telegram_data(c: TelegramConnection) -> dict[str, Any]:
    return {
        "id": str(c.pk),
        "username": c.username or None,
        "firstName": c.first_name,
        "status": c.status,
        "connectedAt": iso(c.connected_at),
        "lastError": c.last_error or None,
    }


def sms_data(c: SmsConnection) -> dict[str, Any]:
    e164 = crypto.decrypt_phone(c.phone_enc)
    return {
        "id": str(c.pk),
        "phoneNumber": e164,
        "display": phones.display_e164(c.country, e164),
        "country": c.country,
        "status": c.status,
        "verifiedAt": iso(c.verified_at),
        "lastError": c.last_error or None,
    }


def device_data(s: PushSubscription) -> dict[str, Any]:
    return {
        "id": str(s.pk),
        "label": s.label,
        "endpointHash": s.endpoint_hash[:16],
        "status": s.status,
        "createdAt": iso(s.created_at),
        "lastSeenAt": iso(s.last_seen_at),
        "lastSuccessAt": iso(s.last_success_at),
    }


def overview(user: Any) -> dict[str, Any]:
    """C1."""
    tg = TelegramConnection.objects.filter(user=user).first()
    sms = SmsConnection.objects.filter(user=user).first()
    week = timezone.now() - dt.timedelta(days=EXPIRED_DEVICE_DAYS)
    devices = PushSubscription.objects.filter(user=user).filter(status="active") | PushSubscription.objects.filter(
        user=user, status="expired", last_seen_at__gte=week
    )
    tg_on, sms_on, push_on = available("telegram"), available("sms"), available("push")
    return {
        "email": {"address": user.email},
        "telegram": {
            "available": tg_on,
            "botUsername": (settings.TELEGRAM_BOT_USERNAME or None) if tg_on else None,
            "connection": telegram_data(tg) if tg else None,
        },
        "sms": {
            "available": sms_on,
            "countries": [c.public() for c in phones.allowed_countries()] if sms_on else [],
            "connection": sms_data(sms) if sms else None,
            "dailyCap": settings.SMS_USER_DAILY_CAP,
            "sentToday": runner.sms_sent_today(user.pk),
        },
        "push": {
            "available": push_on,
            "vapidPublicKey": (settings.VAPID_PUBLIC_KEY or None) if push_on else None,
            "devices": [device_data(s) for s in devices.order_by("-last_seen_at")],
        },
    }


# ───────────────────────── time zone (§5.3) ─────────────────────────


def valid_timezone(value: Any) -> bool:
    return isinstance(value, str) and value in zoneinfo.available_timezones()


def fill_timezone(user: Any, value: Any) -> None:
    """Every connect call carries the browser's zone; it fills `timezone` only while it is still null."""
    if not valid_timezone(value):
        return
    from core.notifications.handlers import preferences_for

    prefs = preferences_for(user)
    if prefs.timezone is None:
        prefs.timezone = value
        prefs.save(update_fields=["timezone", "updated_at"])


# ───────────────────────── Telegram (C2–C5) ─────────────────────────


def normalize_code(text: str) -> str:
    return re.sub(r"[\s-]", "", text or "").upper()


def link_data(link: TelegramLinkRequest, *, code: str = "", token: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {"id": str(link.pk), "status": link.status}
    if link.status == "pending" and code:
        out["code"] = code
        out["deepLink"] = f"https://t.me/{settings.TELEGRAM_BOT_USERNAME}?start={token}"
    out.update(
        {
            "botUsername": settings.TELEGRAM_BOT_USERNAME,
            "expiresAt": iso(link.expires_at),
            "connection": telegram_data(link.connection) if link.status == "linked" and link.connection else None,
        }
    )
    return out


def refresh_link(link: TelegramLinkRequest) -> TelegramLinkRequest:
    if link.status == "pending" and link.expires_at <= timezone.now():
        TelegramLinkRequest.objects.filter(pk=link.pk, status="pending").update(status="expired")
        link.status = "expired"
    return link


def create_link(user: Any, tz: Any = None) -> dict[str, Any]:
    if not available("telegram"):
        raise unavailable("telegram")
    if TelegramConnection.objects.filter(user=user, status="active").exists():
        raise conflict("already_connected", "Telegram is already connected. Disconnect it first.")
    fill_timezone(user, tz)
    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
    token = "lx_" + secrets.token_urlsafe(32)
    with transaction.atomic():
        TelegramLinkRequest.objects.filter(user=user, status="pending").update(status="canceled")
        link = TelegramLinkRequest.objects.create(
            user=user,
            code_hash=crypto.secret_hash("lightex.tglink", code),
            start_hash=crypto.sha256(token),
            expires_at=timezone.now() + dt.timedelta(seconds=settings.TELEGRAM_LINK_TTL_SECONDS),
        )
    return link_data(link, code=code, token=token)


def my_link(user: Any, link_id: Any) -> TelegramLinkRequest:
    link = TelegramLinkRequest.objects.select_related("connection").filter(pk=link_id, user=user).first()
    if link is None:
        raise not_found("Link not found.")
    return refresh_link(link)


def cancel_link(user: Any, link_id: Any) -> None:
    link = my_link(user, link_id)
    if link.status == "pending":
        TelegramLinkRequest.objects.filter(pk=link.pk, status="pending").update(status="canceled")


def disconnect_telegram(user: Any) -> None:
    conn = TelegramConnection.objects.filter(user=user).first()
    if conn is None:
        return
    chat_id = conn.chat_id
    with transaction.atomic():
        dispatch.skip_pending([user.pk], "telegram", "not_connected")
        conn.delete()

    def goodbye() -> None:
        try:
            get_telegram().send_message(
                chat_id, "Disconnected from Lightex. Send /start with a new code to connect again.", button=None
            )
        except Exception:
            logger.warning("Telegram goodbye message failed")

    if available("telegram"):
        transaction.on_commit(goodbye)


# ───────────────────────── SMS (C6–C9, §7.5) ─────────────────────────


def _otp_limits(user: Any, phone_hash: str) -> None:
    now = timezone.now()
    hour, day = now - dt.timedelta(hours=1), now - dt.timedelta(days=1)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    mine = OtpSend.objects.filter(user=user)
    message = "Too many codes requested. Try again later."
    recent = list(mine.filter(created_at__gte=hour).order_by("created_at").values_list("created_at", flat=True))
    if len(recent) >= 5:
        raise throttled(message, recent[0] + dt.timedelta(hours=1), "hourly_limit")
    daily = list(mine.filter(created_at__gte=day).order_by("created_at").values_list("created_at", flat=True))
    if len(daily) >= 10:
        raise throttled(message, daily[0] + dt.timedelta(days=1), "daily_limit")
    by_phone = list(
        OtpSend.objects.filter(phone_hash=phone_hash, created_at__gte=hour)
        .order_by("created_at")
        .values_list("created_at", flat=True)
    )
    if len(by_phone) >= 5:
        raise throttled(message, by_phone[0] + dt.timedelta(hours=1), "phone_limit")
    if OtpSend.objects.filter(created_at__gte=midnight).count() >= settings.SMS_OTP_GLOBAL_DAILY_CAP:
        logger.error("Global OTP daily cap (%s) reached", settings.SMS_OTP_GLOBAL_DAILY_CAP)
        raise throttled(message, midnight + dt.timedelta(days=1), "global_limit")


def _send_otp(v: SmsVerification, e164: str, ip: str | None) -> None:
    """New code, new hash, one OtpSend row, then one synchronous provider call."""
    code = f"{secrets.randbelow(10**6):06d}"
    now = timezone.now()
    v.code_hash = crypto.secret_hash("lightex.otp", f"{v.pk}:{code}")
    v.attempts_left = 3
    v.expires_at = now + OTP_TTL
    v.resend_at = now + RESEND_AFTER
    v.save()
    OtpSend.objects.create(user_id=v.user_id, phone_hash=v.phone_hash, ip=ip or None)
    result = get_sms().send(e164, render.otp_sms(code), status_callback=None)
    if not result.ok:
        SmsVerification.objects.filter(pk=v.pk).update(status="canceled")
        reason = "invalid_number" if result.reason in ("invalid_number", "opted_out") else "provider_error"
        logger.warning("OTP send to %s failed: %s", crypto.mask(e164), result.reason)
        raise send_failed("sms", reason)


def verification_data(v: SmsVerification) -> dict[str, Any]:
    e164 = crypto.decrypt_phone(v.phone_enc)
    return {
        "id": str(v.pk),
        "phoneNumber": e164,
        "display": phones.display_e164(v.country, e164),
        "expiresAt": iso(v.expires_at),
        "resendAt": iso(v.resend_at),
        "attemptsLeft": v.attempts_left,
    }


def start_verification(user: Any, data: dict[str, Any], ip: str | None = None) -> dict[str, Any]:
    if not available("sms"):
        raise unavailable("sms")
    checked = phones.validate(str(data.get("country") or ""), str(data.get("nationalNumber") or ""))
    if not checked.ok:
        raise invalid({checked.field: checked.error})
    if SmsConnection.objects.filter(user=user, status="active").exists():
        raise conflict("already_connected", "Remove your phone number first.")
    phone_hash = crypto.phone_hash(checked.e164)
    _otp_limits(user, phone_hash)
    fill_timezone(user, data.get("timezone"))
    assert checked.country is not None  # noqa: S101
    with transaction.atomic():
        SmsVerification.objects.filter(user=user, status="pending").update(status="canceled")
        now = timezone.now()
        v = SmsVerification.objects.create(
            id=uuid.uuid4(),
            user=user,
            phone_enc=crypto.encrypt_phone(checked.e164),
            phone_hash=phone_hash,
            country=checked.country.code,
            code_hash="",
            expires_at=now + OTP_TTL,
            resend_at=now + RESEND_AFTER,
        )
    _send_otp(v, checked.e164, ip)
    return verification_data(v)


def _my_verification(user: Any, verification_id: Any) -> SmsVerification:
    v = SmsVerification.objects.filter(pk=verification_id, user=user).first()
    if v is None:
        raise not_found("Verification not found.")
    return v


def resend(user: Any, verification_id: Any, ip: str | None = None) -> dict[str, Any]:
    v = _my_verification(user, verification_id)
    if not available("sms"):
        raise unavailable("sms")
    if v.status not in ("pending", "expired"):
        raise ApiError(410, "verification_closed", "This code request is closed.")
    if timezone.now() < v.resend_at:
        raise throttled("Wait before resending.", v.resend_at, "resend_cooldown")
    _otp_limits(user, v.phone_hash)
    v.status = "pending"
    v.send_count += 1
    _send_otp(v, crypto.decrypt_phone(v.phone_enc), ip)
    return verification_data(v)


def verify(user: Any, verification_id: Any, code: Any) -> dict[str, Any]:
    _my_verification(user, verification_id)
    if not isinstance(code, str) or not re.fullmatch(r"\d{6}", code):
        raise invalid({"code": "Enter the 6-digit code"})
    error: ApiError | None = None
    conn: SmsConnection | None = None
    with transaction.atomic():
        v = SmsVerification.objects.select_for_update().get(pk=verification_id)
        if v.status == "expired" or (v.status == "pending" and v.expires_at <= timezone.now()):
            v.status = "expired"
            v.save(update_fields=["status", "updated_at"])
            error = ApiError(410, "code_expired", "Code expired.")
        elif v.status != "pending":
            error = ApiError(410, "verification_closed", "This code request is closed.")
        elif v.attempts_left <= 0:
            error = ApiError(422, "too_many_attempts", "Too many tries.", {"attemptsLeft": 0})
        elif not hmac.compare_digest(v.code_hash, crypto.secret_hash("lightex.otp", f"{v.pk}:{code}")):
            v.attempts_left -= 1
            v.save(update_fields=["attempts_left", "updated_at"])
            if v.attempts_left <= 0:
                error = ApiError(422, "too_many_attempts", "Too many tries.", {"attemptsLeft": 0})
            else:
                error = ApiError(422, "invalid_code", "Wrong code.", {"attemptsLeft": v.attempts_left})
        else:
            now = timezone.now()
            v.status, v.verified_at = "verified", now
            v.save(update_fields=["status", "verified_at", "updated_at"])
            SmsConnection.objects.filter(user=user).delete()
            e164 = crypto.decrypt_phone(v.phone_enc)
            conn = SmsConnection.objects.create(
                user=user,
                phone_enc=v.phone_enc,
                phone_hash=v.phone_hash,
                country=v.country,
                last4=e164[-4:],
                verified_at=now,
            )
    if error is not None:
        raise error
    assert conn is not None  # noqa: S101
    return {"connection": sms_data(conn)}


def remove_sms(user: Any) -> None:
    with transaction.atomic():
        dispatch.skip_pending([user.pk], "sms", "not_connected")
        SmsConnection.objects.filter(user=user).delete()


# ───────────────────────── Push (C10–C13) ─────────────────────────


def endpoint_allowed(endpoint: str) -> bool:
    """SSRF guard (§2.4): https on an allow-listed push service host, checked at subscribe and before every send."""
    try:
        parts = urllib.parse.urlsplit(endpoint or "")
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return False
    if parts.scheme != "https" or not host or parts.username or parts.password or port not in (None, 443):
        return False
    return any(fnmatch.fnmatch(host, p.strip().lower()) for p in settings.WEB_PUSH_ALLOWED_HOSTS if p.strip())


def _b64(value: Any) -> bytes | None:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_\-=+/]+", value):
        return None
    text = value.replace("+", "-").replace("/", "_").rstrip("=")
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError):
        return None


def _valid_p256dh(value: Any) -> bool:
    raw = _b64(value)
    if raw is None or len(raw) != 65 or raw[0] != 4:
        return False
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    except ValueError:
        return False
    return True


BROWSERS = [("Edg/", "Edge"), ("EdgA/", "Edge"), ("Firefox/", "Firefox"), ("FxiOS", "Firefox"), ("CriOS", "Chrome"),
            ("Chrome/", "Chrome"), ("Safari/", "Safari")]  # fmt: skip
SYSTEMS = [("Windows", "Windows"), ("Android", "Android"), ("iPhone", "iOS"), ("iPad", "iOS"), ("Mac OS X", "macOS"),
           ("Macintosh", "macOS"), ("Linux", "Linux")]  # fmt: skip


def device_label(user_agent: str) -> str:
    browser = next((name for needle, name in BROWSERS if needle in user_agent), "Browser")
    system = next((name for needle, name in SYSTEMS if needle in user_agent), "Unknown OS")
    return f"{browser} on {system}"


def subscribe(user: Any, data: dict[str, Any], user_agent: str) -> tuple[dict[str, Any], bool]:
    """C11 → (device, created)."""
    if not available("push"):
        raise unavailable("push")
    mode = data.get("mode")
    raw_sub = data.get("subscription")
    sub: dict[str, Any] = raw_sub if isinstance(raw_sub, dict) else {}
    raw_keys = sub.get("keys")
    keys: dict[str, Any] = raw_keys if isinstance(raw_keys, dict) else {}
    raw_endpoint = sub.get("endpoint")
    endpoint: str = raw_endpoint if isinstance(raw_endpoint, str) else ""
    fields: dict[str, str] = {}
    if mode not in ("subscribe", "refresh"):
        fields["mode"] = "Use subscribe or refresh"
    if not endpoint_allowed(endpoint) or len(endpoint) > 2000:
        fields["subscription.endpoint"] = "Unsupported push service"
    if not _valid_p256dh(keys.get("p256dh")) or len(str(keys.get("p256dh"))) > 100:
        fields["subscription.keys.p256dh"] = "Invalid key"
    auth_raw = _b64(keys.get("auth"))
    if auth_raw is None or len(auth_raw) != 16:
        fields["subscription.keys.auth"] = "Invalid key"
    if fields:
        raise invalid(fields)
    expiration = sub.get("expirationTime")
    expires = dt.datetime.fromtimestamp(expiration / 1000, tz=dt.UTC) if isinstance(expiration, int | float) else None
    now = timezone.now()
    digest = crypto.sha256(endpoint)
    values = {
        "p256dh": keys["p256dh"],
        "auth": keys["auth"],
        "label": device_label(user_agent)[:60],
        "user_agent": user_agent[:256],
        "last_seen_at": now,
        "expiration_time": expires,
    }
    with transaction.atomic():
        existing = PushSubscription.objects.select_for_update().filter(endpoint_hash=digest).first()
        if mode == "refresh":
            if existing is None or existing.user_id != user.pk or existing.status != "active":
                raise not_found("Subscription not found.")
            for k, v in values.items():
                setattr(existing, k, v)
            existing.save()
            return device_data(existing), False
        fill_timezone(user, data.get("timezone"))
        created = existing is None
        if existing is None:
            existing = PushSubscription.objects.create(user=user, endpoint=endpoint, endpoint_hash=digest, **values)
        else:  # a browser subscription belongs to whoever subscribed it last
            existing.user = user
            existing.status = "active"
            existing.failure_count = 0
            for k, v in values.items():
                setattr(existing, k, v)
            existing.save()
        active = PushSubscription.objects.filter(user=user, status="active").order_by("-last_seen_at", "-created_at")
        stale = [s.pk for s in active[MAX_PUSH_DEVICES:]]
        if stale:
            PushSubscription.objects.filter(pk__in=stale).update(status="expired")
    return device_data(existing), created


def remove_push_endpoint(user: Any, endpoint: Any) -> None:
    if isinstance(endpoint, str) and endpoint:
        PushSubscription.objects.filter(user=user, endpoint_hash=crypto.sha256(endpoint)).delete()


def remove_push_device(user: Any, device_id: Any) -> None:
    deleted, _ = PushSubscription.objects.filter(pk=device_id, user=user).delete()
    if not deleted:
        raise not_found("Device not found.")


# ───────────────────────── tests (C14) ─────────────────────────


def _test_context(user: Any, workspace_slug: str | None) -> dict[str, Any]:
    from core.workspaces.models import WorkspaceMember

    url = settings.FRONTEND_URL
    if workspace_slug and WorkspaceMember.objects.filter(user=user, workspace__slug=workspace_slug).exists():
        url = f"{settings.FRONTEND_URL}/{workspace_slug}/settings/notifications"
    return {"cta_url": url}


def _not_connected(channel: str) -> ApiError:
    names = {"telegram": "Telegram", "sms": "SMS", "push": "Push"}
    return conflict("channel_not_connected", f"{names[channel]} isn’t connected.", {"channel": channel})


def send_test(user: Any, channel: str, data: dict[str, Any], workspace_slug: str | None) -> dict[str, Any]:
    if channel not in ("email", "telegram", "sms", "push"):
        raise not_found("Unknown channel.")
    if not available(channel):
        raise unavailable(channel)
    context = _test_context(user, workspace_slug)
    now = timezone.now()
    if channel == "email":
        from django.core.mail import send_mail

        send_mail(
            "Lightex test notification",
            "This is a test notification from Lightex. Email notifications will arrive at this address.\n\n"
            f"{context['cta_url']}",
            settings.DEFAULT_FROM_EMAIL,
            [user.email],
        )
        row = ChannelDelivery.objects.create(
            user=user, channel="email", kind="test", event="test", template="test", context=context,
            status="sent", next_attempt_at=now, sent_at=now,
        )  # fmt: skip
        return {"channel": channel, "status": "sent", "deliveryId": str(row.pk), "sentAt": iso(row.sent_at)}
    targets: list[dict[str, Any]] = []
    if channel == "telegram":
        tg = TelegramConnection.objects.filter(user=user).first()
        if tg is None:
            raise _not_connected(channel)
        if tg.status != "active":
            raise send_failed(channel, "blocked")
        targets = [{"telegram": tg}]
    elif channel == "sms":
        sms = SmsConnection.objects.filter(user=user).first()
        if sms is None:
            raise _not_connected(channel)
        if sms.status != "active":
            raise send_failed(channel, "opted_out" if sms.status == "opted_out" else "invalid_number")
        if runner.sms_sent_today(user.pk) >= settings.SMS_USER_DAILY_CAP:
            midnight = now.replace(hour=0, minute=0, second=0, microsecond=0) + dt.timedelta(days=1)
            raise throttled("Daily SMS limit reached.", midnight, "daily_cap")
        targets = [{"sms": sms}]
    else:
        mine = PushSubscription.objects.filter(user=user)
        device_id = data.get("deviceId")
        if device_id:
            try:
                mine = mine.filter(pk=uuid.UUID(str(device_id)))
            except ValueError:
                mine = mine.none()
        active = [s for s in mine if s.status == "active"]
        if not active:
            if mine.exists():
                raise send_failed(channel, "expired_subscription")
            raise _not_connected(channel)
        targets = [{"push": s} for s in active]
    rows = [
        ChannelDelivery.objects.create(
            user=user,
            channel=channel,
            kind="test",
            event="test",
            template="test",
            context=context,
            status="queued",
            next_attempt_at=now,
            **target,
        )  # fmt: skip
        for target in targets
    ]
    results = [runner.send_delivery(r.pk) or r for r in rows]
    for r in results:
        if r.status in ("retry", "dead"):  # a test is one synchronous attempt: no retry
            ChannelDelivery.objects.filter(pk=r.pk).update(status="failed")
            r.status = "failed"
    sent = next((r for r in results if r.status == "sent"), None)
    if sent is None:
        first = results[0]
        reason = first.error_code or first.skip_reason or "provider_error"
        if reason == "expired":
            reason = "expired_subscription"
        raise send_failed(channel, reason)
    return {"channel": channel, "status": "sent", "deliveryId": str(sent.pk), "sentAt": iso(sent.sent_at)}


# ───────────────────────── quiet hours (§6.6) ─────────────────────────


def retime_deferred(user: Any, prefs: Any) -> None:
    """New quiet hours re-time the user's `deferred` rows; outside a window (or off) they are released now."""
    from . import quiet

    now = timezone.now()
    release = quiet.release_at(quiet.Quiet.of(prefs), now, user.pk) or now
    if ChannelDelivery.objects.filter(user=user, status="deferred").update(next_attempt_at=release):
        transaction.on_commit(lambda: runner.schedule(release))


# ───────────────────────── retention (§6.10) ─────────────────────────


def purge_channels(now: dt.datetime) -> dict[str, int]:
    from .models import OtpSend, TelegramLinkFailure

    day = now - dt.timedelta(days=1)
    return {
        "channel_deliveries": ChannelDelivery.objects.filter(
            status__in=("sent", "skipped", "coalesced", "failed", "dead"), updated_at__lt=now - dt.timedelta(days=30)
        ).delete()[0],
        "telegram_links": TelegramLinkRequest.objects.exclude(status="pending").filter(updated_at__lt=day).delete()[0]
        + TelegramLinkRequest.objects.filter(status="pending", expires_at__lt=day).delete()[0],
        "sms_verifications": SmsVerification.objects.exclude(status="pending").filter(updated_at__lt=day).delete()[0]
        + SmsVerification.objects.filter(status="pending", expires_at__lt=day).delete()[0],
        "otp_sends": OtpSend.objects.filter(created_at__lt=now - dt.timedelta(days=2)).delete()[0],
        "telegram_link_failures": TelegramLinkFailure.objects.filter(created_at__lt=day).delete()[0],
        "push_subscriptions": PushSubscription.objects.filter(
            status="expired", updated_at__lt=now - dt.timedelta(days=7)
        ).delete()[0],
    }
