"""Tracking's realtime wiring: its stream event types, the audit → event mapper, the members hint on access
changes, presence locations (board, task, dashboard) and the explicit publication points (board moves, bulk edits).
"""

from __future__ import annotations

from typing import Any

from core.common.exceptions import not_found
from core.realtime import presence
from core.realtime.protocol import register_realtime_types
from core.realtime.services import (
    MAX_BULK_IDS,
    publish,
    publish_access,
    register_access_hook,
    register_audit_publisher,
)

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
    "Assignee": "assigneeIds",
    "Labels": "labelIds",
    "Objective": "objectiveIds",
    "Time estimate": "timeEstimateMinutes",
}
#: Task actions whose fields are fixed, and actions that don't bump the task's version (sent as `version: null`).
TASK_ACTION_FIELDS = {
    "tracking.task.status_changed": ["statusId"],
    "tracking.task.assigned": ["assigneeIds"],
    "tracking.task.checklist_updated": ["checklist"],
    "tracking.task.objective_linked": ["objectiveIds"],
    "tracking.task.dependency_added": ["dependencies"],
    "tracking.task.dependency_removed": ["dependencies"],
    "tracking.task.time_logged": ["loggedMinutes"],
    "tracking.task.time_entry_deleted": ["loggedMinutes"],
}
UNVERSIONED = {
    "tracking.task.checklist_updated",
    "tracking.task.dependency_added",
    "tracking.task.dependency_removed",
    "tracking.task.time_logged",
    "tracking.task.time_entry_deleted",
}
TASK_OPS = {
    "tracking.task.created": "created",
    "tracking.task.deleted": "deleted",
    "tracking.task.restored": "restored",
}
AREAS = {
    "status": "statuses",
    "label": "labels",
    "sprint": "sprints",
    "epic": "epics",
    "objective": "objectives",
    "milestone": "milestones",
}
SETTINGS_ACTIONS = {
    "tracking.project.updated",
    "tracking.project.archived",
    "tracking.project.unarchived",
    "tracking.project.deleted",
    "tracking.project.restored",
}
CUSTOM_FIELD_ACTIONS = {
    "tracking.project.custom_field_created",
    "tracking.project.custom_field_updated",
    "tracking.project.custom_field_deleted",
    "tracking.project.custom_fields_reordered",
}
MEMBERSHIP_ACTIONS = {"tracking.project_member.added", "tracking.project_member.removed"}


def _task_fields(row: Any) -> list[str]:
    fixed = TASK_ACTION_FIELDS.get(row.action)
    if fixed is not None:
        return list(fixed)
    labels = [c.get("field") for c in row.changes or [] if isinstance(c, dict)]
    fields = [TASK_FIELDS[label] for label in labels if label in TASK_FIELDS]
    unknown = [label for label in labels if label and label not in TASK_FIELDS]
    if unknown and row.scope_id:
        from modules.tracking.projects.models import CustomField

        ids = dict(CustomField.objects.filter(project_id=row.scope_id, name__in=unknown).values_list("name", "pk"))
        fields += [f"customFields.{ids[label]}" for label in unknown if label in ids]
    return list(dict.fromkeys(fields))


