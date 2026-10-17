"""Sending without Redis, and with it (docs/v2/38-telegram-sms-push.md §6.6–§6.8).

- `celery`: one task per row; a retry is `apply_async(countdown=…)`.
- `thread`: a per-process `ThreadPoolExecutor(CHANNEL_SENDER_THREADS)` plus one event-driven sweeper thread. The
  sweeper keeps `next_due` in memory and sleeps on a `Condition`: with nothing pending it issues no queries.
- `inline` (tests): rows are sent synchronously on commit.

Exactly one sender wins a row: the claim is a single conditional UPDATE. The provider call runs outside any
transaction, and its result is written in a short second one.
"""

from __future__ import annotations

import datetime as dt
import logging
import random
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from django.conf import settings
from django.db import connection, transaction
from django.db.models import F, Min, Q
from django.utils import timezone

from . import render
from .models import ChannelDelivery, PushSubscription, SmsConnection, TelegramConnection
from .providers import PushTarget, SendResult, available, get_push, get_sms, get_telegram

logger = logging.getLogger("lightex.channels")

LEASE = dt.timedelta(seconds=120)
BACKOFF = [30, 120, 600, 3600, 6 * 3600]
STALE_AFTER = dt.timedelta(hours=24)
SWEEP_LIMIT = 100
BLOCKED_COPY = "You blocked the bot in Telegram."


def mode() -> str:
    value = settings.CHANNEL_DISPATCH
    if value == "auto":
        return "celery" if settings.REDIS_URL and not settings.CELERY_TASK_ALWAYS_EAGER else "thread"
    return value


# ───────────────────────── hand-over ─────────────────────────

_pool: ThreadPoolExecutor | None = None
_pool_lock = threading.Lock()


def _executor() -> ThreadPoolExecutor:
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(settings.CHANNEL_SENDER_THREADS, thread_name_prefix="lightex-channels")
        return _pool


def _run_in_thread(delivery_id: Any) -> None:  # pragma: no cover - thread mode only
    try:
        send_delivery(delivery_id)
    except Exception:
        logger.exception("Channel delivery %s failed", delivery_id)
    finally:
        connection.close()


def submit(ids: list[Any]) -> None:
    current = mode()
    for delivery_id in ids:
        if current == "inline":
            send_delivery(delivery_id)
        elif current == "celery":
            from .tasks import send_delivery_task

            send_delivery_task.delay(str(delivery_id))
        else:  # pragma: no cover - thread mode only
            sweeper.start()
            _executor().submit(_run_in_thread, delivery_id)


def schedule(at: dt.datetime, delivery_id: Any = None) -> None:
    """A row becomes due at `at` (retry or end of quiet hours)."""
    current = mode()
    if current == "thread":  # pragma: no cover - thread mode only
        sweeper.start()
        sweeper.notify(at)
    elif current == "celery" and delivery_id is not None:
        from .tasks import send_delivery_task

        countdown = max(0, int((at - timezone.now()).total_seconds()))
        send_delivery_task.apply_async((str(delivery_id),), countdown=countdown)


# ───────────────────────── one row ─────────────────────────


def claim(delivery_id: Any) -> bool:
    now = timezone.now()
    return bool(
        ChannelDelivery.objects.filter(pk=delivery_id, status__in=("queued", "retry"), next_attempt_at__lte=now).update(
            status="sending", lease_until=now + LEASE, attempts=F("attempts") + 1, updated_at=now
        )
    )


def _utc_midnight() -> dt.datetime:
    return timezone.now().replace(hour=0, minute=0, second=0, microsecond=0)


def sms_sent_today(user_id: Any | None = None, exclude: Any = None) -> int:
    qs = ChannelDelivery.objects.filter(
        channel="sms", status__in=("sending", "sent", "retry"), created_at__gte=_utc_midnight()
    )
    if user_id is not None:
        qs = qs.filter(user_id=user_id)
    if exclude is not None:
        qs = qs.exclude(pk=exclude)
    return qs.count()


_cap_logged: dict[str, dt.date] = {}


