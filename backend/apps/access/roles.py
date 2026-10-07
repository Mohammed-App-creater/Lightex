"""Role management: custom roles (one scope each), system-role locks, in-use protection."""

from __future__ import annotations

import uuid
from typing import Any

from django.db import transaction
from django.db.models import Count, Q

from apps.audit.services import change, record
from apps.common.exceptions import conflict, forbidden, invalid, not_found

from . import catalogue
from .catalogue import OWNER_PERMISSION, WORKSPACE
from .models import Permission, Role, RolePermission
from .services import invalidate, workspace_permissions


def roles_for(workspace: Any, scope: str | None = None):
    qs = Role.objects.filter(workspace=workspace).prefetch_related("permissions").order_by("scope", "created_at")
    if scope in ("workspace", "project"):
        qs = qs.filter(scope=scope)
    return qs.annotate(
        ws_member_count=Count("workspace_members", filter=Q(workspace_members__status="active"), distinct=True),
        project_member_count=Count("project_members__user", distinct=True),
    )


def get_role(role_id: Any) -> Role:
    try:
        uuid.UUID(str(role_id))
    except (TypeError, ValueError) as exc:
        raise not_found("Role not found.") from exc
    role = Role.objects.select_related("workspace").filter(pk=role_id, workspace__deleted_at__isnull=True).first()
    if role is None:
        raise not_found("Role not found.")
    return role


def _clean_permissions(scope: str, raw: Any) -> list[str]:
    if not isinstance(raw, list) or not all(isinstance(c, str) for c in raw):
        raise invalid({"permissions": "Pick permissions from the list"})
    unknown = [c for c in raw if catalogue.SCOPE_OF.get(c) != scope]
    if unknown:
        raise invalid({"permissions": f"{unknown[0]} isn’t a {scope} permission"})
    return catalogue.ordered(raw)


def _ensure_no_escalation(actor: Any, role_scope: str, workspace: Any, codes: set[str]) -> None:
    """A workspace role can only be given permissions the actor holds themselves."""
    if role_scope != WORKSPACE:
        return
    missing = codes - workspace_permissions(actor, workspace)
    if missing:
        raise forbidden("You can’t grant permissions you don’t have.", {"permission": sorted(missing)[0]})


def _set_permissions(role: Role, codes: list[str]) -> None:
    perms = {p.code: p for p in Permission.objects.filter(code__in=codes)}
    RolePermission.objects.filter(role=role).exclude(permission__code__in=codes).delete()
    have = set(RolePermission.objects.filter(role=role).values_list("permission__code", flat=True))
    RolePermission.objects.bulk_create([RolePermission(role=role, permission=perms[c]) for c in codes if c not in have])


def _name(raw: Any) -> str:
    name = str(raw or "").strip()
    if not name:
        raise invalid({"name": "Name is required"})
    return name[:40]


def _name_taken(workspace: Any, scope: str, name: str, exclude: Any = None) -> bool:
    qs = Role.objects.filter(workspace=workspace, scope=scope, name__iexact=name)
    if exclude is not None:
        qs = qs.exclude(pk=exclude.pk)
    return qs.exists()


def _owner_holders_after(role: Role, new_codes: set[str]) -> int:
    """How many active members would hold the owner permission if `role` had `new_codes`."""
    from apps.workspaces.models import WorkspaceMember

    holders = (
        WorkspaceMember.objects.filter(workspace=role.workspace, status="active")
        .filter(role__permissions__code=OWNER_PERMISSION)
        .exclude(role=role)
        .values("user_id")
        .distinct()
        .count()
    )
    if OWNER_PERMISSION in new_codes:
        holders += WorkspaceMember.objects.filter(role=role, status="active").count()
    return holders


@transaction.atomic
def create_role(actor: Any, workspace: Any, data: dict[str, Any]) -> Role:
    scope = data.get("scope")
    if scope not in ("workspace", "project"):
        raise invalid({"scope": "Pick workspace or project"})
    name = _name(data.get("name"))
    if _name_taken(workspace, scope, name):
        raise invalid({"name": "A role with this name exists"})
    codes = _clean_permissions(scope, data.get("permissions", []))
    _ensure_no_escalation(actor, scope, workspace, set(codes))
    role = Role.objects.create(
        workspace=workspace, name=name, description=str(data.get("description") or "")[:120], scope=scope
    )
    _set_permissions(role, codes)
    record(
        workspace=workspace,
        actor=actor,
        action="role.created",
        target=role.name,
        entity_id=role.pk,
        changes=[change("Permissions", None, ", ".join(codes))],
    )
    return role


