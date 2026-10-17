"""Role management: custom roles (one scope each), system-role locks, in-use protection."""

from __future__ import annotations

import uuid
from typing import Any

from django.db import transaction
from django.db.models import Count, Q

from core.audit.services import change, record
from core.common.exceptions import ApiError, conflict, forbidden, invalid, not_found
from core.modules.services import code_enabled, visible_codes

from . import catalogue
from .catalogue import DATA_SCOPES, OWNER_PERMISSION, WORKSPACE
from .models import Permission, Role, RolePermission
from .services import invalidate, my_data_scopes, workspace_permissions

_SCOPE_RANK = {scope: i for i, scope in enumerate(DATA_SCOPES)}  # own < team < all


def roles_for(workspace: Any, scope: str | None = None):
    qs = (
        Role.objects.filter(workspace=workspace)
        .prefetch_related("permissions", "role_permissions__permission")
        .order_by("scope", "created_at")
    )
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


def _clean_permissions(scope: str, raw: Any, workspace: Any) -> list[str]:
    if not isinstance(raw, list) or not all(isinstance(c, str) for c in raw):
        raise invalid({"permissions": "Pick permissions from the list"})
    unknown = [c for c in raw if catalogue.scope_of(c) != scope]
    if unknown:
        raise invalid({"permissions": f"{unknown[0]} isn’t a {scope} permission"})
    off = [c for c in raw if not code_enabled(workspace, c)]
    if off:
        raise invalid({"permissions": f"{off[0]} belongs to a module that is turned off"})
    return catalogue.ordered(raw)


def _ensure_no_escalation(actor: Any, role_scope: str, workspace: Any, codes: set[str]) -> None:
    """A workspace role can only be given permissions the actor holds themselves."""
    if role_scope != WORKSPACE:
        return
    missing = catalogue.grantable_without_holding(codes - workspace_permissions(actor, workspace))
    if missing:
        raise forbidden("You can’t grant permissions you don’t have.", {"permission": sorted(missing)[0]})


def _ensure_no_scope_widening(
    actor: Any, workspace: Any, scopes: dict[str, str], stored: dict[str, str] | None = None
) -> None:
    """Stage 5: a data scope set or changed by this write can't be wider than the actor's own scope for that code.
    Owners (holders of the owner permission) are exempt."""
    changed = {c: v for c, v in scopes.items() if v != (stored or {}).get(c)}
    if not changed or OWNER_PERMISSION in workspace_permissions(actor, workspace):
        return
    mine = my_data_scopes(actor, workspace)
    for code in catalogue.ordered(changed):
        own = mine.get(code)
        if own is None or _SCOPE_RANK[changed[code]] > _SCOPE_RANK[own]:
            raise ApiError(
                403,
                "data_scope_exceeds_own",
                "You can’t grant a wider data scope than your own.",
                {"code": code, "dataScope": changed[code], "yours": own},
            )


def ensure_scopes_within_own(actor: Any, workspace: Any, roles: Any) -> None:
    """Sales S7: assigning roles (member roles, invitations, a deleted role's members moved to another) can't hand out
    a data scope wider than the actor's own, like role edits. Owners are exempt."""
    widest: dict[str, str] = {}
    for r in roles:
        for code, scope in stored_data_scopes(r).items():
            if code_enabled(workspace, code) and _SCOPE_RANK[scope] > _SCOPE_RANK.get(widest.get(code, ""), -1):
                widest[code] = scope
    _ensure_no_scope_widening(actor, workspace, widest)


