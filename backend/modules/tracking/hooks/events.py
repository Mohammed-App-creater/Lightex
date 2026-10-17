"""Tracking's event types and notification handlers (task, sprint, project access and import notifications)."""

from __future__ import annotations

from typing import Any

from django.conf import settings

from core.accounts.models import User
from core.events.models import DomainEvent
from core.events.registry import register_handler
from core.notifications.emails import base_context, queue_email
from core.notifications.handlers import deliver, preferences_for, recipients
from modules.tracking.module import PROJECT_ADMIN_PERMISSION

from .targets import _fmt, task_channel_context, task_context

MODULE = "tracking"


def _task(event: DomainEvent) -> Any:
    from modules.tracking.tasks.models import Task

    task_id = event.payload.get("taskId") or (event.target_id if event.target_type == "tracking.task" else None)
    return Task.objects.select_related("project", "project__workspace", "sprint").filter(pk=task_id).first()


def _task_target(task: Any) -> tuple[str, Any]:
    return ("tracking.task", task.pk)


def _actor_name(event: DomainEvent, default: str = "") -> str:
    return event.actor.name if event.actor is not None else default


def _channel(event: DomainEvent, task: Any = None, **extra: Any) -> dict[str, Any]:
    ctx: dict[str, Any] = {"actor_name": _actor_name(event), "workspace_slug": "", **extra}
    if task is not None:
        ctx.update(task_channel_context(task))
        ctx.update(extra)
    return ctx


def on_task_assigned(event: DomainEvent) -> None:
    task = _task(event)
    if task is None:
        return
    for user in recipients(event, [event.payload.get("assigneeId")], target=_task_target(task)):
        deliver(
            event,
            user,
            kind="assigned",
            pref="tracking.task.assigned",
            target=_task_target(task),
            email_template="task_assigned",
            email_context={**task_context(task), "assigner_name": _actor_name(event, "Someone")},
            channel_context=_channel(event, task),
            urgent=task.priority == 4,
        )


def on_status_change(event: DomainEvent) -> None:
    task = _task(event)
    if task is None:
        return
    payload = {"fromStatus": event.payload.get("fromStatus"), "toStatus": event.payload.get("toStatus")}
    if event.payload.get("via"):  # board 37: a status change made by an integration's automation
        payload["via"] = event.payload["via"]
    for user in recipients(event, [task.assignee_id, task.reporter_id], target=_task_target(task)):
        deliver(
            event,
            user,
            kind="status",
            pref="tracking.task.status_changed",
            target=_task_target(task),
            payload=payload,
            channel_context=_channel(event, task, from_status=payload["fromStatus"], to_status=payload["toStatus"]),
            urgent=task.priority == 4,
        )


def on_due_soon(event: DomainEvent) -> None:
    task = _task(event)
    if task is None or task.assignee_id is None:
        return
    relative = event.payload.get("relative", "soon")
    for user in recipients(event, [task.assignee_id], target=_task_target(task)):
        deliver(
            event,
            user,
            kind="due",
            pref="tracking.task.due_soon",
            target=_task_target(task),
            payload={"dueDate": task.due_date.isoformat() if task.due_date else None},
            email_template="due_soon",
            email_context={**task_context(task), "due_relative": relative},
            channel_context=_channel(event, task, due_relative=relative),
            urgent=task.priority == 4,
        )


def _sprint(event: DomainEvent) -> Any:
    from modules.tracking.planning.models import Sprint

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


def _member_ids(project: Any) -> Any:
    from modules.tracking.projects.models import ProjectMember

    return ProjectMember.objects.filter(project=project).values_list("user_id", flat=True)


