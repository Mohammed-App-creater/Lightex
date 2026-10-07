"""Task writes: create, update, move, delete/restore, bulk, links. Every write bumps `version`,
records status history where relevant, writes audit rows and emits domain events."""

from __future__ import annotations

import datetime as dt
from typing import Any

from django.contrib.postgres.search import SearchVector
from django.db import transaction
from django.db.models import TextField, Value
from django.utils import timezone

from apps.access import services as access
from apps.audit.services import change, record
from apps.common import fractional
from apps.common.exceptions import ApiError, conflict, forbidden, invalid, not_found
from apps.common.richtext import doc_text, mention_ids, sanitize_doc
from apps.notifications.events import emit
from apps.planning.models import Epic, Milestone, Objective, Sprint, SprintScopeChange
from apps.projects.models import Label, Project, ProjectMember, Status

from . import selectors
from .domain import apply_status, initial_history
from .models import Task, TaskLabel, TaskObjective

MAX_BULK = 200


# ───────────────────────── helpers ─────────────────────────


def can_edit(user: Any, task: Task) -> bool:
    """task.edit_any, or task.edit_own when the user reported or is assigned the task."""
    project = task.project
    if access.can(user, "task.edit_any", project):
        return True
    return access.can(user, "task.edit_own", project) and user.pk in (task.assignee_id, task.reporter_id)


def current_payload(task: Task) -> dict[str, Any]:
    from .serializers import task_data

    fresh = selectors.annotated(Task.all_objects.filter(pk=task.pk)).select_related("status").get()
    return task_data(fresh)


def check_version(task: Task, version: Any) -> None:
    if version is None:
        raise invalid({"version": "Send the version you edited (optimistic concurrency)."})
    if not isinstance(version, int) or isinstance(version, bool) or version != task.version:
        raise ApiError(409, "version_conflict", "Someone else changed this card.", {"current": current_payload(task)})


def _ref(model: Any, project: Project, value: Any, field: str, **extra: Any) -> Any:
    if value is None:
        return None
    obj = model.objects.filter(pk=value, project=project, **extra).first() if selectors.is_uuid(value) else None
    if obj is None:
        raise invalid({field: "Pick one from this project"})
    return obj


def _status(project: Project, value: Any) -> Status:
    status = _ref(Status, project, value, "statusId")
    if status is None:
        raise invalid({"statusId": "Pick a status"})
    return status


def _default_status(project: Project) -> Status:
    statuses = list(project.statuses.order_by("position"))
    for s in statuses:
        if s.glyph == "todo":
            return s
    for s in statuses:
        if s.category == "todo":
            return s
    return statuses[0]


def _assignee(project: Project, value: Any) -> Any:
    if value is None:
        return None
    member = (
        ProjectMember.objects.filter(project=project, user_id=value).select_related("user").first()
        if selectors.is_uuid(value)
        else None
    )
    if member is None:
        raise invalid({"assigneeId": "Assign someone on this project"})
    return member.user


def _sprint(project: Project, value: Any) -> Sprint | None:
    sprint = _ref(Sprint, project, value, "sprintId")
    if sprint is not None and sprint.state == "completed":
        raise invalid({"sprintId": "That sprint is complete. Pick an active or planned sprint."})
    return sprint


def _labels(project: Project, values: Any) -> list[Label]:
    ids = _id_list(values, "labelIds")
    found = list(Label.objects.filter(project=project, pk__in=ids))
    if len(found) != len(ids):
        raise invalid({"labelIds": "Pick labels from this project"})
    return found


def _objectives(project: Project, values: Any) -> list[Objective]:
    ids = _id_list(values, "objectiveIds")
    found = list(Objective.objects.filter(project=project, pk__in=ids))
    if len(found) != len(ids):
        raise invalid({"objectiveIds": "Pick objectives from this project"})
    return found


def _id_list(values: Any, field: str) -> list[str]:
    if not isinstance(values, list) or not all(selectors.is_uuid(v) for v in values):
        raise invalid({field: "Send a list of ids"})
    return list(dict.fromkeys(str(v) for v in values))


def _title(value: Any) -> str:
    title = str(value or "").strip()
    if not title:
        raise invalid({"title": "Give the task a title"})
    return title[:200]


