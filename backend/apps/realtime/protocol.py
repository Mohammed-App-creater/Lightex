"""Realtime protocol version 1 (docs/v2/33-dashboards-presence.md §2.3, §2.4): the envelope and the SSE framing.

Events are invalidation hints (ids, keys, versions, field names), never records. Durable events carry an `id` (the
`RealtimeEvent` row id) and are replayable; volatile events (presence, control) have none. Internally an event is
the envelope plus `userId`, the target of user-scoped events (inbox, access, personal dashboards); `userId` is never
sent to clients.
"""

from __future__ import annotations

import json
from typing import Any

from django.utils import timezone

from apps.common.utils import iso

VERSION = 1
SUPPORTED_VERSIONS = (1,)
CHANNEL = "lightex_rt"
#: pg_advisory_xact_lock key that serialises durable inserts, so ids follow commit order (§2.6).
LOCK_KEY = 0x4C58_5254  # "LXRT"
#: Postgres caps NOTIFY payloads at 8,000 bytes; larger events are sent as a reference to their row.
MAX_NOTIFY_BYTES = 7500
RETRY_MS = 3000

DURABLE_TYPES = (
    "task.changed",
    "tasks.bulk_changed",
    "comment.changed",
    "attachment.changed",
    "project.changed",
    "dashboard.changed",
    "inbox.changed",
    "access.changed",
)
VOLATILE_TYPES = ("presence.updated", "import.progress")
CONTROL_TYPES = ("hello", "reset", "reconnect")
#: Internal-only key: the target user of a user-scoped event.
TARGET = "userId"


def _str(value: Any) -> str | None:
    if value is None:
        return None
    return str(getattr(value, "pk", value))


def envelope(
    type_: str, *, workspace: Any = None, project: Any = None, actor: Any = None, user: Any = None, data: Any
) -> dict[str, Any]:
    """The wire envelope for a broadcast event, plus the internal `userId` target."""
    return {
        "v": VERSION,
        "type": type_,
        "ws": _str(workspace),
        "projectId": _str(project),
        "actorId": _str(actor),
        "at": iso(timezone.now()),
        "data": data,
        TARGET: _str(user),
    }


def control(type_: str, data: dict[str, Any]) -> dict[str, Any]:
    """A control event for one connection (hello, reset, reconnect)."""
    return {"v": VERSION, "type": type_, "data": data}


def dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=str)


def frame(event: dict[str, Any]) -> bytes:
    """One SSE message. The internal target is stripped; durable events get an `id:` line."""
    wire = {k: v for k, v in event.items() if k != TARGET}
    lines = []
    if wire.get("id") is not None:
        wire["id"] = str(wire["id"])
        lines.append(f"id: {wire['id']}")
    lines.append(f"event: {wire['type']}")
    lines.append(f"data: {dumps(wire)}")
    return ("\n".join(lines) + "\n\n").encode()


def ping() -> bytes:
    return f": ping {iso(timezone.now())}\n\n".encode()


def retry() -> bytes:
    return f"retry: {RETRY_MS}\n\n".encode()


def matches(event: dict[str, Any], workspace_id: str, project_ids: set[str] | frozenset[str], user_id: str) -> bool:
    """Delivery rule (§2.7): same workspace, and the target user when the event has one, else a visible project."""
    if event.get("ws") != workspace_id:
        return False
    target = event.get(TARGET)
    if target:
        return target == user_id
    project = event.get("projectId")
    return project is not None and project in project_ids
