"""Reads over the audit log: the workspace audit view and the project/task activity feeds."""

from __future__ import annotations

from typing import Any

from django.db.models import QuerySet

from apps.common.utils import iso

from .models import AuditLog

# Audit action → activity verb shown in feeds.
ACTIVITY_VERBS = {
    "task.created": "created",
    "task.status_changed": "status_changed",
    "task.assigned": "assigned",
    "comment.created": "commented",
    "task.objective_linked": "linked_objective",
    "task.updated": "updated",
    "task.deleted": "deleted",
    "task.restored": "restored",
    "sprint.started": "sprint_started",
    "sprint.completed": "sprint_completed",
    "attachment.created": "attached",
    "project_member.added": "member_added",
}


def activity(project_ids: Any) -> QuerySet[AuditLog]:
    return AuditLog.objects.filter(project_id__in=project_ids, action__in=list(ACTIVITY_VERBS))


def task_activity(task: Any) -> QuerySet[AuditLog]:
    return AuditLog.objects.filter(task=task, action__in=list(ACTIVITY_VERBS)).order_by("-created_at", "-id")


def activity_data(row: AuditLog) -> dict[str, Any]:
    data = {k: v for k, v in (row.data or {}).items() if isinstance(v, str | int | float) or v is None}
    return {
        "id": str(row.pk),
        "actorId": str(row.actor_id) if row.actor_id else None,
        "verb": ACTIVITY_VERBS.get(row.action, "updated"),
        "projectId": str(row.project_id) if row.project_id else None,
        "taskId": str(row.task_id) if row.task_id else None,
        "taskKey": row.task_key,
        "taskTitle": row.task_title,
        "data": data,
        "createdAt": iso(row.created_at),
    }