def on_sprint_started(event: DomainEvent) -> None:
    from django.db.models import Sum

    from modules.tracking.tasks.models import Task

    sprint = _sprint(event)
    if sprint is None:
        return
    tasks = Task.objects.filter(sprint=sprint).exclude(status__glyph="canceled")
    context = {
        **_sprint_context(sprint),
        "task_count": tasks.count(),
        "points_total": tasks.aggregate(p=Sum("estimate"))["p"] or 0,
    }
    target = ("tracking.sprint", sprint.pk)
    for user in recipients(event, _member_ids(sprint.project), target=target):
        deliver(
            event,
            user,
            kind="sprint",
            pref="tracking.sprint.started",
            target=target,
            payload={"sprintName": sprint.name},
            email_template="sprint_started",
            email_context={**context, "your_task_count": tasks.filter(assignee=user).count()},
            channel_context={
                **_channel(event),
                "sprint_id": str(sprint.pk),
                "project_key": sprint.project.key,
                "workspace_slug": sprint.project.workspace.slug,
            },
        )


def on_sprint_completed(event: DomainEvent) -> None:
    """Email only: the inbox has no "sprint completed" row type."""
    from modules.tracking.planning.models import Sprint

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
    for user in recipients(event, _member_ids(sprint.project), target=("tracking.sprint", sprint.pk)):
        prefs = preferences_for(user)
        if prefs.events.get("tracking.sprint.started", {}).get("email") and prefs.email_delivery == "instant":
            queue_email(user.email, "sprint_completed", context)


def on_access_request(event: DomainEvent) -> None:
    """Tells the people who can let the requester in: the project's member managers and its lead."""
    from modules.tracking.projects.models import AccessRequest, ProjectMember

    req = (
        AccessRequest.objects.select_related("user", "project", "project__workspace")
        .filter(pk=event.payload.get("requestId"))
        .first()
    )
    if req is None or req.status != "pending":
        return
    project = req.project
    workspace = project.workspace
    admins = list(
        ProjectMember.objects.filter(project=project, role__permissions__code=PROJECT_ADMIN_PERMISSION).values_list(
            "user_id", flat=True
        )
    )
    if project.lead_id:
        admins.append(project.lead_id)
    context = {
        **base_context(workspace.slug),
        "cta_url": f"{settings.FRONTEND_URL}/{workspace.slug}/projects/{project.key}/settings?tab=members",
        "requester_name": req.user.name,
        "requester_email": req.user.email,
        "project_name": project.name,
        "scope_label": "Project",
        "workspace_name": workspace.name,
        "message": req.message or "",
    }
    target = ("tracking.project", project.pk)
    for user in recipients(event, admins, target=target):
        deliver(
            event,
            user,
            kind="access",
            pref=None,
            target=target,
            payload={"projectKey": project.key, **({"quote": req.message} if req.message else {})},
            email_template="access_request",
            email_context=context,
        )


def on_import_finished(event: DomainEvent) -> None:
    """Board 40 §5.8: one in-app row to the job's creator (a system row: no actor, no task, no email, no
    preference). Bypasses `recipients` (which drops the actor) but still requires an active project member."""
    from modules.tracking.imports.models import ImportJob
    from modules.tracking.projects.models import ProjectMember

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
        target=("tracking.project", job.project_id),
        payload={
            "importId": str(job.pk),
            "projectKey": job.project.key,
            "imported": job.imported,
            "skipped": job.skipped,
            "importStatus": job.status,
        },
    )


def register() -> None:
    """Handlers only: the event types (labels, channels, templates) are declared in modules/tracking/module.py."""
    register_handler("tracking.task.assigned", on_task_assigned, module=MODULE)
    register_handler("tracking.task.status_changed", on_status_change, module=MODULE)
    register_handler("tracking.task.due_soon", on_due_soon, module=MODULE)
    register_handler("tracking.sprint.started", on_sprint_started, module=MODULE)
    register_handler("tracking.sprint.completed", on_sprint_completed, module=MODULE)
    register_handler("tracking.project.access_requested", on_access_request, module=MODULE)
    register_handler("tracking.import.finished", on_import_finished, module=MODULE)