def _estimate(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise invalid({"estimate": "Estimate is a number of points"})
    return max(0, min(99, round(value)))


def _priority(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 4:
        raise invalid({"priority": "Priority is 0–4"})
    return value


def _type(value: Any) -> str:
    if value not in ("feature", "bug", "chore", "spike"):
        raise invalid({"type": "Pick feature, bug, chore or spike"})
    return value


def _due(value: Any) -> dt.date | None:
    if value is None:
        return None
    try:
        return dt.date.fromisoformat(str(value))
    except ValueError as exc:
        raise invalid({"dueDate": "Pick a date"}) from exc


def last_position(project_id: Any, status_id: Any, *, exclude: Any = None) -> str:
    qs = Task.objects.filter(project_id=project_id, status_id=status_id)
    if exclude is not None:
        qs = qs.exclude(pk=exclude)
    last = qs.order_by("-position").values_list("position", flat=True).first()
    return fractional.key_between(last, None)


def rebalance_column(project_id: Any, status_id: Any) -> None:
    """Rewrites a column's positions as short, evenly spaced keys (rare: only when keys grow long)."""
    rows = list(Task.objects.filter(project_id=project_id, status_id=status_id).order_by("position", "created_at"))
    for task, key in zip(rows, fractional.evenly_spaced(len(rows)), strict=True):
        if task.position != key:
            Task.objects.filter(pk=task.pk).update(position=key)


def refresh_search_vector(task: Task) -> None:
    text = doc_text(task.description, mention_prefix=False)
    Task.all_objects.filter(pk=task.pk).update(
        search_vector=SearchVector("key", config="simple", weight="A")
        + SearchVector("title", config="english", weight="A")
        + SearchVector(Value(text, output_field=TextField()), config="english", weight="B")
    )


def _track_scope(task: Task, old_sprint_id: Any, new_sprint_id: Any, actor: Any) -> None:
    """Scope changes are recorded for tasks entering or leaving an active sprint."""
    if old_sprint_id == new_sprint_id:
        return
    for sprint_id, kind in ((old_sprint_id, "removed"), (new_sprint_id, "added")):
        if sprint_id and Sprint.objects.filter(pk=sprint_id, state="active").exists():
            SprintScopeChange.objects.create(
                sprint_id=sprint_id, task=task, kind=kind, estimate=task.estimate, actor=actor
            )


def _audit(task: Task, actor: Any, action: str, changes: list | None = None, data: dict | None = None) -> None:
    record(
        workspace=task.project.workspace_id,
        project=task.project_id,
        task=task,
        actor=actor,
        action=action,
        target=task.title,
        entity_id=task.pk,
        entity_key=task.key,
        changes=changes,
        data=data,
    )


def _name(obj: Any) -> str | None:
    if obj is None:
        return None
    return getattr(obj, "name", None) or getattr(obj, "title", None)


# ───────────────────────── create ─────────────────────────


@transaction.atomic
def create_task(actor: Any, project: Project, data: dict[str, Any]) -> Task:
    if not access.can(actor, "task.create", project):
        raise forbidden(details={"permission": "task.create"})
    title = _title(data.get("title"))
    status = _status(project, data["statusId"]) if data.get("statusId") else _default_status(project)
    assignee = _assignee(project, data.get("assigneeId"))
    if assignee is not None and assignee.pk != actor.pk and not access.can(actor, "task.assign", project):
        raise forbidden("You can’t assign tasks to others.", {"permission": "task.assign"})
    parent = _ref(Task, project, data.get("parentId"), "parentId")
    if parent is not None and parent.parent_id is not None:
        raise invalid({"parentId": "Subtasks can’t have subtasks"})
    if "sprintId" in data:
        sprint = _sprint(project, data.get("sprintId"))
    else:  # new tasks join the active sprint unless the caller says otherwise
        sprint = Sprint.objects.filter(project=project, state="active").first()
    epic = _ref(Epic, project, data.get("epicId"), "epicId")
    milestone = _ref(Milestone, project, data.get("milestoneId"), "milestoneId")
    if parent is not None:
        sprint = parent.sprint
        epic = epic or parent.epic
    labels = _labels(project, data["labelIds"]) if data.get("labelIds") else []
    description = sanitize_doc(data.get("description"))

    locked = Project.objects.select_for_update().get(pk=project.pk)  # serialises key allocation
    locked.task_seq += 1
    locked.save(update_fields=["task_seq", "updated_at"])
    now = timezone.now()
    task = Task(
        project=locked,
        number=locked.task_seq,
        key=f"{locked.key}-{locked.task_seq}",
        title=title,
        description=description,
        type=_type(data.get("type") or "feature"),
        priority=_priority(data.get("priority", 0)),
        assignee=assignee,
        reporter=actor,
        estimate=_estimate(data.get("estimate")),
        due_date=_due(data.get("dueDate")),
        epic=epic,
        milestone=milestone,
        sprint=sprint,
        parent=parent,
        position=last_position(project.pk, status.pk),
        created_at=now,
    )
    apply_status(task, status, actor, at=now)
    task.save()
    initial_history(task, actor, at=now)
    TaskLabel.objects.bulk_create([TaskLabel(task=task, label=lb) for lb in labels])
    refresh_search_vector(task)
    if sprint is not None:
        _track_scope(task, None, sprint.pk, actor)
    _audit(
        task,
        actor,
        "task.created",
        [change("Title", None, title, "text"), change("Status", None, status.glyph, "status")],
    )
    if assignee is not None:
        emit(
            "task_assigned",
            workspace=project.workspace_id,
            project=project,
            actor=actor,
            payload={"taskId": str(task.pk), "assigneeId": str(assignee.pk)},
        )
    _emit_mentions(task, actor, mention_ids(description), [])
    return task


def _emit_mentions(task: Task, actor: Any, now: list[str], before: list[str]) -> None:
    new = [m for m in now if m not in before]
    if new:
        emit(
            "mentioned",
            workspace=task.project.workspace_id,
            project=task.project_id,
            actor=actor,
            payload={
                "taskId": str(task.pk),
                "userIds": new,
                "quote": doc_text(task.description)[:140],
                "source": "description",
            },
        )


# ───────────────────────── update ─────────────────────────

EDITABLE = {
    "title", "type", "priority", "statusId", "assigneeId", "estimate", "dueDate", "epicId", "milestoneId",
    "sprintId", "objectiveIds", "labelIds", "description",
}  # fmt: skip


def _authorize_patch(actor: Any, task: Task, keys: set[str]) -> None:
    editable = can_edit(actor, task)
    if keys == {"statusId"}:
        if not editable and not access.can(actor, "task.move", task.project):
            raise forbidden("You can’t change this task’s status.", {"permission": "task.move"})
    elif not editable:
        raise forbidden("You can only edit tasks you reported or are assigned.", {"permission": "task.edit_any"})


@transaction.atomic
def update_task(actor: Any, task: Task, data: dict[str, Any]) -> Task:
    task = Task.all_objects.select_for_update().select_related("project", "status").get(pk=task.pk)
    check_version(task, data.get("version"))
    if task.deleted_at is not None:
        raise conflict("task_deleted", "This task was deleted. Restore it to make changes.")
    keys = {k for k in data if k in EDITABLE}
    unknown = set(data) - EDITABLE - {"version"}
    if unknown:
        raise invalid({sorted(unknown)[0]: "This field can’t be changed here"})
    _authorize_patch(actor, task, keys)
    project = task.project
    changes: list[dict[str, Any]] = []
    status_change = assign_change = None
    linked: list[Objective] = []
    mentions_before = mention_ids(task.description)

    if "assigneeId" in keys:
        assignee = _assignee(project, data["assigneeId"])
        if (assignee.pk if assignee else None) != task.assignee_id:
            if not access.can(actor, "task.assign", project):
                raise forbidden("You can’t reassign tasks.", {"permission": "task.assign"})
            assign_change = change("Assignee", task.assignee_id, assignee.pk if assignee else None, "person")
            task.assignee = assignee
    if "title" in keys:
        title = _title(data["title"])
        if title != task.title:
            changes.append(change("Title", task.title, title, "text"))
            task.title = title
    if "type" in keys:
        new_type = _type(data["type"])
        if new_type != task.type:
            changes.append(change("Type", task.type, new_type))
            task.type = new_type
    if "priority" in keys:
        priority = _priority(data["priority"])
        if priority != task.priority:
            changes.append(change("Priority", task.priority, priority, "priority"))
            task.priority = priority
    if "estimate" in keys:
        estimate = _estimate(data["estimate"])
        if estimate != task.estimate:
            changes.append(change("Estimate", task.estimate, estimate))
            task.estimate = estimate
    if "dueDate" in keys:
        due = _due(data["dueDate"])
        if due != task.due_date:
            changes.append(change("Due date", task.due_date, due))
            task.due_date = due
    if "epicId" in keys:
        epic = _ref(Epic, project, data["epicId"], "epicId")
        if (epic.pk if epic else None) != task.epic_id:
            changes.append(change("Epic", _name(task.epic), _name(epic)))
            task.epic = epic
    if "milestoneId" in keys:
        milestone = _ref(Milestone, project, data["milestoneId"], "milestoneId")
        if (milestone.pk if milestone else None) != task.milestone_id:
            changes.append(change("Milestone", _name(task.milestone), _name(milestone)))
            task.milestone = milestone
    if "sprintId" in keys:
        if task.parent_id is not None:
            raise invalid({"sprintId": "Subtasks follow their parent’s sprint"})
        sprint = _sprint(project, data["sprintId"])
        if (sprint.pk if sprint else None) != task.sprint_id:
            changes.append(change("Sprint", _name(task.sprint), _name(sprint)))
            _track_scope(task, task.sprint_id, sprint.pk if sprint else None, actor)
            task.sprint = sprint
            Task.objects.filter(parent=task).update(sprint=sprint)
    if "description" in keys:
        description = sanitize_doc(data["description"])
        if description != task.description:
            changes.append(change("Description", doc_text(task.description)[:200], doc_text(description)[:200], "text"))
            task.description = description
    if "statusId" in keys:
        status = _status(project, data["statusId"])
        if status.pk != task.status_id:
            before = task.status
            apply_status(task, status, actor)
            task.position = last_position(project.pk, status.pk, exclude=task.pk)
            status_change = (before, status)
    if "labelIds" in keys:
        labels = _labels(project, data["labelIds"])
        current = set(TaskLabel.objects.filter(task=task).values_list("label_id", flat=True))
        wanted = {lb.pk for lb in labels}
        if wanted != current:
            TaskLabel.objects.filter(task=task).exclude(label_id__in=wanted).delete()
            TaskLabel.objects.bulk_create([TaskLabel(task=task, label_id=i) for i in wanted - current])
            changes.append(change("Labels", len(current), len(wanted)))
    if "objectiveIds" in keys:
        linked = _set_objectives(task, _objectives(project, data["objectiveIds"]))

    task.version += 1
    task.save()
    if {"title", "description"} & keys:
        refresh_search_vector(task)
    if status_change:
        before, after = status_change
        _audit(
            task,
            actor,
            "task.status_changed",
            [change("Status", before.glyph, after.glyph, "status")],
            {"from": before.name, "to": after.name},
        )
        emit(
            "status_change",
            workspace=project.workspace_id,
            project=project,
            actor=actor,
            payload={"taskId": str(task.pk), "fromStatus": before.name, "toStatus": after.name},
        )
    if assign_change:
        name = task.assignee.name if task.assignee else "nobody"
        _audit(task, actor, "task.assigned", [assign_change], {"assignee": name})
        if task.assignee_id:
            emit(
                "task_assigned",
                workspace=project.workspace_id,
                project=project,
                actor=actor,
                payload={"taskId": str(task.pk), "assigneeId": str(task.assignee_id)},
            )
    for objective in linked:
        _audit(
            task,
            actor,
            "task.objective_linked",
            [change("Objective", None, objective.title)],
            {"objective": objective.title},
        )
    if changes:
        _audit(task, actor, "task.updated", changes)
    if "description" in keys:
        _emit_mentions(task, actor, mention_ids(task.description), mentions_before)
    return task


def _set_objectives(task: Task, objectives: list[Objective]) -> list[Objective]:
    current = set(TaskObjective.objects.filter(task=task).values_list("objective_id", flat=True))
    wanted = {o.pk for o in objectives}
    TaskObjective.objects.filter(task=task).exclude(objective_id__in=wanted).delete()
    added = [o for o in objectives if o.pk not in current]
    TaskObjective.objects.bulk_create([TaskObjective(task=task, objective=o) for o in added])
    return added


@transaction.atomic
def set_task_objectives(actor: Any, task: Task, objective_ids: Any) -> Task:
    return update_task(actor, task, {"objectiveIds": objective_ids, "version": task.version})


@transaction.atomic
def set_task_labels(actor: Any, task: Task, label_ids: Any) -> Task:
    return update_task(actor, task, {"labelIds": label_ids, "version": task.version})


# ───────────────────────── move (board) ─────────────────────────


@transaction.atomic
def move_task(actor: Any, task: Task, data: dict[str, Any]) -> Task:
    task = Task.objects.select_for_update().select_related("project", "status").get(pk=task.pk)
    if not access.can(actor, "task.move", task.project):
        raise forbidden(details={"permission": "task.move"})
    check_version(task, data.get("version"))
    raw_position = data.get("position")
    if not isinstance(raw_position, str) or not fractional.is_valid_key(raw_position):
        raise invalid({"position": "Invalid position"})
    position: str = raw_position
    project = task.project
    before = task.status
    if data.get("statusId"):
        status = _status(project, data["statusId"])
        apply_status(task, status, actor)
    if "sprintId" in data:
        if task.parent_id is not None:
            raise invalid({"sprintId": "Subtasks follow their parent’s sprint"})
        sprint = _sprint(project, data.get("sprintId"))
        new_id = sprint.pk if sprint else None
        if new_id != task.sprint_id:
            _track_scope(task, task.sprint_id, new_id, actor)
            task.sprint = sprint
            Task.objects.filter(parent=task).update(sprint=sprint)
    task.position = position
    task.version += 1
    task.save()
    if len(position) > fractional.REBALANCE_LENGTH:
        rebalance_column(project.pk, task.status_id)
        task.refresh_from_db()
    if before.pk != task.status_id:
        _audit(
            task,
            actor,
            "task.status_changed",
            [change("Status", before.glyph, task.status.glyph, "status")],
            {"from": before.name, "to": task.status.name},
        )
        emit(
            "status_change",
            workspace=project.workspace_id,
            project=project,
            actor=actor,
            payload={"taskId": str(task.pk), "fromStatus": before.name, "toStatus": task.status.name},
        )
    return task


# ───────────────────────── delete / restore ─────────────────────────


@transaction.atomic
def delete_task(actor: Any, task: Task) -> None:
    if not access.can(actor, "task.delete", task.project):
        raise forbidden(details={"permission": "task.delete"})
    now = timezone.now()
    Task.objects.filter(pk=task.pk).update(deleted_at=now, deleted_by=actor, version=task.version + 1, updated_at=now)
    Task.objects.filter(parent=task).update(deleted_at=now, deleted_by=actor, updated_at=now)
    _audit(task, actor, "task.deleted", [change("Title", task.title, None)])


@transaction.atomic
def restore_task(actor: Any, task: Task) -> Task:
    if not access.can(actor, "task.delete", task.project):
        raise forbidden(details={"permission": "task.delete"})
    if task.deleted_at is None:
        return task
    if task.parent_id and Task.all_objects.filter(pk=task.parent_id, deleted_at__isnull=False).exists():
        raise conflict("parent_deleted", "Restore the parent task first.")
    when = task.deleted_at
    Task.all_objects.filter(parent=task, deleted_at=when).update(deleted_at=None, deleted_by=None)
    task.deleted_at = None
    task.deleted_by = None
    task.version += 1
    task.save(update_fields=["deleted_at", "deleted_by", "version", "updated_at"])
    _audit(task, actor, "task.restored")
    return task


# ───────────────────────── bulk ─────────────────────────

BULK_FIELDS = {"statusId", "assigneeId", "labelIds", "sprintId", "priority", "epicId", "milestoneId", "dueDate"}


@transaction.atomic
def bulk(actor: Any, project: Project, data: dict[str, Any]) -> list[Task]:
    raw_ids = data.get("ids")
    if not isinstance(raw_ids, list) or not raw_ids:
        raise invalid({"ids": "Pick at least one task"})
    if len(raw_ids) > MAX_BULK:
        raise invalid({"ids": f"Up to {MAX_BULK} tasks at a time"})
    ids = _id_list(raw_ids, "ids")
    tasks = list(
        Task.all_objects.select_for_update().select_related("project", "status").filter(pk__in=ids, project=project)
    )
    if len(tasks) != len(ids):
        raise not_found("Some of those tasks aren’t in this project.")
    if data.get("delete") or data.get("restore"):
        if not access.can(actor, "task.delete", project):
            raise forbidden(details={"permission": "task.delete"})
        for task in tasks:
            if data.get("delete") and task.deleted_at is None:
                delete_task(actor, task)
            elif data.get("restore") and task.deleted_at is not None:
                restore_task(actor, task)
        return list(Task.all_objects.filter(pk__in=ids))
    patch = data.get("patch") or {}
    if not isinstance(patch, dict) or not patch:
        raise invalid({"patch": "Nothing to change"})
    unknown = set(patch) - BULK_FIELDS
    if unknown:
        raise invalid({f"patch.{sorted(unknown)[0]}": "This field can’t be bulk-edited"})
    if "assigneeId" in patch and not access.can(actor, "task.assign", project):
        raise forbidden("You can’t reassign tasks.", {"permission": "task.assign"})
    for task in tasks:
        if task.deleted_at is not None:
            raise conflict("task_deleted", f"{task.key} is deleted.")
        _authorize_patch(actor, task, set(patch))
    out = []
    for task in tasks:
        single = dict(patch)
        if "labelIds" in single:  # bulk labels are added, not replaced
            existing = [str(i) for i in TaskLabel.objects.filter(task=task).values_list("label_id", flat=True)]
            single["labelIds"] = list(
                dict.fromkeys(existing + [str(i) for i in _id_list(single["labelIds"], "labelIds")])
            )
        single["version"] = task.version
        out.append(update_task(actor, task, single))
    return out
