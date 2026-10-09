"""Custom-field definitions (board 39): create, update, delete, reorder. Every write is audited.

Values live in `tasks.TaskFieldValue` and are written through the task PATCH (`tasks.services`).
"""

from __future__ import annotations

import uuid
from typing import Any

from django.db import transaction

from apps.audit.services import change, record
from apps.common.exceptions import conflict, invalid

from .models import FIELD_COLORS, CustomField, CustomFieldOption, Project

MAX_FIELDS = 50
MAX_OPTIONS = 50
MAX_NAME = 40
MAX_OPTION_NAME = 32
TYPES = ("text", "number", "select", "date", "user")


def _audit(project: Project, actor: Any, action: str, target: str, entity_id: Any, **extra: Any) -> None:
    record(
        workspace=project.workspace_id,
        project=project,
        actor=actor,
        action=action,
        target=target,
        entity_id=entity_id,
        **extra,
    )


def _lock(project: Project) -> Project:
    """Serialises definition writes per project (limit, positions, unique names)."""
    return Project.objects.select_for_update().get(pk=project.pk)


def _clean_name(raw: Any, project: Project, errors: dict[str, str], *, exclude: Any = None) -> str:
    name = raw.strip() if isinstance(raw, str) else ""
    if not name:
        errors["name"] = "Name is required"
    elif len(name) > MAX_NAME:
        errors["name"] = f"Up to {MAX_NAME} characters"
    else:
        taken = CustomField.objects.filter(project=project, name__iexact=name)
        if exclude is not None:
            taken = taken.exclude(pk=exclude.pk)
        if taken.exists():
            errors["name"] = "A field with this name exists"
    return name


def _clean_options(raw: Any, errors: dict[str, str], field: CustomField | None = None) -> list[dict[str, Any]]:
    """The submitted options in order: [{id|None, name, color}]. Blank names are dropped first.

    Error paths use the index in the submitted array (`options.N.name`)."""
    if not isinstance(raw, list):
        errors["options"] = "Add at least one option"
        return []
    known = {str(o.pk) for o in field.options.all()} if field is not None else set()
    out: list[dict[str, Any]] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            continue
        raw_name = item.get("name")
        name = raw_name.strip() if isinstance(raw_name, str) else ""
        if not name:
            continue
        option_id = item.get("id")
        if option_id is not None and str(option_id) not in known:
            errors[f"options.{i}.id"] = "Unknown option"
        if len(name) > MAX_OPTION_NAME:
            errors[f"options.{i}.name"] = f"Up to {MAX_OPTION_NAME} characters"
        color = item.get("color")
        if color not in FIELD_COLORS:
            errors[f"options.{i}.color"] = "Pick a colour from the palette"
        out.append({"id": str(option_id) if option_id is not None else None, "name": name, "color": color})
    names = [o["name"].lower() for o in out]
    ids = [o["id"] for o in out if o["id"]]
    if not out:
        errors["options"] = "Add at least one option"
    elif len(out) > MAX_OPTIONS:
        errors["options"] = f"Up to {MAX_OPTIONS} options"
    elif len(set(names)) != len(names) or len(set(ids)) != len(ids):
        errors["options"] = "Options must be unique"
    return out


def _option_names(options: Any) -> str:
    return ", ".join(o.name if isinstance(o, CustomFieldOption) else o["name"] for o in options)


@transaction.atomic
def create_field(actor: Any, project: Project, data: dict[str, Any]) -> CustomField:
    project = _lock(project)
    count = CustomField.objects.filter(project=project).count()
    if count >= MAX_FIELDS:
        raise conflict("field_limit", f"A project can have up to {MAX_FIELDS} custom fields.")
    errors: dict[str, str] = {}
    name = _clean_name(data.get("name"), project, errors)
    field_type = data.get("type")
    if field_type not in TYPES:
        errors["type"] = "Pick text, number, select, date or person"
    options = _clean_options(data.get("options"), errors) if field_type == "select" else []
    for i, o in enumerate(options):  # ids only make sense when editing
        if o["id"]:
            errors.setdefault(f"options.{i}.id", "Unknown option")
    if errors:
        raise invalid(errors)
    required = data.get("required") is True
    field = CustomField.objects.create(
        project=project, name=name, type=str(field_type), required=required, position=count, created_by=actor
    )
    CustomFieldOption.objects.bulk_create(
        [CustomFieldOption(field=field, name=o["name"], color=o["color"], position=i) for i, o in enumerate(options)]
    )
    _audit(
        project,
        actor,
        "project.custom_field_created",
        name,
        field.pk,
        changes=[change("Type", None, field_type), change("Required", None, required)],
    )
    return field


