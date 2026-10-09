"""Publishing realtime events (docs/v2/33-dashboards-presence.md §2.7, §6.2).

`publish()` is called inside service code and sends after the surrounding transaction commits (never on rollback).
Publishing failures are logged and swallowed: a missed hint is healed by the client's refetch-on-focus and the
`reset` paths, and must never fail a user's write.

One hook covers almost every write: `audit.services.record()` calls `publish_for_audit()`, which maps the audit
action to an event. Writes that need another event or audience publish explicitly and wrap their audited calls in
`suppress_audit_events()` (board moves, bulk operations).
"""

from __future__ import annotations

import contextlib
import contextvars
import datetime as dt
import logging
from collections.abc import Iterator
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from .brokers import broker
from .protocol import envelope

logger = logging.getLogger("lightex.realtime")

_suppressed: contextvars.ContextVar[bool] = contextvars.ContextVar("realtime_suppressed", default=False)

MAX_BULK_IDS = 200


def publish(
    type_: str,
    *,
    workspace: Any,
    project: Any = None,
    user: Any = None,
    actor: Any = None,
    data: dict[str, Any],
    durable: bool = True,
) -> None:
    """Queues one event for after the current transaction commits. `user` targets a single user."""
    if not settings.REALTIME_ENABLED:
        return
    event = envelope(type_, workspace=workspace, project=project, actor=actor, user=user, data=data)

    def send() -> None:
        try:
            broker().send(event, durable=durable)
        except Exception:
            logger.exception("Publishing realtime event %s failed", type_)

    transaction.on_commit(send)


@contextlib.contextmanager
def suppress_audit_events() -> Iterator[None]:
    """Audit rows written inside this block publish nothing; the caller publishes one explicit event instead."""
    token = _suppressed.set(True)
    try:
        yield
    finally:
        _suppressed.reset(token)


# ───────────────────────── the audit hook (§6.2) ─────────────────────────

#: Audit change labels → camelCase `Task` field names.
TASK_FIELDS = {
    "Title": "title",
    "Type": "type",
    "Priority": "priority",
    "Estimate": "estimate",
    "Start date": "startDate",
    "Due date": "dueDate",
    "Epic": "epicId",
    "Milestone": "milestoneId",
    "Sprint": "sprintId",
    "Description": "description",
    "Status": "statusId",
    "Assignee": "assigneeId",
    "Labels": "labelIds",
    "Objective": "objectiveIds",
    "Time estimate": "timeEstimateMinutes",
}
#: Task actions whose fields are fixed, and actions that don't bump the task's version (sent as `version: null`).
TASK_ACTION_FIELDS = {
    "task.status_changed": ["statusId"],
    "task.assigned": ["assigneeId"],
    "task.objective_linked": ["objectiveIds"],
    "task.dependency_added": ["dependencies"],
    "task.dependency_removed": ["dependencies"],
    "task.time_logged": ["loggedMinutes"],
    "task.time_entry_deleted": ["loggedMinutes"],
}
UNVERSIONED = {"task.dependency_added", "task.dependency_removed", "task.time_logged", "task.time_entry_deleted"}
TASK_OPS = {"task.created": "created", "task.deleted": "deleted", "task.restored": "restored"}
COMMENT_OPS = {
    "comment.created": "created",
    "comment.updated": "updated",
    "comment.deleted": "deleted",
    "comment.restored": "created",
}
ATTACHMENT_OPS = {"attachment.created": "created", "attachment.deleted": "deleted"}
AREAS = {
    "status": "statuses",
    "label": "labels",
    "sprint": "sprints",
    "epic": "epics",
    "objective": "objectives",
    "milestone": "milestones",
}
SETTINGS_ACTIONS = {
    "project.updated",
    "project.archived",
    "project.unarchived",
    "project.deleted",
    "project.restored",
}
CUSTOM_FIELD_ACTIONS = {
    "project.custom_field_created",
    "project.custom_field_updated",
    "project.custom_field_deleted",
    "project.custom_fields_reordered",
}
MEMBERSHIP_ACTIONS = {"member.role_changed", "project_member.added", "project_member.removed", "member.removed"}


def _task_fields(row: Any) -> list[str]:
    fixed = TASK_ACTION_FIELDS.get(row.action)
    if fixed is not None:
        return list(fixed)
    labels = [c.get("field") for c in row.changes or [] if isinstance(c, dict)]
    fields = [TASK_FIELDS[label] for label in labels if label in TASK_FIELDS]
    unknown = [label for label in labels if label and label not in TASK_FIELDS]
    if unknown and row.project_id:
        from apps.projects.models import CustomField

        ids = dict(CustomField.objects.filter(project_id=row.project_id, name__in=unknown).values_list("name", "pk"))
        fields += [f"customFields.{ids[label]}" for label in unknown if label in ids]
    return list(dict.fromkeys(fields))


