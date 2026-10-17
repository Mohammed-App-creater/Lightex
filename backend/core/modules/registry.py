"""Module definitions: what each module contributes to the platform, declared once in code.

Every module calls `register_module(ModuleDefinition(...))` from its AppConfig `ready()` (core registers its own from
`core.modules`). The permission catalogue, the default role grants, the notification event types and the navigation
the API exposes are all assembled from these definitions. Whether a module is on for a workspace is stored in
`WorkspaceModule` (see `core.modules.services`).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from core.access.catalogue import PermissionDef

CORE = "core"


@dataclass(frozen=True)
class EventTypeDef:
    """A notification event type a module emits (registered into `core.events.registry` on `register_module`)."""

    key: str
    label: str
    #: Channel → on by default ("in_app", "email", "telegram", "sms", "push").
    default_channels: dict[str, bool] = field(default_factory=dict)
    #: The Telegram, SMS and Push template (templates/channels/<name>.<channel>.txt); "" = in-app and email only.
    channel_template: str = ""
    #: Email templates (templates/emails/<name>.html) the module's handlers send for this event.
    email_templates: tuple[str, ...] = ()
    #: The one-line digest summary for the channel template (`ctx` → text).
    channel_summary: Callable[[dict[str, Any]], str] | None = None
    #: The Telegram button label for the channel template ("" = "Open <task key>").
    channel_button: str = ""
    preference: bool = True
    position: int | None = None


@dataclass(frozen=True)
class NavItem:
    key: str
    label: str
    icon: str
    #: Relative to the workspace (`sales` → `/<workspace>/sales`).
    path: str
    #: The permission the user needs to see the item (the client checks it against `my_permissions`).
    permission: str

    def as_dict(self) -> dict[str, str]:
        return {
            "key": self.key,
            "label": self.label,
            "icon": self.icon,
            "path": self.path,
            "permission": self.permission,
        }


@dataclass(frozen=True)
class ModuleDefinition:
    key: str
    name: str
    description: str = ""
    is_core: bool = False
    depends_on: tuple[str, ...] = ()
    permissions: tuple[PermissionDef, ...] = ()
    #: Default role (`system_key`) → codes granted to it when the module is enabled in a workspace. A scopable code
    #: takes its data scope from a `{code: scope}` mapping in place of the list (`{"member": {"sales.lead.view":
    #: "team"}}`); without one, Owner and Admin get `all` and every other role `own`.
    default_role_grants: Mapping[str, list[str] | dict[str, str]] = field(default_factory=dict)
    #: Default role (`system_key`) → codes that system role can never lose (a subset of its grants).
    locked_role_grants: dict[str, list[str]] = field(default_factory=dict)
    event_types: tuple[EventTypeDef, ...] = ()
    #: Target types (`<module>.<entity>`) the module registers resolvers for (core/common/targets.py).
    target_types: tuple[str, ...] = ()
    #: The key the module's search provider is registered under (core/search/services.py), or None.
    search_provider: str | None = None
    nav_items: tuple[NavItem, ...] = ()
    settings_schema: dict[str, Any] | None = None
    #: False: always on (core, and tracking in this phase); the API refuses to switch it.
    toggleable: bool = True


_MODULES: dict[str, ModuleDefinition] = {}
_version = 0


def register_module(defn: ModuleDefinition) -> ModuleDefinition:
    """Registers (or replaces) a module definition and its event types. Idempotent."""
    global _version
    from core.access.catalogue import DATA_SCOPES, WORKSPACE
    from core.events.registry import register_event_type

    for p in defn.permissions:
        if p.module != defn.key:
            raise ValueError(f"Permission {p.code} does not belong to module {defn.key!r}")
        if p.scopable and p.scope != WORKSPACE:
            raise ValueError(f"Permission {p.code}: only workspace permissions can be scopable")
    for grants in defn.default_role_grants.values():
        if isinstance(grants, dict) and any(s not in DATA_SCOPES for s in grants.values()):
            raise ValueError(f"Module {defn.key!r} gives a default grant an unknown data scope")
    _MODULES[defn.key] = defn
    for et in defn.event_types:
        register_event_type(
            et.key,
            et.label,
            et.default_channels,
            defn.key,
            channel_template=et.channel_template,
            email_templates=et.email_templates,
            channel_summary=et.channel_summary,
            channel_button=et.channel_button,
            preference=et.preference,
            position=et.position,
        )
    _version += 1
    return defn


def unregister_module(key: str) -> None:
    """Test helper: removes a definition (its event types stay registered)."""
    global _version
    if _MODULES.pop(key, None) is not None:
        _version += 1


def version() -> int:
    """Bumped on every registration change (the assembled catalogue caches against it)."""
    return _version


def get_module(key: str) -> ModuleDefinition | None:
    return _MODULES.get(key)


def definitions() -> list[ModuleDefinition]:
    """Core first, then the modules in registration order."""
    return sorted(_MODULES.values(), key=lambda d: 0 if d.key == CORE else 1)


def dependents_of(key: str) -> list[ModuleDefinition]:
    return [d for d in definitions() if key in d.depends_on]
