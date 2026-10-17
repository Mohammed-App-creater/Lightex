"""The permission catalogue and default roles.

Core declares only its own entries here (`CORE_PERMISSIONS`, `CORE_ROLES`). Each module declares its permissions and
the codes it grants to the default roles in its `ModuleDefinition` (core/modules/registry.py); the functions below
assemble the full catalogue from every registered definition. It is synced to the database on migrate and by
`manage.py sync_permissions`.

Order: core's codes first, then each module's in registration order, each in the order its definition lists them.
This is the order of `my_permissions` arrays and of `GET /permissions`.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

WORKSPACE = "workspace"
PROJECT = "project"

#: Data scopes of a scopable grant (platform Stage 4), narrowest first.
OWN, TEAM, ALL = "own", "team", "all"
DATA_SCOPES = (OWN, TEAM, ALL)


CORE = "core"


def module_of(code: str) -> str:
    """The owning module is the code's first segment (`core.*`, `tracking.*`, `sales.*`)."""
    return code.split(".", 1)[0]


@dataclass(frozen=True)
class PermissionDef:
    code: str
    scope: str
    group: str
    label: str
    description: str
    module: str
    #: A scopable permission is granted with a data scope (own, team or all); workspace scope only.
    scopable: bool = False


def workspace_permission(
    code: str, group: str, label: str, description: str, *, scopable: bool = False
) -> PermissionDef:
    return PermissionDef(code, WORKSPACE, group, label, description, module_of(code), scopable)


def project_permission(code: str, group: str, label: str, description: str) -> PermissionDef:
    return PermissionDef(code, PROJECT, group, label, description, module_of(code))


_ws = workspace_permission

CORE_PERMISSIONS: list[PermissionDef] = [
    _ws("core.workspace.view", "Administration", "View workspace", "See the workspace and its project list"),
    _ws("core.workspace.update", "Administration", "Workspace settings", "Rename the workspace and change its URL"),
    _ws("core.workspace.delete", "Administration", "Delete workspace", "Delete the workspace and all its projects"),
    _ws("core.workspace.manage_members", "Collaboration", "Manage members", "Invite, remove and change member roles"),
    _ws("core.roles.manage", "Administration", "Manage roles", "Create and edit roles"),
    _ws("core.audit.view", "Reports", "View audit log", "See who changed what across the workspace"),
    _ws("core.modules.manage", "Administration", "Manage modules", "Turn modules on and off for the workspace"),
    # Platform Stage 1: catalogue and default roles only; the teams endpoints arrive in Stage 4.
    _ws("core.teams.manage", "Administration", "Manage teams", "Create teams and choose their members and leads"),
]
CORE_WORKSPACE_CODES = [p.code for p in CORE_PERMISSIONS]

# Permissions that define "ownership"-type invariants (never role names):
OWNER_PERMISSION = "core.workspace.delete"  # the last holder can't be removed or demoted


@dataclass(frozen=True)
class RoleDef:
    key: str
    name: str
    scope: str
    description: str
    permissions: list[str]
    # Permissions a system role can never lose.
    core: list[str] = field(default_factory=list)
    # The data scope of each scopable code in `permissions`.
    data_scopes: dict[str, str] = field(default_factory=dict)


#: The data scope a default role gets for a scopable code when its module does not say (contract §2).
DEFAULT_DATA_SCOPE = {"owner": ALL, "admin": ALL}


def default_data_scope(role_key: str | None, grants: Any = None, code: str = "") -> str:
    """The scope a module's `default_role_grants` entry gives `code` (a `{code: scope}` mapping names it), else
    `all` for Owner and Admin and `own` for every other role."""
    if isinstance(grants, dict) and grants.get(code) in DATA_SCOPES:
        return grants[code]
    return DEFAULT_DATA_SCOPE.get(role_key or "", OWN)


#: The default roles with core's own grants. Modules add theirs through `default_role_grants`.
CORE_ROLES: list[RoleDef] = [
    RoleDef(
        "owner",
        "Owner",
        WORKSPACE,
        "Full control, including deleting the workspace. Can’t be assigned.",
        list(CORE_WORKSPACE_CODES),
        core=list(CORE_WORKSPACE_CODES),
    ),
    RoleDef(
        "admin",
        "Admin",
        WORKSPACE,
        "Manages members, roles and projects.",
        [c for c in CORE_WORKSPACE_CODES if c != OWNER_PERMISSION],
        core=["core.workspace.view", "core.workspace.manage_members"],
    ),
    RoleDef(
        "member",
        "Member",
        WORKSPACE,
        "Sees the workspace and joins projects they’re added to.",
        ["core.workspace.view"],
        core=["core.workspace.view"],
    ),
    RoleDef(
        "project_admin", "Project Admin", PROJECT, "Everything in the project, including members and deletion.", []
    ),
    RoleDef("manager", "Manager", PROJECT, "Plans sprints and goals and edits any task.", []),
    RoleDef("project_member", "Member", PROJECT, "Creates tasks, works their own, comments and uploads.", []),
    RoleDef("viewer", "Viewer", PROJECT, "Read-only access to the board, backlog and goals.", []),
]


