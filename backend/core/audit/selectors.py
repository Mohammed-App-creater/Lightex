"""Reads over the audit log: the workspace audit view and the project/task activity feeds."""

from __future__ import annotations

from typing import Any

from django.db.models import Q, QuerySet

from core.common.utils import iso

from .models import AuditLog

# Audit action → activity verb shown in feeds.
ACTIVITY_VERBS = {
    "tracking.task.created": "created",
    "tracking.task.status_changed": "status_changed",
    "tracking.task.assigned": "assigned",
    "tracking.comment.created": "commented",
    "tracking.task.objective_linked": "linked_objective",
    "tracking.task.updated": "updated",
    "tracking.task.deleted": "deleted",
    "tracking.task.restored": "restored",
    "tracking.sprint.started": "sprint_started",
    "tracking.sprint.completed": "sprint_completed",
    "tracking.attachment.created": "attached",
    "tracking.project_member.added": "member_added",
    "tracking.task.dependency_added": "dependency_added",
    "tracking.task.dependency_removed": "dependency_removed",
    # Board 40: one entry per import in the project/workspace feeds, one per task in the task feed.
    "tracking.task.imported": "imported",
    "tracking.project.import_completed": "imported",
    # Board 37 (§8.2): PR/MR links, branches created from Lightex and merges. Branch links, unlinks and other PR
    # state changes stay audit-only (`_DEV_AUDIT_ONLY`).
    "tracking.task.dev_linked": "dev_linked",
    "tracking.task.dev_branch_created": "dev_branch_created",
    "tracking.task.dev_pr_state": "dev_pr_merged",
}
_DEV_AUDIT_ONLY = (Q(action="tracking.task.dev_linked") & ~Q(data__kind="pull_request")) | (
    Q(action="tracking.task.dev_pr_state") & ~Q(data__to="merged")
)
# Kept in each task's own feed but left out of project/workspace feeds (an import shows as one entry there).
TASK_ONLY = ("tracking.task.imported",)


def activity(project_ids: Any) -> QuerySet[AuditLog]:
    actions = [a for a in ACTIVITY_VERBS if a not in TASK_ONLY]
    return AuditLog.objects.filter(project_id__in=project_ids, action__in=actions).exclude(_DEV_AUDIT_ONLY)


def task_activity(task: Any) -> QuerySet[AuditLog]:
    return (
        AuditLog.objects.filter(task=task, action__in=list(ACTIVITY_VERBS))
        .exclude(_DEV_AUDIT_ONLY)
        .order_by("-created_at", "-id")
    )


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
        "actorName": row.actor_name or None,
        "actorKind": row.actor_kind or "user",
    }
