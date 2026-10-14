"""Fake backends (tests): record every call in `outbox` and can be scripted with `fail_next(...)`."""

from __future__ import annotations

import itertools
from typing import Any

from .base import PushTarget, SendResult

_ids = itertools.count(1)


class _Fake:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.outbox: list[dict[str, Any]] = []
        self._failures: list[SendResult] = []

    def fail_next(
        self, reason: str = "provider_error", *, permanent: bool = False, retry_after: int | None = None, code: str = ""
    ) -> None:
        if retry_after and reason == "provider_error":
            reason = "rate_limited"
        result = SendResult(False, reason=reason, permanent=permanent, retry_after=retry_after, code=code or reason)
        self._failures.append(result)

    def _result(self, prefix: str) -> SendResult:
        if self._failures:
            return self._failures.pop(0)
        return SendResult(True, provider_id=f"{prefix}{next(_ids)}")


class FakeTelegram(_Fake):
    def reset(self) -> None:
        super().reset()
        self.webhook: dict[str, str] | None = None

    def send_message(self, chat_id: int, text_html: str, *, button: tuple[str, str] | None) -> SendResult:
        self.outbox.append({"chat_id": chat_id, "text": text_html, "button": button})
        return self._result("")

    def set_webhook(self, url: str, secret: str) -> None:
        self.webhook = {"url": url, "secret": secret}

    def delete_webhook(self) -> None:
        self.webhook = None

    def webhook_info(self) -> dict:
        return {"url": (self.webhook or {}).get("url", ""), "pending_update_count": 0}

    def get_me(self) -> dict:
        from django.conf import settings

        return {"id": 1, "is_bot": True, "username": settings.TELEGRAM_BOT_USERNAME}

    @staticmethod
    def fake_update(
        text: str = "",
        chat_id: int = 999000,
        *,
        username: str | None = "devbot_user",
        first_name: str = "Dev",
        chat_type: str = "private",
    ) -> dict:
        user: dict[str, Any] = {"id": chat_id, "is_bot": False, "first_name": first_name}
        if username:
            user["username"] = username
        return {
            "update_id": next(_ids),
            "message": {
                "message_id": next(_ids),
                "from": user,
                "chat": {"id": chat_id, "type": chat_type},
                "text": text,
            },
        }


class FakeSms(_Fake):
    def send(self, to_e164: str, body: str, *, status_callback: str | None) -> SendResult:
        self.outbox.append({"to": to_e164, "body": body, "status_callback": status_callback})
        return self._result("SMfake")


class FakePush(_Fake):
    def send(self, sub: PushTarget, payload: bytes, *, ttl: int, urgency: str, topic: str | None) -> SendResult:
        self.outbox.append(
            {"endpoint": sub.endpoint, "payload": payload, "ttl": ttl, "urgency": urgency, "topic": topic}
        )
        return self._result("push-")