# ───────────────────────── assembled from the module definitions ─────────────────────────


@dataclass
class _Catalogue:
    permissions: list[PermissionDef]
    by_code: dict[str, PermissionDef]
    order_index: dict[str, int]
    roles: list[RoleDef]


_built: tuple[int, _Catalogue] | None = None


def _build() -> _Catalogue:
    from core.modules.registry import definitions

    perms: list[PermissionDef] = []
    seen: set[str] = set()
    defs = definitions()
    for d in defs:
        for p in d.permissions:
            if p.code not in seen:
                seen.add(p.code)
                perms.append(p)
    # Workspace codes first, then project codes (each in module order): the my_permissions order per scope.
    ordered_codes = [p.code for p in perms if p.scope == WORKSPACE] + [p.code for p in perms if p.scope != WORKSPACE]
    order_index = {c: i for i, c in enumerate(ordered_codes)}
    roles: list[RoleDef] = []
    by_code = {p.code: p for p in perms}
    for r in CORE_ROLES:
        granted = list(r.permissions)
        locked = list(r.core)
        scoped: dict[str, str] = {}
        for d in defs:
            grants = d.default_role_grants.get(r.key, [])
            granted += list(grants)
            locked += d.locked_role_grants.get(r.key, [])
            for c in grants:
                if c in by_code and by_code[c].scopable:
                    scoped.setdefault(c, default_data_scope(r.key, grants, c))
        key = order_index.get
        roles.append(
            RoleDef(
                r.key,
                r.name,
                r.scope,
                r.description,
                sorted(dict.fromkeys(granted), key=lambda c: key(c, 999)),
                sorted(dict.fromkeys(locked), key=lambda c: key(c, 999)),
                scoped,
            )
        )
    return _Catalogue(perms, by_code, order_index, roles)


def _catalogue() -> _Catalogue:
    global _built
    from core.modules.registry import version

    v = version()
    if _built is None or _built[0] != v:
        _built = (v, _build())
    return _built[1]


def all_permissions() -> list[PermissionDef]:
    """Every registered module's permissions, core first (the catalogue synced to the database)."""
    return list(_catalogue().permissions)


def get(code: str) -> PermissionDef | None:
    return _catalogue().by_code.get(code)


def scope_of(code: str) -> str | None:
    p = get(code)
    return p.scope if p else None


def is_scopable(code: str) -> bool:
    p = get(code)
    return bool(p and p.scopable)


def codes(scope: str | None = None) -> list[str]:
    """Codes in `my_permissions` order (optionally one scope)."""
    idx = _catalogue().order_index
    return [c for c in sorted(idx, key=idx.__getitem__) if scope is None or scope_of(c) == scope]


def ordered(items: Iterable[str]) -> list[str]:
    idx = _catalogue().order_index
    return sorted(set(items), key=lambda c: idx.get(c, 999))


def default_roles() -> list[RoleDef]:
    """The default roles with every module's grants (`permissions`) and locks (`core`)."""
    return list(_catalogue().roles)


def role_def(key: str | None) -> RoleDef | None:
    return next((r for r in _catalogue().roles if r.key == key), None) if key else None


def __getattr__(name: str) -> Any:
    """Read-only views kept for callers of the pre-Stage-3 constants (all assembled from the definitions)."""
    views = {
        "PERMISSIONS": all_permissions,
        "BY_CODE": lambda: dict(_catalogue().by_code),
        "SCOPE_OF": lambda: {p.code: p.scope for p in all_permissions()},
        "WORKSPACE_CODES": lambda: [p.code for p in all_permissions() if p.scope == WORKSPACE],
        "PROJECT_CODES": lambda: [p.code for p in all_permissions() if p.scope == PROJECT],
        "WORKSPACE_ORDER": lambda: codes(WORKSPACE),
        "PROJECT_ORDER": lambda: codes(PROJECT),
        "ORDER_INDEX": lambda: dict(_catalogue().order_index),
        "DEFAULT_ROLES": default_roles,
        "ROLE_DEF_BY_KEY": lambda: {r.key: r for r in default_roles()},
    }
    if name in views:
        return views[name]()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