def sms_cap_reason(user_id: Any, exclude: Any = None) -> str:
    today = timezone.now().date()
    if sms_sent_today(None, exclude) >= settings.SMS_GLOBAL_DAILY_CAP:
        if _cap_logged.get("global") != today:
            _cap_logged["global"] = today
            logger.error("Global SMS daily cap (%s) reached", settings.SMS_GLOBAL_DAILY_CAP)
        return "global_cap"
    if sms_sent_today(user_id, exclude) >= settings.SMS_USER_DAILY_CAP:
        if _cap_logged.get(str(user_id)) != today:
            _cap_logged[str(user_id)] = today
            logger.warning("SMS daily cap reached for user %s", user_id)
        return "cap"
    return ""


def recheck(d: ChannelDelivery) -> str:
    """Send-time re-checks (§6.7); returns a skip reason or ""."""
    if not d.user.is_active:
        return "stale"
    if d.kind == "event":
        n = d.notification
        if n is None:
            return "stale"
        from core.notifications.services import still_visible

        if not still_visible(n, d.user):
            return "stale"
    if not available(d.channel):
        return "unavailable"
    if d.channel == "telegram":
        if d.telegram is None:
            return "not_connected"
        if d.telegram.status != "active":
            return "blocked"
    elif d.channel == "sms":
        if d.sms is None:
            return "not_connected"
        if d.sms.status != "active":
            return "opted_out" if d.sms.status == "opted_out" else "blocked"
        if d.kind != "test" and d.workspace is not None and not d.workspace.sms_enabled:
            return "policy"
        return sms_cap_reason(d.user_id, exclude=d.pk)
    elif d.channel == "push":
        from .services import endpoint_allowed

        if d.push is None:
            return "not_connected"
        if d.push.status != "active" or not endpoint_allowed(d.push.endpoint):
            return "expired"
    return ""


def call_provider(d: ChannelDelivery) -> SendResult:
    ctx = d.context or {}
    if d.channel == "telegram":
        assert d.telegram is not None  # noqa: S101
        text, button = render.telegram(d.template, ctx)
        return get_telegram().send_message(d.telegram.chat_id, text, button=button)
    if d.channel == "sms":
        from .crypto import decrypt_phone

        assert d.sms is not None  # noqa: S101
        body = render.sms(d.template, ctx)
        callback = f"{settings.API_PUBLIC_URL}/api/v1/webhooks/twilio/status"
        return get_sms().send(decrypt_phone(d.sms.phone_enc), body, status_callback=callback)
    assert d.push is not None  # noqa: S101
    payload = render.push_payload(d.template, ctx, sent_at=timezone.now().isoformat().replace("+00:00", "Z"))
    tag = (
        f"task:{ctx['task_id']}" if ctx.get("task_id") else f"sprint:{ctx['sprint_id']}" if ctx.get("sprint_id") else ""
    )
    topic = None
    if tag:
        import base64
        import hashlib

        topic = base64.urlsafe_b64encode(hashlib.sha256(tag.encode()).digest()).decode().rstrip("=")[:32]
    urgency = "high" if d.urgent or d.template == "mentioned" else "normal"
    target = PushTarget(d.push.endpoint, d.push.p256dh, d.push.auth)
    return get_push().send(target, payload, ttl=3600 if d.kind == "test" else 86400, urgency=urgency, topic=topic)


def send_delivery(delivery_id: Any) -> ChannelDelivery | None:
    if not claim(delivery_id):
        return None
    d = (
        ChannelDelivery.objects.select_related("user", "notification", "workspace", "telegram", "sms", "push")
        .filter(pk=delivery_id)
        .first()
    )
    if d is None:  # pragma: no cover - deleted between claim and read
        return None
    reason = recheck(d)
    if reason:
        ChannelDelivery.objects.filter(pk=d.pk).update(status="skipped", skip_reason=reason, lease_until=None)
        d.status, d.skip_reason = "skipped", reason
        return d
    try:
        result = call_provider(d)
    except Exception as exc:  # a programming error: retry like a transient failure, keep the trace
        logger.exception("Channel delivery %s raised", d.pk)
        result = SendResult(False, reason="provider_error", code=type(exc).__name__[:32])
    apply_result(d, result)
    return d


# ───────────────────────── results (§6.8) ─────────────────────────

_config_logged: dict[str, float] = {}


def backoff(attempt: int, retry_after: int | None = None) -> dt.timedelta:
    base = BACKOFF[min(max(attempt, 1), len(BACKOFF)) - 1] * random.uniform(0.8, 1.2)  # noqa: S311
    return dt.timedelta(seconds=max(base, retry_after or 0))