def publish_for_audit(row: Any, task: Any = None) -> None:
    """Maps one audit row to its realtime event (§6.2). Dashboard writes publish explicitly (they need the owner and
    the visibility); purges, views, invitations and workspace settings publish nothing."""
    if _suppressed.get() or not settings.REALTIME_ENABLED:
        return
    action, entity = row.action, row.entity_type
    common = {"workspace": row.workspace_id, "project": row.project_id, "actor": row.actor_id}
    if (
        entity == "task"
        and row.task_id
        and (action in TASK_OPS or action in TASK_ACTION_FIELDS or action == "task.updated")
    ):
        op = TASK_OPS.get(action, "updated")
        version = None if op == "deleted" or action in UNVERSIONED else getattr(task, "version", None)
        data = {"taskId": str(row.task_id), "key": row.task_key or row.entity_key, "op": op, "version": version}
        publish("task.changed", **common, data={**data, "fields": [] if op != "updated" else _task_fields(row)})
    elif action in COMMENT_OPS and row.task_id:
        key = row.task_key or row.entity_key
        data = {"taskId": str(row.task_id), "key": key, "commentId": row.entity_id, "op": COMMENT_OPS[action]}
        publish("comment.changed", **common, data=data)
    elif action in ATTACHMENT_OPS and row.task_id:
        key = row.task_key or row.entity_key
        publish(
            "attachment.changed", **common, data={"taskId": str(row.task_id), "key": key, "op": ATTACHMENT_OPS[action]}
        )
    elif entity in AREAS and row.project_id and not action.endswith(".purged"):
        publish("project.changed", **common, data={"areas": [AREAS[entity]]})
    elif action in SETTINGS_ACTIONS and row.project_id:
        publish("project.changed", **common, data={"areas": ["settings"]})
    elif action in CUSTOM_FIELD_ACTIONS and row.project_id:
        publish("project.changed", **common, data={"areas": ["custom_fields"]})
    elif action == "project.import_completed" and row.project_id:
        publish("tasks.bulk_changed", **common, data={"taskIds": None, "op": "created"})
    elif action == "project.created" and row.project_id and row.actor_id:
        publish_access(row.workspace_id, row.actor_id, row.project_id, actor=row.actor_id)
    elif action in MEMBERSHIP_ACTIONS and row.entity_id:
        publish_access(row.workspace_id, row.entity_id, row.project_id, actor=row.actor_id)
    elif action == "role.updated" and any(c.get("field") == "Permissions" for c in row.changes or []):
        _publish_role_holders(row)


def publish_access(workspace: Any, user_id: Any, project_id: Any, *, actor: Any = None) -> None:
    """`access.changed` to the affected user (their stream ends with `reconnect`), plus `project.changed`
    `["members"]` to the project."""
    project = str(project_id) if project_id else None
    publish(
        "access.changed", workspace=workspace, project=project, user=user_id, actor=actor, data={"projectId": project}
    )
    if project:
        publish("project.changed", workspace=workspace, project=project, actor=actor, data={"areas": ["members"]})


def _publish_role_holders(row: Any) -> None:
    from apps.projects.models import ProjectMember
    from apps.workspaces.models import WorkspaceMember

    users = set(ProjectMember.objects.filter(role_id=row.entity_id).values_list("user_id", flat=True))
    users |= set(WorkspaceMember.objects.filter(role_id=row.entity_id).values_list("user_id", flat=True))
    for user_id in sorted(users, key=str):
        publish(
            "access.changed", workspace=row.workspace_id, user=user_id, actor=row.actor_id, data={"projectId": None}
        )


# ───────────────────────── explicit publication points ─────────────────────────


def publish_task_moved(actor: Any, task: Any, fields: list[str]) -> None:
    publish(
        "task.changed",
        workspace=task.project.workspace_id,
        project=task.project_id,
        actor=actor,
        data={"taskId": str(task.pk), "key": task.key, "op": "moved", "version": task.version, "fields": fields},
    )


def publish_bulk(actor: Any, project: Any, task_ids: list[Any], op: str) -> None:
    ids = [str(i) for i in task_ids]
    publish(
        "tasks.bulk_changed",
        workspace=project.workspace_id,
        project=project.pk,
        actor=actor,
        data={"taskIds": ids if len(ids) <= MAX_BULK_IDS else None, "op": op},
    )


def publish_inbox(user: Any, workspace_ids: list[Any] | None = None) -> None:
    """`inbox.changed` to one user with their unread count (every workspace), in each given workspace (default:
    every workspace they belong to)."""
    if not settings.REALTIME_ENABLED:
        return
    from apps.notifications.views import inbox
    from apps.workspaces.models import WorkspaceMember

    user_id = getattr(user, "pk", user)
    if workspace_ids is None:
        workspace_ids = list(
            WorkspaceMember.objects.filter(user_id=user_id, status="active").values_list("workspace_id", flat=True)
        )
    unread = inbox(user).filter(read_at__isnull=True).count()
    for ws in dict.fromkeys(str(w) for w in workspace_ids):
        publish("inbox.changed", workspace=ws, user=user_id, data={"unread": unread})


# ───────────────────────── housekeeping ─────────────────────────


def purge_events() -> int:
    """Deletes events past `REALTIME_EVENT_RETENTION_SECONDS` (replay then answers `reset`)."""
    from .models import RealtimeEvent

    cutoff = timezone.now() - dt.timedelta(seconds=settings.REALTIME_EVENT_RETENTION_SECONDS)
    deleted, _ = RealtimeEvent.objects.filter(created_at__lt=cutoff).delete()
    return deleted
