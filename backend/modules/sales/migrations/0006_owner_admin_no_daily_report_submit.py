"""S7: the built-in Owner and Admin roles no longer hold `sales.dailyreport.submit` by default (they got reminders
and showed as "missing" in team daily reports). New workspaces get the new grants from `module.py`; this removes the
grant from existing workspaces' Owner and Admin roles. Not reversed (a reverse no-op)."""

from django.db import migrations


def drop_submit(apps, schema_editor):
    RolePermission = apps.get_model("access", "RolePermission")
    RolePermission.objects.filter(
        role__is_system=True,
        role__system_key__in=("owner", "admin"),
        permission__code="sales.dailyreport.submit",
    ).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("sales", "0005_daily_reports"),
        ("access", "0002_initial"),
    ]

    operations = [migrations.RunPython(drop_submit, migrations.RunPython.noop)]