def _connection_effect(d: ChannelDelivery, result: SendResult) -> None:
    now = timezone.now()
    if d.channel == "telegram" and d.telegram_id and result.reason == "blocked":
        TelegramConnection.objects.filter(pk=d.telegram_id).update(
            status="blocked", last_error=BLOCKED_COPY, last_error_at=now
        )
    elif d.channel == "sms" and d.sms_id and result.reason in ("opted_out", "invalid_number"):
        status = "opted_out" if result.reason == "opted_out" else "invalid"
        fields: dict[str, Any] = {"status": status, "last_error": _sms_copy(status), "last_error_at": now}
        if status == "opted_out":
            fields["opted_out_at"] = now
        SmsConnection.objects.filter(pk=d.sms_id).update(**fields)
    elif d.channel == "push" and d.push_id and result.reason == "expired_subscription":
        PushSubscription.objects.filter(pk=d.push_id).update(status="expired")


def _sms_copy(status: str) -> str:
    return "You replied STOP." if status == "opted_out" else "This number can't receive SMS."


def apply_result(d: ChannelDelivery, result: SendResult) -> None:
    now = timezone.now()
    with transaction.atomic():
        if result.ok:
            d.status, d.sent_at, d.provider_id = "sent", now, result.provider_id[:64]
            d.error_code = d.error = ""
            if d.push_id:
                PushSubscription.objects.filter(pk=d.push_id).update(last_success_at=now, failure_count=0)
        elif result.permanent:
            d.status = "failed"
            d.error_code = (result.reason or "provider_error")[:32]
            d.error = f"{result.reason} ({result.code})"[:1000]
            if result.reason == "config_error":
                key = f"{d.channel}:config"
                if time.monotonic() - _config_logged.get(key, -1e9) > 600:
                    _config_logged[key] = time.monotonic()
                    logger.error("%s provider configuration error (%s)", d.channel, result.code)
            _connection_effect(d, result)
        else:
            d.error_code = (result.reason or "provider_error")[:32]
            d.error = f"{result.reason} ({result.code})"[:1000]
            if d.attempts >= settings.CHANNEL_MAX_ATTEMPTS:
                d.status = "dead"
            else:
                d.status = "retry"
                d.next_attempt_at = now + backoff(d.attempts, result.retry_after)
            if d.push_id:
                PushSubscription.objects.filter(pk=d.push_id).update(failure_count=F("failure_count") + 1)
                PushSubscription.objects.filter(pk=d.push_id, failure_count__gte=10).update(status="expired")
        d.lease_until = None
        d.save(
            update_fields=[
                "status", "sent_at", "provider_id", "error_code", "error", "next_attempt_at", "lease_until",
                "updated_at",
            ]
        )  # fmt: skip
    if d.status == "retry":
        transaction.on_commit(lambda: schedule(d.next_attempt_at, d.pk))


# ───────────────────────── sweep ─────────────────────────


def _release(rows: list[ChannelDelivery], now: dt.datetime) -> list[Any]:
    """Due `deferred` rows → coalesce (§6.6) → `queued`. Returns the ids to send."""
    groups: dict[tuple, list[ChannelDelivery]] = defaultdict(list)
    out: list[Any] = []
    due = min(now, timezone.now())  # sendable at once, even when the sweep looks ahead (tests, cron)
    for row in rows:
        if now - row.created_at > STALE_AFTER:
            ChannelDelivery.objects.filter(pk=row.pk).update(status="skipped", skip_reason="stale")
            continue
        groups[(row.user_id, row.channel, row.telegram_id, row.sms_id, row.push_id)].append(row)
    for group in groups.values():
        if len(group) == 1:
            ChannelDelivery.objects.filter(pk=group[0].pk).update(status="queued", next_attempt_at=due)
            out.append(group[0].pk)
            continue
        group.sort(key=lambda r: r.created_at, reverse=True)
        newest = group[0]
        slug = (newest.context or {}).get("workspace_slug") or ""
        items = [
            {
                "task_key": (r.context or {}).get("task_key", ""),
                "line": render.summary_line(r.template, r.context or {}),
            }
            for r in group[:3]
        ]
        summary = ChannelDelivery.objects.create(
            user_id=newest.user_id,
            workspace_id=newest.workspace_id,
            channel=newest.channel,
            kind="summary",
            event="summary",
            telegram_id=newest.telegram_id,
            sms_id=newest.sms_id,
            push_id=newest.push_id,
            template="summary",
            context={
                "count": len(group),
                "items": items,
                "inbox_url": f"{settings.FRONTEND_URL}/{slug}/inbox" if slug else settings.FRONTEND_URL,
                "cta_url": f"{settings.FRONTEND_URL}/{slug}/inbox" if slug else settings.FRONTEND_URL,
                "workspace_slug": slug,
            },
            status="queued",
            next_attempt_at=due,
        )
        ChannelDelivery.objects.filter(pk__in=[r.pk for r in group]).update(status="coalesced", summary=summary)
        out.append(summary.pk)
    return out


