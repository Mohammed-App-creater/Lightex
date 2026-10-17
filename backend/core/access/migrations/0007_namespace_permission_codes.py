"""Platform Stage 1: permission codes become `module.resource.action` (docs/platform/stage1-contract.md §1).

Adds `Permission.module`, renames every existing row in place (so RolePermission links survive), and grants the two
new core codes (`core.modules.manage`, `core.teams.manage`) to the Owner and Admin system roles. Custom roles are not
touched. Idempotent: a row already carrying the new code keeps its links and absorbs the old row's links. The reverse
renames back and drops the two new codes.
"""

from django.db import migrations, models

RENAMES = {
    "workspace.view": "core.workspace.view",
    "workspace.update": "core.workspace.update",
    "workspace.delete": "core.workspace.delete",
    "workspace.manage_members": "core.workspace.manage_members",
    "workspace.manage_roles": "core.roles.manage",
    "audit.view": "core.audit.view",
    **{
        old: f"tracking.{old}"
        for old in (
            "project.create",
            "project.assign_admin",
            "integration.manage",
            "project.view",
            "project.update",
            "project.archive",
            "project.delete",
            "project.manage_members",
            "project.import",
            "objective.manage",
            "milestone.manage",
            "epic.manage",
            "sprint.manage",
            "status.manage",
            "field.manage",
            "task.create",
            "task.edit_any",
            "task.edit_own",
            "task.delete",
            "task.assign",
            "task.move",
            "time.log",
            "time.delete_any",
            "development.link",
            "comment.create",
            "comment.edit_own",
            "comment.delete_any",
            "attachment.upload",
            "attachment.delete_any",
            "dashboard.create",
            "dashboard.manage",
            "report.view",
        )
    },
}
NEW_CORE = {
    "core.modules.manage": ("Administration", "Manage modules", "Turn modules on and off for the workspace"),
    "core.teams.manage": ("Administration", "Manage teams", "Create teams and choose their members and leads"),
}
NEW_CORE_GRANTS = ("owner", "admin")


def _move(Permission, RolePermission, old_code, new_code):
    old = Permission.objects.filter(code=old_code).first()
    if old is None:
        return
    target = Permission.objects.filter(code=new_code).first()
    if target is None:
        old.code = new_code
        old.save(update_fields=["code"])
        return
    # Both exist (the catalogue was synced before migrating): keep the new row, move the old row's links onto it.
    have = set(RolePermission.objects.filter(permission=target).values_list("role_id", flat=True))
    for link in RolePermission.objects.filter(permission=old):
        if link.role_id not in have:
            RolePermission.objects.create(role_id=link.role_id, permission=target)
    old.delete()


def namespace_permission_codes(apps, schema_editor):
    Permission = apps.get_model("access", "Permission")
    Role = apps.get_model("access", "Role")
    RolePermission = apps.get_model("access", "RolePermission")

    for old_code, new_code in RENAMES.items():
        _move(Permission, RolePermission, old_code, new_code)
    for perm in Permission.objects.all():
        module = perm.code.split(".", 1)[0]
        if module in ("core", "tracking") and perm.module != module:
            perm.module = module
            perm.save(update_fields=["module"])

    for code, (group, label, description) in NEW_CORE.items():
        perm, _ = Permission.objects.get_or_create(
            code=code,
            defaults={"module": "core", "scope": "workspace", "group": group, "label": label, "description": description},
        )
        for role in Role.objects.filter(is_system=True, system_key__in=NEW_CORE_GRANTS):
            if not RolePermission.objects.filter(role=role, permission=perm).exists():
                RolePermission.objects.create(role=role, permission=perm)


def restore_permission_codes(apps, schema_editor):
    Permission = apps.get_model("access", "Permission")
    RolePermission = apps.get_model("access", "RolePermission")

    Permission.objects.filter(code__in=list(NEW_CORE)).delete()
    for old_code, new_code in RENAMES.items():
        _move(Permission, RolePermission, new_code, old_code)


class Migration(migrations.Migration):
    dependencies = [("access", "0006_board37_integration_permissions")]

    operations = [
        migrations.AddField(
            model_name="permission",
            name="module",
            field=models.CharField(
                choices=[("core", "Core"), ("tracking", "Tracking")], default="tracking", max_length=16
            ),
        ),
        migrations.RunPython(namespace_permission_codes, restore_permission_codes),
    ]
