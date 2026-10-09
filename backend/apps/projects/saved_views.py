"""Saved views + per-user sidebar pins (board 30). Filter rules mirror the client's
src/features/filters/filter-model.ts: rows of {field, op, values} combined with AND."""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from django.db import transaction
from django.db.models import Exists, Max, OuterRef, Q, QuerySet
from django.utils import timezone

from apps.access import services as access
from apps.audit.services import record
from apps.common.exceptions import forbidden, invalid, not_found

from .models import Project, SavedView, ViewPin

ICONS = ("filter", "star", "user", "calendar", "bolt", "flag")
OPS = {
    "status": ("is", "not", "any"),
    "priority": ("is", "not", "any", "empty"),
    "assignee": ("is", "not", "any", "empty"),
    "label": ("is", "not", "any", "empty"),
    "sprint": ("is", "not", "any", "empty"),
    "epic": ("is", "not", "any", "empty"),
    "due": ("before", "after", "empty"),
    "blocked": ("is",),
}
# Board 39: `cf.<fieldId>` rules, by field type.
CF_OPS = {
    "text": ("set", "empty"),
    "number": ("gt", "lt", "set", "empty"),
    "select": ("is", "not", "any", "empty"),
    "user": ("is", "not", "any", "empty"),
    "date": ("before", "after", "empty"),
}
NO_VALUES = ("empty", "set")
VALUE_RE = re.compile(r"^[\w.-]{1,80}$")
MAX_RULES = 12
MAX_NAME = 40


def _number(value: str) -> bool:
    try:
        float(value)
    except ValueError:
        return False
    return True


def _field_types(project: Project | None) -> dict[str, str]:
    """{"cf.<id>": type} for the project's custom fields."""
    if project is None:
        return {}
    from .models import CustomField

    return {f"cf.{pk}": t for pk, t in CustomField.objects.filter(project=project).values_list("pk", "type")}


def clean_rules(raw: Any, project: Project | None = None) -> list[dict[str, Any]]:
    """Keeps the valid rows. `cf.<id>` rows need a field of `project` and an op valid for its type."""
    if not isinstance(raw, list):
        raise invalid({"filters": "Filters must be a list"})
    field_types = (
        _field_types(project)
        if any(isinstance(i, dict) and str(i.get("field", "")).startswith("cf.") for i in raw[:MAX_RULES])
        else {}
    )
    rules = []
    for item in raw[:MAX_RULES]:
        if not isinstance(item, dict):
            continue
        field, op = item.get("field"), item.get("op")
        field_type = field_types.get(field) if isinstance(field, str) else None
        allowed = CF_OPS[field_type] if field_type else OPS.get(field) if isinstance(field, str) else None
        if not allowed or op not in allowed:
            continue
        raw_values = item.get("values")
        values: list[Any] = raw_values if isinstance(raw_values, list) else []
        clean = list(dict.fromkeys(str(v) for v in values if VALUE_RE.match(str(v))))
        if op in NO_VALUES:
            clean = []
        elif op != "any":
            clean = clean[:1]
        if field == "blocked":
            clean = [v for v in clean if v in ("true", "false")]
        elif op in ("gt", "lt"):
            clean = [v for v in clean if _number(v)]
        if op in NO_VALUES or clean:  # incomplete rows are dropped
            rules.append({"field": field, "op": op, "values": clean})
    return rules


def _resolve_due(value: str, today: dt.date, sprint_end: dt.date | None) -> dt.date | None:
    if value == "today":
        return today
    if value == "tomorrow":
        return today + dt.timedelta(days=1)
    if value == "week":
        return today + dt.timedelta(days=7)
    if value == "sprint":
        return sprint_end
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        return None


_FK = {"assignee": "assignee_id", "sprint": "sprint_id", "epic": "epic_id"}