def _apply_options(field: CustomField, wanted: list[dict[str, Any]]) -> bool:
    """Makes the field's options exactly `wanted` (in order). Removed options take their values with them."""
    current = {str(o.pk): o for o in field.options.all()}
    keep = {o["id"] for o in wanted if o["id"]}
    removed = [o for oid, o in current.items() if oid not in keep]
    changed = bool(removed)
    CustomFieldOption.objects.filter(pk__in=[o.pk for o in removed]).delete()  # values cascade
    # Two passes so swapping names never trips the case-insensitive unique index.
    kept = [current[o["id"]] for o in wanted if o["id"]]
    for o in kept:
        CustomFieldOption.objects.filter(pk=o.pk).update(name=uuid.uuid4().hex)
    for position, item in enumerate(wanted):
        if item["id"]:
            option = current[item["id"]]
            if (option.name, option.color, option.position) != (item["name"], item["color"], position):
                changed = True
            CustomFieldOption.objects.filter(pk=option.pk).update(
                name=item["name"], color=item["color"], position=position
            )
        else:
            changed = True
            CustomFieldOption.objects.create(field=field, name=item["name"], color=item["color"], position=position)
    return changed


@transaction.atomic
def update_field(actor: Any, field: CustomField, data: dict[str, Any]) -> CustomField:
    project = _lock(field.project)
    field = CustomField.objects.select_for_update().get(pk=field.pk)
    errors: dict[str, str] = {}
    if "type" in data and data.get("type") != field.type:
        errors["type"] = "A field’s type can’t be changed"
    name = _clean_name(data.get("name"), project, errors, exclude=field) if "name" in data else field.name
    options = None
    if "options" in data and field.type == "select":
        options = _clean_options(data.get("options"), errors, field)
    if errors:
        raise invalid(errors)
    changes = []
    touched = False
    if name != field.name:
        changes.append(change("Name", field.name, name))
        field.name = name
    if "required" in data:
        required = data.get("required") is True
        if required != field.required:
            changes.append(change("Required", field.required, required))
            field.required = required
    if options is not None:
        before = _option_names(sorted(field.options.all(), key=lambda o: o.position))
        touched = _apply_options(field, options)
        after = _option_names(options)
        if before != after:
            changes.append(change("Options", before, after))
    if changes or touched:
        field.save()
        _audit(project, actor, "project.custom_field_updated", field.name, field.pk, changes=changes)
    return field


def _renumber(project: Project, ordered: list[CustomField] | None = None) -> None:
    rows = ordered if ordered is not None else list(project.custom_fields.order_by("position", "created_at"))
    for i, f in enumerate(rows):
        if f.position != i:
            f.position = i
            f.save(update_fields=["position", "updated_at"])


@transaction.atomic
def delete_field(actor: Any, field: CustomField) -> None:
    project = _lock(field.project)
    removed = field.values.filter(task__deleted_at__isnull=True).count()
    _audit(
        project,
        actor,
        "project.custom_field_deleted",
        field.name,
        field.pk,
        data={"valuesRemoved": removed},
    )
    field.delete()
    _renumber(project)


@transaction.atomic
def reorder_fields(actor: Any, project: Project, ids: Any) -> None:
    project = _lock(project)
    current = list(project.custom_fields.order_by("position", "created_at"))
    by_id = {str(f.pk): f for f in current}
    if not isinstance(ids, list) or sorted(map(str, ids)) != sorted(by_id):
        raise invalid({"ids": "Send every field once"})
    ordered = [by_id[str(i)] for i in ids]
    _renumber(project, ordered)
    _audit(
        project,
        actor,
        "project.custom_fields_reordered",
        project.name,
        project.pk,
        changes=[change("Order", ", ".join(f.name for f in current), ", ".join(f.name for f in ordered))],
    )
