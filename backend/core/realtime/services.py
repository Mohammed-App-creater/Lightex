"""Publishing realtime events (docs/v2/33-dashboards-presence.md §2.7, §6.2).

`publish()` is called inside service code and sends after the surrounding transaction commits (never on rollback).
Publishing failures are logged and swallowed: a missed hint is healed by the client's refetch-on-focus and the
`reset` paths, and must never fail a user's write.

One hook covers almost every write: `audit.services.record()` calls `publish_for_audit()`, which asks the
registered module mappers (`register_audit_publisher`) to map the audit action to an event. Writes that need another
event or audience publish explicitly and wrap their audited calls in `suppress_audit_events()` (board moves, bulk
operations).
"""

from __future__ import annotations

import contextlib
import contextvars
import datetime as dt
import logging
from collections.abc import Callable, Iterator
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

#: Module mappers: `fn(row, task) -> bool` publishes the event for an audit row it owns and returns True.
AuditPublisher = Callable[[Any, Any], bool]
#: Called by `publish_access()` after `core.access.changed` (modules add their own hints, e.g. project members).
AccessHook = Callable[..., None]
_AUDIT_PUBLISHERS: list[AuditPublisher] = []
_ACCESS_HOOKS: list[AccessHook] = []

MEMBERSHIP_ACTIONS = {"core.member.role_changed", "core.member.removed"}


def register_audit_publisher(fn: AuditPublisher) -> None:
    if fn not in _AUDIT_PUBLISHERS:
        _AUDIT_PUBLISHERS.append(fn)


def register_access_hook(fn: AccessHook) -> None:
    if fn not in _ACCESS_HOOKS:
        _ACCESS_HOOKS.append(fn)


def publish_for_audit(row: Any, task: Any = None) -> None:
    """Maps one audit row to its realtime event (§6.2): module mappers first, then core's own actions. Comments and
    attachments publish explicitly (core.collab); purges, views, invitations and workspace settings publish nothing."""
    if _suppressed.get() or not settings.REALTIME_ENABLED:
        return
    for fn in _AUDIT_PUBLISHERS:
        if fn(row, task):
            return
    if row.action in MEMBERSHIP_ACTIONS and row.target_id:
        publish_access(row.workspace_id, row.target_id, row.project_id, actor=row.actor_id)
    elif row.action == "core.role.updated" and any(c.get("field") == "Permissions" for c in row.changes or []):
        _publish_role_holders(row)


def publish_access(workspace: Any, user_id: Any, project_id: Any, *, actor: Any = None) -> None:
    """`access.changed` to the affected user (their stream ends with `reconnect`), plus whatever the registered access
    hooks add (tracking: `project.changed` `["members"]` to the project)."""
    project = str(project_id) if project_id else None
    publish(
        "core.access.changed",
        workspace=workspace,
        project=project,
        user=user_id,
        actor=actor,
        data={"projectId": project},
    )
    for hook in _ACCESS_HOOKS:
        hook(workspace, user_id, project, actor=actor)


def _publish_role_holders(row: Any) -> None:
    from core.access import scopes
    from core.workspaces.models import WorkspaceMember

    users = set(WorkspaceMember.objects.filter(role_id=row.target_id).values_list("user_id", flat=True))
    for provider in scopes.providers():
        users |= set(provider.role_assignments(row.target_id).values_list("user_id", flat=True))
    for user_id in sorted(users, key=str):
        publish(
            "core.access.changed",
            workspace=row.workspace_id,
            user=user_id,
            actor=row.actor_id,
            data={"projectId": None},
        )


# ───────────────────────── explicit publication points ─────────────────────────


def publish_inbox(user: Any, workspace_ids: list[Any] | None = None) -> None:
    """`inbox.changed` to one user with their unread count (every workspace), in each given workspace (default:
    every workspace they belong to)."""
    if not settings.REALTIME_ENABLED:
        return
    from core.notifications.views import inbox
    from core.workspaces.models import WorkspaceMember

    user_id = getattr(user, "pk", user)
    if workspace_ids is None:
        workspace_ids = list(
            WorkspaceMember.objects.filter(user_id=user_id, status="active").values_list("workspace_id", flat=True)
        )
    unread = inbox(user).filter(read_at__isnull=True).count()
    for ws in dict.fromkeys(str(w) for w in workspace_ids):
        publish("core.inbox.changed", workspace=ws, user=user_id, data={"unread": unread})


# ───────────────────────── housekeeping ─────────────────────────


def purge_events() -> int:
    """Deletes events past `REALTIME_EVENT_RETENTION_SECONDS` (replay then answers `reset`)."""
    from .models import RealtimeEvent

    cutoff = timezone.now() - dt.timedelta(seconds=settings.REALTIME_EVENT_RETENTION_SECONDS)
    deleted, _ = RealtimeEvent.objects.filter(created_at__lt=cutoff).delete()
    return deleted
