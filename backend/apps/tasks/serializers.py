from decimal import Decimal

from rest_framework import serializers

from apps.access import services as access
from apps.access.catalogue import ordered
from apps.common.utils import iso

from . import selectors
from .models import Task, TaskDependency, TaskFieldValue


def _id(value) -> str | None:
    return str(value) if value else None


def task_data(t: Task) -> dict:
    """The client's `Task` shape. Expects selectors.annotated() counters (falls back to queries)."""
    return {
        "id": str(t.pk),
        "projectId": str(t.project_id),
        "key": t.key,
        "number": t.number,
        "title": t.title,
        "type": t.type,
        "priority": t.priority,
        "statusId": str(t.status_id),
        "assigneeId": _id(t.assignee_id),
        "reporterId": _id(t.reporter_id) or "",
        "estimate": t.estimate,
        "dueDate": iso(t.due_date),
        "epicId": _id(t.epic_id),
        "milestoneId": _id(t.milestone_id),
        "sprintId": _id(t.sprint_id),
        "parentId": _id(t.parent_id),
        "objectiveIds": [str(o.pk) for o in t.objectives.all()],
        "labelIds": [str(lb.pk) for lb in t.labels.all()],
        "position": t.position,
        "version": t.version,
        "createdAt": iso(t.created_at),
        "updatedAt": iso(t.updated_at),
        "completedAt": iso(t.completed_at),
        "deletedAt": iso(t.deleted_at),
        "subtaskCount": _counter(t, "subtask_count", lambda: t.subtasks.count()),
        "subtaskDoneCount": _counter(
            t,
            "subtask_done_count",
            lambda: t.subtasks.filter(status__category="done").exclude(status__glyph="canceled").count(),
        ),
        "commentCount": _counter(t, "comment_count", lambda: _comments(t)),
        "attachmentCount": _counter(t, "attachment_count", lambda: _attachments(t)),
        **_board39(t),
    }