def publish_for_audit(row: Any, task: Any = None) -> bool:
    """Maps one tracking audit row to its realtime event (§6.2). Returns False for rows it doesn't own. Dashboard
    writes publish explicitly (they need the owner and the visibility)."""
    action, entity = row.action, row.target_type.partition(".")[2]
    if row.module != "tracking":
        return False
    common = {"workspace": row.workspace_id, "project": row.scope_id, "actor": row.actor_id}
    if (
        entity == "task"
        and row.subject_id
        and (action in TASK_OPS or action in TASK_ACTION_FIELDS or action == "tracking.task.updated")
    ):
        op = TASK_OPS.get(action, "updated")
        version = None if op == "deleted" or action in UNVERSIONED else getattr(task, "version", None)
        data = {"taskId": str(row.subject_id), "key": row.task_key or row.entity_key, "op": op, "version": version}
        publish(
            "tracking.task.changed", **common, data={**data, "fields": [] if op != "updated" else _task_fields(row)}
        )
    elif entity in AREAS and row.scope_id and not action.endswith(".purged"):
        publish("tracking.project.changed", **common, data={"areas": [AREAS[entity]]})
    elif action in SETTINGS_ACTIONS and row.scope_id:
        publish("tracking.project.changed", **common, data={"areas": ["settings"]})
    elif action in CUSTOM_FIELD_ACTIONS and row.scope_id:
        publish("tracking.project.changed", **common, data={"areas": ["custom_fields"]})
    elif action == "tracking.project.import_completed" and row.scope_id:
        publish("tracking.tasks.bulk_changed", **common, data={"taskIds": None, "op": "created"})
    elif action == "tracking.project.created" and row.scope_id and row.actor_id:
        publish_access(row.workspace_id, row.actor_id, row.scope_id, actor=row.actor_id)
    elif action in MEMBERSHIP_ACTIONS and row.target_id:
        publish_access(row.workspace_id, row.target_id, row.scope_id, actor=row.actor_id)
    else:
        return False
    return True


def members_changed(workspace: Any, user_id: Any, project: str | None, *, actor: Any = None) -> None:
    """After `core.access.changed`: `project.changed` `["members"]` to the project."""
    if project:
        publish(
            "tracking.project.changed", workspace=workspace, project=project, actor=actor, data={"areas": ["members"]}
        )


# ───────────────────────── presence locations ─────────────────────────


def _alive(workspace: Any) -> dict[str, Any]:
    return {"project__workspace": workspace, "project__deleted_at__isnull": True}


def board_location(user: Any, workspace: Any, location_id: Any) -> tuple[Any, bool]:
    from modules.tracking.projects.models import Project

    project = Project.objects.filter(pk=location_id, workspace=workspace, deleted_at__isnull=True).first()
    if project is None:
        raise not_found(presence.NOT_VISIBLE)
    return project, False


def task_location(user: Any, workspace: Any, location_id: Any) -> tuple[Any, bool]:
    from modules.tracking.tasks.models import Task

    task = Task.objects.select_related("project").filter(pk=location_id, **_alive(workspace)).first()
    if task is None:
        raise not_found(presence.NOT_VISIBLE)
    return task.project, False


def dashboard_location(user: Any, workspace: Any, location_id: Any) -> tuple[Any, bool]:
    from modules.tracking.dashboards.models import Dashboard

    dashboard = Dashboard.objects.select_related("project").filter(pk=location_id, **_alive(workspace)).first()
    if dashboard is None or (dashboard.visibility == "personal" and dashboard.owner_id != user.pk):
        raise not_found(presence.NOT_VISIBLE)
    return dashboard.project, dashboard.visibility == "personal"


# ───────────────────────── explicit publication points ─────────────────────────


def publish_task_moved(actor: Any, task: Any, fields: list[str]) -> None:
    publish(
        "tracking.task.changed",
        workspace=task.project.workspace_id,
        project=task.project_id,
        actor=actor,
        data={"taskId": str(task.pk), "key": task.key, "op": "moved", "version": task.version, "fields": fields},
    )


def publish_bulk(actor: Any, project: Any, task_ids: list[Any], op: str) -> None:
    ids = [str(i) for i in task_ids]
    publish(
        "tracking.tasks.bulk_changed",
        workspace=project.workspace_id,
        project=project.pk,
        actor=actor,
        data={"taskIds": ids if len(ids) <= MAX_BULK_IDS else None, "op": op},
    )


def register() -> None:
    register_realtime_types(
        (
            "tracking.task.changed",
            "tracking.tasks.bulk_changed",
            "tracking.project.changed",
            "tracking.dashboard.changed",
        ),
        workspace=("tracking.integration.changed",),
        volatile=("tracking.import.progress",),
    )
    register_audit_publisher(publish_for_audit)
    register_access_hook(members_changed)
    presence.register_location("board", board_location)
    presence.register_location("dashboard", dashboard_location)
    presence.register_location("task", task_location)
