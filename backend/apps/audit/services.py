"""Writes audit rows. Called by every mutating service inside its transaction."""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from apps.common.middleware import current_request_id

from .models import AuditLog

_SECRET = re.compile(r"pass(word)?|token|secret|hash", re.IGNORECASE)


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
    changes: list[dict[str, Any]] | None = None,
    data: dict[str, Any] | None = None,
    source: str = "web",
) -> AuditLog:
    clean_changes = [c for c in (changes or []) if not _SECRET.search(str(c.get("field", "")))]
    return AuditLog.objects.create(
        workspace_id=getattr(workspace, "pk", workspace),
        project_id=getattr(project, "pk", project),
        task_id=getattr(task, "pk", task),
        actor_id=getattr(actor, "pk", None),
        actor_name=(getattr(actor, "name", "") or "")[:80],
        action=action,
        entity_type=action.split(".")[0],
        entity_id=str(entity_id or ""),
        entity_key=entity_key,
        target=(target or "")[:300],
        task_key=getattr(task, "key", None),
        task_title=(getattr(task, "title", None) or None) and task.title[:300],
        changes=_scrub(clean_changes),
        data=_scrub(data or {}),
        source=source,
        request_id=current_request_id(),
    )
