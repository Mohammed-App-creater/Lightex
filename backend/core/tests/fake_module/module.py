"""The fake module's definition (platform Stage 4). Not registered at start-up, so the fake module stays ungated in
every other test; the data-scope tests register it (toggleable, off until enabled) with `register()`."""

from __future__ import annotations

from core.access.catalogue import workspace_permission
from core.modules.registry import ModuleDefinition, register_module, unregister_module

KEY = "fake"
WIDGET_VIEW = "fake.widget.view"

PERMISSIONS = (
    workspace_permission(WIDGET_VIEW, "Widgets", "View widgets", "See widgets (own, team or all)", scopable=True),
)

DEFINITION = ModuleDefinition(
    key=KEY,
    name="Fake",
    description="Test-only module.",
    permissions=PERMISSIONS,
    # Owner and Admin get `all`, Member `own` (the defaults); the dict form names a scope explicitly.
    default_role_grants={"owner": [WIDGET_VIEW], "admin": [WIDGET_VIEW], "member": {WIDGET_VIEW: "own"}},
    toggleable=True,
)


def register() -> ModuleDefinition:
    return register_module(DEFINITION)


def unregister() -> None:
    unregister_module(KEY)
