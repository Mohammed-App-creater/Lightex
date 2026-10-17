"""Turns domain events into in-app notifications and emails, following each recipient's preferences.

Core handles the events it owns (comment and mention notifications, workspace access requests); modules register
handlers for their own event types (core/events/registry.py) and call `deliver()`.

Invitation and password-reset emails are not routed through here: they carry single-use tokens, which must never be
written to the outbox, so those services send them directly.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from typing import Any

from django.utils import timezone

from core.accounts.models import User
from core.common.targets import get_resolver
from core.events.models import DomainEvent
from core.events.registry import event_type, register_handler

from .emails import base_context, queue_email
from .models import Notification, NotificationPreference, default_events

logger = logging.getLogger("lightex.notifications")


def preferences_for(user: User) -> NotificationPreference:
    prefs, _ = NotificationPreference.objects.get_or_create(user=user, defaults={"events": default_events()})
    return prefs


def recipients(event: DomainEvent, user_ids: Iterable[Any], *, target: tuple[str, Any] | None = None) -> list[User]:
    """Active users who may still see the target, never the actor, each once."""
    ids = {str(u) for u in user_ids if u} - {str(event.actor_id)}
    if not ids:
        return []
    target_type, target_id = target or (event.target_type, event.target_id)
    resolver = get_resolver(target_type) if target_type else None
    if resolver is not None and target_id is not None:
        ids = set(resolver.can_notify(ids, target_id))
    return list(User.objects.filter(pk__in=ids, is_active=True))


def deliver(
    event: DomainEvent,
    recipient: User,
    *,
    kind: str,
    pref: str | None,
    target: tuple[str, Any] | None = None,
    payload: dict | None = None,
    email_template: str = "",
    email_context: dict | None = None,
    channel_context: dict | None = None,
    urgent: bool = False,
) -> Notification | None:
    """One notification (in-app row, email and external channels) for `recipient`, idempotent per event.

    `target` defaults to the event's target. Title, link and the scope hints (`projectId`, `taskId`) come from the
    target resolver's `describe()`.
    """
    from core.channels import dispatch as channels
    from core.modules.services import code_enabled

    target_type, target_id = target or (event.target_type, event.target_id)
    if target_type and not code_enabled(event.workspace_id, target_type):
        return None  # a comment or mention on a record of a module that is turned off in this workspace
    if pref and not code_enabled(event.workspace_id, pref):
        return None
    resolver = get_resolver(target_type) if target_type else None
    info = resolver.describe(target_id) if resolver is not None and target_id is not None else {}
    project_id = info.get("projectId") or event.project_id
    prefs = preferences_for(recipient)
    channel = (prefs.events or {}).get(pref, {}) if pref else {"in_app": True, "email": True}
    in_app = bool(channel.get("in_app", True))
    email = bool(email_template) and bool(channel.get("email", False))
    external = channels.wanted(recipient, prefs, pref, event)  # board 38 §6.1; [] when pref is None
    if not in_app and not email and not external:
        return None
    notification, created = Notification.objects.get_or_create(
        event=event,
        recipient=recipient,
        defaults={
            "workspace_id": event.workspace_id,
            "target_type": target_type or "",
            "target_id": target_id,
            "title": str(info.get("title") or "")[:300],
            "link": str(info.get("link") or "")[:500],
            "scope_id": project_id,
            "subject_id": info.get("taskId"),
            "refs": _refs(info, target_id),
            "type": (pref or event.type)[:64],
            "kind": kind,
            "actor_id": event.actor_id,
            "payload": payload or {},
            "in_app": in_app,
            "email_template": email_template if email else "",
            "email_context": (email_context or {}) if email else {},
        },
    )
    if created and in_app:
        from core.realtime.services import publish_inbox

        publish_inbox(recipient, [event.workspace_id])
    if created and email:
        if prefs.email_delivery == "instant":
            queue_email(recipient.email, email_template, email_context or {})
            notification.emailed_at = timezone.now()
        else:
            notification.email_pending = True
        notification.save(update_fields=["emailed_at", "email_pending", "updated_at"])
    if created and external:
        assert pref is not None  # noqa: S101 - wanted() is empty without a preference key
        etype = event_type(pref)
        channels.enqueue(
            notification,
            recipient,
            prefs,
            external,
            template=etype.channel_template if etype else "",
            context={**(email_context or {}), **(channel_context or {})},
            urgent=urgent,
        )
    return notification


def _refs(info: dict[str, Any], target_id: Any) -> dict[str, Any]:
    """Display hints kept on the row (no foreign keys to module tables): the scope's and the subject's names."""
    subject = info.get("taskId")
    is_subject = subject is not None and str(subject) == str(target_id)
    refs = {
        "projectName": info.get("projectName"),
        "taskKey": info.get("taskKey") or (info.get("key") if is_subject else None),
        "taskTitle": info.get("taskTitle") or (info.get("title") if is_subject else None),
    }
    return {k: str(v)[:300] for k, v in refs.items() if v}


def target_context(event: DomainEvent) -> dict[str, Any]:
    """The target's template merge tags (resolver `context()`), plus the actor's name."""
    resolver = get_resolver(event.target_type) if event.target_type else None
    ctx = resolver.context(event.target_id) if resolver is not None and event.target_id is not None else {}
    return {"actor_name": event.actor.name if event.actor is not None else "", "workspace_slug": "", **ctx}


# ───────────────────────── core handlers ─────────────────────────


def on_mentioned(event: DomainEvent) -> None:
    """`core.comment.mentioned`: the users named in a comment (or any rich text) on a target."""
    resolver = get_resolver(event.target_type)
    if resolver is None or event.target_id is None or resolver.workspace_of(event.target_id) is None:
        return
    quote = str(event.payload.get("quote", ""))[:140]
    actor_name = event.actor.name if event.actor is not None else "Someone"
    ctx = target_context(event)
    for user in recipients(event, event.payload.get("userIds", [])):
        deliver(
            event,
            user,
            kind="mention",
            pref="core.comment.mentioned",
            payload={"quote": quote},
            email_template="mentioned",
            email_context={**ctx, "author_name": actor_name, "comment_excerpt": quote},
            channel_context={**ctx, "author_name": actor_name, "comment_excerpt": quote},
            urgent=bool(ctx.get("urgent")),
        )


def on_comment(event: DomainEvent) -> None:
    """`core.comment.created`: the target's subscribers (resolver `subscribers()`), minus anyone mentioned."""
    resolver = get_resolver(event.target_type)
    if resolver is None or event.target_id is None or resolver.workspace_of(event.target_id) is None:
        return
    quote = str(event.payload.get("quote", ""))[:140]
    ctx = target_context(event)
    for user in recipients(event, event.payload.get("userIds", [])):
        deliver(
            event,
            user,
            kind="comment",
            pref="core.comment.created",
            payload={"quote": quote},
            channel_context={**ctx, "comment_excerpt": quote},
            urgent=bool(ctx.get("urgent")),
        )


