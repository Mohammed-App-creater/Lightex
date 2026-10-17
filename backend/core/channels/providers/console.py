"""Console backends (dev): write the rendered message to the `lightex.channels` logger and succeed. The SMS backend
also logs OTPs, which is why prod settings refuse `SMS_BACKEND=console` (§2.1). Phone numbers are masked."""

from __future__ import annotations

import logging
import secrets

from ..crypto import mask
from .base import PushTarget, SendResult

logger = logging.getLogger("lightex.channels.console")


class ConsoleTelegram:
    def send_message(self, chat_id: int, text_html: str, *, button: tuple[str, str] | None) -> SendResult:
        extra = f" [{button[0]} → {button[1]}]" if button else ""
        logger.info("[telegram → chat %s] %s%s", chat_id, text_html, extra)
        return SendResult(True, provider_id=f"console-{secrets.token_hex(4)}")

    def set_webhook(self, url: str, secret: str) -> None:
        logger.info("[telegram] setWebhook %s", url)

    def delete_webhook(self) -> None:
        logger.info("[telegram] deleteWebhook")

    def webhook_info(self) -> dict:
        return {"url": "", "pending_update_count": 0}

    def get_me(self) -> dict:
        from django.conf import settings

        return {"id": 0, "is_bot": True, "username": settings.TELEGRAM_BOT_USERNAME}


class ConsoleSms:
    def send(self, to_e164: str, body: str, *, status_callback: str | None) -> SendResult:
        logger.info("[sms → %s] %s", mask(to_e164), body)
        return SendResult(True, provider_id=f"SMconsole{secrets.token_hex(8)}")


class ConsolePush:
    def send(self, sub: PushTarget, payload: bytes, *, ttl: int, urgency: str, topic: str | None) -> SendResult:
        logger.info("[push → %s] %s", sub.endpoint.split("/")[2] if "//" in sub.endpoint else "?", payload.decode())
        return SendResult(True, provider_id=f"console-{secrets.token_hex(4)}")
