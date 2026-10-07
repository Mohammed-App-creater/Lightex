"""Sprint writes: create, edit, delete (planned only), start, complete with carry-over."""

from __future__ import annotations

import datetime as dt
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import F, Max, Q, Sum
from django.utils import timezone

from apps.audit.services import change, record
from apps.common.exceptions import conflict, invalid
from apps.notifications.events import emit
from apps.tasks.models import Task

from .models import Sprint, SprintScopeChange
from .selectors import _uuid

SPRINT_LENGTH_DAYS = 14


def _date(value: Any, field: str) -> dt.date | None:
    if value in (None, ""):
        return None
    try:
        return dt.date.fromisoformat(str(value))
    except ValueError as exc:
        raise invalid({field: "Pick a date"}) from exc


def _audit(sprint: Sprint, actor: Any, action: str, changes: list | None = None, data: dict | None = None) -> None:
    record(
        workspace=sprint.project.workspace_id,
        project=sprint.project_id,
        actor=actor,
        action=action,
        target=sprint.name,
        entity_id=sprint.pk,
        changes=changes,
        data=data,
    )


def _open_tasks(sprint: Sprint):
    """Live tasks in the sprint that are neither done nor canceled."""
    return Task.objects.filter(sprint=sprint).exclude(status__category="done")


@transaction.atomic
def create_sprint(actor: Any, project: Any, data: dict[str, Any]) -> Sprint:
    number = (Sprint.objects.filter(project=project).aggregate(m=Max("number"))["m"] or 0) + 1
    last = Sprint.objects.filter(project=project).order_by("-end_date").first()
    start = _date(data.get("startDate"), "startDate") or (
        last.end_date + dt.timedelta(days=1) if last else timezone.now().date()
    )
    end = _date(data.get("endDate"), "endDate") or start + dt.timedelta(days=SPRINT_LENGTH_DAYS - 1)
    if end < start:
        raise invalid({"endDate": "End must be after start"})
    name = str(data.get("name") or "").strip()[:60] or f"Sprint {number}"
    try:
        with transaction.atomic():
            sprint = Sprint.objects.create(
                project=project,
                name=name,
                number=number,
                goal=str(data.get("goal") or "")[:200],
                start_date=start,
                end_date=end,
            )
    except IntegrityError as exc:  # two creates raced for the same number
        raise conflict("conflict", "Another sprint was just created. Try again.") from exc
    _audit(sprint, actor, "sprint.created", [change("Name", None, name), change("Dates", None, f"{start} – {end}")])
    return sprint


@transaction.atomic
def update_sprint(actor: Any, sprint: Sprint, data: dict[str, Any]) -> Sprint:
    changes = []
    if "name" in data:
        name = str(data.get("name") or "").strip()[:60]
        if name and name != sprint.name:
            changes.append(change("Name", sprint.name, name))
            sprint.name = name
    if "goal" in data:
        goal = str(data.get("goal") or "")[:200]
        if goal != sprint.goal:
            changes.append(change("Goal", sprint.goal, goal, "text"))
            sprint.goal = goal
    for field, attr in (("startDate", "start_date"), ("endDate", "end_date")):
        if field in data:
            value = _date(data.get(field), field)
            if value is None:
                raise invalid({field: "Pick a date"})
            if value != getattr(sprint, attr):
                changes.append(change("Start" if attr == "start_date" else "End", getattr(sprint, attr), value))
                setattr(sprint, attr, value)
    if sprint.end_date < sprint.start_date:
        raise invalid({"endDate": "End must be after start"})
    sprint.save()
    if changes:
        _audit(sprint, actor, "sprint.updated", changes)
    return sprint


@transaction.atomic
def delete_sprint(actor: Any, sprint: Sprint) -> None:
    if sprint.state != "planned":
        raise conflict("sprint_not_planned", "Only planned sprints can be deleted.")
    Task.all_objects.filter(sprint=sprint).update(sprint=None, version=F("version") + 1, updated_at=timezone.now())
    _audit(sprint, actor, "sprint.deleted")
    sprint.delete()


