"""Board 40 (v2): import wizard.

Creates the `project.import` permission if it is missing (same values as the catalogue) and adds it to the existing
system roles by `system_key`: Project Admin, Manager and project Member (docs/v2/40-import-wizard.md §3.2). Custom
roles are not touched. Idempotent; the reverse is a no-op.
"""

from django.db import migrations

CODE = "project.import"
GROUP, LABEL, DESCRIPTION = "Tasks", "Import tasks", "Bring in tasks from a CSV or another tool’s export"
GRANTS = ("project_admin", "manager", "project_member")


def add_import_permission(apps, schema_editor):
    Permission = apps.get_model("access", "Permission")
    Role = apps.get_model("access", "Role")
    RolePermission = apps.get_model("access", "RolePermission")

    perm, _ = Permission.objects.get_or_create(
        code=CODE, defaults={"scope": "project", "group": GROUP, "label": LABEL, "description": DESCRIPTION}
    )
    for role in Role.objects.filter(is_system=True, system_key__in=GRANTS):
        if not RolePermission.objects.filter(role=role, permission=perm).exists():
            RolePermission.objects.create(role=role, permission=perm)


class Migration(migrations.Migration):
    dependencies = [("access", "0003_board39_permissions")]

    operations = [migrations.RunPython(add_import_permission, migrations.RunPython.noop)]
