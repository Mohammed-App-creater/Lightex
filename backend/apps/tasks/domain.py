"""Task rules shared by several services: status transitions and their side effects."""

from __future__ import annotations

from typing import Any

from django.utils import timezone

from .models import Task, TaskStatusHistory


def is_done(status: Any) -> bool:
    """Counts as completed work (canceled is in the done category but is not completed)."""
    return status.category == "done" and status.glyph != "canceled"


def apply_status(task: Task, status: Any, actor: Any, *, at: Any = None) -> bool:
    """Moves `task` to `status` (unsaved) and writes TaskStatusHistory. Returns True if it changed.

    Entering the done category sets completed_at (canceled excepted); leaving it clears it.
    The first move into an in-progress status sets started_at (cycle time starts there).
    """
    if task.status_id == status.pk:
        return False
    at = at or timezone.now()
    previous = task.status if task.status_id else None
    task.status = status
    if is_done(status):
        task.completed_at = task.completed_at or at
    else:
        task.completed_at = None
    if status.category == "in_progress" and task.started_at is None:
        task.started_at = at
    if task.pk:
        TaskStatusHistory.objects.create(
            task=task,
            from_status=previous,
            to_status=status,
            from_category=previous.category if previous else None,
            to_category=status.category,
            changed_by=actor,
            at=at,
        )
    return True


def initial_history(task: Task, actor: Any, *, at: Any = None) -> None:
    """History row for a newly created task (from nothing to its first status)."""
    TaskStatusHistory.objects.create(
        task=task,
        from_status=None,
        to_status=task.status,
        from_category=None,
        to_category=task.status.category,
        changed_by=actor,
        at=at or task.created_at,
    )
