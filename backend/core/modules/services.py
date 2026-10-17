"""Which modules are on for a workspace, switching them, and the per-request cache.

`core` and every non-toggleable module (tracking, in this phase) are always on; a toggleable module is on when its
`WorkspaceModule` row says so. Keys with no registered definition are not gated. Lookups are cached for the length of
a request (`EnabledModulesMiddleware`); outside a request every lookup reads the database.

A disabled module keeps its data and its `RolePermission` rows. While it is off, its permissions are hidden from
`my_permissions` and role responses and ignored by `can()`, its routes answer 403 `module_disabled`, and its event
handlers, search provider and trash kinds are skipped.
"""

from __future__ import annotations

from collections.abc import Iterable
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from django.db import transaction
from django.utils import timezone

from core.common.exceptions import ApiError, invalid, not_found

from .registry import CORE, ModuleDefinition, definitions, dependents_of, get_module

_cache: ContextVar[dict[str, frozenset[str]] | None] = ContextVar("lx_enabled_modules", default=None)


# ───────────────────────── request cache ─────────────────────────


@contextmanager
def request_cache():
    """Caches enabled-module lookups until the block exits (one request, one outbox event, …)."""
    token = _cache.set({})
    try:
        yield
    finally:
        _cache.reset(token)


class EnabledModulesMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        with request_cache():
            return self.get_response(request)


def _wid(workspace: Any) -> str:
    return str(getattr(workspace, "pk", workspace))


def invalidate(workspace: Any) -> None:
    cache = _cache.get()
    if cache is not None:
        cache.pop(_wid(workspace), None)


def _enabled_rows(workspace: Any) -> frozenset[str]:
    from .models import WorkspaceModule

    wid = _wid(workspace)
    cache = _cache.get()
    if cache is not None and wid in cache:
        return cache[wid]
    keys = frozenset(
        WorkspaceModule.objects.for_workspace(wid).filter(enabled=True).values_list("module_key", flat=True)
    )
    if cache is not None:
        cache[wid] = keys
    return keys


def prime(workspaces: Iterable[Any]) -> None:
    """Loads the enabled modules of many workspaces in one query (workspace lists)."""
    from .models import WorkspaceModule

    cache = _cache.get()
    if cache is None:
        return
    ids = [w for w in (_wid(w) for w in workspaces) if w not in cache]
    if not ids:
        return
    found: dict[str, set[str]] = {i: set() for i in ids}
    rows = (
        WorkspaceModule.objects.unscoped()  # explicit ids: the workspaces listed for the user
        .filter(workspace_id__in=ids, enabled=True)
        .values_list("workspace_id", "module_key")
    )
    for wid, key in rows:
        found[str(wid)].add(key)
    cache.update({wid: frozenset(keys) for wid, keys in found.items()})


# ───────────────────────── reads ─────────────────────────


def always_on(key: str) -> bool:
    defn = get_module(key)
    return key == CORE or defn is None or not defn.toggleable


def is_enabled(workspace: Any, key: str) -> bool:
    if always_on(key):
        return True
    if workspace is None:
        return True
    return key in _enabled_rows(workspace)


def code_enabled(workspace: Any, code: str) -> bool:
    """Is the module that owns permission (or event, or target type) `code` on in `workspace`?"""
    return is_enabled(workspace, code.split(".", 1)[0])


def visible_codes(workspace: Any, codes: Iterable[str]) -> set[str]:
    return {c for c in codes if code_enabled(workspace, c)}


def enabled_modules(workspace: Any) -> list[str]:
    """Keys of the modules on in `workspace` (always includes `core`), core first."""
    return [d.key for d in definitions() if is_enabled(workspace, d.key)]


def workspace_id_of(scope: Any) -> Any:
    """The workspace id behind a scope object (a Workspace, or a module scope such as a Project)."""
    if scope is None:
        return None
    if scope._meta.label_lower == "workspaces.workspace":
        return scope.pk
    wid = getattr(scope, "workspace_id", None)
    if wid is not None:
        return wid
    from core.access import scopes

    provider = scopes.provider_for_label(scope._meta.label_lower)
    return provider.workspace_of(scope.pk) if provider is not None else None


def module_disabled(defn: ModuleDefinition) -> ApiError:
    return ApiError(
        403, "module_disabled", f"The {defn.name} module is turned off for this workspace.", {"module": defn.key}
    )


def ensure_enabled(key: str, scope: Any) -> None:
    """The module guard: 403 `module_disabled` when module `key` is off in the scope's workspace."""
    if always_on(key):
        return
    if not is_enabled(workspace_id_of(scope), key):
        raise module_disabled(get_module(key))  # type: ignore[arg-type]


