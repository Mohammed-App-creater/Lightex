"""Telegram Bot API backend (docs/v2/38-telegram-sms-push.md §2.2, §6.8). Webhook in production, `getUpdates` only
for the dev `telegram_poll` command."""

from __future__ import annotations

import json
import threading
import time
from typing import Any

from django.conf import settings

from .base import HttpResponse, SendResult, http_request

COMMANDS = [
    {"command": "start", "description": "Connect this chat with a code"},
    {"command": "stop", "description": "Disconnect this chat"},
    {"command": "status", "description": "Is this chat connected?"},
    {"command": "help", "description": "What this bot does"},
]


class _Bucket:
    """Per-process token bucket: 25 messages/s per bot (§6.9)."""

    def __init__(self, rate: float = 25.0):
        self.rate = rate
        self.tokens = rate
        self.at = time.monotonic()
        self.lock = threading.Lock()

    def take(self) -> None:
        with self.lock:
            now = time.monotonic()
            self.tokens = min(self.rate, self.tokens + (now - self.at) * self.rate)
            self.at = now
            if self.tokens < 1:
                time.sleep((1 - self.tokens) / self.rate)
                self.tokens = 1
            self.tokens -= 1


class BotTelegram:
    def __init__(self) -> None:
        self.bucket = _Bucket()

    def _call(self, method: str, payload: dict[str, Any] | None = None) -> HttpResponse:
        url = f"{settings.TELEGRAM_API_BASE}/bot{settings.TELEGRAM_BOT_TOKEN}/{method}"
        body = json.dumps(payload or {}).encode()
        return http_request("POST", url, headers={"Content-Type": "application/json"}, body=body)

    def send_message(self, chat_id: int, text_html: str, *, button: tuple[str, str] | None) -> SendResult:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text_html,
            "parse_mode": "HTML",
            "link_preview_options": {"is_disabled": True},
        }
        if button is not None:
            payload["reply_markup"] = {"inline_keyboard": [[{"text": button[0], "url": button[1]}]]}
        self.bucket.take()
        return map_response(self._call("sendMessage", payload))

    def set_webhook(self, url: str, secret: str) -> None:
        res = self._call(
            "setWebhook",
            {
                "url": url,
                "secret_token": secret,
                "allowed_updates": ["message", "my_chat_member"],
                "max_connections": 10,
            },
        )
        _ensure(res, "setWebhook")
        _ensure(self._call("setMyCommands", {"commands": COMMANDS}), "setMyCommands")

    def delete_webhook(self) -> None:
        _ensure(self._call("deleteWebhook", {"drop_pending_updates": False}), "deleteWebhook")

    def webhook_info(self) -> dict:
        return _ensure(self._call("getWebhookInfo"), "getWebhookInfo")

    def get_me(self) -> dict:
        return _ensure(self._call("getMe"), "getMe")

    def get_updates(self, offset: int | None, timeout: int = 30) -> list[dict]:
        payload: dict[str, Any] = {"timeout": timeout, "allowed_updates": ["message", "my_chat_member"]}
        if offset is not None:
            payload["offset"] = offset
        return _ensure(self._call("getUpdates", payload), "getUpdates") or []


def _ensure(res: HttpResponse, method: str) -> Any:
    data = res.json() or {}
    if res.status != 200 or not data.get("ok"):
        raise RuntimeError(f"Telegram {method} failed ({res.status}): {str(data.get('description', ''))[:200]}")
    return data.get("result")


def map_response(res: HttpResponse) -> SendResult:
    data = res.json() or {}
    description = str(data.get("description", "")).lower()
    code = str(res.status)
    if res.status == 200 and data.get("ok"):
        return SendResult(True, provider_id=str((data.get("result") or {}).get("message_id", "")))
    if res.status == 0:
        return SendResult(False, reason="timeout", code="timeout")
    if res.status == 403 or (res.status == 400 and "chat not found" in description):
        return SendResult(False, permanent=True, reason="blocked", code=code)
    if res.status == 429:
        retry = (data.get("parameters") or {}).get("retry_after")
        return SendResult(False, reason="rate_limited", code=code, retry_after=int(retry) if retry else None)
    if res.status in (401, 404):
        return SendResult(False, permanent=True, reason="config_error", code=code)
    if res.status >= 500:
        return SendResult(False, reason="provider_error", code=code)
    return SendResult(False, permanent=True, reason="provider_error", code=code)
