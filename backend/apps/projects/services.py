"""Project writes: projects, members, access requests, statuses, labels, recents."""

from __future__ import annotations

import re
import uuid
from typing import Any

from django.db import IntegrityError, transaction
from django.db.models import Max
from django.utils import timezone

from apps.access import services as access
from apps.access.catalogue import PROJECT, PROJECT_ADMIN_PERMISSION
from apps.access.models import Role
from apps.audit.services import change, record
from apps.common.exceptions import conflict, forbidden, invalid, not_found
from apps.workspaces.models import WorkspaceMember

from . import selectors, templates
from .models import AccessRequest, Label, Project, ProjectKeyAlias, ProjectMember, Recent, Status

KEY_RE = re.compile(r"^[A-Z]{2,5}$")
COLOR_RE = re.compile(r"^(var\(--[a-z0-9-]{1,30}\)|#[0-9a-fA-F]{3,8})$")


def _uuid(value: Any) -> bool:
    try:
        uuid.UUID(str(value))
    except (TypeError, ValueError):
        return False
    return True


def key_available(ws: Any, key: str, *, exclude: Project | None = None) -> bool:
    live = Project.objects.filter(workspace=ws, key=key)
    aliases = ProjectKeyAlias.objects.filter(workspace=ws, key=key, project__deleted_at__isnull=True)
    if exclude is not None:
        live = live.exclude(pk=exclude.pk)
        aliases = aliases.exclude(project=exclude)
    return not live.exists() and not aliases.exists()


def _reserve_key(project: Project, key: str) -> None:
    # A soft-deleted project's reservation gives way; restoring it later re-checks its key.
    ProjectKeyAlias.objects.filter(workspace=project.workspace, key=key, project__deleted_at__isnull=False).delete()
    ProjectKeyAlias.objects.get_or_create(workspace=project.workspace, key=key, defaults={"project": project})


def _hue(value: Any, field: str = "hue") -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 360:
        raise invalid({field: "Pick a color"})
    return value


# ───────────────────────── projects ─────────────────────────


@transaction.atomic
def create_project(actor: Any, ws: Any, data: dict[str, Any]) -> Project:
    name = str(data.get("name") or "").strip()
    key = str(data.get("key") or "").strip().upper()
    template = data.get("template") or templates.DEFAULT_TEMPLATE
    fields: dict[str, str] = {}
    if len(name) < 2:
        fields["name"] = "Name the project (2+ characters)"
    if not KEY_RE.match(key):
        fields["key"] = "Key: 2–5 letters"
    elif not key_available(ws, key):
        fields["key"] = f"{key} is already used in this workspace"
    if template not in templates.TEMPLATES:
        fields["template"] = "Pick a template"
    if fields:
        raise invalid(fields)
    try:
        with transaction.atomic():
            project = Project.objects.create(
                workspace=ws,
                key=key,
                name=name[:60],
                description=str(data.get("description") or "")[:500],
                lead=actor,
                template=template,
            )
    except IntegrityError as exc:
        raise invalid({"key": f"{key} is already used in this workspace"}) from exc
    _reserve_key(project, key)
    Status.objects.bulk_create(
        [Status(project=project, position=i, **s) for i, s in enumerate(templates.statuses_for(template))]
    )
    Label.objects.bulk_create([Label(project=project, name=n, color=c) for n, c in templates.DEFAULT_LABELS])
    # The creator administers the project. (Role identity for seeding only; access is checked by permission.)
    admin_role = Role.objects.get(workspace=ws, system_key="project_admin")
    ProjectMember.objects.create(project=project, user=actor, role=admin_role)
    access.invalidate(actor)
    record(
        workspace=ws,
        project=project,
        actor=actor,
        action="project.created",
        target=project.name,
        entity_id=project.pk,
        entity_key=key,
    )
    return project


