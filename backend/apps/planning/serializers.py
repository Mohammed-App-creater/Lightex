"""Planning payloads (Objective, Milestone, Epic, Sprint) with computed progress."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers

from apps.common.utils import iso

from .models import Epic, Milestone, Objective, Sprint
from .selectors import expected_percent, progress


def _id(value: Any) -> str | None:
    return str(value) if value else None


def _progress(obj: Any) -> dict[str, int]:
    return progress(getattr(obj, "p_done", 0) or 0, getattr(obj, "p_total", 0) or 0)


def objective_data(o: Objective) -> dict[str, Any]:
    task_ids = [str(t) for t in o.tasks.filter(deleted_at__isnull=True).values_list("id", flat=True)]
    return {
        "id": str(o.pk),
        "projectId": str(o.project_id),
        "title": o.title,
        "description": o.description,
        "ownerId": _id(o.owner_id),
        "quarter": o.quarter,
        "dueDate": iso(o.due_date),
        "status": o.status,
        "taskIds": task_ids,
        "progress": _progress(o),
        "createdAt": iso(o.created_at),
    }


def milestone_data(m: Milestone) -> dict[str, Any]:
    base = _progress(m)
    completed = m.completed_at is not None
    percent = 100 if completed else base["percent"]
    expected = expected_percent(m.start_date, m.due_date)
    return {
        "id": str(m.pk),
        "projectId": str(m.project_id),
        "name": m.name,
        "description": m.description,
        "ownerId": _id(m.owner_id),
        "startDate": iso(m.start_date),
        "dueDate": iso(m.due_date),
        "completedAt": iso(m.completed_at),
        "taskIds": [str(t) for t in m.tasks.filter(deleted_at__isnull=True).values_list("id", flat=True)],
        "progress": {**base, "percent": percent, "expected": expected, "atRisk": not completed and percent < expected},
    }


def epic_data(e: Epic) -> dict[str, Any]:
    return {
        "id": str(e.pk),
        "projectId": str(e.project_id),
        "name": e.name,
        "description": e.description,
        "hue": e.hue,
        "ownerId": _id(e.owner_id),
        "milestoneId": _id(e.milestone_id),
        "archivedAt": iso(e.archived_at),
        "progress": _progress(e),
    }


def sprint_data(s: Sprint) -> dict[str, Any]:
    return {
        "id": str(s.pk),
        "projectId": str(s.project_id),
        "name": s.name,
        "number": s.number,
        "goal": s.goal,
        "startDate": iso(s.start_date),
        "endDate": iso(s.end_date),
        "state": s.state,
        "completedAt": iso(s.completed_at),
        "progress": {
            **_progress(s),
            "points": getattr(s, "p_points", 0) or 0,
            "donePoints": getattr(s, "p_done_points", 0) or 0,
        },
    }


# ── schema-only serializers ──


class ProgressOut(serializers.Serializer):
    done = serializers.IntegerField()
    total = serializers.IntegerField()
    percent = serializers.IntegerField()


class ObjectiveOut(serializers.Serializer):
    id = serializers.UUIDField()
    projectId = serializers.UUIDField()
    title = serializers.CharField()
    description = serializers.CharField()
    ownerId = serializers.UUIDField(allow_null=True)
    quarter = serializers.CharField()
    dueDate = serializers.DateField(allow_null=True)
    status = serializers.ChoiceField(choices=["active", "achieved", "dropped"])
    taskIds = serializers.ListField(child=serializers.UUIDField())
    progress = ProgressOut()
    createdAt = serializers.DateTimeField()


class MilestoneProgressOut(ProgressOut):
    expected = serializers.IntegerField()
    atRisk = serializers.BooleanField()


class MilestoneOut(serializers.Serializer):
    id = serializers.UUIDField()
    projectId = serializers.UUIDField()
    name = serializers.CharField()
    description = serializers.CharField()
    ownerId = serializers.UUIDField(allow_null=True)
    startDate = serializers.DateField()
    dueDate = serializers.DateField()
    completedAt = serializers.DateTimeField(allow_null=True)
    taskIds = serializers.ListField(child=serializers.UUIDField())
    progress = MilestoneProgressOut()


class EpicOut(serializers.Serializer):
    id = serializers.UUIDField()
    projectId = serializers.UUIDField()
    name = serializers.CharField()
    description = serializers.CharField()
    hue = serializers.IntegerField()
    ownerId = serializers.UUIDField(allow_null=True)
    milestoneId = serializers.UUIDField(allow_null=True)
    archivedAt = serializers.DateTimeField(allow_null=True)
    progress = ProgressOut()


class SprintProgressOut(ProgressOut):
    points = serializers.IntegerField()
    donePoints = serializers.IntegerField()


class SprintOut(serializers.Serializer):
    id = serializers.UUIDField()
    projectId = serializers.UUIDField()
    name = serializers.CharField()
    number = serializers.IntegerField()
    goal = serializers.CharField()
    startDate = serializers.DateField()
    endDate = serializers.DateField()
    state = serializers.ChoiceField(choices=["planned", "active", "completed"])
    completedAt = serializers.DateTimeField(allow_null=True)
    progress = SprintProgressOut()


class ObjectiveIn(serializers.Serializer):
    title = serializers.CharField(required=False)
    description = serializers.CharField(required=False, allow_blank=True)
    ownerId = serializers.UUIDField(required=False, allow_null=True)
    quarter = serializers.CharField(required=False, allow_blank=True)
    dueDate = serializers.DateField(required=False, allow_null=True)
    status = serializers.ChoiceField(choices=["active", "achieved", "dropped"], required=False)


class MilestoneIn(serializers.Serializer):
    name = serializers.CharField(required=False)
    description = serializers.CharField(required=False, allow_blank=True)
    ownerId = serializers.UUIDField(required=False, allow_null=True)
    startDate = serializers.DateField(required=False)
    dueDate = serializers.DateField(required=False)
    completed = serializers.BooleanField(required=False)
    taskIds = serializers.ListField(child=serializers.UUIDField(), required=False)


class EpicIn(serializers.Serializer):
    name = serializers.CharField(required=False)
    description = serializers.CharField(required=False, allow_blank=True)
    hue = serializers.IntegerField(required=False)
    ownerId = serializers.UUIDField(required=False, allow_null=True)
    milestoneId = serializers.UUIDField(required=False, allow_null=True)
    archived = serializers.BooleanField(required=False)


class SprintIn(serializers.Serializer):
    name = serializers.CharField(required=False)
    goal = serializers.CharField(required=False, allow_blank=True)
    startDate = serializers.DateField(required=False)
    endDate = serializers.DateField(required=False)


class TaskIdsIn(serializers.Serializer):
    taskIds = serializers.ListField(child=serializers.UUIDField())
