"""Planning writes: objectives (with task links), milestones, epics. Sprints live in sprints.py."""

from __future__ import annotations

import datetime as dt
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

from apps.audit.services import change, record
from apps.common.exceptions import ApiError, invalid
from apps.projects.models import ProjectMember
from apps.tasks.models import Task, TaskObjective

from .models import Epic, Milestone, Objective
from .selectors import _uuid

MAX_LINKS = 200


def _audit(
    obj: Any, actor: Any, action: str, target: str, changes: list | None = None, data: dict | None = None
) -> None:
    record(
        workspace=obj.project.workspace_id,
        project=obj.project_id,
        actor=actor,
        action=action,
        target=target,
        entity_id=obj.pk,
        changes=changes,
        data=data,
    )


def _date(value: Any, field: str, *, required: bool = False) -> dt.date | None:
    if value in (None, ""):
        if required:
            raise invalid({field: "Pick a date"})
        return None
    try:
        return dt.date.fromisoformat(str(value))
    except ValueError as exc:
        raise invalid({field: "Pick a date"}) from exc


def _required_date(value: Any, field: str) -> dt.date:
    result = _date(value, field, required=True)
    if result is None:  # pragma: no cover - _date raises first
        raise invalid({field: "Pick a date"})
    return result


def _owner(project: Any, value: Any) -> Any:
    if value is None:
        return None
    member = (
        ProjectMember.objects.filter(project=project, user_id=value).select_related("user").first()
        if _uuid(value)
        else None
    )
    if member is None:
        raise invalid({"ownerId": "Pick a project member"})
    return member.user