@transaction.atomic
def update_project(actor: Any, project: Project, data: dict[str, Any]) -> Project:
    project = Project.objects.select_for_update().get(pk=project.pk)
    fields: dict[str, str] = {}
    changes = []
    if "name" in data:
        name = str(data.get("name") or "").strip()
        if len(name) < 2:
            fields["name"] = "Name the project (2+ characters)"
        elif name[:60] != project.name:
            changes.append(change("Name", project.name, name[:60]))
            project.name = name[:60]
    if "description" in data:
        description = str(data.get("description") or "")[:500]
        if description != project.description:
            changes.append(change("Description", project.description, description, "text"))
            project.description = description
    if "hue" in data:
        hue = _hue(data.get("hue"))
        if hue != project.hue:
            changes.append(change("Color", project.hue, hue))
            project.hue = hue
    if "key" in data:
        key = str(data.get("key") or "").strip().upper()
        if not KEY_RE.match(key):
            fields["key"] = "Key: 2–5 letters"
        elif key != project.key:
            if not key_available(project.workspace, key, exclude=project):
                fields["key"] = f"{key} is already used"
            else:
                # Existing task keys never change; new tasks use the new prefix.
                changes.append(change("Key", project.key, key))
                project.key = key
                _reserve_key(project, key)
    if fields:
        raise invalid(fields)
    if changes:
        project.save()
        record(
            workspace=project.workspace_id,
            project=project,
            actor=actor,
            action="project.updated",
            target=project.name,
            entity_id=project.pk,
            entity_key=project.key,
            changes=changes,
        )
    return project


@transaction.atomic
def set_archived(actor: Any, project: Project, archived: bool) -> Project:
    status = "archived" if archived else "active"
    if project.status != status:
        before = project.status
        project.status = status
        project.save(update_fields=["status", "updated_at"])
        record(
            workspace=project.workspace_id,
            project=project,
            actor=actor,
            action="project.archived" if archived else "project.unarchived",
            target=project.name,
            entity_id=project.pk,
            entity_key=project.key,
            changes=[change("Status", before, status)],
        )
    access.invalidate(actor)
    return project


@transaction.atomic
def delete_project(actor: Any, project: Project, confirm: str) -> None:
    if confirm != project.key:
        raise invalid({"confirm": f"Type {project.key} to confirm"})
    project.deleted_at = timezone.now()
    project.deleted_by = actor
    project.save(update_fields=["deleted_at", "deleted_by", "updated_at"])
    record(
        workspace=project.workspace_id,
        project=project,
        actor=actor,
        action="project.deleted",
        target=project.name,
        entity_id=project.pk,
        entity_key=project.key,
    )


@transaction.atomic
def restore_project(actor: Any, project: Project) -> Project:
    if project.deleted_at is None:
        return project
    if not key_available(project.workspace, project.key, exclude=project):
        raise conflict(
            "key_taken",
            f"Another project already uses the key {project.key}. Rename it, then restore.",
            {"item": {"kind": "project", "id": str(project.pk)}},
        )
    project.deleted_at = None
    project.deleted_by = None
    project.save(update_fields=["deleted_at", "deleted_by", "updated_at"])
    _reserve_key(project, project.key)
    record(
        workspace=project.workspace_id,
        project=project,
        actor=actor,
        action="project.restored",
        target=project.name,
        entity_id=project.pk,
        entity_key=project.key,
    )
    return project


# ───────────────────────── members ─────────────────────────


def _project_role(project: Project, role_id: Any) -> Role:
    role = (
        Role.objects.filter(pk=role_id, workspace_id=project.workspace_id, scope=PROJECT).first()
        if _uuid(role_id)
        else None
    )
    if role is None:
        raise invalid({"roleId": "Pick a project role"})
    return role


def _guard_last_admin(project: Project, member: ProjectMember, new_role: Role | None) -> None:
    """A project never ends up without someone holding project.manage_members (via this API)."""
    if not selectors.is_project_admin_role(member.role):
        return
    if new_role is not None and selectors.is_project_admin_role(new_role):
        return
    if selectors.admin_count(project, excluding_user=member.user_id) == 0:
        raise conflict("last_project_admin", "A project needs at least one admin. Make someone else an admin first.")


