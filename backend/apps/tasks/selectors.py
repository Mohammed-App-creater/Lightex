"""Task reads. Lists are always scoped to a project the caller belongs to (resolved by the view)."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from django.db.models import Count, IntegerField, OuterRef, Prefetch, Q, QuerySet, Subquery, Value
from django.db.models.functions import Coalesce

from apps.common.exceptions import invalid, not_found
from apps.planning.models import Objective
from apps.projects.models import Label, ProjectMember
from apps.projects.selectors import project_for

from .models import Task


def _count(qs: QuerySet, fk: str = "task") -> Coalesce:
    sub = qs.filter(**{fk: OuterRef("pk")}).order_by().values(fk).annotate(c=Count("pk")).values("c")
    return Coalesce(Subquery(sub, output_field=IntegerField()), Value(0))


def annotated(qs: QuerySet[Task]) -> QuerySet[Task]:
    """Adds the counters the Task payload carries, using subqueries (no join fan-out)."""
    from apps.collaboration.models import Attachment, Comment

    live_subtasks = Task.objects.all()
    done_subtasks = Task.objects.filter(status__category="done").exclude(status__glyph="canceled")
    return qs.annotate(
        subtask_count=_count(live_subtasks, "parent"),
        subtask_done_count=_count(done_subtasks, "parent"),
        comment_count=_count(Comment.objects.all()),
        attachment_count=_count(Attachment.objects.filter(status="ready")),
    ).prefetch_related(
        Prefetch("objectives", queryset=Objective.objects.only("id")),
        Prefetch("labels", queryset=Label.objects.only("id")),
    )


def is_uuid(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True


def task_for(user: Any, task_id: Any, *, include_deleted: bool = False) -> Task:
    """A task the user can see (project membership required; 404 / 403 like projects)."""
    manager = Task.all_objects if include_deleted else Task.objects
    task = (
        manager.select_related("project", "status").filter(pk=task_id, project__deleted_at__isnull=True).first()
        if is_uuid(task_id)
        else None
    )
    if task is None:
        raise not_found("Task not found. It may have been deleted, or you may not have access.")
    project_for(user, task.project_id)
    return task


def task_by_key(user: Any, key: str, *, workspace: Any = None) -> Task:
    qs = Task.objects.select_related("project", "status").filter(
        key__iexact=key, project__deleted_at__isnull=True, project__workspace__deleted_at__isnull=True
    )
    if workspace is not None:
        qs = qs.filter(project__workspace=workspace)
    else:
        mine = ProjectMember.objects.filter(user_id=user.pk).values("project_id")
        qs = qs.filter(project_id__in=mine)
    task = qs.first()
    if task is None:
        raise not_found("Task not found. It may have been deleted, or you may not have access.")
    project_for(user, task.project_id)
    return task


def task_by_id_or_key(user: Any, value: str) -> Task:
    return task_for(user, value) if is_uuid(value) else task_by_key(user, value)


# ───────────────────────── list filters and sorting ─────────────────────────

SORTS: dict[str, tuple[str, Any]] = {
    # api name: (model field, sentinel for nulls or None)
    "number": ("number", None),
    "key": ("number", None),
    "title": ("title", None),
    "priority": ("priority", None),
    "dueDate": ("due_date", dt.date(9999, 12, 31)),
    "estimate": ("estimate", 10_000),
    "createdAt": ("created_at", None),
    "updatedAt": ("updated_at", None),
    "position": ("position", None),
    "type": ("type", None),
}


def _ids(values: list[str], field: str, *, allow: tuple[str, ...] = ()) -> list[str]:
    bad = [v for v in values if v not in allow and not is_uuid(v)]
    if bad:
        raise invalid({f"filter[{field}]": f"“{bad[0]}” isn’t a valid id"})
    return values


def filter_tasks(qs: QuerySet[Task], params: Any, user: Any) -> QuerySet[Task]:
    def values(key: str) -> list[str]:
        return [v for v in params.getlist(f"filter[{key}]") if v != ""]

    def nullable(field: str, key: str, model_field: str) -> None:
        nonlocal qs
        raw = _ids(values(key), key, allow=("none", "me") if key == "assignee" else ("none",))
        if not raw:
            return
        ids = [user.pk if v == "me" else v for v in raw if v != "none"]
        cond = Q(**{f"{model_field}__in": ids}) if ids else Q()
        if "none" in raw:
            cond = cond | Q(**{f"{model_field}__isnull": True}) if ids else Q(**{f"{model_field}__isnull": True})
        qs = qs.filter(cond)

    status = _ids(values("status"), "status")
    if status:
        qs = qs.filter(status_id__in=status)
    nullable("assignee", "assignee", "assignee_id")
    nullable("sprint", "sprint", "sprint_id")
    nullable("epic", "epic", "epic_id")
    nullable("milestone", "milestone", "milestone_id")
    nullable("parent", "parent", "parent_id")
    labels = _ids(values("label"), "label")
    if labels:
        qs = qs.filter(labels__id__in=labels).distinct()
    priorities = values("priority")
    if priorities:
        try:
            qs = qs.filter(priority__in=[int(p) for p in priorities])
        except ValueError as exc:
            raise invalid({"filter[priority]": "Priority is 0–4"}) from exc
    types = values("type")
    if types:
        qs = qs.filter(type__in=types)
    q = (params.get("q") or "").strip()
    if q:
        qs = qs.filter(Q(title__icontains=q) | Q(key__iexact=q) | Q(key__istartswith=q))
    return qs


def sort_spec(raw: str | None) -> list[tuple[str, bool]]:
    raw = raw or "number"
    desc = raw.startswith("-")
    name = raw[1:] if desc else raw
    if name not in SORTS:
        raise invalid({"sort": f"Sort by one of: {', '.join(SORTS)}"})
    return [(f"_sort_{SORTS[name][0]}", desc), ("id", False)]


def apply_sort_annotation(qs: QuerySet[Task], raw: str | None) -> QuerySet[Task]:
    name = (raw or "number").lstrip("-")
    field, sentinel = SORTS.get(name, SORTS["number"])
    from django.db.models import F

    expr = Coalesce(F(field), Value(sentinel)) if sentinel is not None else F(field)
    return qs.annotate(**{f"_sort_{field}": expr})
