"""Turns domain events into in-app notifications and emails, following each recipient's preferences.

Invitation and password-reset emails are not routed through here: they carry single-use tokens,
which must never be written to the outbox, so those services send them directly.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from typing import Any

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from apps.access.catalogue import PROJECT_ADMIN_PERMISSION
from apps.accounts.models import User
from apps.projects.models import ProjectMember

from .emails import PRIORITY_COLOR, PRIORITY_LABEL, base_context, queue_email
from .models import DomainEvent, Notification, NotificationPreference, default_events

logger = logging.getLogger("lightex.notifications")


def preferences_for(user: User) -> NotificationPreference:
    prefs, _ = NotificationPreference.objects.get_or_create(user=user, defaults={"events": default_events()})
    return prefs


def _fmt(date: Any) -> str:
    return f"{date:%b} {date.day}" if date else ""


def _task_url(task: Any) -> str:
    return f"{settings.FRONTEND_URL}/{task.project.workspace.slug}/tasks/{task.key}"


def _task_context(task: Any) -> dict[str, Any]:
    return {
        **base_context(task.project.workspace.slug),
        "cta_url": _task_url(task),
        "task_key": task.key,
        "task_title": task.title,
        "project_name": task.project.name,
        "workspace_name": task.project.workspace.name,
        "priority": PRIORITY_LABEL.get(task.priority, ""),
        "priority_color": PRIORITY_COLOR.get(task.priority, "#8794B6"),
        "due_date": _fmt(task.due_date),
        "sprint_name": task.sprint.name if task.sprint_id else "No sprint",
    }


def _recipients(event: DomainEvent, user_ids: Iterable[Any]) -> list[User]:
    """Project members only, never the actor, each once."""
    ids = {str(u) for u in user_ids if u} - {str(event.actor_id)}
    if not ids:
        return []
    if event.project_id:
        members = set(
            map(
                str,
                ProjectMember.objects.filter(project_id=event.project_id, user_id__in=ids).values_list(
                    "user_id", flat=True
                ),
            )
        )
        ids &= members
    return list(User.objects.filter(pk__in=ids, is_active=True))


def deliver(
    event: DomainEvent,
    recipient: User,
    *,
    kind: str,
    pref: str | None,
    task: Any = None,
    payload: dict | None = None,
    email_template: str = "",
    email_context: dict | None = None,
) -> Notification | None:
    if event.project_id is None:  # in-app rows always belong to a project
        return None
    project_id = event.project_id
    prefs = preferences_for(recipient)
    channel = (prefs.events or {}).get(pref, {}) if pref else {"in_app": True, "email": True}
    in_app = bool(channel.get("in_app", True))
    email = bool(email_template) and bool(channel.get("email", False))
    if not in_app and not email:
        return None
    notification, created = Notification.objects.get_or_create(
        event=event,
        recipient=recipient,
        defaults={
            "workspace_id": event.workspace_id,
            "project_id": project_id,
            "task": task,
            "type": kind,
            "actor_id": event.actor_id,
            "payload": payload or {},
            "in_app": in_app,
            "email_template": email_template if email else "",
            "email_context": (email_context or {}) if email else {},
        },
    )
    if created and email:
        if prefs.email_delivery == "instant":
            queue_email(recipient.email, email_template, email_context or {})
            notification.emailed_at = timezone.now()
        else:
            notification.email_pending = True
        notification.save(update_fields=["emailed_at", "email_pending", "updated_at"])
    return notification


def _task(event: DomainEvent) -> Any:
    from apps.tasks.models import Task

    return (
        Task.objects.select_related("project", "project__workspace", "sprint")
        .filter(pk=event.payload.get("taskId"))
        .first()
    )


# ───────────────────────── handlers ─────────────────────────


def on_task_assigned(event: DomainEvent) -> None:
    task = _task(event)
    if task is None:
        return
    actor_name = event.actor.name if event.actor is not None else "Someone"
    for user in _recipients(event, [event.payload.get("assigneeId")]):
        deliver(
            event,
            user,
            kind="assigned",
            pref="assigned",
            task=task,
            email_template="task_assigned",
            email_context={**_task_context(task), "assigner_name": actor_name},
        )


def on_status_change(event: DomainEvent) -> None:
    task = _task(event)
    if task is None:
        return
    payload = {"fromStatus": event.payload.get("fromStatus"), "toStatus": event.payload.get("toStatus")}
    for user in _recipients(event, [task.assignee_id, task.reporter_id]):
        deliver(event, user, kind="status", pref="status_change", task=task, payload=payload)


def on_mentioned(event: DomainEvent) -> None:
    task = _task(event)
    if task is None:
        return
    quote = str(event.payload.get("quote", ""))[:140]
    actor_name = event.actor.name if event.actor is not None else "Someone"
    for user in _recipients(event, event.payload.get("userIds", [])):
        deliver(
            event,
            user,
            kind="mention",
            pref="mentioned",
            task=task,
            payload={"quote": quote},
            email_template="mentioned",
            email_context={**_task_context(task), "author_name": actor_name, "comment_excerpt": quote},
        )


def on_comment(event: DomainEvent) -> None:
    task = _task(event)
    if task is None:
        return
    quote = str(event.payload.get("quote", ""))[:140]
    for user in _recipients(event, event.payload.get("userIds", [])):
        deliver(event, user, kind="comment", pref="comment", task=task, payload={"quote": quote})


def _sprint(event: DomainEvent) -> Any:
    from apps.planning.models import Sprint

    return (
        Sprint.objects.select_related("project", "project__workspace").filter(pk=event.payload.get("sprintId")).first()
    )


def _sprint_context(sprint: Any) -> dict[str, Any]:
    project = sprint.project
    return {
        **base_context(project.workspace.slug),
        "cta_url": f"{settings.FRONTEND_URL}/{project.workspace.slug}/projects/{project.key}/board",
        "project_name": project.name,
        "workspace_name": project.workspace.name,
        "sprint_name": sprint.name,
        "sprint_start": _fmt(sprint.start_date),
        "sprint_end": _fmt(sprint.end_date),
    }


def on_sprint_started(event: DomainEvent) -> None:
    from django.db.models import Sum

    from apps.tasks.models import Task

    sprint = _sprint(event)
    if sprint is None:
        return
    tasks = Task.objects.filter(sprint=sprint).exclude(status__glyph="canceled")
    context = {
        **_sprint_context(sprint),
        "task_count": tasks.count(),
        "points_total": tasks.aggregate(p=Sum("estimate"))["p"] or 0,
    }
    members = ProjectMember.objects.filter(project=sprint.project).values_list("user_id", flat=True)
    for user in _recipients(event, members):
        deliver(
            event,
            user,
            kind="sprint",
            pref="sprint_started",
            payload={"sprintName": sprint.name},
            email_template="sprint_started",
            email_context={**context, "your_task_count": tasks.filter(assignee=user).count()},
        )


def on_sprint_completed(event: DomainEvent) -> None:
    """Email only: the inbox has no "sprint completed" row type in v1."""
    from apps.planning.models import Sprint

    sprint = _sprint(event)
    if sprint is None:
        return
    total = int(event.payload.get("total") or 0)
    completed = int(event.payload.get("completed") or 0)
    nxt = (
        Sprint.objects.filter(pk=event.payload.get("nextSprintId")).first()
        if event.payload.get("nextSprintId")
        else None
    )
    context = {
        **_sprint_context(sprint),
        "task_count": total,
        "completed_count": completed,
        "completed_pct": round(completed * 100 / total) if total else 0,
        "carried_count": int(event.payload.get("carried") or 0),
        "next_sprint_name": nxt.name if nxt else "the backlog",
    }
    members = ProjectMember.objects.filter(project=sprint.project).values_list("user_id", flat=True)
    for user in _recipients(event, members):
        prefs = preferences_for(user)
        if prefs.events.get("sprint_started", {}).get("email") and prefs.email_delivery == "instant":
            queue_email(user.email, "sprint_completed", context)


def _access_request_context(req: Any, *, project: Any, workspace: Any) -> dict[str, Any]:
    scope = project.name if project is not None else f"a project in {workspace.name}"
    cta = (
        f"{settings.FRONTEND_URL}/{workspace.slug}/projects/{project.key}/settings?tab=members"
        if project is not None
        else f"{settings.FRONTEND_URL}/{workspace.slug}/settings/members"
    )
    return {
        **base_context(workspace.slug),
        "cta_url": cta,
        "requester_name": req.user.name,
        "requester_email": req.user.email,
        "project_name": scope,
        "scope_label": "Project" if project is not None else "Wants",
        "workspace_name": workspace.name,
        "message": getattr(req, "message", "") or "",
    }


def on_access_request(event: DomainEvent) -> None:
    """Tells the people who can let the requester in: the project's member managers and its lead."""
    from apps.projects.models import AccessRequest

    req = (
        AccessRequest.objects.select_related("user", "project", "project__workspace")
        .filter(pk=event.payload.get("requestId"))
        .first()
    )
    if req is None or req.status != "pending":
        return
    project = req.project
    admins = list(
        ProjectMember.objects.filter(project=project, role__permissions__code=PROJECT_ADMIN_PERMISSION).values_list(
            "user_id", flat=True
        )
    )
    if project.lead_id:
        admins.append(project.lead_id)
    context = _access_request_context(req, project=project, workspace=project.workspace)
    for user in _recipients(event, admins):
        deliver(
            event,
            user,
            kind="access",
            pref=None,
            payload={"projectKey": project.key, **({"quote": req.message} if req.message else {})},
            email_template="access_request",
            email_context=context,
        )