@transaction.atomic
def add_member(actor: Any, project: Project, user_id: Any, role_id: Any) -> ProjectMember:
    role = _project_role(project, role_id)
    grants_admin = role.permissions.filter(code=PROJECT_ADMIN_PERMISSION).exists()
    # Workspace admins may appoint a project admin without becoming members themselves
    # (project.assign_admin); everything else needs project.manage_members on the project.
    allowed = access.can(actor, "project.manage_members", project) or (
        grants_admin and access.can(actor, "project.assign_admin", project.workspace)
    )
    if not allowed:
        raise forbidden(details={"permission": "project.manage_members"})
    target_ws_member = (
        WorkspaceMember.objects.filter(workspace_id=project.workspace_id, user_id=user_id, status="active")
        .select_related("user")
        .first()
        if _uuid(user_id)
        else None
    )
    if target_ws_member is None:
        raise invalid({"userId": "Only workspace members can join projects"})
    member = ProjectMember.objects.filter(project=project, user_id=user_id).select_related("role", "user").first()
    if member is not None:
        if member.role_id != role.pk:
            _guard_last_admin(project, member, role)
            before = member.role.name
            member.role = role
            member.save(update_fields=["role", "updated_at"])
            record(
                workspace=project.workspace_id,
                project=project,
                actor=actor,
                action="member.role_changed",
                target=member.user.name,
                entity_id=member.user_id,
                changes=[change("Project role", before, role.name)],
            )
    else:
        member = ProjectMember.objects.create(project=project, user=target_ws_member.user, role=role)
        record(
            workspace=project.workspace_id,
            project=project,
            actor=actor,
            action="project_member.added",
            target=target_ws_member.user.name,
            entity_id=user_id,
            data={"member": target_ws_member.user.name, "role": role.name},
        )
    AccessRequest.objects.filter(project=project, user_id=user_id, status="pending").update(
        status="approved", decided_by=actor, decided_at=timezone.now()
    )
    return member


def _member(project: Project, user_id: Any) -> ProjectMember:
    member = (
        ProjectMember.objects.filter(project=project, user_id=user_id).select_related("role", "user").first()
        if _uuid(user_id)
        else None
    )
    if member is None:
        raise not_found("Member not found.")
    return member


@transaction.atomic
def change_member_role(actor: Any, project: Project, user_id: Any, role_id: Any) -> ProjectMember:
    member = _member(project, user_id)
    role = _project_role(project, role_id)
    if role.pk != member.role_id:
        _guard_last_admin(project, member, role)
        before = member.role.name
        member.role = role
        member.save(update_fields=["role", "updated_at"])
        record(
            workspace=project.workspace_id,
            project=project,
            actor=actor,
            action="member.role_changed",
            target=member.user.name,
            entity_id=member.user_id,
            changes=[change("Project role", before, role.name)],
        )
    return member


@transaction.atomic
def remove_member(actor: Any, project: Project, user_id: Any) -> None:
    member = _member(project, user_id)
    if member.user_id != actor.pk and not access.can(actor, "project.manage_members", project):
        raise forbidden(details={"permission": "project.manage_members"})
    _guard_last_admin(project, member, None)
    name = member.user.name
    member.delete()
    from apps.dashboards.services import delete_personal_for_member

    delete_personal_for_member(project, member.user_id)
    record(
        workspace=project.workspace_id,
        project=project,
        actor=actor,
        action="project_member.removed",
        target=name,
        entity_id=user_id,
    )


# ───────────────────────── access requests ─────────────────────────


@transaction.atomic
def request_access(actor: Any, project: Project, message: str = "") -> AccessRequest:
    if ProjectMember.objects.filter(project=project, user=actor).exists():
        raise conflict("already_member", "You’re already a member.")
    req = AccessRequest.objects.filter(project=project, user=actor, status="pending").first()
    if req is None:
        req = AccessRequest.objects.create(project=project, user=actor, message=str(message or "")[:300])
        record(
            workspace=project.workspace_id,
            project=project,
            actor=actor,
            action="project.access_requested",
            target=project.name,
            entity_id=req.pk,
        )
        from apps.notifications.events import emit

        emit(
            "access_request",
            workspace=project.workspace,
            project=project,
            actor=actor,
            payload={"requestId": str(req.pk)},
        )
    return req