# ───────────────────────── API data ─────────────────────────


def module_data(workspace: Any, key: str) -> dict[str, Any]:
    return modules_data(workspace, only=key)[0]


def modules_data(workspace: Any, *, only: str | None = None) -> list[dict[str, Any]]:
    from core.common.utils import iso

    from .models import WorkspaceModule

    rows = {r.module_key: r for r in WorkspaceModule.objects.filter(workspace=workspace)}
    out = []
    for d in definitions():
        if only is not None and d.key != only:
            continue
        on = is_enabled(workspace, d.key)
        row = rows.get(d.key) if on else None
        out.append(
            {
                "key": d.key,
                "name": d.name,
                "description": d.description,
                "isCore": d.is_core,
                "toggleable": d.toggleable,
                "enabled": on,
                "dependsOn": list(d.depends_on),
                "enabledAt": iso(row.enabled_at) if row is not None else None,
                "enabledBy": str(row.enabled_by_id) if row is not None and row.enabled_by_id else None,
                "navItems": [n.as_dict() for n in d.nav_items] if on else [],
            }
        )
    return out


# ───────────────────────── writes ─────────────────────────


def _dependency_error(message: str, modules: list[str]) -> ApiError:
    return ApiError(400, "module_dependency", message, {"modules": modules})


def _names(keys: Iterable[str]) -> str:
    return ", ".join((get_module(k).name if get_module(k) else k) for k in keys)  # type: ignore[union-attr]


@transaction.atomic
def set_module_enabled(actor: Any, workspace: Any, key: str, enabled: bool) -> dict[str, Any]:
    """Turns module `key` on or off for `workspace` (the view requires `core.modules.manage`)."""
    from core.access import services as access
    from core.audit.services import change, record
    from core.realtime.services import publish

    from .models import WorkspaceModule

    defn = get_module(key)
    if defn is None:
        raise not_found("Module not found.")
    if not defn.toggleable:
        raise ApiError(400, "module_not_toggleable", f"{defn.name} is always on.", {"module": key})
    invalidate(workspace)
    row = WorkspaceModule.objects.select_for_update().filter(workspace=workspace, module_key=key).first()
    current = bool(row and row.enabled)
    if enabled:
        missing = [d for d in defn.depends_on if not is_enabled(workspace, d)]
        if missing:
            raise _dependency_error(f"Turn on {_names(missing)} first.", missing)
    else:
        blockers = [d.key for d in dependents_of(key) if is_enabled(workspace, d.key)]
        if blockers:
            raise _dependency_error(f"Turn off {_names(blockers)} first: it needs {defn.name}.", blockers)
    if enabled == current:
        return module_data(workspace, key)
    if row is None:
        row = WorkspaceModule(workspace=workspace, module_key=key)
    row.enabled = enabled
    if enabled:
        row.enabled_by = actor
        row.enabled_at = timezone.now()
    row.save()
    invalidate(workspace)
    if enabled:
        access.seed_module_grants(workspace, defn)
    access.invalidate(actor)
    record(
        workspace=workspace,
        actor=actor,
        action="core.module.enabled" if enabled else "core.module.disabled",
        target=defn.name,
        entity_id=row.pk,
        changes=[change("Enabled", current, enabled)],
        data={"module": key},
    )
    publish("core.module.changed", workspace=workspace, actor=actor, data={"module": key, "enabled": enabled})
    return module_data(workspace, key)


def enable_initial_modules(actor: Any, workspace: Any, requested: Any) -> list[str]:
    """A new workspace: every non-toggleable module (tracking) plus `requested` (validated). Returns the keys."""
    from .models import WorkspaceModule

    if requested is None:
        requested = []
    if not isinstance(requested, list) or not all(isinstance(k, str) for k in requested):
        raise invalid({"modules": "Send a list of module keys"})
    unknown = [k for k in requested if get_module(k) is None]
    if unknown:
        raise invalid({"modules": f"{unknown[0]} isn’t a module"})
    keys = [d.key for d in definitions() if d.key != CORE and (not d.toggleable or d.key in requested)]
    on = {CORE, *keys}
    for k in keys:
        missing = [dep for dep in get_module(k).depends_on if dep not in on]  # type: ignore[union-attr]
        if missing:
            raise _dependency_error(f"{_names([k])} needs {_names(missing)}.", missing)
    now = timezone.now()
    WorkspaceModule.objects.bulk_create(
        [
            WorkspaceModule(workspace=workspace, module_key=k, enabled=True, enabled_by=actor, enabled_at=now)
            for k in keys
        ]
    )
    invalidate(workspace)
    return keys