def _text(value: Any, field: str, limit: int, message: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise invalid({field: message})
    return text[:limit]


def _quarter(due: dt.date | None) -> str:
    return f"Q{(due.month - 1) // 3 + 1}" if due else ""


def _project_tasks(project: Any, ids: Any) -> list[Task]:
    if not isinstance(ids, list) or not all(_uuid(i) for i in ids):
        raise invalid({"taskIds": "Send a list of task ids"})
    if len(ids) > MAX_LINKS:
        raise invalid({"taskIds": f"Up to {MAX_LINKS} tasks at a time"})
    tasks = list(Task.objects.filter(project=project, pk__in=ids))
    if len(tasks) != len(set(map(str, ids))):
        raise invalid({"taskIds": "Pick tasks from this project"})
    return tasks


# ───────────────────────── objectives ─────────────────────────


@transaction.atomic
def create_objective(actor: Any, project: Any, data: dict[str, Any]) -> Objective:
    title = _text(data.get("title"), "title", 120, "Add a title")
    due = _required_date(data.get("dueDate"), "dueDate")
    owner = _owner(project, data["ownerId"]) if data.get("ownerId") else actor
    objective = Objective.objects.create(
        project=project,
        title=title,
        description=str(data.get("description") or "")[:1000],
        owner=owner,
        quarter=str(data.get("quarter") or _quarter(due))[:16],
        due_date=due,
    )
    _audit(objective, actor, "objective.created", title)
    return objective


@transaction.atomic
def update_objective(actor: Any, objective: Objective, data: dict[str, Any]) -> Objective:
    changes = []
    if "title" in data:
        title = _text(data.get("title"), "title", 120, "Add a title")
        if title != objective.title:
            changes.append(change("Title", objective.title, title, "text"))
            objective.title = title
    if "description" in data:
        objective.description = str(data.get("description") or "")[:1000]
    if "ownerId" in data:
        owner = _owner(objective.project, data.get("ownerId"))
        if (owner.pk if owner else None) != objective.owner_id:
            changes.append(change("Owner", objective.owner_id, owner.pk if owner else None, "person"))
            objective.owner = owner
    if "dueDate" in data:
        due = _required_date(data.get("dueDate"), "dueDate")
        if due != objective.due_date:
            changes.append(change("Due date", objective.due_date, due))
            objective.due_date = due
    if "quarter" in data:
        objective.quarter = str(data.get("quarter") or "")[:16]
    if "status" in data:
        if data["status"] not in ("active", "achieved", "dropped"):
            raise invalid({"status": "Pick active, achieved or dropped"})
        if data["status"] != objective.status:
            changes.append(change("Status", objective.status, data["status"]))
            objective.status = data["status"]
    objective.save()
    if changes:
        _audit(objective, actor, "objective.updated", objective.title, changes)
    return objective


@transaction.atomic
def delete_objective(actor: Any, objective: Objective) -> None:
    linked = list(TaskObjective.objects.filter(objective=objective).values_list("task_id", flat=True))
    Task.objects.filter(pk__in=linked).update(version=F("version") + 1, updated_at=timezone.now())
    _audit(objective, actor, "objective.deleted", objective.title)
    objective.delete()


@transaction.atomic
def link_tasks(actor: Any, objective: Objective, task_ids: Any) -> Objective:
    tasks = _project_tasks(objective.project, task_ids)
    existing = set(TaskObjective.objects.filter(objective=objective).values_list("task_id", flat=True))
    added = [t for t in tasks if t.pk not in existing]
    TaskObjective.objects.bulk_create([TaskObjective(task=t, objective=objective) for t in added])
    Task.objects.filter(pk__in=[t.pk for t in added]).update(version=F("version") + 1, updated_at=timezone.now())
    for task in added:
        record(
            workspace=objective.project.workspace_id,
            project=objective.project_id,
            task=task,
            actor=actor,
            action="task.objective_linked",
            target=task.title,
            entity_id=task.pk,
            entity_key=task.key,
            changes=[change("Objective", None, objective.title)],
            data={"objective": objective.title},
        )
    return objective


@transaction.atomic
def unlink_task(actor: Any, objective: Objective, task_id: Any) -> Objective:
    if not _uuid(task_id):
        raise invalid({"taskId": "Unknown task"})
    removed, _ = TaskObjective.objects.filter(objective=objective, task_id=task_id).delete()
    if removed:
        Task.objects.filter(pk=task_id).update(version=F("version") + 1, updated_at=timezone.now())
        _audit(objective, actor, "objective.task_unlinked", objective.title, data={"taskId": str(task_id)})
    return objective


# ───────────────────────── milestones ─────────────────────────


def _set_milestone_tasks(milestone: Milestone, task_ids: Any) -> None:
    tasks = _project_tasks(milestone.project, task_ids)
    wanted = {t.pk for t in tasks}
    now = timezone.now()
    Task.objects.filter(milestone=milestone).exclude(pk__in=wanted).update(
        milestone=None, version=F("version") + 1, updated_at=now
    )
    Task.objects.filter(pk__in=wanted).exclude(milestone=milestone).update(
        milestone=milestone, version=F("version") + 1, updated_at=now
    )


@transaction.atomic
def create_milestone(actor: Any, project: Any, data: dict[str, Any]) -> Milestone:
    name = _text(data.get("name"), "name", 120, "Add a title")
    due = _required_date(data.get("dueDate"), "dueDate")
    today = timezone.now().date()
    start = _date(data.get("startDate"), "startDate") or min(today, due)
    if start > due:
        raise invalid({"startDate": "Start must be on or before the due date"})
    milestone = Milestone.objects.create(
        project=project,
        name=name,
        description=str(data.get("description") or "")[:1000],
        owner=_owner(project, data["ownerId"]) if data.get("ownerId") else actor,
        start_date=start,
        due_date=due,
    )
    if data.get("taskIds") is not None:
        _set_milestone_tasks(milestone, data["taskIds"])
    _audit(milestone, actor, "milestone.created", name)
    return milestone


@transaction.atomic
def update_milestone(actor: Any, milestone: Milestone, data: dict[str, Any]) -> Milestone:
    changes = []
    if "name" in data:
        name = _text(data.get("name"), "name", 120, "Add a title")
        if name != milestone.name:
            changes.append(change("Name", milestone.name, name))
            milestone.name = name
    if "description" in data:
        milestone.description = str(data.get("description") or "")[:1000]
    if "ownerId" in data:
        milestone.owner = _owner(milestone.project, data.get("ownerId"))
    if "startDate" in data:
        milestone.start_date = _required_date(data.get("startDate"), "startDate")
    if "dueDate" in data:
        due = _required_date(data.get("dueDate"), "dueDate")
        if due != milestone.due_date:
            changes.append(change("Due date", milestone.due_date, due))
            milestone.due_date = due
        if milestone.start_date > due and "startDate" not in data:
            milestone.start_date = due
    if milestone.start_date > milestone.due_date:
        raise invalid({"startDate": "Start must be on or before the due date"})
    if "completed" in data:
        completed = bool(data.get("completed"))
        if completed != (milestone.completed_at is not None):
            changes.append(change("Completed", milestone.completed_at is not None, completed))
            milestone.completed_at = timezone.now() if completed else None
    milestone.save()
    if data.get("taskIds") is not None:
        _set_milestone_tasks(milestone, data["taskIds"])
    if changes:
        _audit(milestone, actor, "milestone.updated", milestone.name, changes)
    return milestone


@transaction.atomic
def delete_milestone(actor: Any, milestone: Milestone) -> None:
    Task.all_objects.filter(milestone=milestone).update(
        milestone=None, version=F("version") + 1, updated_at=timezone.now()
    )
    _audit(milestone, actor, "milestone.deleted", milestone.name)
    milestone.delete()


# ───────────────────────── epics ─────────────────────────


def _epic_fields(project: Any, data: dict[str, Any], epic: Epic | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    fields: dict[str, str] = {}
    if "name" in data or epic is None:
        name = str(data.get("name") or "").strip()[:80]
        if not name:
            fields["name"] = "Name the epic"
        else:
            clash = Epic.objects.filter(project=project, name__iexact=name)
            if epic is not None:
                clash = clash.exclude(pk=epic.pk)
            if clash.exists():
                fields["name"] = "An epic with this name exists"
        out["name"] = name
    if "hue" in data:
        hue = data.get("hue")
        if isinstance(hue, bool) or not isinstance(hue, int) or not 0 <= hue <= 360:
            fields["hue"] = "Pick a color"
        out["hue"] = hue
    if "ownerId" in data:
        try:
            out["owner"] = _owner(project, data.get("ownerId"))
        except ApiError:
            fields["ownerId"] = "Pick a project member"
    if "milestoneId" in data:
        mid = data.get("milestoneId")
        milestone = Milestone.objects.filter(project=project, pk=mid).first() if mid and _uuid(mid) else None
        if mid and milestone is None:
            fields["milestoneId"] = "Pick a milestone in this project"
        out["milestone"] = milestone
    if fields:
        raise invalid(fields)
    if "description" in data:
        out["description"] = str(data.get("description") or "")[:600]
    return out


@transaction.atomic
def create_epic(actor: Any, project: Any, data: dict[str, Any]) -> Epic:
    values = _epic_fields(project, data, None)
    values.setdefault("owner", actor)
    try:
        with transaction.atomic():
            epic = Epic.objects.create(project=project, **values)
    except IntegrityError as exc:
        raise invalid({"name": "An epic with this name exists"}) from exc
    _audit(epic, actor, "epic.created", epic.name)
    return epic


@transaction.atomic
def update_epic(actor: Any, epic: Epic, data: dict[str, Any]) -> Epic:
    values = _epic_fields(epic.project, data, epic)
    changes = []
    for key, value in values.items():
        before = getattr(epic, key)
        if before != value:
            if key in ("name", "description", "hue"):
                changes.append(change(key.capitalize(), before, value))
            setattr(epic, key, value)
    if "archived" in data:
        archived = bool(data.get("archived"))
        if archived != (epic.archived_at is not None):
            changes.append(change("Archived", epic.archived_at is not None, archived))
            epic.archived_at = timezone.now() if archived else None
    epic.save()
    if changes:
        _audit(epic, actor, "epic.updated", epic.name, changes)
    return epic


@transaction.atomic
def delete_epic(actor: Any, epic: Epic) -> None:
    Task.all_objects.filter(epic=epic).update(epic=None, version=F("version") + 1, updated_at=timezone.now())
    _audit(epic, actor, "epic.deleted", epic.name)
    epic.delete()