def sweep(now: dt.datetime | None = None) -> tuple[list[Any], dt.datetime | None]:
    """One sweep: returns (ids now sendable, next due time of what remains)."""
    now = now or timezone.now()
    with transaction.atomic():
        rows = list(
            ChannelDelivery.objects.select_for_update(skip_locked=True)
            .filter(
                Q(status__in=("queued", "retry", "deferred"), next_attempt_at__lte=now)
                | Q(status="sending", lease_until__lt=now)
            )
            .order_by("next_attempt_at")[:SWEEP_LIMIT]
        )
        ready: list[Any] = []
        deferred = []
        for row in rows:
            if row.status == "deferred":
                deferred.append(row)
            elif row.status == "sending":
                dead = row.attempts >= settings.CHANNEL_MAX_ATTEMPTS
                ChannelDelivery.objects.filter(pk=row.pk).update(
                    status="dead" if dead else "retry", next_attempt_at=min(now, timezone.now()), lease_until=None
                )
                if not dead:
                    ready.append(row.pk)
            else:
                ready.append(row.pk)
        ready += _release(deferred, now)
    nxt = (
        ChannelDelivery.objects.filter(status__in=("queued", "retry", "deferred"))
        .exclude(pk__in=ready)
        .aggregate(m=Min("next_attempt_at"))["m"]
    )
    return ready, nxt


def sweep_and_send(now: dt.datetime | None = None) -> int:
    """`send_channel_deliveries`: one sweep, sent inline."""
    ready, _ = sweep(now)
    for delivery_id in ready:
        send_delivery(delivery_id)
    return len(ready)


class Sweeper:
    """One daemon thread per process. It sleeps until `next_due` (or until `notify()` brings it forward)."""

    def __init__(self) -> None:
        self.cond = threading.Condition()
        self.next_due: dt.datetime | None = None
        self.thread: threading.Thread | None = None
        self.started = False
        self.stopping = False

    def start(self) -> None:
        with self.cond:
            if self.thread is not None and self.thread.is_alive():
                return
            self.stopping = False
            self.next_due = timezone.now()  # one sweep at process start picks up orphaned rows
            self.thread = threading.Thread(target=self._loop, name="lightex-channels-sweeper", daemon=True)
            self.thread.start()

    def stop(self) -> None:
        with self.cond:
            self.stopping = True
            self.cond.notify_all()
        if self.thread is not None:
            self.thread.join(timeout=2)
        self.thread = None

    def notify(self, at: dt.datetime) -> None:
        with self.cond:
            if self.next_due is None or at < self.next_due:
                self.next_due = at
                self.cond.notify_all()

    def _wait(self) -> bool:
        with self.cond:
            while not self.stopping:
                if self.next_due is None:
                    self.cond.wait()
                    continue
                delay = (self.next_due - timezone.now()).total_seconds()
                if delay <= 0:
                    self.next_due = None
                    return True
                self.cond.wait(min(delay, 3600))
            return False

    def _loop(self) -> None:
        while self._wait():
            nxt = None
            try:
                ready, nxt = sweep()
                if ready:
                    if mode() == "thread":  # pragma: no cover - thread mode only
                        for delivery_id in ready:
                            _executor().submit(_run_in_thread, delivery_id)
                    else:
                        for delivery_id in ready:
                            send_delivery(delivery_id)
            except Exception:
                logger.exception("Channel sweep failed")
                nxt = timezone.now() + dt.timedelta(seconds=30)
            finally:
                connection.close()
            if nxt is not None:
                self.notify(nxt)


sweeper = Sweeper()


def start_sweeper() -> None:
    """gunicorn `post_worker_init` (thread mode only)."""
    if mode() == "thread":
        sweeper.start()
