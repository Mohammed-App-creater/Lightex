"""Board 33 (v2): dashboards.

Creates `dashboard.create` and `dashboard.manage` if they are missing (same values as the catalogue) and adds them to
the existing system roles by `system_key` (docs/v2/33-dashboards-presence.md §4.2): Project Admin and Manager get both,
the project Member gets `dashboard.create`. Custom roles are not touched. Idempotent; the reverse is a no-op.
"""

from django.db import migrations

PERMISSIONS = {
    "dashboard.create": ("Reports", "Create dashboards", "Build dashboards and edit the ones you created"),
    "dashboard.manage": ("Reports", "Manage shared dashboards", "Edit, rearrange and delete any shared dashboard"),
}
GRANTS = {
    "dashboard.create": ("project_admin", "manager", "project_member"),
    "dashboard.manage": ("project_admin", "manager"),
}


def add_dashboard_permissions(apps, schema_editor):
    Permission = apps.get_model("access", "Permission")
    Role = apps.get_model("access", "Role")
    RolePermission = apps.get_model("access", "RolePermission")

    for code, (group, label, description) in PERMISSIONS.items():
        perm, _ = Permission.objects.get_or_create(
            code=code, defaults={"scope": "project", "group": group, "label": label, "description": description}
        )
        for role in Role.objects.filter(is_system=True, system_key__in=GRANTS[code]):
            if not RolePermission.objects.filter(role=role, permission=perm).exists():
                RolePermission.objects.create(role=role, permission=perm)


class Migration(migrations.Migration):
    dependencies = [("access", "0004_board40_import_permission")]

    operations = [migrations.RunPython(add_dashboard_permissions, migrations.RunPython.noop)]