def on_workspace_access_request(event: DomainEvent) -> None:
    """Emails the workspace's member managers (in-app rows always belong to a project, so email only)."""
    from apps.access import services as access
    from apps.workspaces.models import WorkspaceAccessRequest, WorkspaceMember

    req = (
        WorkspaceAccessRequest.objects.select_related("user", "workspace")
        .filter(pk=event.payload.get("requestId"))
        .first()
    )
    if req is None:
        return
    ws = req.workspace
    context = _access_request_context(req, project=None, workspace=ws)
    members = WorkspaceMember.objects.filter(workspace=ws, status="active", user__is_active=True).select_related("user")
    for m in members:
        if m.user_id == event.actor_id or not access.can(m.user, "workspace.manage_members", ws):
            continue
        queue_email(m.user.email, "access_request", context)


def on_due_soon(event: DomainEvent) -> None:
    task = _task(event)
    if task is None or task.assignee_id is None:
        return
    for user in _recipients(event, [task.assignee_id]):
        deliver(
            event,
            user,
            kind="due",
            pref="due_soon",
            task=task,
            payload={"dueDate": task.due_date.isoformat() if task.due_date else None},
            email_template="due_soon",
            email_context={**_task_context(task), "due_relative": event.payload.get("relative", "soon")},
        )


