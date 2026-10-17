"""Access decisions. `can()` is the only function that decides whether a user may do something.

Workspace permissions come only from the user's WorkspaceMember role; permissions of a module scope (`project`)
only from the role the module's scope provider loads (core/access/scopes.py). Neither scope grants anything in the
other. Results are cached per request on the user instance (DRF builds a fresh user object for every request).
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import TYPE_CHECKING, Any
from uuid import UUID

from django.db import transaction

from . import catalogue, scopes
from .catalogue import PROJECT, SCOPE_OF, WORKSPACE

if TYPE_CHECKING:
    from core.accounts.models import User

_CACHE_ATTR = "_lx_access_cache"


def _cache(user: Any) -> dict[str, dict]:
    cache = user.__dict__.get(_CACHE_ATTR)
    if cache is None:
        cache = {"ws": {}, "prj": {}}
        user.__dict__[_CACHE_ATTR] = cache
    return cache


def invalidate(user: Any) -> None:
    user.__dict__.pop(_CACHE_ATTR, None)


def _key(obj_or_id: Any) -> UUID | str:
    return getattr(obj_or_id, "pk", obj_or_id)


# ───────────────────────── workspace scope ─────────────────────────


def workspace_permissions(user: Any, workspace: Any) -> frozenset[str]:
    if not getattr(user, "is_authenticated", False):
        return frozenset()
    wid = _key(workspace)
    cache = _cache(user)["ws"]
    if wid not in cache:
        from core.workspaces.models import WorkspaceMember

        rows = WorkspaceMember.objects.filter(
            user_id=user.pk, workspace_id=wid, status="active", workspace__deleted_at__isnull=True
        ).values_list("role__permissions__code", "role__permissions__scope")
        cache[wid] = frozenset(code for code, scope in rows if code and scope == WORKSPACE)
    return cache[wid]


def is_workspace_member(user: Any, workspace: Any) -> bool:
    from core.workspaces.models import WorkspaceMember

    if not getattr(user, "is_authenticated", False):
        return False
    return WorkspaceMember.objects.filter(
        user_id=user.pk, workspace_id=_key(workspace), status="active", workspace__deleted_at__isnull=True
    ).exists()


# ───────────────────────── module scopes (project) ─────────────────────────


def _provider(scope: str = PROJECT) -> scopes.ScopeProvider:
    p = scopes.provider(scope)
    if p is None:
        raise LookupError(f"No scope provider is registered for {scope!r}")
    return p


def project_permissions(user: Any, project: Any, *, include_deleted: bool = False) -> frozenset[str]:
    """Permissions from the user's project role (loaded by the `project` scope provider). `include_deleted` reads the
    role a member held in a soft-deleted project (trash: restore and purge decisions)."""
    if not getattr(user, "is_authenticated", False):
        return frozenset()
    pid = _key(project)
    if include_deleted:
        return _provider().load_permissions(user, [pid], include_deleted=True)[pid]
    cache = _cache(user)["prj"]
    if pid not in cache:
        cache.update(_provider().load_permissions(user, [pid]))
    return cache[pid]


def prefetch_project_permissions(user: Any, projects: Iterable[Any]) -> dict[Any, frozenset[str]]:
    """Loads permissions for many projects in one query (project lists)."""
    if not getattr(user, "is_authenticated", False):
        return {}
    cache = _cache(user)["prj"]
    ids = [_key(p) for p in projects]
    missing = [i for i in ids if i not in cache]
    if missing:
        cache.update(_provider().load_permissions(user, missing))
    return {i: cache[i] for i in ids}


def is_project_member(user: Any, project: Any) -> bool:
    return _provider().is_member(user, _key(project))


# ───────────────────────── the decision ─────────────────────────


def can(user: User | Any, code: str, obj: Any, *, include_deleted: bool = False) -> bool:
    """May `user` exercise permission `code` on `obj` (a Workspace or a Project)?

    A workspace-scope code is only ever checked against a workspace, a project-scope code only
    against a project. There is no override in either direction.
    """
    scope = SCOPE_OF.get(code)
    if scope is None:
        raise ValueError(f"Unknown permission {code!r}")
    if not getattr(user, "is_authenticated", False) or not getattr(user, "is_active", False):
        return False
    label = obj._meta.label_lower
    if label == "workspaces.workspace":
        return scope == WORKSPACE and obj.deleted_at is None and code in workspace_permissions(user, obj)
    provider = scopes.provider_for_label(label)
    if provider is not None:
        return scope == provider.scope and code in _scope_permissions(user, provider, obj, include_deleted)
    raise TypeError(f"can() needs a Workspace or a registered scope object, got {label}")


def _scope_permissions(user: Any, provider: scopes.ScopeProvider, obj: Any, include_deleted: bool) -> frozenset[str]:
    if provider.scope == PROJECT:
        return project_permissions(user, obj, include_deleted=include_deleted)
    return provider.load_permissions(user, [obj.pk], include_deleted=include_deleted)[obj.pk]


def my_permissions(user: Any, obj: Any) -> list[str]:
    label = obj._meta.label_lower
    if label == "workspaces.workspace":
        return catalogue.ordered(workspace_permissions(user, obj))
    provider = scopes.provider_for_label(label)
    if provider is None:
        raise TypeError(f"my_permissions() needs a Workspace or a registered scope object, got {label}")
    return catalogue.ordered(_scope_permissions(user, provider, obj, False))


# ───────────────────────── catalogue + default roles ─────────────────────────


def sync_permission_catalogue() -> tuple[int, int, int]:
    """Creates/updates Permission rows from the code catalogue and removes stale ones."""
    from .models import Permission

    created = updated = 0
    with transaction.atomic():
        existing = {p.code: p for p in Permission.objects.all()}
        for i, p in enumerate(catalogue.PERMISSIONS):
            row = existing.pop(p.code, None)
            values = {
                "module": p.module,
                "scope": p.scope,
                "group": p.group,
                "label": p.label,
                "description": p.description,
                "position": i,
            }
            if row is None:
                Permission.objects.create(code=p.code, **values)
                created += 1
            elif any(getattr(row, k) != v for k, v in values.items()):
                for k, v in values.items():
                    setattr(row, k, v)
                row.save()
                updated += 1
        removed = len(existing)
        if existing:
            Permission.objects.filter(code__in=list(existing)).delete()
    return created, updated, removed


def seed_default_roles(workspace: Any) -> dict[str, Any]:
    """Creates the seven system roles for a new workspace. Returns {system_key: Role}."""
    from .models import Permission, Role, RolePermission

    perms = {p.code: p for p in Permission.objects.all()}
    if len(perms) < len(catalogue.PERMISSIONS):
        sync_permission_catalogue()
        perms = {p.code: p for p in Permission.objects.all()}
    roles: dict[str, Any] = {}
    links: list[Any] = []
    for r in catalogue.DEFAULT_ROLES:
        role = Role.objects.create(
            workspace=workspace,
            name=r.name,
            description=r.description,
            scope=r.scope,
            is_system=True,
            system_key=r.key,
        )
        roles[r.key] = role
        links.extend(RolePermission(role=role, permission=perms[c]) for c in r.permissions)
    RolePermission.objects.bulk_create(links)
    return roles


def role_permission_codes(role: Any) -> set[str]:
    return set(role.permissions.values_list("code", flat=True))
