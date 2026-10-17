"""The sales module's definition. A placeholder: the real sales specification is a separate document."""

from __future__ import annotations

from core.access.catalogue import workspace_permission
from core.modules.registry import ModuleDefinition, NavItem

KEY = "sales"
HEALTH_VIEW = "sales.health.view"

PERMISSIONS = (workspace_permission(HEALTH_VIEW, "Sales", "View sales", "Open the Sales area of the workspace"),)

DEFINITION = ModuleDefinition(
    key=KEY,
    name="Sales",
    description="Leads, opportunities, targets and daily reports for sales teams.",
    is_core=False,
    depends_on=(),
    permissions=PERMISSIONS,
    default_role_grants={"owner": [HEALTH_VIEW], "admin": [HEALTH_VIEW], "member": [HEALTH_VIEW]},
    nav_items=(NavItem("sales", "Sales", "briefcase", "sales", HEALTH_VIEW),),
    toggleable=True,
)