def on_import_finished(event: DomainEvent) -> None:
    """Board 40 §5.8: one in-app row to the job's creator (a system row: no actor, no task, no email, no
    preference). Bypasses `_recipients` (which drops the actor) but still requires an active project member."""
    from apps.imports.models import ImportJob

    job = ImportJob.objects.select_related("project").filter(pk=event.payload.get("jobId")).first()
    if job is None or job.created_by_id is None:
        return
    if not ProjectMember.objects.filter(project_id=job.project_id, user_id=job.created_by_id).exists():
        return
    user = User.objects.filter(pk=job.created_by_id, is_active=True).first()
    if user is None:
        return
    deliver(
        event,
        user,
        kind="import",
        pref=None,
        payload={
            "importId": str(job.pk),
            "projectKey": job.project.key,
            "imported": job.imported,
            "skipped": job.skipped,
            "importStatus": job.status,
        },
    )


HANDLERS: dict[str, Callable[[DomainEvent], None]] = {
    "task_assigned": on_task_assigned,
    "status_change": on_status_change,
    "mentioned": on_mentioned,
    "comment": on_comment,
    "sprint_started": on_sprint_started,
    "sprint_completed": on_sprint_completed,
    "access_request": on_access_request,
    "workspace_access_request": on_workspace_access_request,
    "due_soon": on_due_soon,
    "import_finished": on_import_finished,
    # Recorded for the outbox trail; the email itself is sent by the service (it carries a token).
    "invitation": lambda event: None,
}


def process_event(event_id: Any) -> bool:
    """Processes one event exactly once. Returns True if it was handled now."""
    try:
        with transaction.atomic():
            event = (
                DomainEvent.objects.select_for_update(skip_locked=True, of=("self",))
                .select_related("actor")
                .filter(pk=event_id, processed_at__isnull=True)
                .first()
            )
            if event is None:
                return False
            handler = HANDLERS.get(event.type)
            if handler is not None:
                handler(event)
            event.processed_at = timezone.now()
            event.attempts += 1
            event.save(update_fields=["processed_at", "attempts", "updated_at"])
        return True
    except Exception as exc:
        logger.exception("Processing event %s failed", event_id)
        DomainEvent.objects.filter(pk=event_id).update(error=str(exc)[:2000])
        from django.db.models import F

        DomainEvent.objects.filter(pk=event_id).update(attempts=F("attempts") + 1)
        return False
