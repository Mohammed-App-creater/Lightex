"""Access decisions. `can()` is the only function that decides whether a user may do something.

Workspace permissions come only from the user's WorkspaceMember roles (the union of all of them; sales S0);
permissions of a module scope (`project`)
only from the role the module's scope provider loads (core/access/scopes.py). Neither scope grants anything in the
other. Results are cached per request on the user instance (DRF builds a fresh user object for every request).

Permissions of a module that is disabled in the workspace are dropped from every result (`can()` is False for them
and `my_permissions` leaves them out); their `RolePermission` rows stay, so re-enabling the module restores them.

Data scope (platform Stage 4): a scopable permission is granted with a scope (`own`, `team`, `all`).
`visible_to()` is the only place it is applied to a queryset.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import TYPE_CHECKING, Any
from uuid import UUID

from django.core.exceptions import ImproperlyConfigured
from django.db import transaction
from django.db.models import Q, QuerySet

from core.modules.services import code_enabled, is_enabled, visible_codes, workspace_id_of

from . import catalogue, scopes
from .catalogue import ALL, OWN, PROJECT, TEAM, WORKSPACE

if TYPE_CHECKING:
    from core.accounts.models import User

_CACHE_ATTR = "_lx_access_cache"
_SCOPE_RANK = {scope: i for i, scope in enumerate(catalogue.DATA_SCOPES)}  # own < team < all


def _cache(user: Any) -> dict[str, dict]:
    cache = user.__dict__.get(_CACHE_ATTR)
    if cache is None:
        cache = {"ws": {}, "prj": {}, "ds": {}}
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
        ).values_list("roles__permissions__code", "roles__permissions__scope")
        cache[wid] = frozenset(visible_codes(wid, (code for code, scope in rows if code and scope == WORKSPACE)))
    return cache[wid]


def is_workspace_member(user: Any, workspace: Any) -> bool:
    from core.workspaces.models import WorkspaceMember

    if not getattr(user, "is_authenticated", False):
        return False
    return WorkspaceMember.objects.filter(
        user_id=user.pk, workspace_id=_key(workspace), status="active", workspace__deleted_at__isnull=True
    ).exists()


def my_data_scopes(user: Any, workspace: Any) -> dict[str, str]:
    """{code: scope} for the scopable workspace codes the user's roles grant (disabled modules left out). With several
    roles granting a code, the widest scope wins (`all` > `team` > `own`)."""
    if not getattr(user, "is_authenticated", False) or not getattr(user, "is_active", False):
        return {}
    wid = _key(workspace)
    cache = _cache(user)["ds"]
    if wid not in cache:
        from .models import RolePermission

        rows = RolePermission.objects.filter(
            role__workspace_members__user_id=user.pk,
            role__workspace_members__workspace_id=wid,
            role__workspace_members__status="active",
            role__workspace__deleted_at__isnull=True,
            permission__scope=WORKSPACE,
            permission__scopable=True,
            data_scope__isnull=False,
        ).values_list("permission__code", "data_scope")
        found: dict[str, str] = {}
        for code, scope in rows:
            if _SCOPE_RANK[scope] > _SCOPE_RANK.get(found.get(code, ""), -1):
                found[code] = scope
        visible = visible_codes(wid, found)
        cache[wid] = {c: found[c] for c in catalogue.ordered(visible)}
    return dict(cache[wid])


def visible_to(queryset: QuerySet, user: Any, code: str, workspace: Any) -> QuerySet:
    """`queryset` narrowed to the workspace's records the user may see under scopable permission `code`.

    The model names its owner field with `data_scope_owner_field` (and its workspace field with
    `data_scope_workspace_field`, default "workspace"). No grant, a disabled module or a non-member → nothing;
    `own` → records the user owns; `team` → records owned by the user or by anyone sharing a (live) team with them;
    `all` → every record in the workspace.
    """
    perm = catalogue.get(code)
    if perm is None:
        raise ValueError(f"Unknown permission {code!r}")
    if not perm.scopable:
        raise ValueError(f"{code} is not a scopable permission; check it with can()")
    model = queryset.model
    owner_field = getattr(model, "data_scope_owner_field", None)
    if not owner_field:
        raise ImproperlyConfigured(f"{model._meta.label} must declare data_scope_owner_field to use visible_to()")
    ws_field = getattr(model, "data_scope_workspace_field", "workspace")
    wid = _key(workspace)
    qs = queryset.filter(**{f"{ws_field}_id": wid})
    scope = my_data_scopes(user, wid).get(code)
    if scope == ALL:
        return qs
    if scope == OWN:
        return qs.filter(**{f"{owner_field}_id": user.pk})
    if scope == TEAM:
        from core.teams.models import TeamMember

        mine = TeamMember.objects.filter(workspace_id=wid, user_id=user.pk, team__deleted_at__isnull=True)
        mates = TeamMember.objects.filter(team_id__in=mine.values("team_id")).values("user_id")
        return qs.filter(Q(**{f"{owner_field}_id": user.pk}) | Q(**{f"{owner_field}_id__in": mates}))
    return qs.none()


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
    scope = catalogue.scope_of(code)
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
        codes = project_permissions(user, obj, include_deleted=include_deleted)
    else:
        codes = provider.load_permissions(user, [obj.pk], include_deleted=include_deleted)[obj.pk]
    return frozenset(visible_codes(workspace_id_of(obj), codes))


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
        for i, p in enumerate(catalogue.all_permissions()):
            row = existing.pop(p.code, None)
            values = {
                "module": p.module,
                "scope": p.scope,
                "group": p.group,
                "label": p.label,
                "description": p.description,
                "position": i,
                "scopable": p.scopable,
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
        _comply_data_scopes()
    return created, updated, removed


def _comply_data_scopes() -> None:
    """Keeps `RolePermission.data_scope` in line with the catalogue after a sync: null for non-scopable codes, and a
    default scope (the module's default grant for a system role, else `own`) where a scopable code has none."""
    from .models import RolePermission

    # Every workspace's roles: the catalogue is global.
    RolePermission.objects.unscoped().filter(permission__scopable=False, data_scope__isnull=False).update(
        data_scope=None
    )
    missing = (
        RolePermission.objects.unscoped()
        .filter(permission__scopable=True, data_scope__isnull=True)
        .select_related("role", "permission")
    )
    for rp in missing:
        rdef = catalogue.role_def(rp.role.system_key) if rp.role.is_system else None
        rp.data_scope = (rdef.data_scopes.get(rp.permission.code) if rdef else None) or OWN
        rp.save(update_fields=["data_scope", "updated_at"])


def seed_default_roles(workspace: Any) -> dict[str, Any]:
    """Creates the seven system roles for a new workspace with the grants of core and of the modules already
    enabled in it (`enable_initial_modules` runs first). Returns {system_key: Role}."""
    from .models import Permission, Role, RolePermission

    perms = {p.code: p for p in Permission.objects.all()}
    if any(p.code not in perms for p in catalogue.all_permissions()):
        sync_permission_catalogue()
        perms = {p.code: p for p in Permission.objects.all()}
    roles: dict[str, Any] = {}
    links: list[Any] = []
    for r in catalogue.default_roles():
        role = Role.objects.create(
            workspace=workspace,
            name=r.name,
            description=r.description,
            scope=r.scope,
            is_system=True,
            system_key=r.key,
        )
        roles[r.key] = role
        links.extend(
            RolePermission(
                role=role, permission=perms[c], data_scope=r.data_scopes.get(c) if perms[c].scopable else None
            )
            for c in r.permissions
            if code_enabled(workspace, c)
        )
    RolePermission.objects.bulk_create(links)
    from core.modules.registry import definitions

    for defn in definitions():
        if defn.default_roles and is_enabled(workspace, defn.key):
            roles.update(seed_module_roles(workspace, defn))
    return roles


def seed_module_roles(workspace: Any, defn: Any) -> dict[str, Any]:
    """Creates the module's contributed default roles (`ModuleDefinition.default_roles`) that the workspace lacks.
    A role that exists (by `system_key`) is left exactly as it is, so admin edits survive and re-enabling is a no-op.
    Returns {system_key: Role} of the roles created."""
    from .models import Permission, Role, RolePermission

    rdefs = catalogue.module_default_roles(defn.key)
    if not rdefs:
        return {}
    wanted = {c for r in rdefs for c in r.permissions}
    bad = [c for c in wanted if catalogue.scope_of(c) != WORKSPACE]
    if bad:
        raise LookupError(f"Module {defn.key} default roles grant {sorted(bad)[0]}, not a workspace permission")
    if Permission.objects.filter(code__in=wanted).count() < len(wanted):
        sync_permission_catalogue()
    perms = {p.code: p for p in Permission.objects.filter(code__in=wanted)}
    existing = set(
        Role.objects.for_workspace(workspace).filter(system_key__isnull=False).values_list("system_key", flat=True)
    )
    names = {
        n.lower() for n in Role.objects.for_workspace(workspace).filter(scope=WORKSPACE).values_list("name", flat=True)
    }
    created: dict[str, Any] = {}
    links: list[Any] = []
    for r in rdefs:
        if r.key in existing:
            continue
        name = r.name if r.name.lower() not in names else f"{r.name} ({defn.name})"[:40]
        if name.lower() in names:
            continue
        names.add(name.lower())
        role = Role.objects.create(
            workspace=workspace, name=name, description=r.description[:120], scope=WORKSPACE, is_system=True,
            system_key=r.key,
        )  # fmt: skip
        created[r.key] = role
        links.extend(
            RolePermission(
                role=role, permission=perms[c], data_scope=r.data_scopes.get(c) if perms[c].scopable else None
            )
            for c in r.permissions
        )
    RolePermission.objects.bulk_create(links)
    return created


def seed_module_grants(workspace: Any, defn: Any) -> int:
    """Gives the workspace's system roles a module's default grants (on enable) and creates the module's own default
    roles. Idempotent: existing rows are kept, missing ones added. Returns how many grants were added."""
    from .models import Permission, RolePermission

    seed_module_roles(workspace, defn)

    if any(catalogue.get(c) is None for codes in defn.default_role_grants.values() for c in codes):
        raise LookupError(f"Module {defn.key} grants a permission missing from the catalogue")
    wanted = {c for codes in defn.default_role_grants.values() for c in codes}
    if not wanted:
        return 0
    if Permission.objects.filter(code__in=wanted).count() < len(wanted):
        sync_permission_catalogue()
    perms = {p.code: p for p in Permission.objects.filter(code__in=wanted)}
    roles = workspace.roles.filter(is_system=True, system_key__in=list(defn.default_role_grants))
    have = set(RolePermission.objects.filter(role__in=roles).values_list("role_id", "permission__code"))
    links = []
    for role in roles:
        grants = defn.default_role_grants.get(role.system_key, [])
        for c in grants:
            if (role.pk, c) in have:
                continue
            scope = catalogue.default_data_scope(role.system_key, grants, c) if perms[c].scopable else None
            links.append(RolePermission(role=role, permission=perms[c], data_scope=scope))
    RolePermission.objects.bulk_create(links, ignore_conflicts=True)
    return len(links)


def role_permission_codes(role: Any) -> set[str]:
    """The role's codes, without those of modules disabled in its workspace."""
    return visible_codes(role.workspace_id, role.permissions.values_list("code", flat=True))