def apply_rules(qs: QuerySet, rules: list[dict[str, Any]], user: Any, project: Project) -> QuerySet:
    from apps.planning.models import Sprint

    today = timezone.now().date()
    sprint_end = Sprint.objects.filter(project=project, state="active").values_list("end_date", flat=True).first()
    field_types = _field_types(project) if any(r["field"].startswith("cf.") for r in rules) else {}
    for r in rules:
        field, op, values = r["field"], r["op"], r["values"]
        if field == "blocked":
            from apps.tasks.selectors import is_blocked

            qs = qs.filter(is_blocked() if values == ["true"] else ~is_blocked())
            continue
        if field.startswith("cf."):
            if field in field_types:  # a rule whose field was deleted is ignored
                qs = _apply_cf_rule(qs, field[3:], field_types[field], op, values, user, today, sprint_end)
            continue
        if field == "due":
            if op == "empty":
                qs = qs.filter(due_date__isnull=True)
                continue
            date = _resolve_due(values[0], today, sprint_end) if values else None
            qs = (
                qs.none() if date is None else qs.filter(**{"due_date__lt" if op == "before" else "due_date__gt": date})
            )
            continue
        if field == "status":
            cond = Q(status_id__in=[v for v in values if _uuid(v)])
        elif field == "priority":
            if op == "empty":
                qs = qs.filter(priority=0)
                continue
            cond = Q(priority__in=[int(v) for v in values if v.isdigit()])
        elif field == "label":
            if op == "empty":
                qs = qs.filter(labels__isnull=True)
                continue
            cond = Q(labels__id__in=[v for v in values if _uuid(v)])
        else:
            column = _FK[field]
            if op == "empty":
                qs = qs.filter(**{f"{column}__isnull": True})
                continue
            ids = [str(user.pk) if (field == "assignee" and v == "me") else v for v in values]
            cond = Q(**{f"{column}__in": [v for v in ids if _uuid(v)]})
        qs = qs.exclude(cond) if op == "not" else qs.filter(cond)
    return qs.distinct()


def _apply_cf_rule(
    qs: QuerySet, field_id: str, field_type: str, op: str, values: list[str], user: Any, today: dt.date, sprint_end: Any
) -> QuerySet:
    """`cf.<id>` semantics (board 39): `not` matches tasks with no value; before/after/gt/lt don't."""
    from apps.tasks.models import TaskFieldValue

    def has(**lookup: Any) -> Exists:
        return Exists(TaskFieldValue.objects.filter(task=OuterRef("pk"), **{"field_id": field_id}, **lookup))

    if op == "set":
        return qs.filter(has())
    if op == "empty":
        return qs.filter(~has())
    if op in ("gt", "lt"):
        return qs.filter(has(**{f"number__{op}": values[0]}))
    if op in ("before", "after"):
        date = _resolve_due(values[0], today, sprint_end)
        return qs.none() if date is None else qs.filter(has(**{"date__lt" if op == "before" else "date__gt": date}))
    column = "option_id" if field_type == "select" else "user_id"
    ids = [str(user.pk) if (field_type == "user" and v == "me") else v for v in values]
    match = has(**{f"{column}__in": [v for v in ids if _uuid(v)]})
    return qs.filter(~match) if op == "not" else qs.filter(match)


def _uuid(value: Any) -> bool:
    import uuid

    try:
        uuid.UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True


def count_for(view: SavedView, user: Any) -> int:
    from apps.tasks.models import Task

    return apply_rules(Task.objects.filter(project=view.project), view.filters, user, view.project).count()


def visible_views(user: Any, workspace: Any) -> list[SavedView]:
    views = (
        SavedView.objects.filter(workspace=workspace, project__deleted_at__isnull=True)
        .filter(Q(owner=user) | Q(visibility="project"))
        .select_related("project")
    )
    return [v for v in views if access.can(user, "project.view", v.project)]


def view_data(view: SavedView, user: Any) -> dict[str, Any]:
    from apps.common.utils import iso

    pin = ViewPin.objects.filter(user=user, view=view).first()
    return {
        "id": str(view.pk),
        "workspaceId": str(view.workspace_id),
        "projectId": str(view.project_id),
        "ownerId": str(view.owner_id),
        "name": view.name,
        "icon": view.icon,
        "visibility": view.visibility,
        "layout": view.layout,
        "filters": view.filters,
        "pinned": pin is not None,
        "position": pin.position if pin else 0,
        "count": count_for(view, user),
        "createdAt": iso(view.created_at),
    }


def list_for(user: Any, workspace: Any) -> list[dict[str, Any]]:
    rows = [view_data(v, user) for v in visible_views(user, workspace)]
    return sorted(rows, key=lambda r: (not r["pinned"], r["position"], r["name"].lower()))


def _name(raw: Any) -> str:
    name = str(raw or "").strip()[:MAX_NAME]
    if not name:
        raise invalid({"name": "Name is required"})
    return name


def _name_taken(user: Any, workspace: Any, name: str, exclude: Any = None) -> bool:
    qs = SavedView.objects.filter(workspace=workspace, owner=user, name__iexact=name)
    if exclude is not None:
        qs = qs.exclude(pk=exclude.pk)
    return qs.exists()