def withdraw_access_request(actor: Any, project: Project) -> None:
    AccessRequest.objects.filter(project=project, user=actor, status="pending").update(status="withdrawn")


@transaction.atomic
def deny_access_request(actor: Any, project: Project, request_id: Any) -> AccessRequest:
    req = (
        AccessRequest.objects.filter(pk=request_id, project=project, status="pending").select_related("user").first()
        if _uuid(request_id)
        else None
    )
    if req is None:
        raise not_found("Request not found.")
    req.status = "denied"
    req.decided_by = actor
    req.decided_at = timezone.now()
    req.save(update_fields=["status", "decided_by", "decided_at", "updated_at"])
    record(
        workspace=project.workspace_id,
        project=project,
        actor=actor,
        action="project.access_denied",
        target=req.user.name,
        entity_id=req.pk,
    )
    return req


# ───────────────────────── statuses ─────────────────────────


def _status(project: Project, status_id: Any) -> Status:
    status = Status.objects.filter(pk=status_id, project=project).first() if _uuid(status_id) else None
    if status is None:
        raise not_found("Status not found.")
    return status


def _status_name(raw: Any) -> str:
    name = str(raw or "").strip()
    if not name:
        raise invalid({"name": "Name the status"})
    return name[:30]


@transaction.atomic
def create_status(actor: Any, project: Project, data: dict[str, Any]) -> Status:
    name = _status_name(data.get("name"))
    category = data.get("category") or "in_progress"
    if category not in templates.CATEGORY_GLYPH:
        raise invalid({"category": "Pick To do, In progress or Done"})
    position = (Status.objects.filter(project=project).aggregate(m=Max("position"))["m"] or 0) + 1
    status = Status.objects.create(
        project=project, name=name, category=category, glyph=templates.CATEGORY_GLYPH[category], position=position
    )
    _renumber(project)
    record(
        workspace=project.workspace_id,
        project=project,
        actor=actor,
        action="status.created",
        target=name,
        entity_id=status.pk,
    )
    status.refresh_from_db()
    return status


def _renumber(project: Project, ordered: list[Status] | None = None) -> None:
    rows = (
        ordered
        if ordered is not None
        else list(Status.objects.filter(project=project).order_by("position", "created_at"))
    )
    for i, s in enumerate(rows):
        if s.position != i:
            s.position = i
            s.save(update_fields=["position", "updated_at"])


@transaction.atomic
def update_status(actor: Any, project: Project, status_id: Any, data: dict[str, Any]) -> Status:
    status = _status(project, status_id)
    changes = []
    if "name" in data:
        name = _status_name(data.get("name"))
        if name != status.name:
            changes.append(change("Name", status.name, name))
            status.name = name
    if "color" in data:
        color = data.get("color")
        if color is not None and (not isinstance(color, str) or not COLOR_RE.match(color)):
            raise invalid({"color": "Pick a color"})
        status.color = color
    status.save()
    if "position" in data:
        position = data.get("position")
        if not isinstance(position, int) or isinstance(position, bool):
            raise invalid({"position": "Position must be a number"})
        rows = [
            s for s in Status.objects.filter(project=project).order_by("position", "created_at") if s.pk != status.pk
        ]
        rows.insert(max(0, min(position, len(rows))), status)
        _renumber(project, rows)
    if changes:
        record(
            workspace=project.workspace_id,
            project=project,
            actor=actor,
            action="status.updated",
            target=status.name,
            entity_id=status.pk,
            changes=changes,
        )
    status.refresh_from_db()
    return status


@transaction.atomic
def reorder_statuses(actor: Any, project: Project, ids: Any) -> list[Status]:
    current = list(Status.objects.filter(project=project))
    by_id = {str(s.pk): s for s in current}
    if not isinstance(ids, list) or sorted(map(str, ids)) != sorted(by_id):
        raise invalid({"ids": "Send every status id exactly once"})
    _renumber(project, [by_id[str(i)] for i in ids])
    record(
        workspace=project.workspace_id,
        project=project,
        actor=actor,
        action="status.reordered",
        target=project.name,
        entity_id=project.pk,
    )
    return list(Status.objects.filter(project=project).order_by("position"))