def on_workspace_access_request(event: DomainEvent) -> None:
    """Emails the workspace's member managers (no in-app row: there is no target to open)."""
    from core.access import services as access
    from core.workspaces.models import WorkspaceAccessRequest, WorkspaceMember

    req = (
        WorkspaceAccessRequest.objects.select_related("user", "workspace")
        .filter(pk=event.payload.get("requestId"))
        .first()
    )
    if req is None:
        return
    ws = req.workspace
    context = workspace_access_context(req, ws)
    members = WorkspaceMember.objects.filter(workspace=ws, status="active", user__is_active=True).select_related("user")
    for m in members:
        if m.user_id == event.actor_id or not access.can(m.user, "core.workspace.manage_members", ws):
            continue
        queue_email(m.user.email, "access_request", context)


def workspace_access_context(req: Any, workspace: Any) -> dict[str, Any]:
    from django.conf import settings

    return {
        **base_context(workspace.slug),
        "cta_url": f"{settings.FRONTEND_URL}/{workspace.slug}/settings/members",
        "requester_name": req.user.name,
        "requester_email": req.user.email,
        "project_name": f"a project in {workspace.name}",
        "scope_label": "Wants",
        "workspace_name": workspace.name,
        "message": getattr(req, "message", "") or "",
    }


def register() -> None:
    """Core's notification handlers (called from the notifications AppConfig). The event types are declared in core's
    module definition (core/modules/core_module.py)."""
    register_handler("core.comment.mentioned", on_mentioned, module="core")
    register_handler("core.comment.created", on_comment, module="core")
    register_handler("core.workspace.access_requested", on_workspace_access_request, module="core")
