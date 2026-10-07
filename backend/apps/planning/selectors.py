"""Planning reads. Progress is computed here from live, non-canceled tasks; it is never stored.

done  = tasks in a done-category status other than canceled
total = live tasks other than canceled
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from django.db.models import Count, IntegerField, Q, QuerySet, Sum
from django.db.models.functions import Coalesce
from django.utils import timezone

from apps.common.exceptions import not_found
from apps.projects.selectors import project_for

from .models import Epic, Milestone, Objective, Sprint


def _uuid(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True


def _progress_annotations(prefix: str = "tasks") -> dict[str, Any]:
    live = Q(**{f"{prefix}__deleted_at__isnull": True}) & ~Q(**{f"{prefix}__status__glyph": "canceled"})
    done = live & Q(**{f"{prefix}__status__category": "done"})
    return {
        "p_total": Count(prefix, filter=live, distinct=True),
        "p_done": Count(prefix, filter=done, distinct=True),
    }


def progress(done: int, total: int) -> dict[str, int]:
    return {"done": done, "total": total, "percent": round(done * 100 / total) if total else 0}


def expected_percent(start: dt.date, due: dt.date, today: dt.date | None = None) -> int:
    """Share of the start→due window elapsed today (0–100)."""
    today = today or timezone.now().date()
    if due <= start:
        return 100 if today >= due else 0
    elapsed = (today - start).days / (due - start).days
    return round(min(1.0, max(0.0, elapsed)) * 100)


def objectives_of(project: Any) -> QuerySet[Objective]:
    return project.objectives.annotate(**_progress_annotations()).order_by("created_at")


def milestones_of(project: Any) -> QuerySet[Milestone]:
    return project.milestones.annotate(**_progress_annotations()).order_by("due_date", "created_at")


def epics_of(project: Any) -> QuerySet[Epic]:
    return project.epics.annotate(**_progress_annotations()).order_by("created_at")


def sprints_of(project: Any) -> QuerySet[Sprint]:
    live = Q(tasks__deleted_at__isnull=True) & ~Q(tasks__status__glyph="canceled")
    done = live & Q(tasks__status__category="done")
    return project.sprints.annotate(
        **_progress_annotations(),
        p_points=Coalesce(Sum("tasks__estimate", filter=live), 0, output_field=IntegerField()),
        p_done_points=Coalesce(Sum("tasks__estimate", filter=done), 0, output_field=IntegerField()),
    ).order_by("number")


def _scoped(model: Any, user: Any, pk: Any, label: str) -> Any:
    obj = (
        model.objects.select_related("project").filter(pk=pk, project__deleted_at__isnull=True).first()
        if _uuid(pk)
        else None
    )
    if obj is None:
        raise not_found(f"{label} not found.")
    project_for(user, obj.project_id)  # 404 for other workspaces, 403 for non-members
    return obj


def objective_for(user: Any, pk: Any) -> Objective:
    return _scoped(Objective, user, pk, "Objective")


def milestone_for(user: Any, pk: Any) -> Milestone:
    return _scoped(Milestone, user, pk, "Milestone")


def epic_for(user: Any, pk: Any) -> Epic:
    return _scoped(Epic, user, pk, "Epic")


def sprint_for(user: Any, pk: Any) -> Sprint:
    return _scoped(Sprint, user, pk, "Sprint")


def with_progress(obj: Any) -> Any:
    """Re-reads one planning object with its progress annotations."""
    model = type(obj)
    if model is Sprint:
        return sprints_of(obj.project).get(pk=obj.pk)
    return model.objects.filter(pk=obj.pk).annotate(**_progress_annotations()).get()
