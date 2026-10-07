"""Domain events (outbox). Services call emit() inside their transaction; once it commits, the event
is handed to Celery (inline when no broker), which turns it into notifications and emails."""

from __future__ import annotations

from typing import Any

from django.db import transaction


def emit(
    event_type: str, *, workspace: Any, actor: Any = None, project: Any = None, payload: dict | None = None
) -> Any:
    from .models import DomainEvent

    event = DomainEvent.objects.create(
        type=event_type,
        workspace_id=getattr(workspace, "pk", workspace),
        project_id=getattr(project, "pk", project),
        actor_id=getattr(actor, "pk", actor),
        payload=payload or {},
    )
    transaction.on_commit(lambda: _dispatch(event.pk))
    return event


def _dispatch(event_id: Any) -> None:
    from .tasks import process_event_task

    process_event_task.delay(str(event_id))