def _clean_data_scopes(granted: list[str], raw: Any, stored: dict[str, str] | None = None) -> dict[str, str]:
    """The role's data scopes after a write (contract §2). `granted` is the role's final code list, `raw` the
    request's `dataScopes` (None when left out) and `stored` the current map, which stands in for codes the request
    leaves out. Scopes for scopable codes the role doesn't grant are dropped."""
    if raw is not None and not isinstance(raw, dict):
        raise invalid({"dataScopes": "Send an object of permission code → scope"})
    given: dict[str, Any] = raw or {}
    not_allowed = [c for c in given if not catalogue.is_scopable(c)]
    if not_allowed:
        raise ApiError(
            400, "data_scope_not_allowed", "Only scopable permissions take a data scope.", {"codes": not_allowed}
        )
    if any(v not in DATA_SCOPES for v in given.values()):
        raise invalid({"dataScopes": "Use own, team or all"})
    stored = stored or {}
    out: dict[str, str] = {}
    missing: list[str] = []
    for c in granted:
        if not catalogue.is_scopable(c):
            continue
        scope = given.get(c) or stored.get(c)
        if scope:
            out[c] = scope
        else:
            missing.append(c)
    if missing:
        raise ApiError(
            400,
            "data_scope_required",
            "Choose Own, Team or All for each scoped permission.",
            {"codes": catalogue.ordered(missing)},
        )
    return out


def stored_data_scopes(role: Role) -> dict[str, str]:
    rows = RolePermission.objects.filter(role=role, data_scope__isnull=False)
    return {code: scope for code, scope in rows.values_list("permission__code", "data_scope") if scope}


def _set_permissions(role: Role, codes: list[str], scopes: dict[str, str] | None = None) -> None:
    scopes = scopes or {}
    perms = {p.code: p for p in Permission.objects.filter(code__in=codes)}
    RolePermission.objects.filter(role=role).exclude(permission__code__in=codes).delete()
    have = {rp.permission.code: rp for rp in RolePermission.objects.filter(role=role).select_related("permission")}
    for c, rp in have.items():
        if rp.data_scope != scopes.get(c):
            rp.data_scope = scopes.get(c)
            rp.save(update_fields=["data_scope", "updated_at"])
    RolePermission.objects.bulk_create(
        [RolePermission(role=role, permission=perms[c], data_scope=scopes.get(c)) for c in codes if c not in have]
    )


def _scopes_text(scopes: dict[str, str]) -> str:
    return ", ".join(f"{c}: {scopes[c]}" for c in catalogue.ordered(scopes))


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
    """How many active members would hold the owner permission if `role` had `new_codes` (members hold several roles:
    an owner through another role still counts)."""
    from core.workspaces.models import WorkspaceMemberRole

    links = WorkspaceMemberRole.objects.for_workspace(role.workspace_id).filter(member__status="active")
    holders = set(
        links.filter(role__permissions__code=OWNER_PERMISSION).exclude(role=role).values_list("member_id", flat=True)
    )
    if OWNER_PERMISSION in new_codes:
        holders |= set(links.filter(role=role).values_list("member_id", flat=True))
    return len(holders)