@transaction.atomic
def update_role(actor: Any, role: Role, data: dict[str, Any]) -> Role:
    role = Role.objects.select_for_update().select_related("workspace").get(pk=role.pk)
    changes = []
    if "name" in data:
        name = _name(data.get("name"))
        if name != role.name:
            if role.is_system:
                raise forbidden("System roles can’t be renamed. Duplicate it to customise.")
            if _name_taken(role.workspace, role.scope, name, exclude=role):
                raise invalid({"name": "A role with this name exists"})
            changes.append(change("Name", role.name, name))
            role.name = name
    if "description" in data:
        description = str(data.get("description") or "")[:120]
        if description != role.description:
            if role.is_system:
                raise forbidden("System roles can’t be renamed. Duplicate it to customise.")
            changes.append(change("Description", role.description, description, "text"))
            role.description = description
    if "permissions" in data:
        codes = _clean_permissions(role.scope, data.get("permissions"))
        current = set(role.permissions.values_list("code", flat=True))
        new = set(codes)
        if role.is_system and role.system_key in catalogue.ROLE_DEF_BY_KEY:
            locked = set(catalogue.ROLE_DEF_BY_KEY[role.system_key].core) - new
            if locked:
                raise invalid({"permissions": f"{sorted(locked)[0]} can’t be removed from the {role.name} role"})
        _ensure_no_escalation(actor, role.scope, role.workspace, new - current)
        if (
            role.scope == WORKSPACE
            and OWNER_PERMISSION in current
            and OWNER_PERMISSION not in new
            and _owner_holders_after(role, new) == 0
        ):
            raise conflict("last_owner", "A workspace needs at least one owner.")
        if new != current:
            _set_permissions(role, codes)
            changes.append(change("Permissions", ", ".join(catalogue.ordered(current)), ", ".join(codes)))
    if changes:
        role.save()
        record(
            workspace=role.workspace,
            actor=actor,
            action="role.updated",
            target=role.name,
            entity_id=role.pk,
            changes=changes,
        )
    invalidate(actor)
    return role


@transaction.atomic
def delete_role(actor: Any, role: Role, reassign_to: Any = None) -> None:
    from apps.projects.models import ProjectMember
    from apps.workspaces.models import Invitation, WorkspaceMember

    if role.is_system:
        raise forbidden("System roles can’t be deleted.")
    ws_members = WorkspaceMember.objects.filter(role=role)
    project_members = ProjectMember.objects.filter(role=role)
    in_use = ws_members.exists() or project_members.exists()
    target = None
    if reassign_to:
        try:
            uuid.UUID(str(reassign_to))
        except (TypeError, ValueError) as exc:
            raise invalid({"reassignTo": "Pick another role in the same scope"}) from exc
        target = (
            Role.objects.filter(pk=reassign_to, workspace=role.workspace, scope=role.scope).exclude(pk=role.pk).first()
        )
        if target is None:
            raise invalid({"reassignTo": "Pick another role in the same scope"})
    if in_use and target is None:
        count = ws_members.values("user").distinct().count() + project_members.values("user").distinct().count()
        raise conflict("role_in_use", "Reassign members before deleting this role.", {"memberCount": count})
    if target is not None:
        target_codes = set(target.permissions.values_list("code", flat=True))
        _ensure_no_escalation(actor, role.scope, role.workspace, target_codes)
        if (
            role.scope == WORKSPACE
            and ws_members.filter(role__permissions__code=OWNER_PERMISSION).exists()
            and OWNER_PERMISSION not in target_codes
            and _owner_holders_after(role, set()) == 0
        ):
            raise conflict("last_owner", "A workspace needs at least one owner.")
        ws_members.update(role=target)
        project_members.update(role=target)
        Invitation.objects.filter(role=role, status="pending").update(role=target)
    record(
        workspace=role.workspace,
        actor=actor,
        action="role.deleted",
        target=role.name,
        entity_id=role.pk,
        data={"reassignedTo": target.name if target else None},
    )
    role.delete()
    invalidate(actor)
