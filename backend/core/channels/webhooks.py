"""Webhooks H1–H3 (docs/v2/38-telegram-sms-push.md §5.12, §7.3).

The Telegram handler answers the bot commands in the webhook response itself (`{"method": "sendMessage", …}`), and
`telegram_poll` feeds `handle_update()` the same updates in development. Twilio requests are verified with
`X-Twilio-Signature` over `API_PUBLIC_URL` + path + the sorted form parameters.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import logging
import re
from typing import Any

from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from django.utils import timezone

from . import crypto, dispatch
from .models import ChannelDelivery, SmsConnection, TelegramConnection, TelegramLinkFailure, TelegramLinkRequest
from .services import CODE_ALPHABET, normalize_code

logger = logging.getLogger("lightex.channels.webhooks")

MAX_FAILURES = 5
CONNECTED = "Connected to Lightex. Notifications for your account will arrive here. Send /stop to disconnect."
DIDNT_WORK = (
    "That code didn't work. Codes expire after 10 minutes. Open Lightex → Settings → Notifications for a new one."
)
STATUS_ON = "This chat is connected to Lightex."
STATUS_OFF = "Not connected. In Lightex open Settings → Notifications → Telegram → Connect."
STOPPED = "Disconnected. You won't get Lightex notifications here."
NO_REPLIES = "Replies aren't supported yet. Use the button to open the task in Lightex."
HELP = (
    "Lightex sends your notifications here.\n/start CODE · connect this chat\n/status · is this chat connected?\n"
    "/stop · disconnect this chat"
)
BLOCKED_COPY = "You blocked the bot in Telegram."
_CODE = re.compile(f"[{CODE_ALPHABET}]{{6}}")


# ───────────────────────── Telegram (H1) ─────────────────────────


def telegram_secret_ok(header: str | None) -> bool:
    secret = settings.TELEGRAM_WEBHOOK_SECRET
    return bool(secret) and hmac.compare_digest((header or "").encode(), secret.encode())


def _reply(chat_id: int, text: str) -> dict[str, Any]:
    return {"method": "sendMessage", "chat_id": chat_id, "text": text}


def _silenced(chat_id: int) -> bool:
    since = timezone.now() - dt.timedelta(hours=1)
    return TelegramLinkFailure.objects.filter(chat_id=chat_id, created_at__gte=since).count() >= MAX_FAILURES


def _link(chat_id: int, sender: dict[str, Any], *, token: str = "", code: str = "") -> dict[str, Any]:
    if _silenced(chat_id):
        return {}
    now = timezone.now()
    with transaction.atomic():
        qs = TelegramLinkRequest.objects.select_for_update().filter(status="pending", expires_at__gt=now)
        if token:
            link = qs.filter(start_hash=crypto.sha256(token)).first()
        else:
            link = qs.filter(code_hash=crypto.secret_hash("lightex.tglink", code)).first()
        if link is None:
            TelegramLinkFailure.objects.create(chat_id=chat_id)
            return _reply(chat_id, DIDNT_WORK)
        conn, _ = TelegramConnection.objects.update_or_create(
            user_id=link.user_id,
            defaults={
                "chat_id": chat_id,
                "username": (sender.get("username") or None),
                "first_name": str(sender.get("first_name") or "")[:64],
                "status": "active",
                "connected_at": now,
                "last_error": None,
                "last_error_at": None,
            },
        )
        link.status, link.linked_at, link.connection = "linked", now, conn
        link.save(update_fields=["status", "linked_at", "connection", "updated_at"])
    return _reply(chat_id, CONNECTED)


def _message(msg: dict[str, Any]) -> dict[str, Any]:
    chat = msg.get("chat") or {}
    chat_id = chat.get("id")
    if not isinstance(chat_id, int):
        return {}
    if chat.get("type") != "private":
        return _reply(chat_id, f"I only work in a private chat. Open t.me/{settings.TELEGRAM_BOT_USERNAME}.")
    sender = msg.get("from") or {}
    if sender:
        TelegramConnection.objects.filter(chat_id=chat_id).update(
            username=sender.get("username") or None, first_name=str(sender.get("first_name") or "")[:64]
        )
    text = str(msg.get("text") or "").strip()
    command, _, arg = text.partition(" ")
    command = command.split("@")[0].lower()
    arg = arg.strip()
    if command == "/start":
        if not arg:
            return _status(chat_id)
        if arg.startswith("lx_"):
            return _link(chat_id, sender, token=arg)
        return _link(chat_id, sender, code=normalize_code(arg))
    if command == "/stop":
        TelegramConnection.objects.filter(chat_id=chat_id).delete()
        return _reply(chat_id, STOPPED)
    if command == "/status":
        return _status(chat_id)
    if command == "/help":
        return _reply(chat_id, HELP)
    code = normalize_code(text)
    if _CODE.fullmatch(code):
        return _link(chat_id, sender, code=code)
    return _reply(chat_id, NO_REPLIES)


def _status(chat_id: int) -> dict[str, Any]:
    linked = TelegramConnection.objects.filter(chat_id=chat_id, status="active").exists()
    return _reply(chat_id, STATUS_ON if linked else STATUS_OFF)


def _chat_member(update: dict[str, Any]) -> None:
    chat_id = (update.get("chat") or {}).get("id")
    status = (update.get("new_chat_member") or {}).get("status")
    if not isinstance(chat_id, int):
        return
    if status == "kicked":
        TelegramConnection.objects.filter(chat_id=chat_id).update(
            status="blocked", last_error=BLOCKED_COPY, last_error_at=timezone.now()
        )
    elif status == "member":
        TelegramConnection.objects.filter(chat_id=chat_id, status="blocked").update(
            status="active", last_error=None, last_error_at=None
        )


def handle_update(update: dict[str, Any]) -> dict[str, Any]:
    """One Telegram update → the reply method call ({} for none). Idempotent."""
    update_id = update.get("update_id")
    if update_id is not None and not cache.add(f"tg_update:{update_id}", 1, timeout=600):
        return {}
    if isinstance(update.get("message"), dict):
        return _message(update["message"])
    if isinstance(update.get("my_chat_member"), dict):
        _chat_member(update["my_chat_member"])
    return {}


# ───────────────────────── Twilio (H2, H3) ─────────────────────────

STOP_WORDS = {"STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"}
START_WORDS = {"START", "UNSTOP", "YES"}
UNREACHABLE = {"30003", "30005", "30006"}
TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>'


def twilio_signature(path: str, params: dict[str, str]) -> str:
    data = settings.API_PUBLIC_URL + path + "".join(k + params[k] for k in sorted(params))
    digest = hmac.new(settings.TWILIO_AUTH_TOKEN.encode(), data.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def twilio_signature_ok(path: str, params: dict[str, str], header: str | None) -> bool:
    if not settings.TWILIO_AUTH_TOKEN or not header:
        return False
    return hmac.compare_digest(twilio_signature(path, params).encode(), header.encode())


def twilio_inbound(params: dict[str, str]) -> None:
    sender = params.get("From", "")
    if not sender:
        return
    conns = SmsConnection.objects.filter(phone_hash=crypto.phone_hash(sender))
    opt = (params.get("OptOutType") or "").upper()
    word = (params.get("Body") or "").strip().upper()
    now = timezone.now()
    if opt == "STOP" or word in STOP_WORDS:
        with transaction.atomic():
            users = list(conns.values_list("user_id", flat=True))
            conns.update(status="opted_out", opted_out_at=now, last_error="You replied STOP.", last_error_at=now)
            dispatch.skip_pending(users, "sms", "opted_out")
    elif opt == "START" or word in START_WORDS:
        conns.filter(status="opted_out").update(status="active", opted_out_at=None, last_error=None)


def twilio_status(params: dict[str, str]) -> None:
    sid = params.get("MessageSid", "")
    status = params.get("MessageStatus", "")
    if not sid or status not in ("undelivered", "failed"):
        return
    delivery = ChannelDelivery.objects.filter(channel="sms", provider_id=sid).first()
    if delivery is None:
        return
    code = str(params.get("ErrorCode") or "")
    delivery.error_code = code[:32]
    delivery.error = f"{status} ({code})"
    delivery.save(update_fields=["error_code", "error", "updated_at"])
    if delivery.sms_id is None:
        return
    now = timezone.now()
    if code == "21610":
        SmsConnection.objects.filter(pk=delivery.sms_id).update(
            status="opted_out", opted_out_at=now, last_error="You replied STOP.", last_error_at=now
        )
    elif code in UNREACHABLE:
        recent = ChannelDelivery.objects.filter(
            sms_id=delivery.sms_id, error_code__in=UNREACHABLE, updated_at__gte=now - dt.timedelta(days=7)
        ).count()
        if recent >= 3:
            SmsConnection.objects.filter(pk=delivery.sms_id).update(
                status="invalid", last_error="This number can't receive SMS.", last_error_at=now
            )
