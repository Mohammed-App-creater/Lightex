"""Board 39 (v2): custom fields, dependencies, time tracking.

Creates the three new project permissions if they are missing (same values as the catalogue) and adds them to
the existing system roles by `system_key`. Custom roles are not touched. Idempotent; the reverse is a no-op.
"""

from django.db import migrations

NEW_PERMISSIONS = [
    # code, group, label, description
    ("field.manage", "Planning", "Manage custom fields", "Create, edit, reorder and delete custom fields"),
    ("time.log", "Tasks", "Log time", "Track time on tasks with the timer or by hand"),
    ("time.delete_any", "Tasks", "Delete anyone’s time", "Remove time entries logged by others"),
]

GRANTS = {
    "project_admin": ["field.manage", "time.log", "time.delete_any"],
    "manager": ["field.manage", "time.log", "time.delete_any"],
    "project_member": ["time.log"],
}


def add_board39_permissions(apps, schema_editor):
    Permission = apps.get_model("access", "Permission")
    Role = apps.get_model("access", "Role")
    RolePermission = apps.get_model("access", "RolePermission")

    perms = {}
    for code, group, label, description in NEW_PERMISSIONS:
        perm, _ = Permission.objects.get_or_create(
            code=code,
            defaults={"scope": "project", "group": group, "label": label, "description": description},
        )
        perms[code] = perm
    for system_key, codes in GRANTS.items():
        for role in Role.objects.filter(is_system=True, system_key=system_key):
            have = set(RolePermission.objects.filter(role=role).values_list("permission__code", flat=True))
            RolePermission.objects.bulk_create(
                [RolePermission(role=role, permission=perms[c]) for c in codes if c not in have]
            )


class Migration(migrations.Migration):
    dependencies = [("access", "0002_initial")]

    operations = [migrations.RunPython(add_board39_permissions, migrations.RunPython.noop)]