@transaction.atomic
def start_sprint(actor: Any, sprint: Sprint, data: dict[str, Any]) -> Sprint:
    sprint = Sprint.objects.select_for_update().select_related("project").get(pk=sprint.pk)
    if sprint.state != "planned":
        raise conflict("sprint_not_planned", "Only planned sprints can be started.")
    if Sprint.objects.filter(project=sprint.project, state="active").exists():
        raise conflict("sprint_active", "Complete the active sprint first.")
    tasks = Task.objects.filter(sprint=sprint).exclude(status__glyph="canceled")
    if not tasks.exists():
        raise conflict("sprint_empty", "Add tasks to the sprint before starting it.")
    start = _date(data.get("startDate"), "startDate")
    end = _date(data.get("endDate"), "endDate")
    if start:
        sprint.start_date = start
    if end:
        sprint.end_date = end
    if sprint.end_date < sprint.start_date:
        raise invalid({"endDate": "End must be after start"})
    if "goal" in data:
        sprint.goal = str(data.get("goal") or "")[:200]
    sprint.state = "active"
    sprint.started_at = timezone.now()
    sprint.committed_points = tasks.aggregate(p=Sum("estimate"))["p"] or 0
    sprint.committed_count = tasks.count()
    try:
        with transaction.atomic():
            sprint.save()
    except IntegrityError as exc:  # the partial unique index caught a concurrent start
        raise conflict("sprint_active", "Complete the active sprint first.") from exc
    _audit(sprint, actor, "sprint.started", data={"sprint": sprint.name})
    emit(
        "sprint_started",
        workspace=sprint.project.workspace_id,
        project=sprint.project,
        actor=actor,
        payload={"sprintId": str(sprint.pk)},
    )
    return sprint


@transaction.atomic
def complete_sprint(actor: Any, sprint: Sprint, move_open_to: Any) -> Sprint:
    sprint = Sprint.objects.select_for_update().select_related("project").get(pk=sprint.pk)
    if sprint.state != "active":
        raise conflict("sprint_not_active", "Only the active sprint can be completed.")
    target = None
    destination = move_open_to or "backlog"
    if destination != "backlog":
        target = (
            Sprint.objects.filter(pk=destination, project=sprint.project, state="planned").first()
            if _uuid(destination)
            else None
        )
        if target is None:
            raise invalid({"moveOpenTasksTo": "Pick a planned sprint or the backlog"})
    open_tasks = _open_tasks(sprint)
    open_ids = list(open_tasks.values_list("pk", flat=True))
    total = Task.objects.filter(sprint=sprint).exclude(status__glyph="canceled").count()
    done = Task.objects.filter(sprint=sprint, status__category="done").exclude(status__glyph="canceled").count()
    now = timezone.now()
    # Carry-over leaves the sprint at completion; recorded so its burndown can be replayed later.
    SprintScopeChange.objects.bulk_create(
        [
            SprintScopeChange(sprint=sprint, task_id=tid, kind="removed", estimate=est, actor=actor, at=now)
            for tid, est in open_tasks.values_list("pk", "estimate")
        ]
    )
    Task.objects.filter(Q(pk__in=open_ids) | Q(parent_id__in=open_ids)).update(
        sprint=target, version=F("version") + 1, updated_at=now
    )
    sprint.state = "completed"
    sprint.completed_at = now
    sprint.save(update_fields=["state", "completed_at", "updated_at"])
    _audit(sprint, actor, "sprint.completed", data={"sprint": sprint.name, "moved": len(open_ids)})
    emit(
        "sprint_completed",
        workspace=sprint.project.workspace_id,
        project=sprint.project,
        actor=actor,
        payload={
            "sprintId": str(sprint.pk),
            "carried": len(open_ids),
            "completed": done,
            "total": total,
            "nextSprintId": str(target.pk) if target else None,
        },
    )
    return sprint