def _set_pinned(user: Any, view: SavedView, pinned: bool) -> None:
    if pinned:
        if not ViewPin.objects.filter(user=user, view=view).exists():
            last = ViewPin.objects.filter(user=user).aggregate(m=Max("position"))["m"]
            ViewPin.objects.create(user=user, view=view, position=0 if last is None else last + 1)
    else:
        ViewPin.objects.filter(user=user, view=view).delete()


@transaction.atomic
def create_view(user: Any, workspace: Any, data: dict[str, Any]) -> SavedView:
    project_id = data.get("projectId")
    project = Project.objects.filter(pk=project_id, workspace=workspace).first() if _uuid(project_id) else None
    if project is None:
        raise invalid({"projectId": "Unknown project"})
    if not access.can(user, "project.view", project):
        raise forbidden("You’re not a member of this project.", {"permission": "project.view"})
    visibility = "project" if data.get("visibility") == "project" else "me"
    if visibility == "project" and not access.can(user, "task.create", project):
        raise forbidden("Your role can’t share views with the project.", {"permission": "task.create"})
    name = _name(data.get("name"))
    if _name_taken(user, workspace, name):
        raise invalid({"name": "A view with this name exists"})
    rules = clean_rules(data.get("filters"), project)
    if not rules:
        raise invalid({"filters": "Add at least one filter"})
    view = SavedView.objects.create(
        workspace=workspace,
        project=project,
        owner=user,
        name=name,
        icon=str(data["icon"]) if data.get("icon") in ICONS else "filter",
        visibility=visibility,
        layout="board" if data.get("layout") == "board" else "list",
        filters=rules,
    )
    if data.get("pinned"):
        _set_pinned(user, view, True)
    record(workspace=workspace, project=project, actor=user, action="view.created", target=name, entity_id=view.pk)
    return view


def view_for(user: Any, view_id: Any) -> SavedView:
    view = (
        SavedView.objects.select_related("project", "workspace").filter(pk=view_id).first() if _uuid(view_id) else None
    )
    if (
        view is None
        or not (view.owner_id == user.pk or view.visibility == "project")
        or not access.can(user, "project.view", view.project)
    ):
        raise not_found("View not found.")
    return view


@transaction.atomic
def update_view(user: Any, view: SavedView, data: dict[str, Any]) -> SavedView:
    edits = {"name", "icon", "filters", "visibility"} & set(data)
    if edits and view.owner_id != user.pk:
        raise forbidden("Only the person who saved this view can change it.")
    if "name" in data:
        name = _name(data.get("name"))
        if _name_taken(user, view.workspace, name, exclude=view):
            raise invalid({"name": "A view with this name exists"})
        view.name = name
    icon = data.get("icon")
    if isinstance(icon, str) and icon in ICONS:
        view.icon = icon
    if "filters" in data:
        rules = clean_rules(data.get("filters"), view.project)
        if not rules:
            raise invalid({"filters": "Add at least one filter"})
        view.filters = rules
    if "visibility" in data:
        visibility = "project" if data.get("visibility") == "project" else "me"
        if visibility == "project" and not access.can(user, "task.create", view.project):
            raise forbidden("Your role can’t share views with the project.", {"permission": "task.create"})
        view.visibility = visibility
    view.save()
    if isinstance(data.get("pinned"), bool):
        _set_pinned(user, view, data["pinned"])
    if edits:
        record(
            workspace=view.workspace,
            project=view.project,
            actor=user,
            action="view.updated",
            target=view.name,
            entity_id=view.pk,
        )
    return view


@transaction.atomic
def delete_view(user: Any, view: SavedView) -> None:
    if view.owner_id != user.pk:
        raise forbidden("Only the person who saved this view can delete it.")
    record(
        workspace=view.workspace,
        project=view.project,
        actor=user,
        action="view.deleted",
        target=view.name,
        entity_id=view.pk,
    )
    view.delete()


@transaction.atomic
def reorder_pins(user: Any, ids: Any) -> None:
    if not isinstance(ids, list):
        raise invalid({"ids": "ids must be a list"})
    pins = {str(p.view_id): p for p in ViewPin.objects.filter(user=user)}
    for i, view_id in enumerate(map(str, ids)):
        pin = pins.get(view_id)
        if pin is not None and pin.position != i:
            pin.position = i
            pin.save(update_fields=["position", "updated_at"])
