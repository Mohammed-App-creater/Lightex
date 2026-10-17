"""Provider interfaces and their resolution from settings (docs/v2/38-telegram-sms-push.md §2.1).

Real backends never raise for HTTP outcomes: every response maps to a `SendResult` (§6.8). They raise only for
programming errors. `get_telegram()`, `get_sms()` and `get_push()` resolve the backend from settings, once per
(channel, backend) per process.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol

from django.conf import settings

logger = logging.getLogger("lightex.channels")

REASONS = (
    "blocked",
    "opted_out",
    "invalid_number",
    "expired_subscription",
    "rate_limited",
    "provider_error",
    "config_error",
    "timeout",
)


@dataclass
class SendResult:
    ok: bool
    provider_id: str = ""
    retry_after: int | None = None
    permanent: bool = False
    reason: str = ""
    code: str = ""


@dataclass
class PushTarget:
    endpoint: str
    p256dh: str
    auth: str


class TelegramProvider(Protocol):
    def send_message(self, chat_id: int, text_html: str, *, button: tuple[str, str] | None) -> SendResult: ...
    def set_webhook(self, url: str, secret: str) -> None: ...
    def get_me(self) -> dict: ...


class SmsProvider(Protocol):
    def send(self, to_e164: str, body: str, *, status_callback: str | None) -> SendResult: ...


class PushProvider(Protocol):
    def send(self, sub: PushTarget, payload: bytes, *, ttl: int, urgency: str, topic: str | None) -> SendResult: ...


# ───────────────────────── HTTP (standard library) ─────────────────────────


@dataclass
class HttpResponse:
    status: int  # 0 = timeout / network failure
    headers: dict[str, str]
    body: bytes

    def json(self) -> Any:
        try:
            return json.loads(self.body or b"null")
        except ValueError:
            return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def http_request(method: str, url: str, *, headers: dict[str, str], body: bytes | None = None) -> HttpResponse:
    req = urllib.request.Request(url, data=body, method=method, headers={"User-Agent": "Lightex-Channels/1", **headers})  # noqa: S310
    try:
        with _opener.open(req, timeout=settings.CHANNEL_HTTP_TIMEOUT) as res:
            return HttpResponse(res.status, {k.lower(): v for k, v in res.headers.items()}, res.read(1_000_000))
    except urllib.error.HTTPError as exc:
        return HttpResponse(exc.code, {k.lower(): v for k, v in (exc.headers or {}).items()}, exc.read(1_000_000))
    except (OSError, ValueError) as exc:
        logger.warning("channel HTTP %s %s failed: %s", method, url.split("?")[0][:80], type(exc).__name__)
        return HttpResponse(0, {}, b"")


def retry_after_header(headers: dict[str, str]) -> int | None:
    value = headers.get("retry-after", "")
    return int(value) if value.isdigit() else None


# ───────────────────────── resolution ─────────────────────────

_instances: dict[tuple[str, str], Any] = {}


def backend(channel: str) -> str:
    return {
        "telegram": settings.TELEGRAM_BACKEND,
        "sms": settings.SMS_BACKEND,
        "push": settings.WEB_PUSH_BACKEND,
    }[channel]


def available(channel: str) -> bool:
    if channel == "email":
        return True
    return backend(channel) != "disabled"


def _get(channel: str) -> Any:
    name = backend(channel)
    key = (channel, name)
    if key not in _instances:
        from . import console, fake, telegram, twilio, webpush

        table: dict[tuple[str, str], Any] = {
            ("telegram", "bot"): telegram.BotTelegram,
            ("telegram", "console"): console.ConsoleTelegram,
            ("telegram", "fake"): fake.FakeTelegram,
            ("sms", "twilio"): twilio.TwilioSms,
            ("sms", "console"): console.ConsoleSms,
            ("sms", "fake"): fake.FakeSms,
            ("push", "webpush"): webpush.WebPush,
            ("push", "console"): console.ConsolePush,
            ("push", "fake"): fake.FakePush,
        }
        if key not in table:
            raise RuntimeError(f"{channel} channel is disabled")
        _instances[key] = table[key]()
    return _instances[key]


def get_telegram() -> Any:
    return _get("telegram")


def get_sms() -> Any:
    return _get("sms")


def get_push() -> Any:
    return _get("push")
