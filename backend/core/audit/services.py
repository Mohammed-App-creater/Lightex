"""Writes audit rows. Called by every mutating service inside its transaction.

`record()` also publishes the matching realtime event after commit (board 33, `realtime.services.publish_for_audit`).
`record_many()` (imports) publishes nothing per row; the import publishes one `tasks.bulk_changed` at the end.
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from core.common.middleware import current_request_id

from .models import AuditLog

_SECRET = re.compile(r"pass(word)?|token|secret|hash|credentials|^code$", re.IGNORECASE)


def target_type_of(action: str) -> str:
    """The namespaced target type of an action: `tracking.task.created` → `tracking.task`."""
    parts = action.split(".")
    return ".".join(parts[:2]) if len(parts) > 2 else parts[0]


def module_of(action: str) -> str:
    parts = action.split(".")
    return parts[0] if len(parts) > 2 else ""


def change(field: str, before: Any, after: Any, kind: str = "value") -> dict[str, Any]:
    """One field diff for AuditEntry.changes: kind ∈ text|status|priority|person|value."""
    return {"field": field, "kind": kind, "before": _plain(before), "after": _plain(after)}


def _plain(v: Any) -> Any:
    if v is None or isinstance(v, int | float | str | bool):
        return v
    if isinstance(v, dt.datetime | dt.date):
        return v.isoformat()
    return str(v)


def _scrub(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: ("[redacted]" if _SECRET.search(str(k)) else _scrub(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_scrub(v) for v in obj]
    return obj


def record(
    *,
    workspace: Any,
    actor: Any,
    action: str,
    target: str = "",
    entity_id: Any = "",
    entity_key: str | None = None,
    project: Any = None,
    task: Any = None,
    task_key: str | None = None,
    task_title: str | None = None,
    changes: list[dict[str, Any]] | None = None,
    data: dict[str, Any] | None = None,
    source: str = "web",
    request_id: str | None = None,
) -> AuditLog:
    """`project` and `task` (objects or ids) fill the generic `scope_id` / `subject_id` hints; a `task` object with a
    `version` is also handed to the realtime mapper."""
    row = AuditLog.objects.create(
        **_row(
            workspace=workspace,
            actor=actor,
            action=action,
            target=target,
            entity_id=entity_id,
            entity_key=entity_key,
            project=project,
            task=task,
            task_key=task_key,
            task_title=task_title,
            changes=changes,
            data=data,
            source=source,
            request_id=request_id,
        )
    )
    # Board 33: the matching realtime event, sent after the surrounding transaction commits.
    from core.realtime.services import publish_for_audit

    publish_for_audit(row, task=task if hasattr(task, "version") else None)
    return row


def record_many(rows: list[dict[str, Any]]) -> list[AuditLog]:
    """Many rows in one INSERT (imports): each item takes `record()`'s keyword arguments, same scrubbing."""
    if not rows:
        return []
    return AuditLog.objects.bulk_create([AuditLog(**_row(**r)) for r in rows])


def _row(
    *,
    workspace: Any,
    actor: Any,
    action: str,
    target: str = "",
    entity_id: Any = "",
    entity_key: str | None = None,
    project: Any = None,
    task: Any = None,
    task_key: str | None = None,
    task_title: str | None = None,
    changes: list[dict[str, Any]] | None = None,
    data: dict[str, Any] | None = None,
    source: str = "web",
    request_id: str | None = None,
) -> dict[str, Any]:
    clean_changes = [c for c in (changes or []) if not _SECRET.search(str(c.get("field", "")))]
    # Board 37: a system actor (an integration) has `actor_kind = "integration"`, a `ref` and a display name.
    kind = getattr(actor, "actor_kind", "user")
    system = kind != "user"
    title = getattr(task, "title", None) or task_title
    return {
        "workspace_id": getattr(workspace, "pk", workspace),
        "scope_id": getattr(project, "pk", project),
        "subject_id": getattr(task, "pk", task),
        "actor_id": None if system else getattr(actor, "pk", None),
        "actor_name": (getattr(actor, "name", "") or "")[:80],
        "actor_kind": kind,
        "actor_ref": str(getattr(actor, "ref", "")) if system else "",
        "action": action,
        "module": module_of(action),
        "target_type": target_type_of(action),
        "target_id": str(entity_id or ""),
        "entity_key": entity_key,
        "target": (target or "")[:300],
        "task_key": getattr(task, "key", None) or task_key,
        "task_title": str(title)[:300] if title else None,
        "changes": _scrub(clean_changes),
        "data": _scrub(data or {}),
        "source": getattr(actor, "source", source) if system else source,
        "request_id": request_id or current_request_id(),
    }