@transaction.atomic
def delete_status(actor: Any, project: Project, status_id: Any, move_to: Any = None) -> None:
    from apps.tasks.domain import apply_status
    from apps.tasks.models import Task

    status = _status(project, status_id)
    siblings = Status.objects.filter(project=project).exclude(pk=status.pk)
    if status.category in ("todo", "done") and not siblings.filter(category=status.category).exists():
        raise conflict("status_required", "A workflow needs at least one To do and one Done status.")
    live = Task.objects.filter(status=status)
    target = None
    if move_to:
        target = siblings.filter(pk=move_to).first() if _uuid(move_to) else None
        if target is None:
            raise invalid({"moveTo": "Pick another status in this project"})
    if live.exists() and target is None:
        raise conflict("status_in_use", "Move this status’s tasks before deleting it.", {"taskCount": live.count()})
    fallback = (
        target
        or siblings.filter(category=status.category).order_by("position").first()
        or siblings.order_by("position").first()
    )
    now = timezone.now()
    for task in Task.all_objects.filter(status=status).select_related("status"):
        if task.deleted_at is None:
            apply_status(task, fallback, actor, at=now)
            task.version += 1
        else:
            task.status = fallback
        task.save()
    status.delete()
    _renumber(project)
    record(
        workspace=project.workspace_id,
        project=project,
        actor=actor,
        action="status.deleted",
        target=status.name,
        entity_id=status_id,
        data={"movedTo": fallback.name if fallback else None},
    )


# ───────────────────────── labels ─────────────────────────


def _label_name(raw: Any) -> str:
    name = str(raw or "").strip().lower()[:24]
    if not name:
        raise invalid({"name": "Name the label"})
    return name


def _color(raw: Any) -> str:
    if not isinstance(raw, str) or not COLOR_RE.match(raw):
        raise invalid({"color": "Pick a color"})
    return raw


@transaction.atomic
def create_label(actor: Any, project: Project, data: dict[str, Any]) -> Label:
    name = _label_name(data.get("name"))
    existing = Label.objects.filter(project=project, name__iexact=name).first()
    if existing:
        return existing
    color = _color(data["color"]) if data.get("color") else "var(--text-3)"
    label = Label.objects.create(project=project, name=name, color=color)
    record(
        workspace=project.workspace_id,
        project=project,
        actor=actor,
        action="label.created",
        target=name,
        entity_id=label.pk,
    )
    return label


def _label(project: Project, label_id: Any) -> Label:
    label = Label.objects.filter(pk=label_id, project=project).first() if _uuid(label_id) else None
    if label is None:
        raise not_found("Label not found.")
    return label


@transaction.atomic
def update_label(actor: Any, project: Project, label_id: Any, data: dict[str, Any]) -> Label:
    label = _label(project, label_id)
    changes = []
    if "name" in data:
        name = _label_name(data.get("name"))
        if Label.objects.filter(project=project, name__iexact=name).exclude(pk=label.pk).exists():
            raise invalid({"name": "A label with this name exists"})
        if name != label.name:
            changes.append(change("Name", label.name, name))
            label.name = name
    if "color" in data:
        label.color = _color(data.get("color"))
    label.save()
    if changes:
        record(
            workspace=project.workspace_id,
            project=project,
            actor=actor,
            action="label.updated",
            target=label.name,
            entity_id=label.pk,
            changes=changes,
        )
    return label


@transaction.atomic
def delete_label(actor: Any, project: Project, label_id: Any) -> None:
    label = _label(project, label_id)
    record(
        workspace=project.workspace_id,
        project=project,
        actor=actor,
        action="label.deleted",
        target=label.name,
        entity_id=label.pk,
    )
    label.delete()


# ───────────────────────── recents ─────────────────────────


def record_recent(user: Any, kind: str, object_id: Any) -> None:
    Recent.objects.update_or_create(user=user, object_id=object_id, defaults={"kind": kind, "at": timezone.now()})
    stale = Recent.objects.filter(user=user).order_by("-at").values_list("pk", flat=True)[30:]
    if stale:
        Recent.objects.filter(pk__in=list(stale)).delete()
