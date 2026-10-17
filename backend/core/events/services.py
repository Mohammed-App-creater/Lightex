"""Domain events (outbox).

`emit()` writes the row inside the caller's transaction; once it commits, the event is handed to Celery (inline when
no worker is configured), which calls every matching handler. `process_event()` runs the handlers in one transaction
and marks the row processed; a failure rolls the handlers back and records `attempts` and `error`, so the
`process_outbox` command can retry it safely (handlers are idempotent).
"""

from __future__ import annotations

import logging
from typing import Any

from django.db import transaction
from django.db.models import F
from django.utils import timezone

from .models import DomainEvent
from .registry import handlers_for

logger = logging.getLogger("lightex.events")


def emit(
    event_type: str,
    *,
    workspace: Any,
    target_type: str = "",
    target_id: Any = None,
    actor: Any = None,
    payload: dict | None = None,
) -> DomainEvent:
    event = DomainEvent.objects.create(
        type=event_type,
        workspace_id=getattr(workspace, "pk", workspace),
        target_type=target_type or "",
        target_id=getattr(target_id, "pk", target_id),
        actor_id=getattr(actor, "pk", actor),
        payload=payload or {},
    )
    transaction.on_commit(lambda: dispatch(event.pk))
    return event


def dispatch(event_id: Any) -> None:
    from .tasks import process_event_task

    process_event_task.delay(str(event_id))


def process_event(event_id: Any) -> bool:
    """Processes one event exactly once. Returns True if it was handled now."""
    try:
        with transaction.atomic():
            event = (
                DomainEvent.objects.select_for_update(skip_locked=True, of=("self",))
                .select_related("actor")
                .filter(pk=event_id, processed_at__isnull=True)
                .first()
            )
            if event is None:
                return False
            for entry in handlers_for(event.type):
                entry.handler(event)
            event.processed_at = timezone.now()
            event.attempts += 1
            event.error = ""
            event.save(update_fields=["processed_at", "attempts", "error", "updated_at"])
        return True
    except Exception as exc:
        logger.exception("Processing event %s failed", event_id)
        DomainEvent.objects.filter(pk=event_id).update(error=str(exc)[:2000], attempts=F("attempts") + 1)
        return False


def pending(max_attempts: int = 5) -> list[Any]:
    """Unprocessed events still worth retrying, oldest first."""
    return list(
        DomainEvent.objects.filter(processed_at__isnull=True, attempts__lt=max_attempts)
        .order_by("created_at")
        .values_list("pk", flat=True)
    )