def number_out(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral_value() else float(value)


def field_value(v: TaskFieldValue) -> str | int | float | None:
    """Wire value: select → option id, user → user id, date → ISO, number → number, text → string."""
    if v.option_id:
        return str(v.option_id)
    if v.user_id:
        return str(v.user_id)
    if v.date is not None:
        return v.date.isoformat()
    if v.number is not None:
        return number_out(v.number)
    return v.text


def _board39(t: Task) -> dict:
    """Custom-field values, blockers and time. Uses selectors.annotated() prefetches (falls back to queries)."""
    links = getattr(t, "open_blocker_links", None)
    if links is None:
        links = list(
            selectors.open_blocker_links().filter(blocked=t).select_related("blocker").order_by("blocker__number")
        )
    blockers = [{"id": str(d.blocker.pk), "key": d.blocker.key, "title": d.blocker.title} for d in links]
    return {
        "customFields": {str(v.field_id): field_value(v) for v in t.field_values.all()},
        "isBlocked": bool(blockers),
        "openBlockers": blockers,
        "timeEstimateMinutes": t.time_estimate_minutes,
        "loggedMinutes": _counter(t, "logged_minutes", lambda: _logged(t)),
    }


def _logged(t: Task) -> int:
    from django.db.models import Sum

    from apps.timetracking.models import TimeEntry

    return TimeEntry.objects.filter(task=t).aggregate(s=Sum("minutes"))["s"] or 0


def _comments(t: Task) -> int:
    from apps.collaboration.models import Comment

    return Comment.objects.filter(task=t).count()


def _attachments(t: Task) -> int:
    from apps.collaboration.models import Attachment

    return Attachment.objects.filter(task=t, status="ready").count()


def _counter(t: Task, attr: str, fallback) -> int:
    value = getattr(t, attr, None)
    return value if value is not None else fallback()


def dependency_task_data(t: Task) -> dict:
    return {
        "id": str(t.pk),
        "key": t.key,
        "title": t.title,
        "statusId": str(t.status_id),
        "status": {"name": t.status.name, "glyph": t.status.glyph, "category": t.status.category},
        "assigneeId": _id(t.assignee_id),
    }


def _dependency_item(d: TaskDependency, other: Task) -> dict:
    return {
        "id": str(d.pk),
        "task": dependency_task_data(other),
        "createdAt": iso(d.created_at),
        "createdById": _id(d.created_by_id),
    }


def dependencies_data(task: Task) -> dict:
    """The client's `TaskDependencies` shape."""
    blocked_by, blocks = selectors.dependencies_of(task)
    blocked_by_items = list(blocked_by)
    return {
        "taskId": str(task.pk),
        "isBlocked": any(d.blocker.status.category != "done" for d in blocked_by_items),
        "blockedBy": [_dependency_item(d, d.blocker) for d in blocked_by_items],
        "blocks": [_dependency_item(d, d.blocked) for d in blocks],
    }


def task_detail_data(t: Task, user, subtasks) -> dict:
    project = t.project
    return {
        **task_data(t),
        "description": t.description,
        "subtasks": [task_data(s) for s in subtasks],
        "dependencies": dependencies_data(t),
        "project": {
            "id": str(project.pk),
            "key": project.key,
            "name": project.name,
            "hue": project.hue,
            "my_permissions": ordered(access.project_permissions(user, project)),
        },
    }


class TaskRefOut(serializers.Serializer):
    id = serializers.UUIDField()
    key = serializers.CharField()
    title = serializers.CharField()


class DependencyStatusOut(serializers.Serializer):
    name = serializers.CharField()
    glyph = serializers.CharField()
    category = serializers.CharField()


class DependencyTaskOut(TaskRefOut):
    statusId = serializers.UUIDField()
    status = DependencyStatusOut()
    assigneeId = serializers.UUIDField(allow_null=True)


class DependencyItemOut(serializers.Serializer):
    id = serializers.UUIDField()
    task = DependencyTaskOut()
    createdAt = serializers.DateTimeField()
    createdById = serializers.UUIDField(allow_null=True)


class TaskDependenciesOut(serializers.Serializer):
    taskId = serializers.UUIDField()
    isBlocked = serializers.BooleanField()
    blockedBy = DependencyItemOut(many=True)
    blocks = DependencyItemOut(many=True)


class DependencyIn(serializers.Serializer):
    relation = serializers.ChoiceField(choices=["blocked_by", "blocks"])
    taskId = serializers.UUIDField()


class TaskOut(serializers.Serializer):
    """Schema for the Task payload (built by task_data)."""

    id = serializers.UUIDField()
    projectId = serializers.UUIDField()
    key = serializers.CharField()
    number = serializers.IntegerField()
    title = serializers.CharField()
    type = serializers.ChoiceField(choices=["feature", "bug", "chore", "spike"])
    priority = serializers.IntegerField(min_value=0, max_value=4)
    statusId = serializers.UUIDField()
    assigneeId = serializers.UUIDField(allow_null=True)
    reporterId = serializers.UUIDField()
    estimate = serializers.IntegerField(allow_null=True)
    dueDate = serializers.DateField(allow_null=True)
    epicId = serializers.UUIDField(allow_null=True)
    milestoneId = serializers.UUIDField(allow_null=True)
    sprintId = serializers.UUIDField(allow_null=True)
    parentId = serializers.UUIDField(allow_null=True)
    objectiveIds = serializers.ListField(child=serializers.UUIDField())
    labelIds = serializers.ListField(child=serializers.UUIDField())
    position = serializers.CharField()
    version = serializers.IntegerField()
    createdAt = serializers.DateTimeField()
    updatedAt = serializers.DateTimeField()
    completedAt = serializers.DateTimeField(allow_null=True)
    deletedAt = serializers.DateTimeField(allow_null=True)
    subtaskCount = serializers.IntegerField()
    subtaskDoneCount = serializers.IntegerField()
    commentCount = serializers.IntegerField()
    attachmentCount = serializers.IntegerField()
    customFields = serializers.DictField(
        help_text="Set values only, keyed by custom field id: select → option id, user → user id, "
        "date → ISO date, number → number, text → string."
    )
    isBlocked = serializers.BooleanField()
    openBlockers = TaskRefOut(many=True)
    timeEstimateMinutes = serializers.IntegerField(allow_null=True)
    loggedMinutes = serializers.IntegerField()


class TaskPageOut(serializers.Serializer):
    data = TaskOut(many=True)  # type: ignore[assignment]
    nextCursor = serializers.CharField(allow_null=True)


class TaskDetailOut(TaskOut):
    description = serializers.JSONField(allow_null=True)
    subtasks = TaskOut(many=True)
    project = serializers.JSONField()
    dependencies = TaskDependenciesOut()


class TaskWriteIn(serializers.Serializer):
    title = serializers.CharField(required=False)
    statusId = serializers.UUIDField(required=False)
    type = serializers.ChoiceField(choices=["feature", "bug", "chore", "spike"], required=False)
    priority = serializers.IntegerField(required=False, min_value=0, max_value=4)
    assigneeId = serializers.UUIDField(required=False, allow_null=True)
    sprintId = serializers.UUIDField(required=False, allow_null=True)
    epicId = serializers.UUIDField(required=False, allow_null=True)
    milestoneId = serializers.UUIDField(required=False, allow_null=True)
    dueDate = serializers.DateField(required=False, allow_null=True)
    parentId = serializers.UUIDField(required=False, allow_null=True)
    labelIds = serializers.ListField(child=serializers.UUIDField(), required=False)
    objectiveIds = serializers.ListField(child=serializers.UUIDField(), required=False)
    description = serializers.JSONField(required=False, allow_null=True)
    estimate = serializers.IntegerField(required=False, allow_null=True)
    customFields = serializers.DictField(
        required=False, help_text="PATCH only. Merge: listed field ids are set, null clears, others are untouched."
    )
    timeEstimateMinutes = serializers.IntegerField(
        required=False, allow_null=True, help_text="PATCH only. 1–60000 minutes; null or 0 clears."
    )
    version = serializers.IntegerField(required=False)


class BulkIn(serializers.Serializer):
    ids = serializers.ListField(child=serializers.UUIDField())
    patch = TaskWriteIn(required=False)
    delete = serializers.BooleanField(required=False)
    restore = serializers.BooleanField(required=False)


class ActivityOut(serializers.Serializer):
    id = serializers.UUIDField()
    actorId = serializers.UUIDField(allow_null=True)
    verb = serializers.CharField()
    projectId = serializers.UUIDField()
    taskId = serializers.UUIDField(allow_null=True)
    taskKey = serializers.CharField(allow_null=True)
    taskTitle = serializers.CharField(allow_null=True)
    data = serializers.JSONField()  # type: ignore[assignment]
    createdAt = serializers.DateTimeField()
