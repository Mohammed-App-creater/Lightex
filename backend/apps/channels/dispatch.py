"""Fan-out from the outbox (docs/v2/38-telegram-sms-push.md §6.1, §6.2).

`notifications.handlers.deliver()` calls `wanted()` and then `enqueue()` inside `process_event`'s transaction. Rows
are handed to the runner on commit, so a rolled-back event sends nothing and a crash after commit leaves `queued`
rows for the sweeper.
"""

from __future__ import annotations

import logging
from typing import Any

from django.db import transaction
from django.utils import timezone

from . import quiet
from .models import ChannelDelivery, PushSubscription, SmsConnection, TelegramConnection
from .providers import available

logger = logging.getLogger("lightex.channels")

EXTERNAL = ("telegram", "sms", "push")
EVENTS = ("assigned", "mentioned", "status_change", "comment", "due_soon", "sprint_started")
_unavailable_logged: set[str] = set()


def wanted(recipient: Any, prefs: Any, pref: str | None, event: Any = None) -> list[str]:
    """Channels switched on for this event (§6.2 #1). `access`, `import` and `sprint_completed` never fan out."""
    if pref not in EVENTS:
        return []
    row = (prefs.events or {}).get(pref) or {}
    return [c for c in EXTERNAL if row.get(c)]


def _targets(user: Any, channel: str, workspace: Any) -> list[dict[str, Any]]:
    """One dict of row fields per target: `{}` extra fields for a usable target, or a `skipped` reason."""
    if not available(channel):
        if channel not in _unavailable_logged:
            _unavailable_logged.add(channel)
            logger.info("%s channel is unavailable on this server; deliveries are skipped", channel)
        return [{"status": "skipped", "skip_reason": "unavailable"}]
    if channel == "telegram":
        tg = TelegramConnection.objects.filter(user=user).first()
        if tg is None:
            return []
        if tg.status != "active":
            return [{"telegram": tg, "status": "skipped", "skip_reason": "blocked"}]
        return [{"telegram": tg}]
    if channel == "sms":
        sms = SmsConnection.objects.filter(user=user).first()
        if sms is None:
            return []
        if sms.status != "active":
            reason = "opted_out" if sms.status == "opted_out" else "blocked"
            return [{"sms": sms, "status": "skipped", "skip_reason": reason}]
        if workspace is not None and not workspace.sms_enabled:
            return [{"sms": sms, "status": "skipped", "skip_reason": "policy"}]
        return [{"sms": sms}]
    subs = list(PushSubscription.objects.filter(user=user).order_by("-last_seen_at"))
    active = [s for s in subs if s.status == "active"]
    if active:
        return [{"push": s} for s in active]
    if subs:
        return [{"push": subs[0], "status": "skipped", "skip_reason": "expired"}]
    return []


def enqueue(
    notification: Any,
    recipient: Any,
    prefs: Any,
    channels: list[str],
    *,
    template: str,
    context: dict[str, Any] | None,
    urgent: bool,
) -> list[ChannelDelivery]:
    now = timezone.now()
    workspace = notification.workspace
    q = quiet.Quiet.of(prefs)
    release = None if (urgent and prefs.quiet_urgent_bypass) else quiet.release_at(q, now, recipient.pk)
    rows = []
    for channel in channels:
        for target in _targets(recipient, channel, workspace):
            status = target.pop("status", "deferred" if release else "queued")
            rows.append(
                ChannelDelivery(
                    user=recipient,
                    workspace=workspace,
                    channel=channel,
                    kind="event",
                    notification=notification,
                    event=template,
                    template=template,
                    context=context or {},
                    urgent=urgent,
                    status=status,
                    next_attempt_at=release if status == "deferred" and release else now,
                    **target,
                )
            )
    if not rows:
        return []
    created = ChannelDelivery.objects.bulk_create(rows, ignore_conflicts=True)
    queued = [r.pk for r in created if r.status == "queued"]
    deferred = [r.next_attempt_at for r in created if r.status == "deferred"]

    def hand_over() -> None:
        from . import runner

        if queued:
            runner.submit(queued)
        if deferred:
            runner.schedule(min(deferred))

    transaction.on_commit(hand_over)
    return created


def skip_pending(user_ids: Any, channel: str, reason: str) -> int:
    return ChannelDelivery.objects.filter(
        user_id__in=list(user_ids), channel=channel, status__in=ChannelDelivery.PENDING
    ).update(status="skipped", skip_reason=reason, updated_at=timezone.now())
