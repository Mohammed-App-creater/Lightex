"""Tracking's wrapper around `core.events.emit`: puts the project in `payload.projectId` and picks the target
(`taskId` -> tracking.task, `sprintId` -> tracking.sprint, otherwise the project)."""

from __future__ import annotations

from typing import Any

from core.events.services import emit as core_emit


def emit(
    event_type: str,
    *,
    workspace: Any,
    project: Any = None,
    actor: Any = None,
    payload: dict | None = None,
    target: tuple[str, Any] | None = None,
) -> Any:
    payload = dict(payload or {})
    project_id = getattr(project, "pk", project)
    if project_id is not None:
        payload.setdefault("projectId", str(project_id))
    if target is None:
        if payload.get("taskId"):
            target = ("tracking.task", payload["taskId"])
        elif payload.get("sprintId"):
            target = ("tracking.sprint", payload["sprintId"])
        elif project_id is not None:
            target = ("tracking.project", project_id)
    target_type, target_id = target or ("", None)
    return core_emit(
        event_type, workspace=workspace, target_type=target_type, target_id=target_id, actor=actor, payload=payload
    )