@transaction.atomic
def create_role(actor: Any, workspace: Any, data: dict[str, Any]) -> Role:
    scope = data.get("scope")
    if scope not in ("workspace", "project"):
        raise invalid({"scope": "Pick workspace or project"})
    name = _name(data.get("name"))
    if _name_taken(workspace, scope, name):
        raise invalid({"name": "A role with this name exists"})
    codes = _clean_permissions(scope, data.get("permissions", []), workspace)
    scopes = _clean_data_scopes(codes, data.get("dataScopes"))
    _ensure_no_escalation(actor, scope, workspace, set(codes))
    _ensure_no_scope_widening(actor, workspace, scopes)
    role = Role.objects.create(
        workspace=workspace, name=name, description=str(data.get("description") or "")[:120], scope=scope
    )
    _set_permissions(role, codes, scopes)
    changes = [change("Permissions", None, ", ".join(codes))]
    if scopes:
        changes.append(change("Data scopes", None, _scopes_text(scopes)))
    record(
        workspace=workspace,
        actor=actor,
        action="core.role.created",
        target=role.name,
        entity_id=role.pk,
        changes=changes,
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
    if "permissions" in data or "dataScopes" in data:
        stored_scopes = stored_data_scopes(role)
        stored = set(role.permissions.values_list("code", flat=True))
        if "permissions" in data:
            codes = _clean_permissions(role.scope, data.get("permissions"), role.workspace)
        else:
            codes = catalogue.ordered(visible_codes(role.workspace, stored))
        # Grants of disabled modules are hidden from the editor and kept as they are.
        current = visible_codes(role.workspace, stored)
        hidden = stored - current
        new = set(codes)
        rdef = catalogue.role_def(role.system_key) if role.is_system else None
        if rdef is not None:
            locked = visible_codes(role.workspace, rdef.core) - new
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
        final = [*codes, *sorted(hidden)]
        scopes = _clean_data_scopes(final, data.get("dataScopes"), stored_scopes)
        _ensure_no_scope_widening(actor, role.workspace, scopes, stored_scopes)
        if new != current or scopes != stored_scopes:
            _set_permissions(role, final, scopes)
        if new != current:
            changes.append(change("Permissions", ", ".join(catalogue.ordered(current)), ", ".join(codes)))
        if scopes != stored_scopes:
            changes.append(change("Data scopes", _scopes_text(stored_scopes), _scopes_text(scopes)))
    if changes:
        role.save()
        record(
            workspace=role.workspace,
            actor=actor,
            action="core.role.updated",
            target=role.name,
            entity_id=role.pk,
            changes=changes,
        )
    invalidate(actor)
    return role


@transaction.atomic
def delete_role(actor: Any, role: Role, reassign_to: Any = None) -> None:
    from core.workspaces.models import Invitation, InvitationRole, WorkspaceMember, WorkspaceMemberRole

    from . import scopes

    if role.is_system:
        raise forbidden("System roles can’t be deleted.")
    ws_members = WorkspaceMember.objects.for_workspace(role.workspace_id).filter(roles=role)
    # Memberships in module scopes (project members) that use this role, from each scope provider.
    scope_members = [p.role_assignments(role) for p in scopes.providers()]
    in_use = ws_members.exists() or any(qs.exists() for qs in scope_members)
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
        count = ws_members.values("user").distinct().count() + sum(
            qs.values("user").distinct().count() for qs in scope_members
        )
        raise conflict("role_in_use", "Reassign members before deleting this role.", {"memberCount": count})
    if target is not None:
        target_codes = visible_codes(role.workspace, target.permissions.values_list("code", flat=True))
        _ensure_no_escalation(actor, role.scope, role.workspace, target_codes)
        if role.scope == WORKSPACE:
            ensure_scopes_within_own(actor, role.workspace, [target])
        if (
            role.scope == WORKSPACE
            and OWNER_PERMISSION in visible_codes(role.workspace, role.permissions.values_list("code", flat=True))
            and OWNER_PERMISSION not in target_codes
            and _owner_holders_after(role, set()) == 0
        ):
            raise conflict("last_owner", "A workspace needs at least one owner.")
        _move_links(WorkspaceMemberRole.objects.for_workspace(role.workspace_id), "member", role, target)
        for qs in scope_members:
            qs.update(role=target)
        pending = InvitationRole.objects.for_workspace(role.workspace_id).filter(invitation__status="pending")
        _move_links(pending, "invitation", role, target)
    # As before: an invitation whose only role is the deleted one goes with it.
    with_role = InvitationRole.objects.for_workspace(role.workspace_id).filter(role=role).values("invitation_id")
    invites = Invitation.objects.for_workspace(role.workspace_id)
    sole = invites.filter(pk__in=with_role).annotate(n=Count("role_links")).filter(n=1).values_list("pk", flat=True)
    invites.filter(pk__in=list(sole)).delete()
    record(
        workspace=role.workspace,
        actor=actor,
        action="core.role.deleted",
        target=role.name,
        entity_id=role.pk,
        data={"reassignedTo": target.name if target else None},
    )
    role.delete()
    invalidate(actor)


def _move_links(links: Any, parent: str, role: Role, target: Role) -> None:
    """Role links (member or invitation → role) of `role` now point at `target`; a parent that already holds
    `target` just loses the old link."""
    has_target = links.filter(role=target).values(parent)
    links.filter(role=role, **{f"{parent}__in": has_target}).delete()
    links.filter(role=role).update(role=target)
