"""Board 37 (v2): GitHub and GitLab integrations.

Creates `integration.manage` (workspace) and `development.link` (project) if they are missing (same values as the
catalogue) and adds them to the existing system roles by `system_key` (docs/v2/37-integrations-github-gitlab.md §4.2):
Owner and Admin get `integration.manage`; Project Admin, Manager and the project Member get `development.link`.
Custom roles are not touched. Idempotent; the reverse is a no-op.
"""

from django.db import migrations

PERMISSIONS = {
    "integration.manage": (
        "workspace",
        "Administration",
        "Manage integrations",
        "Connect GitHub and GitLab, choose repositories and disconnect",
    ),
    "development.link": (
        "project",
        "Tasks",
        "Link code",
        "Create branches and link or unlink pull requests, commits and branches",
    ),
}
GRANTS = {
    "integration.manage": ("owner", "admin"),
    "development.link": ("project_admin", "manager", "project_member"),
}


def add_integration_permissions(apps, schema_editor):
    Permission = apps.get_model("access", "Permission")
    Role = apps.get_model("access", "Role")
    RolePermission = apps.get_model("access", "RolePermission")

    for code, (scope, group, label, description) in PERMISSIONS.items():
        perm, _ = Permission.objects.get_or_create(
            code=code, defaults={"scope": scope, "group": group, "label": label, "description": description}
        )
        for role in Role.objects.filter(is_system=True, system_key__in=GRANTS[code]):
            if not RolePermission.objects.filter(role=role, permission=perm).exists():
                RolePermission.objects.create(role=role, permission=perm)


class Migration(migrations.Migration):
    dependencies = [("access", "0005_board33_dashboard_permissions")]

    operations = [migrations.RunPython(add_integration_permissions, migrations.RunPython.noop)]
